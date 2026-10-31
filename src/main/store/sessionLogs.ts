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

/** 列出全部录制文件，按修改时间倒序 */
export async function listSessionLogs(): Promise<SessionLogFile[]> {
  const dir = sessionLogDir()
  await fs.mkdir(dir, { recursive: true })
  const names = await fs.readdir(dir)
  const out: SessionLogFile[] = []
  for (const name of names) {
    if (!name.endsWith('.cast')) continue
    const full = join(dir, name)
    try {
      const st = await fs.stat(full)
      out.push({ path: full, name, size: st.size, mtime: st.mtimeMs })
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

/** 删除一个录制文件（只允许日志目录内的路径） */
export async function removeSessionLog(filePath: string): Promise<void> {
  await fs.rm(assertInside(filePath), { force: true })
}
