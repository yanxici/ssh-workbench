import type { TaskNotifyPrefs } from '@shared/types'

/**
 * 任务完成通知的纯决策层（v2.1.4）。
 *
 * 为什么单独一层：真正决定「弹不弹、弹哪种」的只有几个布尔量，但它是这个功能
 * 唯一容易出错的地方（静音没生效、聚焦时还弹系统通知、启发式关掉了还报）。
 * 把它从 React/zustand/Electron 里剥出来，verify 脚本就能直接对着它跑断言，
 * 不用起窗口 —— 与 v2.1.3 的 highlight.ts / highlightRuntime.ts 同一路子。
 *
 * 这一层不做任何 IO：不读 settings、不问窗口焦点、不弹通知，全部由调用方喂进来。
 */

/** 决策层看到的偏好（与落盘结构一致，单独起名是为了让调用点不依赖 AppSettings） */
export type NotifyPrefs = TaskNotifyPrefs

/** 会产生完成通知的任务类别 */
export const NOTIFY_KINDS = ['batch', 'diag', 'firmware', 'sftp', 'discover', 'tftp', 'trzsz', 'heuristic'] as const
export type NotifyKind = (typeof NOTIFY_KINDS)[number]

export interface NotifyRequest {
  kind: NotifyKind
  /** 通知主标题；空串直接判为不弹（宁可不弹也不要一条标题是空白的气质） */
  title: string
  /** 副文本：结果统计、文件名、失败原因 */
  detail?: string
  /** 归属连接；用于静音判定与「点击切到哪台设备」 */
  connectionId?: string
  /** 归属会话；点击通知时切到该标签 */
  sessionId?: string
}

export type NotifyChannel = 'none' | 'toast' | 'system'

/** 为什么是这个结论 —— 只用于测试断言与调试，不进 UI */
export type NotifyReason =
  | 'disabled'
  | 'empty-title'
  | 'heuristic-off'
  | 'muted'
  | 'focused'
  | 'unfocused'
  | 'system-off'

export interface NotifyDecision {
  channel: NotifyChannel
  reason: NotifyReason
}

/**
 * 启发式判定的静默阈值。
 *
 * 1.5s 是权衡出来的：0.5s 会把正常的命令间隔（敲完 ls 想下一个命令）当成结束；
 * 5s 又太迟钝（编译完 5 秒才提示，人已经切回窗口了）。1.5s 大致等于
 * 「一条命令的执行停顿」与「一个任务的结束」的分界。
 */
export const HEURISTIC_IDLE_MS = 1500

/** 主标题上限（Windows 操作中心里超过就被截断，截断位置不可控，不如自己截） */
const MAX_TITLE = 120
/** 正文上限 */
const MAX_BODY = 300

export function isMuted(list: readonly string[] | undefined, connectionId?: string): boolean {
  if (!connectionId || !list || list.length === 0) return false
  return list.includes(connectionId)
}

/**
 * 决策核心。
 *
 * 顺序是有意义的，别随手调换：
 * 1. 总开关最先 —— 关了就什么都不发，避免"关了还弹静音提示"这种自相矛盾。
 * 2. 启发式开关在静音之前：启发式关掉是"这个判定方式本身不要"，
 *    而静音是"这台设备不要"，两个维度互不替代，但先说清楚它压根不成立。
 * 3. 静音在聚焦判定之前：静音的设备即使窗口失焦也不该弹。
 * 4. 聚焦时一律只 toast —— 人就在窗口前面，右下角一条提示足够，
 *    再弹系统通知等于同一件事说两遍。
 */
export function planNotify(
  req: NotifyRequest,
  ctx: { prefs: NotifyPrefs; focused: boolean }
): NotifyDecision {
  if (!ctx.prefs.enabled) return { channel: 'none', reason: 'disabled' }
  if (!req.title.trim()) return { channel: 'none', reason: 'empty-title' }
  if (req.kind === 'heuristic' && !ctx.prefs.heuristic) {
    return { channel: 'none', reason: 'heuristic-off' }
  }
  if (isMuted(ctx.prefs.mutedConnectionIds, req.connectionId)) {
    return { channel: 'none', reason: 'muted' }
  }
  if (ctx.focused) return { channel: 'toast', reason: 'focused' }
  if (ctx.prefs.system) return { channel: 'system', reason: 'unfocused' }
  return { channel: 'toast', reason: 'system-off' }
}

/**
 * 启发式「疑似结束」判定。
 *
 * notifiedAt 的作用是**一轮输出只提醒一次**：不做这个门，同一条静默会被
 * 每秒轮询重复命中，一次编译能刷出几十条通知。
 */
export function heuristicHit(ctx: {
  now: number
  /** 上次收到终端输出的时刻；0 表示这个会话从没输出过 → 不判定 */
  lastOutputAt: number
  /** 上次因静默提醒过的时刻；0 表示还没提醒过 */
  notifiedAt: number
  prefs: NotifyPrefs
}): boolean {
  if (!ctx.prefs.enabled || !ctx.prefs.heuristic) return false
  if (ctx.lastOutputAt <= 0) return false
  if (ctx.notifiedAt > 0 && ctx.notifiedAt >= ctx.lastOutputAt) return false
  return ctx.now - ctx.lastOutputAt >= HEURISTIC_IDLE_MS
}

export function addMuted(list: readonly string[] | undefined, connectionId: string): string[] {
  const base = (list ?? []).filter((id) => typeof id === 'string' && id)
  if (!connectionId || base.includes(connectionId)) return base
  return [...base, connectionId]
}

export function removeMuted(list: readonly string[] | undefined, connectionId: string): string[] {
  return (list ?? []).filter((id) => typeof id === 'string' && id && id !== connectionId)
}

/**
 * 老配置兜底。
 *
 * 为什么要自己 sanitize 而不是信主进程：settings.json 是用户可手改的文件，
 * 也是跨版本升级来的 —— 可能出现 mutedConnectionIds 里混着 null、
 * sound 是字符串 "false"（手写的）、整个 taskNotify 是 null。
 * 一处 true/false 的语义错了（字符串 "false" 是真值），静音就整片失效。
 */
export function normalizeNotifyPrefs(input: unknown): NotifyPrefs {
  const raw = (input ?? {}) as Partial<Record<keyof TaskNotifyPrefs, unknown>>
  const bool = (v: unknown, fallback: boolean): boolean =>
    typeof v === 'boolean' ? v : fallback
  const muted = Array.isArray(raw.mutedConnectionIds)
    ? [
        ...new Set(
          raw.mutedConnectionIds.filter((id): id is string => typeof id === 'string' && !!id.trim())
        )
      ]
    : []
  return {
    enabled: bool(raw.enabled, true),
    system: bool(raw.system, true),
    sound: bool(raw.sound, false),
    heuristic: bool(raw.heuristic, false),
    mutedConnectionIds: muted
  }
}

/** 拼系统通知正文：标题截到 120、正文截到 300，超长补省略号 */
export function buildNotifyText(req: NotifyRequest): { title: string; body: string } {
  const clip = (s: string, max: number): string => {
    const t = s.replace(/\s+/g, ' ').trim()
    return t.length <= max ? t : t.slice(0, max - 1) + '…'
  }
  return { title: clip(req.title, MAX_TITLE), body: clip(req.detail ?? '', MAX_BODY) }
}
