import { createWriteStream, existsSync, promises as fs, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { sessionLogDir } from '../store/sessionLogs'
import { recordError } from '../store/errorLog'

/**
 * 会话日志录制器 —— 把终端输入/输出带时间戳落盘。
 *
 * 文件格式：与 asciinema cast v2 兼容的 JSON Lines：
 *   首行：{"version":2,"width":120,"height":32,"timestamp":...,"title":"A区"}
 *   数据行：[elapsed秒, "o"|"i", "内容"]
 * 兼容带来的好处：可用 asciinema 生态工具（asciinema play / agg 转 GIF）直接打开，
 * 也便于我们自己实现回放。
 *
 * 除了 .cast，还会同时写一份同名 .log 的纯文本日志（可关）。
 * 为什么要两份：.cast 是给回放器用的（数组 + 转义，人读不了），
 * 而现场排错最常见的诉求是「把这半小时的输出贴给同事 / 丢进 grep」——
 * 从 JSON Lines 里再解一遍字符串属于自找麻烦。
 *
 * 约束：
 * - 单会话日志上限 50MB（两种格式各自计数，超限停止记录并落一条提示）；
 * - 输入按 200ms 聚合（键盘逐键事件过碎）；
 * - 读取/删除带目录白名单校验，防止路径逃逸。
 */

const MAX_SESSION_LOG_BYTES = 50 * 1024 * 1024
const INPUT_FLUSH_MS = 200

/** 建日志时的开关，来自设置项（调用方传入，Recorder 不自己去读设置） */
export interface RecorderOptions {
  /** 同时写一份纯文本日志，默认开 */
  plainText?: boolean
  /** 纯文本日志每行带 HH:MM:SS.mmm 时间戳，默认开 */
  timestamp?: boolean
}

interface Recording {
  filePath: string
  stream: WriteStream
  /** 纯文本日志（关闭时为 undefined） */
  textStream?: WriteStream
  textBytes: number
  textTruncated: boolean
  /** 纯文本日志是否带时间戳 */
  withTimestamp: boolean
  /** 下一段输出是否落在行首 —— 决定要不要补时间戳前缀 */
  atLineStart: boolean
  startedAt: number
  bytes: number
  pendingInput: string[]
  inputTimer?: NodeJS.Timeout
  truncated: boolean
}

/** ESC 与 BEL 的码点写成常量，避免正则里堆 \u001b 造成的双层转义 */
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)

/**
 * 去掉 ANSI 转义序列。
 *
 * 纯文本日志里留着 [32m 这类东西时，grep 出来的每一行都带着控制码尾巴，
 * 贴进工单也不像话。手写扫描而不是一条大正则：正则版本里 OSC / CSI 的
 * 转义层数一多就没人敢改，而这里每个分支都在讲一件具体的事。
 */
function stripAnsi(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    if (text[i] !== ESC) {
      out += text[i]
      i += 1
      continue
    }
    const next = text[i + 1]
    if (next === '[') {
      // CSI：ESC [ 参数 中间字节 终止符（终止符落在 0x40..0x7e）
      let j = i + 2
      while (j < text.length) {
        const code = text.charCodeAt(j)
        if (code >= 0x40 && code <= 0x7e) break
        j += 1
      }
      i = j + 1
      continue
    }
    if (next === ']') {
      // OSC：ESC ] … 以 BEL 或 ESC \\ 收尾（改标题、设置超链接走这条）
      let j = i + 2
      while (j < text.length) {
        if (text[j] === BEL) break
        if (text[j] === ESC && text[j + 1] === '\\') break
        j += 1
      }
      i = text[j] === BEL ? j + 1 : j + 2
      continue
    }
    // 其余双字节转义（如 ESC M 反向索引）直接跳过
    i += 2
  }
  return out.split(BEL).join('')
}

function formatStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function sanitize(name: string): string {
  // '#' 也替换：它是同秒重名后缀的分隔符，留在文件名里会让 bundle 的
  // 「名#N」判据和用户自己的 '#' 撞车
  return name.replace(/[\\/:*?"<>|#]/g, '_').trim() || 'session'
}

/**
 * 同一秒内开两个同名会话时，后一个不能直接 append 到前一个的 .cast 上。
 *
 * 录音文件用 `时间戳-标题` 命名，时间戳精度到秒。追加模式（flags: 'a'）撞名时
 * 两份会话的数据会写进同一个文件、各带一套相对时间 —— 回放出来是两台机器的
 * 输出交错，两份记录同时作废。这里退到 `-2`、`-3`。
 */
/*
 * 进程内已占用的文件名前缀。
 *
 * 光判 existsSync 不够：createWriteStream 是**异步**打开的，实测同一 tick 里
 * 连续调两次 start 时，第二次的 existsSync 仍然返回 false，两个流于是写到
 * 同一个 .cast 上交替追加，两份录屏一起作废。这里在进程内先占位。
 * 跨进程的碰撞由 existsSync 兜底（同一 userData 只有一个主进程）。
 */
const reservedBases = new Set<string>()

function reserveBase(dir: string, base: string): string {
  for (let i = 1; i < 100; i += 1) {
    // 后缀用 '#' 而不是 '-'：'web-1' 这种自带数字尾巴的连接名，用 '-' 分不开
    // 是重名后缀还是名字本身（bundle 侧的归属判定就栽在这上面）
    const candidate = i === 1 ? base : `${base}#${i}`
    if (reservedBases.has(join(dir, candidate))) continue
    const cast = join(dir, `${candidate}.cast`)
    if (!existsSync(cast) && !existsSync(join(dir, `${candidate}.log`))) {
      reservedBases.add(join(dir, candidate))
      return candidate
    }
  }
  const fallback = `${base}#${Date.now()}`
  reservedBases.add(join(dir, fallback))
  return fallback
}

class Recorder {
  private recordings = new Map<string, Recording>()
  /**
   * 每次 start 自增的代（R-H24）。
   *
   * start 里要先 await fs.mkdir。这期间 stop() 或第二次 start() 完全可能已经
   * 跑完，回来的第一次 start 却照样创建并登记两条 WriteStream ——
   * 后登记的覆盖先登记的，被覆盖的那对句柄再也没人关。
   */
  private startGen = new Map<string, number>()

  /** 日志目录：userData/sessions/（与日志管理的读取逻辑共用同一约定） */
  logDir(): string {
    return sessionLogDir()
  }

  async start(
    sessionId: string,
    title: string,
    cols: number,
    rows: number,
    options: RecorderOptions = {}
  ): Promise<void> {
    if (this.recordings.has(sessionId)) return
    const gen = (this.startGen.get(sessionId) ?? 0) + 1
    this.startGen.set(sessionId, gen)
    const dir = this.logDir()
    await fs.mkdir(dir, { recursive: true })
    // await 期间被 stop 或新的 start 抢跑：这次作废，别登记无人看管的流
    if (this.startGen.get(sessionId) !== gen || this.recordings.has(sessionId)) return

    const stamp = formatStamp(new Date())
    const base = reserveBase(dir, `${stamp}-${sanitize(title)}`)
    const baseKey = join(dir, base)
    const filePath = join(dir, `${base}.cast`)
    const stream = createWriteStream(filePath, { flags: 'a', encoding: 'utf-8' })
    /*
     * 必须挂 error：磁盘满、目录被删、权限被改时 WriteStream 会 emit('error')，
     * 没有监听就是进程级 uncaughtException（主进程弹崩溃框）。而且这条 stream
     * 之后每次 write 都会继续抛 —— 只能摘掉整条录制。
     */
    // 必须核对 stream 身份：重连复用同一 sessionId 时，旧流关闭期迟到的
    // 'error' 若无条件 drop(sessionId) 会把刚开的新录屏毁掉（R-H24）
    stream.on('error', (err: Error) => this.drop(sessionId, err, stream))
    /*
     * 占位名必须等流真正 close 才释放。
     * 旧实现（连同 stop/drop 里的 `filePath.replace(/.cast$/,''))` 有三重问题：
     * 正则里的 . 没转义，且 stop() 一调用就同步释放 —— 此时 createWriteStream
     * 还没 flush 完、文件甚至还没被 O_EXCL 建出来，紧接着同秒新开的同名会话
     * 会抢到同一个文件名，两份录屏写进同一个 .cast。close 是唯一可靠时点。
     */
    stream.once('close', () => reservedBases.delete(baseKey))
    stream.write(
      `${JSON.stringify({
        version: 2,
        width: cols,
        height: rows,
        timestamp: Math.floor(Date.now() / 1000),
        title
      })}\n`
    )

    /*
     * 纯文本日志与 .cast 同名不同后缀，时间戳前缀相同 —— 在日志面板里
     * 两者会挨着排，用户一眼能看出「这是同一次会话的两种形态」。
     * 默认开：这个功能的成本（一次额外 write）远小于它的收益
     * （现场要把输出贴给别人时不用现找转换工具）。
     */
    const plainText = options.plainText !== false
    const textStream = plainText
      ? createWriteStream(join(dir, `${base}.log`), { flags: 'a', encoding: 'utf-8' })
      : undefined
    textStream?.on('error', (err: Error) => {
      // 文本日志挂掉不该连累 .cast：只关掉这条通道，回放文件继续录
      void recordError({
        level: 'warn',
        source: 'recorder',
        title: '纯文本日志写入失败',
        detail: err.message
      })
      const rec = this.recordings.get(sessionId)
      // 同上：只处理属于这条文本流的记录
      if (rec && rec.textStream === textStream) {
        rec.textTruncated = true
        rec.textStream = undefined
      }
      try {
        textStream.destroy()
      } catch {
        /* ignore */
      }
    })

    this.recordings.set(sessionId, {
      filePath,
      stream,
      textStream,
      textBytes: 0,
      textTruncated: false,
      withTimestamp: options.timestamp !== false,
      atLineStart: true,
      startedAt: Date.now(),
      bytes: 0,
      pendingInput: [],
      truncated: false
    })
  }

  /** 终端输出（主进程合帧后的数据） */
  appendOutput(sessionId: string, data: string): void {
    const rec = this.recordings.get(sessionId)
    if (!rec || !data) return
    this.writeLine(rec, 'o', data)
  }

  /** 终端输入（键盘 / 常用命令发送），200ms 聚合 */
  appendInput(sessionId: string, data: string): void {
    const rec = this.recordings.get(sessionId)
    if (!rec || !data) return
    rec.pendingInput.push(data)
    if (rec.inputTimer) return
    rec.inputTimer = setTimeout(() => {
      rec.inputTimer = undefined
      const text = rec.pendingInput.join('')
      rec.pendingInput = []
      if (text) this.writeLine(rec, 'i', text)
    }, INPUT_FLUSH_MS)
  }

  stop(sessionId: string): void {
    // 作废在途的 start（它可能正卡在 fs.mkdir 上）
    this.startGen.set(sessionId, (this.startGen.get(sessionId) ?? 0) + 1)
    const rec = this.recordings.get(sessionId)
    if (!rec) return
    this.recordings.delete(sessionId)
    // 占位名由流自己的 'close' 释放（见 start），这里不再提前删
    if (rec.inputTimer) clearTimeout(rec.inputTimer)
    if (rec.pendingInput.length > 0 && !rec.truncated) {
      this.writeLine(rec, 'i', rec.pendingInput.join(''))
    }
    rec.stream.end()
    rec.textStream?.end()
  }

  /**
   * 退出前收尾：停掉所有录制并等到写盘流真正 flush 完成。
   *
   * stop() 只是 end()，数据还在用户态缓冲里；主进程紧接着退出，最后几秒
   * 的终端输出就丢了。这里等 'finish'（或 'close'/'error'）再返回。
   */
  async stopAllAndFlush(): Promise<void> {
    const ids = [...this.recordings.keys()]
    const pending: Promise<void>[] = []
    for (const id of ids) {
      const rec = this.recordings.get(id)
      if (!rec) continue
      const wait = (
        s?: { once: (ev: string, fn: () => void) => void; writableFinished: boolean; destroyed: boolean }
      ): Promise<void> => {
        if (!s) return Promise.resolve()
        return new Promise<void>((resolve) => {
          let done = false
          const fin = (): void => {
            if (done) return
            done = true
            resolve()
          }
          s.once('finish', fin)
          s.once('close', fin)
          s.once('error', fin)
          /*
           * 已经 end 过（或已被 destroy）的流不会再发 finish，兜底直接返回。
           * writableEnded 只是「调用过 end()」，数据可能还没落盘；用
           * writableFinished（已真正 flush 完）加 destroyed 才是终态判据。
           */
          if (s.writableFinished || s.destroyed) fin()
        })
      }
      const streams = [wait(rec.stream), wait(rec.textStream)]
      this.stop(id)
      pending.push(...streams)
    }
    await Promise.all(pending)
  }

  /** 流写坏了：摘掉这条录制并销毁两条 stream，别让后续 write 继续炸 */
  private drop(sessionId: string, err: Error, stream?: unknown): void {
    const rec = this.recordings.get(sessionId)
    if (!rec) return
    // 迟到的旧流报错：记录已经被新的 start 换掉了，别毁掉新录屏
    if (stream !== undefined && rec.stream !== stream) return
    this.recordings.delete(sessionId)
    // 同上：占位名等 'close' 释放；drop 会 destroy 两条流，close 必然到来
    if (rec.inputTimer) clearTimeout(rec.inputTimer)
    void recordError({
      level: 'warn',
      source: 'recorder',
      title: '会话日志写入失败，已停止录制',
      detail: err.message
    })
    for (const s of [rec.stream, rec.textStream]) {
      try {
        s?.destroy()
      } catch {
        /* ignore */
      }
    }
  }
  private writeLine(rec: Recording, type: 'o' | 'i', data: string): void {
    const elapsed = Number(((Date.now() - rec.startedAt) / 1000).toFixed(3))
    if (!rec.truncated) {
      const line = `${JSON.stringify([elapsed, type, data])}\n`
      rec.bytes += Buffer.byteLength(line, 'utf-8')
      if (rec.bytes > MAX_SESSION_LOG_BYTES) {
        rec.truncated = true
        rec.stream.write(
          `${JSON.stringify([
            elapsed,
            'o',
            '\r\n[Portix] 日志已超过 50 MB 上限，停止记录\r\n'
          ])}\n`
        )
      } else {
        rec.stream.write(line)
      }
    }
    // 纯文本是并行的第二条通道：.cast 截断不影响它继续记（两份各自计数）
    this.writeText(rec, type, data)
  }

  /**
   * 往纯文本日志追加一段。
   *
   * 不按「一行一条记录」写，而是按输出流原样追加 —— 远端程序用 \r 原地刷新的
   * 进度条、多行一次性喷出来的启动日志，都只有保持原顺序、原换行才有意义。
   * 时间戳加在真正的行首（atLineStart），而不是每个数据块的前面：
   * 否则一行会攒出十几个时间戳，读起来比没有还糟。
   */
  private writeText(rec: Recording, type: 'o' | 'i', data: string): void {
    const stream = rec.textStream
    if (!stream || rec.textTruncated || !data) return
    // 统一换行：Windows 记事本看见孤立的 \r 会当成换行，其余编辑器当成怪字符
    const text = stripAnsi(data).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    if (!text) return
    const segments = text.split('\n')
    let out = ''
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i]
      const last = i === segments.length - 1
      if (seg !== '') {
        if (rec.atLineStart) {
          if (rec.withTimestamp) out += `[${clock()}] `
          // 输入单独标出来：事后看日志时「这是谁打的」比「这是什么时候的」更常问
          if (type === 'i') out += '> '
        }
        out += seg
        rec.atLineStart = false
      }
      if (!last) {
        out += '\n'
        rec.atLineStart = true
      }
    }
    if (out === '') return
    rec.textBytes += Buffer.byteLength(out, 'utf-8')
    if (rec.textBytes > MAX_SESSION_LOG_BYTES) {
      rec.textTruncated = true
      stream.write('\n[Portix] 文本日志已超过 50 MB 上限，停止记录\n')
      return
    }
    stream.write(out)
  }
}

/**
 * 纯文本日志的行首时间戳：HH:MM:SS.mmm。
 *
 * 用墙上时间而不是「会话开始后第几秒」：现场排错时人要拿它跟
 * 设备日志、同事的消息、抓包时间对表。相对秒数对不上任何别的东西。
 */
function clock(): string {
  const d = new Date()
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  const ms = String(d.getMilliseconds()).padStart(3, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${ms}`
}

export const recorder = new Recorder()
