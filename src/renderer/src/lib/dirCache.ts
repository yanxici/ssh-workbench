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

/**
 * 新鲜期：这段时间内重复展开不重新请求。
 *
 * 原来是 5s —— 实际用起来「点开 A、看两眼、点回 B、再点回 A」很容易超过 5s，
 * 于是每次都重新 readdir，慢链路上就是每次都要等一轮 RTT。这里放宽到 30s：
 * 过期数据不会直接上屏后就停住（stale-while-revalidate），后台仍会补新；
 * 任何写操作（上传/删除/改名/新建/刷新按钮）都会显式失效，不受 TTL 影响。
 */
const FRESH_MS = 30_000

/** 缓存上限：目录数太多时按写入时间淘汰最旧的，避免长时间浏览把内存吃满 */
const MAX_DIRS = 300

/** key = sessionId + '\u0000' + path */
const cache = new Map<string, CachedDir>()

/** 在途请求去重：同一目录并发展开只发一次 */
const inflight = new Map<string, Promise<RemoteFile[] | null>>()

function keyOf(sessionId: string, path: string): string {
  return sessionId + '\u0000' + path
}

/** 超上限时按写入时间淘汰最旧的一批（Map 保持插入顺序，直接从头删即可） */
function evictIfNeeded(): void {
  if (cache.size <= MAX_DIRS) return
  const overflow = cache.size - MAX_DIRS
  let n = 0
  for (const k of cache.keys()) {
    if (n >= overflow) break
    cache.delete(k)
    n++
  }
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
  const k = keyOf(sessionId, path)
  // 重新插入一次，让它在 Map 里排到最后 —— 淘汰时先丢真正最久没被写过的目录
  cache.delete(k)
  cache.set(k, { files, at: Date.now() })
  evictIfNeeded()
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

/**
 * 批量读目录：一次 IPC 拿回多个目录的结果。
 *
 * 为什么要有它：展开目录树时如果是「一个目录一条 IPC」，耗时并不等于 N 条
 * readdir 的时间之和 —— 客户端 RTT 只有一次，但每条 IPC 都要走一遍
 * 渲染→主进程→SFTP→主进程→渲染 的调度与序列化，实测在慢链路上这部分
 * 调度开销比 readdir 本身还大。批量把 N 条压成一条，主进程内部再并发发出去。
 *
 * 语义：
 * - 命新鲜缓存的目录不发请求；命过期缓存的照样发（重新验证），但**先用旧值兜底**；
 * - 返回值里 `files` 是「能用的最好数据」（可能是过期缓存），`stale` 标记它是否
 *   还需要后台补新 —— 让调用方决定要不要显示 loading；
 * - 单个目录失败不影响其它目录（主进程用 errors 单独带回）。
 */
export interface DirBatchResult {
  /** path → 最新可用数据；没有数据（且请求失败）时不含该 key */
  files: Record<string, RemoteFile[]>
  /** path → 错误信息 */
  errors: Record<string, string>
  /** 仍需后台补新的 path（命了过期缓存，或请求失败但有旧值） */
  stale: string[]
}

export async function loadDirs(
  sessionId: string,
  dirs: string[],
  fetcher: (
    missing: string[]
  ) => Promise<{ dirs: Record<string, RemoteFile[]>; errors: Record<string, string> } | null>,
  force = false
): Promise<DirBatchResult> {
  const files: Record<string, RemoteFile[]> = {}
  const errors: Record<string, string> = {}
  const stale: string[] = []
  const missing: string[] = []

  for (const dir of new Set(dirs)) {
    const hit = !force ? cache.get(keyOf(sessionId, dir)) : undefined
    if (hit) {
      files[dir] = hit.files
      if (Date.now() - hit.at >= FRESH_MS) stale.push(dir)
    } else {
      missing.push(dir)
    }
  }

  if (missing.length === 0) return { files, errors, stale }

  const res = await fetcher(missing).catch(() => null)
  if (!res) {
    for (const d of missing) {
      if (files[d]) stale.push(d)
      else errors[d] = '读取目录失败'
    }
    return { files, errors, stale }
  }

  for (const [dir, list] of Object.entries(res.dirs)) {
    writeDir(sessionId, dir, list)
    files[dir] = list
  }
  for (const [dir, msg] of Object.entries(res.errors)) {
    if (!files[dir]) errors[dir] = msg
    else stale.push(dir)
  }
  return { files, errors, stale }
}
