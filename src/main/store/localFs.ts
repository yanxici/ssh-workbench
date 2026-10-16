import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { LocalFile } from '@shared/types'

/**
 * 本地文件系统操作（文件管理器左栏）。
 * 只处理用户主动指定的路径；删除等破坏性操作由渲染层负责二次确认。
 */

const CONCURRENCY = 32

export async function localList(dir: string): Promise<LocalFile[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  const results: LocalFile[] = []

  // 分批 lstat，控制并发（大目录下避免 EMFILE）
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY)
    const stats = await Promise.all(
      batch.map(async (e) => {
        const full = join(dir, e.name)
        try {
          const st = await fs.lstat(full)
          return {
            name: e.name,
            path: full,
            isDir: st.isDirectory(),
            size: st.size,
            mtime: st.mtimeMs
          } satisfies LocalFile
        } catch {
          return null
        }
      })
    )
    for (const s of stats) if (s) results.push(s)
  }

  results.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
  return results
}

export async function localMkdir(dir: string, name: string): Promise<void> {
  await fs.mkdir(join(dir, name))
}

export async function localDelete(paths: string[]): Promise<void> {
  for (const p of paths) {
    await fs.rm(p, { recursive: true, force: true })
  }
}

export async function localRename(from: string, to: string): Promise<void> {
  await fs.rename(from, to)
}

/** Windows 下枚举存在的盘符；其他平台返回根 */
export async function listDrives(): Promise<string[]> {
  if (process.platform !== 'win32') return ['/']
  const drives: string[] = []
  for (let c = 67 /* C */; c <= 90 /* Z */; c += 1) {
    const root = `${String.fromCharCode(c)}:\\`
    try {
      await fs.access(root)
      drives.push(root)
    } catch {
      /* 盘符不存在 */
    }
  }
  return drives
}
