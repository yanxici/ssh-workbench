/**
 * 分屏同步输入与后台标签未读的纯判定函数。
 *
 * 刻意不 import 任何 store：TabBar / sessionStore 都不能反向依赖 splitStore
 * （paneRegistry.ts 的注释里记过这个循环依赖），这里只吃 { type } 形状的数据，
 * 由调用方把状态查好传进来。纯函数才好让 scripts/verify-split-sync.cjs 直接跑。
 */
import type { ConnStatus } from '@shared/types'
import type { PaneNode } from '@/lib/paneTree'

/** 默认的「离开多久才算真的走了」阈值：切标签途中的抖动不该点亮未读 */
const DEFAULT_UNREAD_GRACE_MS = 500

/**
 * 同步输入的广播目标。
 *
 * 三条硬约束（少一条就会把字节打进用户没盯着的终端）：
 *  1. 只在当前标签自己的窗格树里取叶子，绝不跨标签；
 *  2. 只广播给 connected 的窗格，断线/连接中的窗格丢掉输入是静默的；
 *  3. 自己永远排在里面（哪怕自己正断线重连），否则这一格敲的字会丢。
 *
 * 单窗格（或没有树）时返回 [selfId]，调用方据此走原来的 session.write 单播。
 */
export function resolveSyncTargets(
  tabRoot: PaneNode | undefined,
  syncEnabled: boolean,
  sessions: Array<{ id: string; status: ConnStatus }>,
  selfId: string
): string[] {
  if (!tabRoot || !syncEnabled) return [selfId]

  const ids = collectLeafIds(tabRoot)
  if (ids.length < 2) return [selfId]
  if (!ids.includes(selfId)) return [selfId]

  const statusById = new Map(sessions.map((s) => [s.id, s.status]))
  return ids.filter((id) => id === selfId || statusById.get(id) === 'connected')
}

/** 与 paneTree.leafIds 同序（左→右、上→下），但不 import 它，避免把整棵树的实现拖进来 */
function collectLeafIds(node: PaneNode): string[] {
  if (node.type === 'leaf') return [node.sessionId]
  return [...collectLeafIds(node.children[0]), ...collectLeafIds(node.children[1])]
}

export interface UnreadInput {
  /** 该会话所在标签是否就是当前激活标签（且这一格可见） */
  isVisibleInActiveTab: boolean
  status: ConnStatus
  /** 本次到达的终端数据（原样，含 ANSI 控制序列） */
  data: string
  /** 离开该标签的时刻；从未离开过则为 undefined */
  leftAt?: number
  now: number
  graceMs?: number
}

/**
 * 后台标签要不要点亮未读圆点。
 *
 * 误报比漏报更伤：一个总亮着的圆点等于没有圆点，用户会彻底忽略它。
 * 所以纯控制序列（清屏、改色、光标移动、OSC 改标题）与纯空白一律不算输出，
 * 且必须有超过 graceMs 的离开时长。
 */
export function shouldMarkUnread(input: UnreadInput): boolean {
  if (input.isVisibleInActiveTab) return false
  if (input.status !== 'connected') return false

  const grace = input.graceMs ?? DEFAULT_UNREAD_GRACE_MS
  if (input.leftAt !== undefined && input.now - input.leftAt < grace) return false

  return hasVisibleText(input.data)
}

/*
 * 剥掉 CSI / OSC / 两字节 ESC 序列与字符集切换，再看还剩不剩可见字符。
 * 这里的正则**必须**写进控制字符本身 —— 要匹配的就是 ESC / BEL，
 * 写成字符类简写就认不出它们了（与 @/lib/zmodem 同一处理由）。
 */
/* eslint-disable no-control-regex -- 见上：要匹配的就是 ESC(0x1B) 与 BEL(0x07) */
function hasVisibleText(data: string): boolean {
  if (!data) return false
  const stripped = data
    // OSC：ESC ] ...（BEL 或 ST 收尾）
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
    // CSI：ESC [ 参数 中间字节 终止字节
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
    // 其余两字节转义（含 ESC ( B 这类字符集指定）
    .replace(/\u001B[()#][0-9A-Za-z]/g, '')
    .replace(/\u001B[@-Z\\-_]/g, '')
  return stripped.replace(/[\s\u0000-\u001F\u007F]/g, '').length > 0
}
