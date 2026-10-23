/**
 * 上传目标目录解析。
 *
 * 历史问题：各上传入口在没有「当前目录」时直接退化成 '/'（远端根目录），
 * 而且没有任何界面能让用户改目标目录 —— 系统文件对话框只能选本地文件，
 * 远端目录是调用方硬编码塞进去的，用户完全无法选择。
 *
 * 这里把「默认目录」收敛成一条明确的优先级链，并且**不再**用 '/' 兜底：
 *   1) 调用方显式指定的目录（上下文里确实有意义的那个，比如右键的那一行）
 *   2) 本会话上次上传用过的目录（同一个会话里连续上传通常是一个地方）
 *   3) 远端 home（sftp realpath '.'）
 *   4) 都没有 → 返回 ''，由 UI 让用户自己填/选，绝不静默落到根目录
 */
import { call } from '@/lib/ipc'

/** 会话级「上次上传目录」记忆（进程内，不落盘） */
const lastDirBySession = new Map<string, string>()

/**
 * 归一化远端 POSIX 目录：
 * - 去首尾空白、折叠重复斜杠、去掉尾部斜杠（根目录 '/ ' → '/'）
 * - 空串 / 只有空白 → ''（表示「不知道」，绝不当作根目录）
 */
export function normalizeRemoteDir(dir: string | null | undefined): string {
  const raw = (dir ?? '').trim()
  if (!raw) return ''
  const collapsed = raw.replace(/\/{2,}/g, '/')
  if (collapsed === '/') return '/'
  return collapsed.replace(/\/+$/, '') || '/'
}

export function rememberUploadDir(sessionId: string, dir: string): void {
  const normalized = normalizeRemoteDir(dir)
  if (normalized) lastDirBySession.set(sessionId, normalized)
}

export function lastUploadDir(sessionId: string): string {
  return lastDirBySession.get(sessionId) ?? ''
}

export function forgetUploadDir(sessionId: string): void {
  lastDirBySession.delete(sessionId)
}

/**
 * 解析默认上传目录。返回 '' 表示「真的没有可用的默认值」，
 * 调用方必须让用户自己选择，而不是替用户决定传到根目录。
 */
export async function resolveUploadDir(
  sessionId: string,
  preferred?: string | null
): Promise<string> {
  const explicit = normalizeRemoteDir(preferred)
  if (explicit) return explicit

  const remembered = lastUploadDir(sessionId)
  if (remembered) return remembered

  const home = await call(window.api.sftp.home(sessionId), { silent: true })
  return normalizeRemoteDir(home)
}
