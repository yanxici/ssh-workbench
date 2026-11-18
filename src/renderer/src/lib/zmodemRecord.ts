import type { TransferRecord } from '@shared/types'

/**
 * ZMODEM 传输记录回报。
 *
 * 为什么只有 ZMODEM 走这条通道：SFTP 与 trzsz 都在主进程里跑，引擎自己就能把
 * 记录写进 transfer-records.json。ZMODEM 是唯一跑在渲染进程的传输实现
 * （协议状态机依赖 xterm 字节流），所以它必须反向回报给主进程 —— 主进程仍是
 * 唯一写者，这里只做「补齐身份字段 + 发一条 IPC」。
 *
 * 身份字段（connectionId / connectionName / target）由 UI 层注册的解析器提供：
 * ZMODEM 的 sessionId 只在本次运行内有效，记录里存 sessionId 重启后必然失配，
 * 必须在写入前换算成 connectionId。会话已经关掉时取不到就不带身份 ——
 * 宁可缺字段，也不要写一个假的。
 *
 * 这个文件刻意不 import 任何 store：lib/zmodem.ts 被 scripts/verify-zmodem-renderer.cjs
 * 用 esbuild 单独打包跑无头回归，而 store 们大量使用 @/ 别名，那个脚本解析不了。
 * 依赖方向反过来（UI 注册 → 协议层调用）就绕开了整棵 store 依赖树。
 */

type IdentityResolver = (sessionId: string) => {
  connectionId?: string
  connectionName?: string
  target?: string
}

let resolveIdentity: IdentityResolver = () => ({})

/** 由 UI 层注册（ZmodemOverlay 挂载时调用），协议层不依赖会话表 */
export function setZmodemIdentityResolver(fn: IdentityResolver | null): void {
  resolveIdentity = fn ?? (() => ({}))
}

/**
 * 写一条 ZMODEM 记录。
 *
 * 只在两个时刻调用：传输真正开始（有字节流动）与终态。进度帧一律不写 ——
 * 每 150ms 一次 IPC + 整份 JSON 落盘会把磁盘打满，而进程被强杀时留下的
 * running 记录恰好是有用信息（主进程 sweepStale 会改判 interrupted）。
 *
 * 失败不抛：记录是旁路账本，写不进去不能反过来打断用户正在进行的传输。
 */
export function reportZmodemRecord(input: {
  id: string
  sessionId: string
  direction: 'upload' | 'download'
  status: TransferRecord['status']
  fileName?: string
  localPath?: string
  remotePath?: string
  size?: number
  transferred?: number
  startedAt: number
  error?: string
  note?: string
}): void {
  if (typeof window === 'undefined' || !window.api?.transfer) return
  const record: TransferRecord = {
    id: input.id,
    ...resolveIdentity(input.sessionId),
    // 只给面板回查实时进度用，不作身份（重启后必然失配）
    sessionId: input.sessionId,
    direction: input.direction,
    via: 'zmodem',
    localPath: input.localPath ?? '',
    remotePath: input.remotePath ?? '',
    fileName: input.fileName ?? '',
    size: input.size ?? 0,
    transferred: input.transferred ?? 0,
    unit: 'bytes',
    status: input.status,
    error: input.error,
    note: input.note,
    startedAt: input.startedAt,
    finishedAt:
      input.status === 'done' || input.status === 'error' || input.status === 'canceled'
        ? Date.now()
        : undefined
  }
  void window.api.transfer.upsert(record).catch(() => undefined)
}
