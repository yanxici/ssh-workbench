/** 通用小工具 */

import { tNow } from '../i18n/core'

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
  if (!ts) return tNow('common.time.never')
  const diff = Date.now() - ts
  if (diff < 60_000) return tNow('common.time.justNow')
  if (diff < 3_600_000) return tNow('common.time.minutesAgo', { n: Math.floor(diff / 60_000) })
  if (diff < 86_400_000) return tNow('common.time.hoursAgo', { n: Math.floor(diff / 3_600_000) })
  if (diff < 30 * 86_400_000) return tNow('common.time.daysAgo', { n: Math.floor(diff / 86_400_000) })
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function formatMode(mode: number): string {
  const perm = (m: number): string =>
    `${m & 4 ? 'r' : '-'}${m & 2 ? 'w' : '-'}${m & 1 ? 'x' : '-'}`
  // 必须先整体取出类型位再比较：直接 `mode & 0o120000` 对普通文件（0o100000）也为真，
  // 于是所有普通文件都会显示成软链接 'l'。
  const kind = mode & 0o170000
  const type = kind === 0o040000 ? 'd' : kind === 0o120000 ? 'l' : '-'
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

/**
 * 本地路径父目录（兼容 Windows 反斜杠）。
 *
 * 根目录必须是固定值：'C:\\Users' 的父级是 'C:\\' 而不是 'C:'
 * （'C:' 是盘符相对路径，主进程按绝对路径校验会直接拒绝），'/tmp' 的父级是 '/'。
 */
export function localDirname(path: string): string {
  // 先剥掉尾部的悬浮分隔符：'C:\\a\\b\\' 的父级是 'C:\\a' 而不是它自己，
  // '/tmp/' 的父级是 '/'。盘符根剥完会变成 'C:'（盘符相对路径），须补回分隔符。
  let p = path
  while (p.length > 1 && /[\\/]$/.test(p)) p = p.slice(0, -1)
  if (/^[a-zA-Z]:$/.test(p)) return p + '\\'
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (idx < 0) return p
  if (idx === 0) return '/'
  // 盘符根：'C:\\Users' → idx=2，前缀 'C:'
  if (idx === 2 && /^[a-zA-Z]:[\\/]/.test(p)) return p.slice(0, 3)
  return p.slice(0, idx)
}

/**
 * 严格解析八进制权限（'755' / '0755'）。
 *
 * parseInt('758', 8) 会静默截断成 0o75 —— 属主权限被整段剥掉还不报错。
 * 非八进制数字或超范围时返回 null，让调用方放弃提交。
 */
export function parseOctalMode(text: string): number | null {
  const s = text.trim().replace(/^0o?/i, '')
  if (!s || !/^[0-7]{1,4}$/.test(s)) return null
  const mode = Number.parseInt(s, 8)
  return Number.isFinite(mode) ? mode : null
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
