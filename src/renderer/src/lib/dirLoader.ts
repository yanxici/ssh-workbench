import type { RemoteFile } from '@shared/types'
import { call } from '@/lib/ipc'

/**
 * 目录批量读取器：把同一帧内的多个目录请求合并成一次 IPC。
 *
 * 为什么需要合批（这是「展开远端目录慢」的主要来源之一）：
 *
 *   旧路径下每个目录一次 `window.api.sftp.list()`。Electron 的 IPC 是
 *   「一次调用一次往返」：渲染进程序列化 → 主进程反序列化 → 排队 → SFTP 通道
 *   发 readdir → 回来再反序列化推回渲染进程。单次开销不大，但它**串行排队**：
 *   展开一棵有 K 个目录的树，就是 K 次这样的往返。实测在 60~120ms RTT 的链路上，
 *   光调度就比远端 readdir 本身还贵。
 *
 * 这里的做法是「同一帧内到达的请求合并」：
 *   - 调用方只管把自己的目录扔进来，拿到 Promise；
 *   - 微任务结束后（setTimeout 0）统一 flush，把这一批目录压成一条 IPC 发出去；
 *   - 主进程内部用 LIST_MANY_CONCURRENCY(=8) 并发跑 readdir，一次 RTT 拿回全部。
 *
 * 为什么用 setTimeout(0) 而不是 requestAnimationFrame：rAF 在窗口不可见或被
 * 节流时会挂起，目录读取不该依赖窗口是否可见。0ms 定时器足够把同一事件循环
 * 批次里的调用攒到一起。
 */

export interface DirBatchResponse {
  dirs: Record<string, RemoteFile[]>
  errors: Record<string, string>
}

interface Waiter {
  dirs: string[]
  resolve: (r: DirBatchResponse) => void
}

/** 待发送的目录（Set 顺带去重） */
let pendingDirs = new Set<string>()
let waiters: Waiter[] = []
let flushTimer: ReturnType<typeof setTimeout> | null = null
let currentSession: string | null = null

function scheduleFlush(): void {
  if (flushTimer !== null) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    void flush()
  }, 0)
}

async function flush(): Promise<void> {
  const batchWaiters = waiters
  const batchDirs = [...pendingDirs]
  waiters = []
  pendingDirs = new Set()

  const sessionId = currentSession
  if (!sessionId || batchDirs.length === 0) {
    for (const w of batchWaiters) w.resolve({ dirs: {}, errors: {} })
    return
  }

  let out: DirBatchResponse = { dirs: {}, errors: {} }
  if (batchDirs.length === 1) {
    // 单目录不值得开批量通道：直接走原来的 list（少一层服务器兼容风险）
    const files = await call(window.api.sftp.list(sessionId, batchDirs[0]), { silent: true })
    out = files ? { dirs: { [batchDirs[0]]: files }, errors: {} } : { dirs: {}, errors: {} }
  } else {
    const res = await call(window.api.sftp.listMany(sessionId, batchDirs), { silent: true })
    if (res) out = res
  }

  for (const w of batchWaiters) {
    const dirs: Record<string, RemoteFile[]> = {}
    const errors: Record<string, string> = {}
    for (const d of w.dirs) {
      if (out.dirs[d]) dirs[d] = out.dirs[d]
      else if (out.errors[d]) errors[d] = out.errors[d]
    }
    w.resolve({ dirs, errors })
  }
}

/**
 * 请求一批目录。Promise 在本批 flush 后兑现，只含本次请求的目录。
 * 读失败的目录放在 `errors` 里；既没有数据也没有错误的 key 表示请求被丢弃
 * （会话已切换），调用方按需要重试即可。
 */
export function requestDirs(sessionId: string, dirs: string[]): Promise<DirBatchResponse> {
  // 会话切换：上一批还没发出去的结果不能串到新会话
  if (currentSession !== sessionId) {
    currentSession = sessionId
    pendingDirs.clear()
    const stale = waiters
    waiters = []
    for (const w of stale) w.resolve({ dirs: {}, errors: {} })
  }
  for (const d of dirs) pendingDirs.add(d)
  return new Promise<DirBatchResponse>((resolve) => {
    waiters.push({ dirs: [...dirs], resolve })
    scheduleFlush()
  })
}

/** 测试/诊断用 */
export function loaderStats(): { pending: number; waiters: number; scheduled: boolean } {
  return { pending: pendingDirs.size, waiters: waiters.length, scheduled: flushTimer !== null }
}
