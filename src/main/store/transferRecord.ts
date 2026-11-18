import { join } from 'node:path'
import type {
  TransferFailureGroup,
  TransferProgressEvent,
  TransferRecord,
  TransferRecordStatus
} from '@shared/types'
import { JsonStore, dataDir } from './jsonStore'

/**
 * 传输记录（历史账本）。
 *
 * 为什么主进程是唯一写者：SFTP 与 trzsz 本来就在主进程里跑，ZMODEM 走一条
 * TRANSFER_RECORD_UPSERT 通道回报。如果让渲染层各自写各自的文件，
 * 「最近 200 条带明细」这种跨方向、跨链路的淘汰规则就要实现多份，
 * 且两边的保留策略一旦漂移就再也对不齐。
 *
 * 落盘时机（有意为之）：只在**状态跃迁**时写一次（入队 running、终态 done/error/
 * canceled）。进度事件一律不落盘 —— 每 150ms 一次整份 JSON 读写会把磁盘打满，
 * 而进程被强杀时留下的「上次没收尾的 running」恰好是有用信息（见 sweepStale）。
 */

/** 任务级上限：超出的最旧**已结束**记录被淘汰（running 永不淘汰） */
const MAX_RECORDS = 500
/** 只有最近的这么多条保留逐文件明细，更老的只留统计数字 */
const MAX_DETAIL_RECORDS = 200
/** 同一个错误原因最多留这么多条样例路径 */
const MAX_SAMPLE = 50
/** 记录变更信号的节流窗口 */
export const RECORD_EMIT_MS = 300

const store = new JsonStore<TransferRecord[]>(join(dataDir(), 'transfer-records.json'), () => [])

/** 记录变更通知（主进程只发「变了」这个信号，不广播内容） */
let onChanged: (() => void) | null = null
let emitTimer: NodeJS.Timeout | null = null

export function setRecordChangeHandler(fn: () => void): void {
  onChanged = fn
}

function scheduleEmit(): void {
  if (!onChanged || emitTimer) return
  emitTimer = setTimeout(() => {
    emitTimer = null
    onChanged?.()
  }, RECORD_EMIT_MS)
  emitTimer.unref?.()
}

/**
 * 把逐文件失败按错误原因聚合成若干组。
 *
 * 为什么按原因而不是按文件：2 万个文件里 300 个因权限失败，若一行一条，
 * 列表会被同一种错误淹没 —— 用户真正要问的是「是不是全是 Permission denied」。
 * 聚合后行数只跟「不同原因数」相关，与失败文件数脱钩。
 */
export function aggregateFailures(
  failures: Array<{ path: string; message: string }> | undefined
): { groups: TransferFailureGroup[]; total: number } {
  if (!failures || failures.length === 0) return { groups: [], total: 0 }
  const byMessage = new Map<string, string[]>()
  for (const f of failures) {
    const list = byMessage.get(f.message)
    if (list) list.push(f.path)
    else byMessage.set(f.message, [f.path])
  }
  const groups: TransferFailureGroup[] = []
  for (const [message, paths] of byMessage) {
    groups.push({
      message,
      count: paths.length,
      // 只留前 50 条：第 51 条路径对「判断原因」没有增量信息
      sample: paths.slice(0, MAX_SAMPLE)
    })
  }
  // 失败数多的原因排前面：那才是用户要先处理的
  groups.sort((a, b) => b.count - a.count)
  return { groups, total: failures.length }
}

/** 是否已结束（只有已结束的记录才允许被淘汰） */
function isFinished(status: TransferRecordStatus): boolean {
  return status !== 'running' && status !== 'pending'
}

/**
 * 写入或更新一条记录。
 *
 * 身份字段（connectionId / connectionName / target）由调用方在**入队时**快照，
 * 这里不再查会话 —— 查了也只会在会话关掉后拿到 undefined，
 * 记录就变成「未知连接」。
 */
export async function upsertRecord(record: TransferRecord): Promise<void> {
  await store.update((list) => {
    const next = [...list]
    const idx = next.findIndex((r) => r.id === record.id)
    /*
     * 合并时保住首次写入的 startedAt。
     * 调用方收尾时也会带上 startedAt（它只知道「现在」），若直接覆盖，
     * 记录的开始时间就变成结束时间 —— 上面按时间淘汰、面板排序全会跟着错。
     */
    if (idx >= 0) next[idx] = { ...next[idx], ...record, startedAt: next[idx].startedAt }
    else next.push(record)

    // 明细只留给最近的 MAX_DETAIL_RECORDS 条；更老的留下计数，丢掉路径
    const withDetail = next.filter((r) => r.failures && r.failures.length > 0)
    if (withDetail.length > MAX_DETAIL_RECORDS) {
      const keep = new Set(
        withDetail
          .slice()
          .sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt))
          .slice(0, MAX_DETAIL_RECORDS)
          .map((r) => r.id)
      )
      for (const r of next) {
        if (r.failures && r.failures.length > 0 && !keep.has(r.id)) {
          delete r.failures
        }
      }
    }

    if (next.length <= MAX_RECORDS) return next
    /*
     * 超额淘汰：running 永不淘汰（它还在写），只按时间丢最旧的已结束记录。
     * 极端情况（500 条全是 running）时宁可不裁剪，也不丢正在进行的任务。
     */
    const overflow = next.length - MAX_RECORDS
    const victims = new Set(
      next
        .filter((r) => isFinished(r.status))
        .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt))
        .slice(0, overflow)
        .map((r) => r.id)
    )
    return next.filter((r) => !victims.has(r.id))
  })
  scheduleEmit()
}

/** 从 SFTP 进度事件写一条记录（主进程内部调用，SFTP 与记录层同进程） */
export async function recordFromEvent(
  e: TransferProgressEvent,
  identity: {
    connectionId?: string
    connectionName?: string
    target?: string
    /** 只用于面板回查实时进度，不作身份（重启后失配是预期的） */
    sessionId?: string
  },
  via: TransferRecord['via'] = 'sftp'
): Promise<void> {
  const fileName = (e.remotePath || e.localPath || '').split(/[\\/]/).pop() || ''
  const { groups, total } = aggregateFailures(e.failures)
  await upsertRecord({
    id: e.taskId,
    connectionId: identity.connectionId,
    connectionName: identity.connectionName,
    target: identity.target,
    sessionId: identity.sessionId,
    direction: e.direction,
    via,
    localPath: e.localPath,
    remotePath: e.remotePath,
    fileName,
    size: e.total,
    transferred: e.transferred,
    unit: e.unit,
    status: e.status === 'paused' ? 'running' : e.status,
    error: e.error,
    note: e.note,
    failures: groups.length > 0 ? groups : undefined,
    failureCount: total > 0 ? total : undefined,
    startedAt: Date.now(),
    finishedAt:
      e.status === 'done' || e.status === 'error' || e.status === 'canceled'
        ? Date.now()
        : undefined
  })
}

/** 读取全部记录（新的在前） */
export async function listRecords(): Promise<TransferRecord[]> {
  const list = await store.read()
  return [...list].sort((a, b) => b.startedAt - a.startedAt)
}

/** 标记旧记录被哪条新记录重试过 */
export async function markRetried(oldId: string, newId: string): Promise<void> {
  await store.update((list) =>
    list.map((r) => (r.id === oldId ? { ...r, retriedBy: newId } : r))
  )
  scheduleEmit()
}

/**
 * 启动时清理僵尸记录。
 *
 * 上次进程在传输中途退出（崩溃、强杀、关机），记录停在 running 且永远不会有
 * 人来收尾。改成 interrupted 而不是删掉：它是事实（确实开始过、确实没传完），
 * 而且用户可以据此重试。让渲染层自己「找不到活任务就猜中断」是不行的 ——
 * 排队中或渲染层刚重载时都会误判。
 */
export async function sweepStale(): Promise<void> {
  const list = await store.read()
  const stale = list.filter((r) => r.status === 'running' || r.status === 'pending')
  if (stale.length === 0) return
  await store.update((all) =>
    all.map((r) =>
      r.status === 'running' || r.status === 'pending'
        ? {
            ...r,
            status: 'interrupted',
            error: '上次会话意外结束，进度未知',
            finishedAt: r.finishedAt ?? Date.now()
          }
        : r
    )
  )
  scheduleEmit()
}

/** 供面板/诊断读取规模 */
export async function recordStats(): Promise<{ total: number; withDetail: number }> {
  const list = await store.read()
  return {
    total: list.length,
    withDetail: list.filter((r) => (r.failures?.length ?? 0) > 0).length
  }
}
