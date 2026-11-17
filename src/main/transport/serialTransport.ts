/**
 * 串口传输实现。
 *
 * 与 SSH 的差异（每一条都影响接口形状）：
 * - 没有「连接」概念，open 即占用端口，close 即释放；
 * - 没有终端尺寸，resize 是空操作；
 * - 没有服务端 locale，字符编码必须由连接配置决定（现场大量 GBK 设备）；
 * - 换行符由设备协议决定，不是固定 CR。
 *
 * 解码用 iconv-lite 的流式 decoder：串口分片到达时双字节汉字可能被切成两半，
 * 一次性 `iconv.decode(chunk)` 会在切点上产出替换字符，必须保留解码器状态。
 *
 * serialport 走 serialLoader 懒加载：原生模块加载失败时不能连累 SSH。
 */
import iconv from 'iconv-lite'
import type { SerialPort } from 'serialport'
import type { SerialCharset, SerialConfig, SerialNewline } from '@shared/types'
import { normalizeBaudRate } from '@shared/serialBaud'
import { normalizeCharDelayMs, normalizeLineDelayMs } from '@shared/serialTiming'
import type { Transport, TransportEvents, TransportOpenOptions } from './types'
import { loadSerialport } from './serialLoader'

/** 换行符映射表：终端里按回车发出的是 CR，落到底层要换成设备认的那一个 */
const NEWLINE_SEQ: Record<SerialNewline, string> = {
  cr: '\r',
  lf: '\n',
  crlf: '\r\n'
}

/**
 * 把终端发来的换行统一成配置的那一种。
 *
 * 为什么必须统一：xterm 的回车是 `\r`，命令面板发出的命令末尾可能是 `\n`，
 * 两者落到同一个串口上。如果只对其中一种做替换，同一条连接上的行为就会
 * 随输入来源而变 —— 用户会看到「手敲能跑、点按钮跑两遍」这种诡异现象。
 */
export function applyNewline(data: string, newline: SerialNewline): string {
  const seq = NEWLINE_SEQ[newline]
  // 先并掉 CRLF 再逐个替换，避免 \r\n 被替换成两段
  return data.replace(/\r\n|\r|\n/g, seq)
}

/**
 * 入站换行归一：设备只发了 LF 时补一个 CR。
 *
 * 为什么必须补：xterm 里「换行」是两个动作 —— LF 把光标下移一行、CR 把光标
 * 拉到行首。设备只发 LF 时只有前者发生，屏幕上就是阶梯状一路右移的行。
 * Linux 设备本该由 tty 的 ONLCR 把 \n 翻成 \r\n 再吐出来，但 busybox 的
 * 精简 shell、不少裸机固件的日志输出、以及把输出重定向到串口的场景都会
 * 直接 write("\n")，现场就会看到这个错位。
 *
 * 为什么放在传输层而不是渲染层开 xterm 的 convertEol：convertEol 是终端实例
 * 级的开关，SSH 会话也会跟着被改写；而 SSH 对端发的本来就是完整 CRLF，
 * 多余的改写一旦碰上「上游已经补过 CR」的情况就会变成 \r\r\n。放在串口
 * 传输层，经过它的只有串口数据。
 *
 * 为什么看 config.newline 也没用：那个字段描述的是「我们发出去用什么」，
 * 与设备回什么无关 —— 设备回什么由它自己的 tty 设置决定，不是我们能配的。
 *
 * lastWasCR 是跨帧状态：串口按块到达，上一块末尾是 \r、下一块开头是 \n 时
 * 那是一个完整的 CRLF。若单看当前块，会用「前面不是 \r」的假设把它补成
 * \r\r\n，屏幕上反而多出一个空行。
 */
export function normalizeInboundNewlines(
  text: string,
  lastWasCR: boolean
): { text: string; lastWasCR: boolean } {
  if (text.indexOf('\n') === -1) {
    // 一个 LF 都没有就不必改写，但仍要记住末尾是不是 CR：下一帧开头的 LF 要和它配对
    return {
      text,
      lastWasCR: text.length > 0 ? text[text.length - 1] === '\r' : lastWasCR
    }
  }
  let out = ''
  let from = 0
  let prevWasCR = lastWasCR
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '\n') {
      if (!prevWasCR) {
        // 裸 LF：补 CR 后整段落下（含本行之前的原文）
        out += text.slice(from, i) + '\r\n'
        from = i + 1
      }
      // 已经是 CRLF 时什么都不做，等结尾的 slice(from) 把它原样带出去
      prevWasCR = false
      continue
    }
    prevWasCR = ch === '\r'
  }
  out += text.slice(from)
  return { text: out, lastWasCR: prevWasCR }
}

/**
 * 从字符串里切出下一个发送单元。
 *
 * 逐字符节流不能按 UTF-16 code unit 切：一个汉字占两个 code unit，
 * 拆开发出去就是两个残字节，设备侧收到的不是那个字符。这里用
 * codePointAt 取完整码点 —— 对 BMP 之外的字符（emoji、部分符号）
 * 也只会切出一个完整的 4 字节 UTF-8 序列。
 */
function nextUnit(text: string, offset: number): { head: string; size: number } {
  const code = text.codePointAt(offset)
  // offset 越界时返回空串，调用方的「已发完」判断会立刻收敛
  if (code === undefined) return { head: '', size: 1 }
  const size = code > 0xffff ? 2 : 1
  return { head: text.slice(offset, offset + size), size }
}

/**
 * 判断某个下标处的字符是不是行尾。
 *
 * CRLF 里的 \r\n 只算一次行尾：两个都算的话，配置成 CRLF 换行的连接
 * 每行会被停两次，用户按 200ms 调出来的节奏变成 400ms。
 */
function isLineBreakAt(text: string, index: number): boolean {
  const ch = text[index]
  if (ch === '\n') return true
  if (ch === '\r') return text[index + 1] !== '\n'
  return false
}

/** 取流式解码器；iconv-lite 对未知编码返回 undefined，此处兜底 UTF-8 */
function makeDecoder(charset: SerialCharset): (buf: Buffer) => string {
  if (charset === 'utf-8') {
    // UTF-8 也要流式：多字节字符同样会被分片切断
    const dec = new TextDecoder('utf-8', { fatal: false })
    return (buf) => dec.decode(buf, { stream: true })
  }
  const dec = iconv.getDecoder(charset)
  if (!dec) {
    const fallback = new TextDecoder('utf-8', { fatal: false })
    return (buf) => fallback.decode(buf, { stream: true })
  }
  return (buf) => dec.write(buf)
}

export interface SerialTransportOptions {
  config: SerialConfig
  /**
   * 端口实例工厂（测试注入点）。
   *
   * 生产环境不传，走 serialLoader 里的真实 SerialPort。测试里换成假端口，
   * 才能验证 DTR 脉冲时序、打开失败的错误收敛这些「只在真实端口上才发生」
   * 的行为 —— 否则这类逻辑只能靠人工插拔设备验，等于没有回归保护。
   */
  portFactory?: (config: SerialConfig) => SerialPort
}

/** 造真实的串口实例（参数映射集中在这里，改一处即可） */
function createRealPort(cfg: SerialConfig): SerialPort {
  const { SerialPort: Ctor } = loadSerialport()
  return new Ctor({
    path: cfg.path,
    baudRate: cfg.baudRate,
    dataBits: cfg.dataBits,
    stopBits: cfg.stopBits,
    parity: cfg.parity,
    // rtscts：硬件流控；xon/xoff：软件流控。两者互斥
    rtscts: cfg.flowControl === 'hardware',
    xon: cfg.flowControl === 'software',
    xoff: cfg.flowControl === 'software',
    // 打开动作由下面的 port.open 显式触发，便于把错误收成一次 reject
    autoOpen: false
  })
}

export class SerialTransport implements Transport {
  readonly kind = 'serial' as const

  private readonly config: SerialConfig
  private readonly events: TransportEvents
  private readonly portFactory?: (config: SerialConfig) => SerialPort
  private port?: SerialPort
  private decode: (buf: Buffer) => string
  private opened = false
  /** 本实现主动 close()：之后的端口事件不再上报 */
  private closing = false

  /*
   * 发送节奏相关状态。
   *
   * 为什么是「字符队列 + 定时器」而不是 async 循环：Transport.write 的签名是
   * 同步的（见 types.ts 的说明：键盘输入必须保序，宁可同步阻塞）。改成异步写
   * 会让两个并发调用互相插队，串口上的命令就拼错了。这里 write 仍然立即返回，
   * 只是把字符推进队列，由 pump 按间隔逐个落到端口 —— 顺序由队列本身保证。
   */
  /**
   * 待发送队列。文本按「一个字符」为单位逐个落端口，二进制整块落。
   *
   * 为什么文本要拆成字符而不是整段写完：节流的意义就在字符之间留间隙，
   * 整段写下去等于没有延迟。队列里存整串 + 游标（cursor）而不是预先拆成
   * 字符数组，是为了让一次粘贴几千字符时不必先分配几千个元素的数组。
   */
  private queue: Array<{ kind: 'text'; data: string } | { kind: 'bytes'; data: Buffer }> = []
  /** 队首文本已发到的下标 */
  private cursor = 0
  /** 正在等待的定时器；有它就不重复排程 */
  private pumpTimer?: ReturnType<typeof setTimeout>
  /** 逐字符间隔（毫秒），0 = 关闭 */
  private readonly charDelayMs: number
  /** 换行后的追加间隔（毫秒），0 = 关闭 */
  private readonly lineDelayMs: number
  /** 上一帧的最后一个字符是不是 CR（跨帧判断 CRLF 用，见 normalizeInboundNewlines） */
  private lastWasCR = false

  constructor(options: SerialTransportOptions, events: TransportEvents) {
    this.config = options.config
    this.events = events
    this.portFactory = options.portFactory
    this.decode = makeDecoder(options.config.charset)
    // 构造函数里就收敛一次：串口参数在会话存续期间不会变（改参数即重连），
    // 每个字符都重新解析一遍配置纯属浪费
    this.charDelayMs = normalizeCharDelayMs(options.config.charDelayMs)
    this.lineDelayMs = normalizeLineDelayMs(options.config.lineDelayMs)
  }

  async open(_opts: TransportOpenOptions): Promise<void> {
    if (this.opened) throw new Error('传输层已打开')
    const cfg = this.config
    if (!cfg.path) throw new Error('未选择串口')

    const port = this.portFactory ? this.portFactory(cfg) : createRealPort(cfg)

    if (this.closing) {
      port.close(() => {})
      throw new Error('会话已关闭')
    }

    this.port = port
    this.opened = true
    // 每次打开都是一条新的字节流：上一条连接末尾残留的 CR 不该影响这一条的首帧
    this.lastWasCR = false

    port.on('data', (chunk: Buffer) => {
      if (this.closing) return
      // 文本走归一（补 CR），raw 原样透传：ZMODEM 帧与二进制协议靠 raw 判帧，
      // 改动一个字节 CRC 就废了，所以两者必须分开走
      const inbound = normalizeInboundNewlines(this.decode(chunk), this.lastWasCR)
      this.lastWasCR = inbound.lastWasCR
      this.events.onData(chunk, inbound.text)
    })
    port.on('error', (err: Error) => this.handleClosed(err))
    port.on('close', () => this.handleClosed())

    await new Promise<void>((resolve, reject) => {
      port.open((err) => (err ? reject(err) : resolve()))
    })

    if (this.config.autoReset) await this.pulseDtr()
  }

  write(data: string): void {
    if (!this.port || this.closing || !this.port.isOpen) return
    const payload = applyNewline(data, this.config.newline)
    // 没有配置延迟时保持原来的整段直发：多数连接不需要节流，
    // 走队列只会给键盘输入平白加一层定时器
    if (this.charDelayMs === 0 && this.lineDelayMs === 0 && this.queue.length === 0) {
      this.port.write(payload)
      return
    }
    this.queue.push({ kind: 'text', data: payload })
    this.pump()
  }

  writeBytes(data: Buffer): void {
    if (!this.port || this.closing || !this.port.isOpen) return
    /*
     * 二进制帧不逐字节节流：ZMODEM 之类的协议靠连续字节流判帧头，
     * 在两个字节之间插几十毫秒等于把协议拆散。它只保证「排在已排队的文本之后」，
     * 因为文本队列里可能正卡着一条还没发完的命令。
     */
    if (this.queue.length === 0) {
      this.port.write(data)
      return
    }
    this.queue.push({ kind: 'bytes', data })
    this.pump()
  }

  /** 串口没有终端尺寸：显式空实现，避免调用方以为它生效了 */
  resize(_cols: number, _rows: number): void {
    /* no-op */
  }

  /**
   * 在线切换波特率，不重开端口。
   *
   * 为什么需要它：设备的两个阶段常常跑不同速率 —— 7628 的 U-Boot 是 57600，
   * 进了系统变成 115200；ESP 系列的 ROM 是 74880，应用是 115200。
   * 以前只能「断开 → 改连接配置 → 重连」，中间那几秒的输出全丢，
   * 而恰恰是启动日志最值钱。
   *
   * 用 `port.update({ baudRate })` 而不是 close + new：serialport 的 update
   * 只改驱动里的 termios / DCB，不碰 DTR/RTS，也不释放句柄 —— 重开端口会在
   * Windows 上重新枚举一次设备，等于拔插，可能触发自动下载电路。
   *
   * 返回实际生效的值（收敛后的），让界面显示与驱动一致。
   */
  async setBaudRate(baudRate: number): Promise<number> {
    const port = this.port
    if (!port || this.closing || !port.isOpen) throw new Error('串口未打开，无法切换波特率')
    if (typeof port.update !== 'function') throw new Error('当前串口驱动不支持在线改波特率')
    const next = normalizeBaudRate(baudRate, this.config.baudRate)
    await new Promise<void>((resolve, reject) => {
      port.update({ baudRate: next }, (err) => (err ? reject(err) : resolve()))
    })
    // 记到 config 上：传输层后续若被重建（拔插恢复），用的是最后生效的速率
    this.config.baudRate = next
    return next
  }

  /**
   * 发一个 BREAK：TX 保持逻辑 0 一段时间。
   *
   * 为什么它是「有些场景的唯一手段」：不少 bootloader 与交换机 / 路由器的
   * 串口控制台用 BREAK 作为「打断自动启动、进维护模式」的信号，
   * 没有任何字节序列能替代 —— 它不是一个字符，是物理层上把线路拉低。
   * minicom 是 Ctrl+A F、picocom 是发送 break 命令，本工具此前只能换一个工具去做。
   *
   * 时长默认 250ms：短于 100ms 有些 UART 收不到（接收端要把这段低电平
   * 当帧错误累积），长于 2 秒对端可能已经在重启了。这里夹在 50..2000。
   */
  async sendBreak(durationMs = 250): Promise<void> {
    const port = this.port
    if (!port || this.closing || !port.isOpen) throw new Error('串口未打开，无法发送 BREAK')
    const hold = Math.min(Math.max(Math.floor(Number(durationMs) || 250), 50), 2000)
    let failure: Error | undefined
    await new Promise<void>((resolve) => {
      port.set({ brk: true }, (err) => {
        if (err) failure = err
        resolve()
      })
    })
    await new Promise((r) => setTimeout(r, hold))
    // 无论拉低是否报错都要尝试释放：卡在 brk 状态等于把 TX 钉死在地上
    await new Promise<void>((resolve) => {
      port.set({ brk: false }, (err) => {
        if (err && !failure) failure = err
        resolve()
      })
    })
    if (failure) throw failure
  }

  close(): void {
    if (this.closing) return
    this.closing = true
    this.resetPacing()
    const port = this.port
    this.port = undefined
    if (!port) return
    try {
      port.close(() => {})
    } catch {
      /* 端口已失效时忽略 */
    }
  }

  /**
   * 按配置的节奏把队列里的内容落到端口。
   *
   * 每次只发一个字符就返回（除非间隔是 0，那就继续循环），让出事件循环 ——
   * 一次性把几 KB 塞进 setTimeout 回调会让主进程在粘贴长命令时卡顿，
   * 而串口本身的速率远低于此，攒着发也没有任何收益。
   */
  private pump(): void {
    if (this.pumpTimer) return
    const port = this.port
    if (!port || this.closing || !port.isOpen) {
      this.queue.length = 0
      return
    }

    while (this.queue.length > 0) {
      const head = this.queue[0]

      if (head.kind === 'bytes') {
        port.write(head.data)
        this.queue.shift()
        // 二进制块之后不需要字符间隔（协议帧已经整块交给驱动），
        // 但若用户在等下一段文本，字符间隔照样生效
        if (this.charDelayMs > 0 && this.waitThen(this.charDelayMs)) return
        continue
      }

      const at = this.cursor
      const { head: ch, size } = nextUnit(head.data, at)
      port.write(ch)
      this.cursor += size
      if (this.cursor >= head.data.length) {
        this.queue.shift()
        this.cursor = 0
      }

      /*
       * 换行处用行间延迟，其余字符用字符间隔；两个都配了时取较大的那个。
       *
       * 为什么取 max 而不是相加："每字符 5ms + 换行后 200ms" 的意图是
       * 「这一行发完后停 200ms 等设备回 OK」，不是 205ms。相加会让用户
       * 按 200 试出来的值在加了字符间隔之后莫名其妙变慢。
       */
      const delay = isLineBreakAt(head.data, at)
        ? Math.max(this.lineDelayMs, this.charDelayMs)
        : this.charDelayMs
      if (delay > 0 && this.waitThen(delay)) return
    }
  }

  /**
   * 排一次定时器后继续 pump。
   *
   * 返回 true 表示真的排上了 —— 调用方必须立刻返回，把控制权交回事件循环；
   * 队列已空时返回 false，调用方可以接着跑完 while（不会留下空转的定时器）。
   */
  private waitThen(ms: number): boolean {
    if (this.queue.length === 0) return false
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined
      this.pump()
    }, ms)
    return true
  }

  /** 清掉待发送内容：端口没了，留着队列只会让下次 pump 撞到已失效的 port */
  private resetPacing(): void {
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer)
      this.pumpTimer = undefined
    }
    this.queue.length = 0
    this.cursor = 0
  }

  /**
   * 拉一次 DTR 复位设备。
   *
   * 时序参照 esptool 的经典自动复位：DTR 拉低 → 短暂保持 → 释放。
   * 只做 DTR，不碰 RTS —— RTS 常接 BOOT 引脚，同时拉会进下载模式而不是复位。
   */
  private async pulseDtr(): Promise<void> {
    const port = this.port
    if (!port) return
    try {
      await new Promise<void>((resolve) => port.set({ dtr: false }, () => resolve()))
      await new Promise((r) => setTimeout(r, 100))
      await new Promise<void>((resolve) => port.set({ dtr: true }, () => resolve()))
      await new Promise((r) => setTimeout(r, 50))
    } catch {
      // 个别 USB 转串口芯片不支持 set：不影响收发，静默跳过
    }
  }

  private handleClosed(err?: Error): void {
    if (this.closing) return
    this.closing = true
    this.resetPacing()
    this.port = undefined
    // 拔线在 Windows 上表现为 error（EIO / "设备未就绪"），正常关闭则无 error。
    // 上层据此区分「设备掉了」与「对端关掉了」。
    this.events.onClose(err instanceof Error ? err : undefined)
  }
}
