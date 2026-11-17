import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import type { SessionLogFile } from '@shared/types'

/**
 * 会话日志的**本地存取**（纯文件操作，属 store 域）。
 *
 * 与 ssh/recorder.ts 的分工：
 *   - ssh/recorder.ts 负责「跟着会话写」：start/stop、输出输入落盘、50MB 上限；
 *   - 本文件负责「读回来/列出来/删掉」：list/read/remove + 路径白名单校验。
 * 拆开的理由与 backups 同源：store 是被依赖的最底层，不该反向依赖 ssh 业务层。
 * 日志管理只需要知道目录和文件，不需要知道有没有 SSH 会话。
 */

/** 日志目录：userData/sessions/（录制器与日志管理共用同一约定） */
export function sessionLogDir(): string {
  return join(app.getPath('userData'), 'sessions')
}

/** 校验目标文件必须位于日志目录内（防路径逃逸） */
function assertInside(filePath: string): string {
  const dir = resolve(sessionLogDir())
  const target = resolve(filePath)
  if (target !== dir && !target.startsWith(dir + sep)) {
    throw new Error('非法日志路径')
  }
  if (basename(target).startsWith('.')) throw new Error('非法日志路径')
  return target
}

/**
 * 列出全部会话日志（.cast 与纯文本 .log 都在内），按修改时间倒序。
 *
 * 两种格式都列：一次会话会落两个同名不同后缀的文件，只列 .cast 会让
 * 「我要那份纯文本」变成一件需要去文件夹里翻的事 —— 而录文本的初衷
 * 恰恰是让人不必翻文件夹。
 */
export async function listSessionLogs(): Promise<SessionLogFile[]> {
  const dir = sessionLogDir()
  await fs.mkdir(dir, { recursive: true })
  const names = await fs.readdir(dir)
  const out: SessionLogFile[] = []
  for (const name of names) {
    const format = name.endsWith('.cast') ? 'cast' : name.endsWith('.log') ? 'log' : null
    if (!format) continue
    const full = join(dir, name)
    try {
      const st = await fs.stat(full)
      out.push({ path: full, name, size: st.size, mtime: st.mtimeMs, format })
    } catch {
      /* 跳过读取失败的文件 */
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}

/** 读取一个录制文件（只允许日志目录内的路径） */
export async function readSessionLog(filePath: string): Promise<string> {
  return fs.readFile(assertInside(filePath), 'utf-8')
}

/**
 * 删除一个日志文件（只允许日志目录内的路径）。
 *
 * 连同它的「另一份」一起删：一次会话的 .cast 与 .log 是同一次录制的两种形态，
 * 留着半份要么白占地方、要么在列表里变成一个没有回放来源的孤儿。
 * 用户删的是「那次会话的记录」，不是「那个后缀」。
 */
export async function removeSessionLog(filePath: string): Promise<void> {
  const target = assertInside(filePath)
  await fs.rm(target, { force: true })
  const twin = target.endsWith('.cast')
    ? target.slice(0, -'.cast'.length) + '.log'
    : target.endsWith('.log')
      ? target.slice(0, -'.log'.length) + '.cast'
      : null
  if (twin) await fs.rm(twin, { force: true }).catch(() => {})
}
