/** 通用小工具 */

export function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ')
}

/** 生成客户端 id（会话 id 等），优先 UUID */
export function uid(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  }
}

/** 相对时间展示：刚刚 / N 分钟前 / N 小时前 / N 天前 / yyyy-MM-dd */
export function formatRelativeTime(ts?: number): string {
  if (!ts) return '从未使用'
  const diff = Date.now() - ts
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function formatMode(mode: number): string {
  const perm = (m: number): string =>
    `${m & 4 ? 'r' : '-'}${m & 2 ? 'w' : '-'}${m & 1 ? 'x' : '-'}`
  const type = mode & 0o40000 ? 'd' : mode & 0o120000 ? 'l' : '-'
  return type + perm((mode >> 6) & 7) + perm((mode >> 3) & 7) + perm(mode & 7)
}

/** 延迟的着色等级 */
export function latencyLevel(ms?: number): 'none' | 'good' | 'fair' | 'bad' {
  if (ms === undefined) return 'none'
  if (ms < 80) return 'good'
  if (ms < 250) return 'fair'
  return 'bad'
}

/* ------------------------------------------------------------------ *
 *  文件管理辅助
 * ------------------------------------------------------------------ */

/** 远端 POSIX 路径拼接 */
export function remoteJoin(dir: string, name: string): string {
  if (dir === '/') return `/${name}`
  return `${dir.replace(/\/+$/, '')}/${name}`
}

/** 远端 POSIX 路径的父目录 */
export function remoteDirname(path: string): string {
  const idx = path.lastIndexOf('/')
  if (idx <= 0) return '/'
  return path.slice(0, idx)
}

/** 本地路径父目录（兼容 Windows 反斜杠） */
export function localDirname(path: string): string {
  const idx = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  if (idx <= 0) return path
  return path.slice(0, idx)
}

/** 本地路径拼接（保持原分隔符风格） */
export function localJoin(dir: string, name: string): string {
  const sep = dir.includes('\\') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  if (size < 1024 ** 3) return `${(size / 1024 / 1024).toFixed(1)} MB`
  return `${(size / 1024 ** 3).toFixed(2)} GB`
}

export function formatTime(ts: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
