import type { ColorThemeId } from './types'

/**
 * 当前在架配色主题（顺序即设置面板色板的展示顺序）。
 *
 * 为什么单独放一个 shared 模块而不是让渲染层从 colorThemes.ts 里导出：
 * 主进程的 settings 迁移也要判断「这个 ID 还认不认」，而 colorThemes.ts
 * 依赖 @xterm/xterm 的类型与整份调色板数据 —— 主进程不需要也不该把它拖进来。
 * 一个 4 元素的常量 + 一个映射函数，是两端唯一需要共享的那点事实。
 */
export const ACTIVE_COLOR_THEMES: readonly ColorThemeId[] = [
  'vscode',
  'mono',
  'solarized',
  'dracula'
]

const ACTIVE = new Set<string>(ACTIVE_COLOR_THEMES)

/**
 * 把任意历史 ID 收敛到在架集合。
 *
 * 退役的 workbench / nord / onedark 与任何未知字符串（含 undefined）一律回落到
 * vscode —— 它是默认配色，也是当初最多人用的那套冷灰蓝，视觉距离最近。
 *
 * 刻意**不**抛错也刻意不返回 undefined：调用点遍及主进程读取、渲染层取变量表、
 * 设置面板渲染三处，任何一处拿到 undefined 都会在渲染时炸成白屏；而回落到默认
 * 配色最坏结果只是「主题看起来像 vscode」，用户还能自己去改。
 */
export function normalizeColorTheme(id: string | undefined | null): ColorThemeId {
  return id && ACTIVE.has(id) ? (id as ColorThemeId) : 'vscode'
}
