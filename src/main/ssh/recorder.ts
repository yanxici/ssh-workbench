import { createWriteStream, promises as fs, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { sessionLogDir } from '../store/sessionLogs'

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
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'session'
}

class Recorder {
  private recordings = new Map<string, Recording>()

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
    await fs.mkdir(this.logDir(), { recursive: true })

    const stamp = formatStamp(new Date())
    const base = `${stamp}-${sanitize(title)}`
    const filePath = join(this.logDir(), `${base}.cast`)
    const stream = createWriteStream(filePath, { flags: 'a', encoding: 'utf-8' })
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
      ? createWriteStream(join(this.logDir(), `${base}.log`), { flags: 'a', encoding: 'utf-8' })
      : undefined

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
    const rec = this.recordings.get(sessionId)
    if (!rec) return
    this.recordings.delete(sessionId)
    if (rec.inputTimer) clearTimeout(rec.inputTimer)
    if (rec.pendingInput.length > 0 && !rec.truncated) {
      this.writeLine(rec, 'i', rec.pendingInput.join(''))
    }
    rec.stream.end()
    rec.textStream?.end()
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
            '\r\n[SSH Workbench] 日志已超过 50 MB 上限，停止记录\r\n'
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
      stream.write('\n[SSH Workbench] 文本日志已超过 50 MB 上限，停止记录\n')
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
