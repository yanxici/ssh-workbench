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

  constructor(options: SerialTransportOptions, events: TransportEvents) {
    this.config = options.config
    this.events = events
    this.portFactory = options.portFactory
    this.decode = makeDecoder(options.config.charset)
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

    port.on('data', (chunk: Buffer) => {
      if (this.closing) return
      this.events.onData(chunk, this.decode(chunk))
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
    this.port.write(payload)
  }

  writeBytes(data: Buffer): void {
    if (!this.port || this.closing || !this.port.isOpen) return
    this.port.write(data)
  }

  /** 串口没有终端尺寸：显式空实现，避免调用方以为它生效了 */
  resize(_cols: number, _rows: number): void {
    /* no-op */
  }

  close(): void {
    if (this.closing) return
    this.closing = true
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
    this.port = undefined
    // 拔线在 Windows 上表现为 error（EIO / "设备未就绪"），正常关闭则无 error。
    // 上层据此区分「设备掉了」与「对端关掉了」。
    this.events.onClose(err instanceof Error ? err : undefined)
  }
}
