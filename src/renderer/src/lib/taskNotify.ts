import { useSettingsStore } from '@/stores/settingsStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useToastStore, type ToastKind } from '@/stores/toastStore'
import { uid } from '@/lib/utils'
import {
  buildNotifyText,
  heuristicHit,
  normalizeNotifyPrefs,
  planNotify,
  type NotifyDecision,
  type NotifyKind,
  type NotifyRequest
} from '@/lib/notifyPlan'

/**
 * 任务完成通知的运行时（v2.1.4）。
 *
 * 职责边界：
 * - notifyPlan.ts = 纯决策（弹不弹、弹哪种），可被 verify 脚本直接跑；
 * - 本文件 = 把决策落到三个真实东西上：应用内 toast、系统通知、标签闪烁；
 *   并持有「终端静默」的计时状态（启发式判定需要跨事件记账）。
 *
 * 所有入口都是 fire-and-forget：通知失败绝不能让一个已经成功完成的任务
 * 显示成失败，所以内部一律 catch 掉异常，只留 toast 兜底。
 */

/** 每个会话的静默计时：lastOutputAt = 最后一次收到终端输出的时刻 */
const idleSince = new Map<string, { lastOutputAt: number; notifiedAt: number }>()

/**
 * 「刚结束的任务」高亮请求。
 *
 * 不直接操作 DOM 的原因：闪烁要靠标签栏自己渲染（它才知道哪个 div 是标签）。
 * 这里只发一个带时间戳的信号，TabBar 消费后置空 —— 单向数据流，
 * 不需要在 store 里存"是否正在闪"这种瞬时状态。
 */
let flashTarget: { sessionId: string; at: number } | null = null
const flashListeners = new Set<() => void>()

export function flashSession(sessionId: string): void {
  flashTarget = { sessionId, at: Date.now() }
  for (const fn of flashListeners) fn()
}

export function takeFlashTarget(): { sessionId: string; at: number } | null {
  return flashTarget
}

export function clearFlashTarget(): void {
  flashTarget = null
}

export function watchFlash(cb: () => void): () => void {
  flashListeners.add(cb)
  return () => {
    flashListeners.delete(cb)
  }
}

function prefs(): ReturnType<typeof normalizeNotifyPrefs> {
  return normalizeNotifyPrefs(useSettingsStore.getState().settings.taskNotify)
}

/** 窗口是否聚焦（主进程回答；失败当作聚焦，宁可少弹系统通知） */
async function isFocused(): Promise<boolean> {
  try {
    return await window.api.win.isFocused()
  } catch {
    return true
  }
}

const KIND_TOAST: Record<NotifyKind, ToastKind> = {
  batch: 'success',
  diag: 'info',
  firmware: 'success',
  sftp: 'success',
  discover: 'info',
  tftp: 'info',
  trzsz: 'success',
  heuristic: 'info'
}

/**
 * 发一条任务完成提示。
 *
 * 调用方（batchStore / diagStore / firmwareStore / sftpStore ...）只需要说
 * 「什么任务、什么结果、属于哪个连接」，「怎么提示」全部收敛在这里。
 */
export async function notifyTask(req: NotifyRequest): Promise<'none' | 'toast' | 'system'> {
  // 显式标注：不写类型时 try/catch 两侧的赋值让 TS 推成 any，随后每次
  // 读 decision.channel 都会触发 no-unsafe-member-access
  let decision: NotifyDecision
  try {
    const focused = await isFocused()
    decision = planNotify(req, { prefs: prefs(), focused })
  } catch {
    decision = { channel: 'toast' as const, reason: 'focused' as const }
  }

  if (decision.channel === 'none') return 'none'

  const { title, body } = buildNotifyText(req)

  if (decision.channel === 'toast') {
    useToastStore.getState().push({
      kind: KIND_TOAST[req.kind] ?? 'info',
      title,
      detail: body || undefined
    })
    return 'toast'
  }

  // 系统通知：先发，失败（不支持/被系统关掉）再退回 toast ——
  // 反过来会让系统通知成功的场景下也闪一条 toast，重复提示
  let shown = false
  try {
    const res = await window.api.notify.show({
      title,
      body: body || undefined,
      sessionId: req.sessionId,
      silent: !prefs().sound
    })
    shown = res.ok === true && res.data === true
  } catch {
    shown = false
  }
  if (!shown) {
    useToastStore.getState().push({
      kind: KIND_TOAST[req.kind] ?? 'info',
      title,
      detail: body || undefined
    })
    return 'toast'
  }
  // 系统通知发出后，应用内在标签上闪一下 —— 用户点通知回来时
  // 能立刻看出是哪一台设备跑完了
  if (req.sessionId) flashSession(req.sessionId)
  return 'system'
}

/* ------------------------------------------------------------------ *
 *  传输类任务的汇总（SFTP 多文件 / TFTP 分包）
 * ------------------------------------------------------------------ */

/**
 * 传输类通知的待汇总队列。
 *
 * 为什么不让每个文件各弹一条：上传一个 40 个文件的目录会得到 40 条通知，
 * 操作中心被刷满，用户反而看不到真正重要的那条。这里按 1.2 秒的静默窗口
 * 把连续完成的任务压成一条「传输完成：40 个文件」。
 *
 * 1.2 秒而不是等待"整批结束"：SFTP 的任务之间没有批次 id（每次 upload 调用
 * 各自成 task），拿不到"这一批还剩几个"，只能按时间聚。
 */
interface TransferAgg {
  count: number
  failed: number
  bytes: number
  lastName: string
  sessionId?: string
  connectionId?: string
  timer: number | null
}

const transferAgg = new Map<string, TransferAgg>()

/** 某个会话完成一次传输（成功/失败都算）；1.2s 后汇总成一条通知 */
export function queueTransferNotify(args: {
  sessionId: string
  connectionId?: string
  ok: boolean
  bytes: number
  name: string
}): void {
  const key = args.sessionId
  const cur = transferAgg.get(key)
  const agg: TransferAgg = cur ?? {
    count: 0,
    failed: 0,
    bytes: 0,
    lastName: '',
    sessionId: args.sessionId,
    connectionId: args.connectionId,
    timer: null
  }
  agg.count += 1
  if (!args.ok) agg.failed += 1
  agg.bytes += Math.max(0, args.bytes)
  agg.lastName = args.name
  if (args.connectionId) agg.connectionId = args.connectionId
  if (agg.timer !== null) window.clearTimeout(agg.timer)
  agg.timer = window.setTimeout(() => {
    transferAgg.delete(key)
    const title =
      agg.count === 1
        ? agg.failed
          ? `传输失败：${agg.lastName}`
          : `传输完成：${agg.lastName}`
        : `传输完成：${agg.count - agg.failed}/${agg.count} 个文件`
    void notifyTask({
      kind: 'sftp',
      title,
      detail:
        agg.count === 1
          ? agg.failed
            ? '失败'
            : formatBytes(agg.bytes)
          : `共 ${formatBytes(agg.bytes)}${agg.failed ? `，${agg.failed} 个失败` : ''}`,
      connectionId: agg.connectionId,
      sessionId: agg.sessionId
    })
  }, 1200)
  transferAgg.set(key, agg)
}

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

/* ------------------------------------------------------------------ *
 *  启发式：终端静默即"疑似结束"
 * ------------------------------------------------------------------ */

/**
 * 收到一次会话输出时记账。由 App.tsx 的 sessionData 回调调用。
 *
 * 放在写终端之前调，因为写终端之后界面已经动了，语义上"输出到达"是更早的事。
 */
export function noteSessionOutput(sessionId: string): void {
  const cur = idleSince.get(sessionId)
  const now = Date.now()
  if (cur) {
    cur.lastOutputAt = now
  } else {
    idleSince.set(sessionId, { lastOutputAt: now, notifiedAt: 0 })
  }
}

export function forgetNotifySession(sessionId: string): void {
  idleSince.delete(sessionId)
}

/**
 * 低频巡检（2 秒一次）：找出"静默超过阈值且窗口失焦"的会话，各提醒一次。
 *
 * 为什么用固定定时器而不是 setTimeout 排程：一个会话每收到一行输出就要重置
 * 定时器，20 个会话就是 20 条链，且它们互相之间没有关系。定时巡检是 O(会话数)
 * 的常量开销（2 秒一次 × 20 个 Map 条目，实测零感知），排队反而更脆。
 */
let sweepTimer: number | null = null

export function startHeuristicSweep(): void {
  if (sweepTimer !== null) return
  sweepTimer = window.setInterval(() => {
    const p = prefs()
    if (!p.enabled || !p.heuristic) return
    /*
     * 窗口在前台时不弹通知 —— 但必须把「已经看过了」记下来。
     * 原来直接 return，notifiedAt 一直停在很早以前的值；用户切走窗口的那一刻，
     * 所有早就静默结束的旧会话同时满足「静默够久 且 没提醒过」，
     * 于是刷屏式弹出一整批「疑似完成」。人就在屏幕前面看着的输出，
     * 不该在他离开时被当成新闻补发。
     */
    if (!document.hidden && document.hasFocus()) {
      for (const rec of idleSince.values()) {
        if (rec.notifiedAt < rec.lastOutputAt) rec.notifiedAt = rec.lastOutputAt
      }
      return
    }
    const now = Date.now()
    for (const [sessionId, rec] of idleSince) {
      if (!heuristicHit({ now, lastOutputAt: rec.lastOutputAt, notifiedAt: rec.notifiedAt, prefs: p }))
        continue
      rec.notifiedAt = now
      const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
      if (!session) continue
      void notifyTask({
        kind: 'heuristic',
        title: `疑似完成：${session.title || session.host}`,
        detail: '终端已静默 1.5 秒以上（启发式判断，不一定是真的结束）',
        connectionId: session.connectionId,
        sessionId
      })
    }
  }, 2000)
}

export function stopHeuristicSweep(): void {
  if (sweepTimer !== null) {
    window.clearInterval(sweepTimer)
    sweepTimer = null
  }
}

/** 测试用：读某会话的记账 */
export function peekIdle(sessionId: string): { lastOutputAt: number; notifiedAt: number } | undefined {
  const r = idleSince.get(sessionId)
  return r ? { ...r } : undefined
}

/** 静音/取消静音当前连接（标签右键菜单用） */
export function toggleMuteConnection(connectionId: string, mute: boolean): void {
  const settings = useSettingsStore.getState().settings
  const cur = normalizeNotifyPrefs(settings.taskNotify)
  const next = {
    ...cur,
    mutedConnectionIds: mute
      ? [...new Set([...(cur.mutedConnectionIds ?? []), connectionId])]
      : (cur.mutedConnectionIds ?? []).filter((id) => id !== connectionId)
  }
  void useSettingsStore.getState().update({ taskNotify: next })
}

/** 生成一个不会撞的 toast id（ToastHost 需要 key）；导出给测试用 */
export function newNotifyId(): string {
  return uid()
}
