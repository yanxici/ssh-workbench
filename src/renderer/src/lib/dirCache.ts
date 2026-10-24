/**
 * 远端目录缓存（方案 A）。
 *
 * 问题：SessionFileTree 的 useEffect 依赖 [sessionId, path, version]，
 * 折叠再展开、切走再切回来都会重新发一次 sftp.list。慢链路上每次几百毫秒，
 * 用户感知就是「点开要等一会」。
 *
 * 策略：stale-while-revalidate
 *   1. 命中新鲜缓存 → 立刻返回，不发请求；
 *   2. 命中过期缓存 → 先立刻返回旧数据（界面不空），同时后台重拉，
 *      拉到后替换并通知订阅者；
 *   3. 无缓存 → 正常请求。
 *
 * 为什么是模块级单例而不是 store：
 * 缓存是「网络结果的副本」，不是 UI 状态；放进 zustand 会让每次
 * 写缓存都触发订阅者重渲染，反而更慢。
 *
 * 失效时机：TTL 到期、显式 refresh()、会话关闭、任何写操作（上传/删除/改名/新建）。
 */

import type { RemoteFile } from '@shared/types'

export interface CachedDir {
  files: RemoteFile[]
  /** 写入时间戳（ms） */
  at: number
}

/** 新鲜期：这段时间内重复展开不重新请求 */
const FRESH_MS = 5000

/** key = sessionId + '\u0000' + path */
const cache = new Map<string, CachedDir>()

/** 在途请求去重：同一目录并发展开只发一次 */
const inflight = new Map<string, Promise<RemoteFile[] | null>>()

function keyOf(sessionId: string, path: string): string {
  return sessionId + '\u0000' + path
}

export interface DirLookup {
  /** 是否有可直接用的缓存（新鲜或过期都算） */
  cached: CachedDir | null
  /** 缓存是否还在新鲜期内；true 表示不需要后台重拉 */
  fresh: boolean
}

export function peekDir(sessionId: string, path: string): DirLookup {
  const hit = cache.get(keyOf(sessionId, path))
  if (!hit) return { cached: null, fresh: false }
  return { cached: hit, fresh: Date.now() - hit.at < FRESH_MS }
}

export function writeDir(sessionId: string, path: string, files: RemoteFile[]): void {
  cache.set(keyOf(sessionId, path), { files, at: Date.now() })
}

/**
 * 失效一个目录，或（传 sessionId 且不传 path）整个会话。
 * 写操作后必须调用，否则用户看到的是改动前的旧列表。
 */
export function invalidateDir(sessionId: string, path?: string): void {
  if (path === undefined) {
    const prefix = sessionId + '\u0000'
    for (const k of [...cache.keys()]) {
      if (k.startsWith(prefix)) cache.delete(k)
      }
    for (const k of [...inflight.keys()]) {
      if (k.startsWith(prefix)) inflight.delete(k)
    }
    return
  }
  cache.delete(keyOf(sessionId, path))
}

/** 清空全部（会话关闭 / 断开时用） */
export function clearDirCache(): void {
  cache.clear()
  inflight.clear()
}

/**
 * 带缓存与请求去重的目录读取。
 *
 * @param fetcher 真正发请求的函数（通常是 window.api.sftp.list）
 * @param force   true = 忽略缓存直接重拉（刷新按钮、写操作之后）
 */
export async function loadDir(
  sessionId: string,
  path: string,
  fetcher: () => Promise<RemoteFile[] | null>,
  force = false
): Promise<RemoteFile[] | null> {
  const k = keyOf(sessionId, path)

  if (!force) {
    const { cached, fresh } = peekDir(sessionId, path)
    if (cached && fresh) return cached.files
  }

  // 同一目录已有请求在飞：搭车，别再发一条
  const existing = inflight.get(k)
  if (existing) return existing

  const p = (async () => {
    try {
      const files = await fetcher()
      if (files) writeDir(sessionId, path, files)
      return files
    } finally {
      inflight.delete(k)
    }
  })()

  inflight.set(k, p)
  return p
}

/** 供测试与诊断读取内部规模 */
export function cacheStats(): { dirs: number; inflight: number; freshMs: number } {
  return { dirs: cache.size, inflight: inflight.size, freshMs: FRESH_MS }
}
