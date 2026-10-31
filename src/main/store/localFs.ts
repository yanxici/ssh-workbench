import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { LocalFile } from '@shared/types'
import { assertBrowsableDir, assertSafeLocalPath, assertSafeLocalPaths, assertSafeName } from './pathGuard'

/**
 * 本地文件系统操作（文件管理器左栏）。
 * 只处理用户主动指定的路径；删除等破坏性操作由渲染层负责二次确认。
 */

const CONCURRENCY = 32

export async function localList(dir: string): Promise<LocalFile[]> {
  /*
   * 浏览是只读的，危害比删除轻，但它能把任意目录的内容枚举回渲染层 ——
   * 配合别的通道可以做信息收集。用 assertBrowsableDir 而不是 assertSafeLocalPath：
   * 后者拒绝盘符根，而文件管理器必须能列 C:\ 。
   */
  const target = assertBrowsableDir(dir)
  const entries = await fs.readdir(target, { withFileTypes: true })
  const results: LocalFile[] = []

  // 分批 lstat，控制并发（大目录下避免 EMFILE）
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY)
    const stats = await Promise.all(
      batch.map(async (e) => {
        // 必须用校验清洗后的 target，不能用原始 dir：
        // dir 带前后空格时 readdir(target) 能读到条目，lstat(join(dir,...)) 全 ENOENT，
        // 结果是静默空目录；dir 带 \\?\ 前缀时返回的 path 会把前缀漏给渲染层。
        const full = join(target, e.name)
        try {
          const st = await fs.lstat(full)
          return {
            name: e.name,
            path: full,
            isDir: st.isDirectory(),
            size: st.size,
            mtime: st.mtimeMs
          } satisfies LocalFile
        } catch (err) {
          // ENOENT 是「目录静默变空」的唯一成因（路径清洗不一致导致条目全被跳过），必须留痕；
          // EPERM/EACCES 是列 C:\ 根时的常态（pagefile.sys 等），不刷屏。
          if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
            console.warn('[localFs] lstat ENOENT，条目被跳过:', full, err)
          }
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
  /*
   * 两道校验，缺一不可 —— 这是 Volt 实测发现的缺口：
   * `join(dir, name)` 会先把 `..` 折叠掉，例如
   * `join('/home/u', '../../etc/evil')` → `\etc\evil`，
   * 交给路径守卫时 `..` 已经从字符串里消失了，位置判断可能放行。
   * 所以名字的形状必须在 join 之前验；join 之后再过一次路径守卫兜位置。
   * 否则用户在「新建文件夹」输入框里填 `..\..\Windows\Temp\evil`，
   * 主进程就在系统目录下建目录。
   */
  const safeName = assertSafeName(name, '新建文件夹')
  const parent = assertBrowsableDir(dir)
  const target = assertSafeLocalPath(join(parent, safeName), '新建文件夹')
  await fs.mkdir(target)
}

export async function localDelete(paths: string[]): Promise<void> {
  /*
   * 先过守卫。这里不是保险，是必需品：
   * 渲染层一旦被污染，`local:delete` 就是任意路径的 rm -rf（recursive + force）。
   * 守卫拦「形状不对 + 危险位置」，正常操作照旧放行 —— 详见 pathGuard.ts 的说明。
   */
  const safe = assertSafeLocalPaths(paths, '删除')
  for (const p of safe) {
    await fs.rm(p, { recursive: true, force: true })
  }
}

export async function localRename(from: string, to: string): Promise<void> {
  // from 是用户选中的现有文件，to 是同目录下的新名字：两端都要校验，
  // 否则可以把一个文件「重命名」到 C:\Windows\System32 去覆盖系统文件。
  const safeFrom = assertSafeLocalPath(from, '重命名')
  const safeTo = assertSafeLocalPath(to, '重命名')
  await fs.rename(safeFrom, safeTo)
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
