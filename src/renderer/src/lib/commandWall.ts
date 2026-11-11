import type { Command } from '@shared/types'

/**
 * 命令墙的几何与状态规则（纯函数，便于单测）。
 *
 * 卡片从「固定 3 列 + 图标 + 命令行」改成「宽度驱动列数 + 2px 色条 + 两行名字」，
 * 这次改动的全部判据都收在这里，组件只负责画：
 *   列数怎么算、卡片多宽、方向键跨几格、左侧色条该是什么颜色。
 */

/** 拿不到宽度时的兜底列数（首帧 ResizeObserver 还没回调） */
export const WALL_COLS_FALLBACK = 4
/** 命令墙容器左右内边距之和：px-1.5 = 6px × 2 */
export const WALL_PAD_X = 12
/** 网格 gaps：gap-1 = 4px */
export const WALL_GAP = 4

/**
 * 宽度 → 列数。
 *
 * 旧实现写死 3 列，理由是「空间记忆」：列数一变，口头描述「第三行右边」就失效。
 * 但那个前提是用户从不拖宽度 —— 实际用户把命令栏拖到过 340 下限，
 * 固定 3 列在窄栏里等于惩罚用户：每张卡只剩 60px，名字全变省略号。
 * 所以改成宽度驱动，代价是拖动分隔条时列数会跳一次，只在跨越阈值时发生。
 */
export function wallColumns(width: number): number {
  if (!Number.isFinite(width) || width <= 0) return WALL_COLS_FALLBACK
  if (width < 360) return 3
  if (width < 480) return 4
  return 5
}

/** 单张卡片的外框宽（含边框，不含 grid gap） */
export function wallCardWidth(width: number, cols: number): number {
  const n = cols > 0 ? cols : WALL_COLS_FALLBACK
  const usable = Math.max(0, width - WALL_PAD_X - WALL_GAP * (n - 1))
  return usable / n
}

/**
 * 方向键步长。↑↓ 必须等于实际列数，否则光标会跳到相邻列而不是相邻行；
 * ←→ 恒为 1。旧实现把 3 写死在这里，列数一变就错位。
 */
export function wallStep(key: string, cols: number): number {
  const n = cols > 0 ? cols : WALL_COLS_FALLBACK
  if (key === 'ArrowDown') return n
  if (key === 'ArrowUp') return -n
  if (key === 'ArrowRight') return 1
  if (key === 'ArrowLeft') return -1
  return 0
}

/** 环形移动光标；空列表返回 0 */
export function wrapIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return 0
  return (((current + delta) % length) + length) % length
}

export type AccentTone = 'confirm' | 'pinned' | 'vars' | 'none'

/**
 * 左侧 2px 色条要表达的状态，优先级：需确认 > 收藏 > 有变量 > 普通。
 *
 * 安全信息（会重启、会断电）必须最醒目，收藏是偏好，变量只是提示。
 * 卡片内不再常驻角标 —— 那一列 24px 是名字的宽度预算。
 */
export function accentTone(
  c: Pick<Command, 'confirmRequired' | 'variables'>,
  pinned: boolean
): AccentTone {
  if (c.confirmRequired) return 'confirm'
  if (pinned) return 'pinned'
  if ((c.variables?.length ?? 0) > 0) return 'vars'
  return 'none'
}

/**
 * 色条 class 必须写成字面量，Tailwind 的 content 扫描看不到拼接出来的类名。
 */
export const ACCENT_CLASS: Record<AccentTone, string> = {
  confirm: 'border-l-warning',
  pinned: 'border-l-accent',
  vars: 'border-l-violet-400',
  none: 'border-l-edge'
}

export function accentClass(tone: AccentTone): string {
  return ACCENT_CLASS[tone] ?? ACCENT_CLASS.none
}
