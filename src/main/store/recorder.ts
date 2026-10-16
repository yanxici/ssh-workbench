import { app } from 'electron'
import { createWriteStream, promises as fs, type WriteStream } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import type { SessionLogFile } from '@shared/types'

/**
 * 会话日志录制器 —— 把终端输入/输出带时间戳落盘。
 *
 * 文件格式：与 asciinema cast v2 兼容的 JSON Lines：
 *   首行：{"version":2,"width":120,"height":32,"timestamp":...,"title":"A区"}
 *   数据行：[elapsed秒, "o"|"i", "内容"]
 * 兼容带来的好处：可用 asciinema 生态工具（asciinema play / agg 转 GIF）直接打开，
 * 也便于我们自己实现回放。
 *
 * 约束：
 * - 单会话日志上限 50MB（超限停止记录并落一条提示，防止异常输出打满磁盘）；
 * - 输入按 200ms 聚合（键盘逐键事件过碎）；
 * - 读取/删除带目录白名单校验，防止路径逃逸。
 */

const MAX_SESSION_LOG_BYTES = 50 * 1024 * 1024
const INPUT_FLUSH_MS = 200

interface Recording {
  filePath: string
  stream: WriteStream
  startedAt: number
  bytes: number
  pendingInput: string[]
  inputTimer?: NodeJS.Timeout
  truncated: boolean
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

  /** 日志目录：userData/sessions/ */
  logDir(): string {
    return join(app.getPath('userData'), 'sessions')
  }

  async start(sessionId: string, title: string, cols: number, rows: number): Promise<void> {
    if (this.recordings.has(sessionId)) return
    await fs.mkdir(this.logDir(), { recursive: true })

    const filePath = join(this.logDir(), `${formatStamp(new Date())}-${sanitize(title)}.cast`)
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

    this.recordings.set(sessionId, {
      filePath,
      stream,
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
  }

  private writeLine(rec: Recording, type: 'o' | 'i', data: string): void {
    if (rec.truncated) return
    const elapsed = Number(((Date.now() - rec.startedAt) / 1000).toFixed(3))
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
      return
    }
    rec.stream.write(line)
  }

  /* ------------------------------ 日志管理 ------------------------------ */

  async list(): Promise<SessionLogFile[]> {
    await fs.mkdir(this.logDir(), { recursive: true })
    const names = await fs.readdir(this.logDir())
    const out: SessionLogFile[] = []
    for (const name of names) {
      if (!name.endsWith('.cast')) continue
      const full = join(this.logDir(), name)
      try {
        const st = await fs.stat(full)
        out.push({ path: full, name, size: st.size, mtime: st.mtimeMs })
      } catch {
        /* 跳过读取失败的文件 */
      }
    }
    return out.sort((a, b) => b.mtime - a.mtime)
  }

  async read(filePath: string): Promise<string> {
    return fs.readFile(this.assertInside(filePath), 'utf-8')
  }

  async remove(filePath: string): Promise<void> {
    await fs.rm(this.assertInside(filePath), { force: true })
  }

  /** 校验目标文件必须位于日志目录内（防路径逃逸） */
  private assertInside(filePath: string): string {
    const dir = resolve(this.logDir())
    const target = resolve(filePath)
    if (target !== dir && !target.startsWith(dir + sep)) {
      throw new Error('非法日志路径')
    }
    if (basename(target).startsWith('.')) throw new Error('非法日志路径')
    return target
  }
}

export const recorder = new Recorder()
