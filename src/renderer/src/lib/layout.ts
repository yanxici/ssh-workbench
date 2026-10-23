/**
 * 栏尺寸：默认值 + 夹取 + 拖拽换算（纯函数，可单测）。
 *
 * 老实现把 `w-[250px]` / `w-[232px]` / `h-[136px]` 硬编码在 JSX 里，
 * 于是 1080p 屏上左栏永远 250、4K 屏上也永远 250，用户没有任何办法
 * 把空间让给真正需要宽度的终端 —— 这是「界面不够精致」最直接的一条。
 *
 * ---- 为什么是两个可拖区域 ----
 * 左侧只有一个侧栏（连接/文件/历史/日志/隧道由活动栏切换），
 * 右侧是**常驻**的命令栏。命令栏之所以不放进左侧活动栏切换：
 * 执行命令是高频动作，切到命令视图会同时把终端旁边的连接列表挤走，
 * 于是「看一眼主机名再点命令」要来回切两次 —— 它本该一直在那儿。
 *
 * 老配置里的 fileTree / commandPanel / commandPanelHeight 会留在文件里
 * （无害），但不再读取。
 */

import type { LayoutSizes } from '@shared/types'

export type PaneKey = 'sidebar' | 'commandRail'

export interface PaneSpec {
  default: number
  min: number
  max: number
  /** 拖拽方向：x 表示横向改宽，y 表示纵向改高 */
  axis: 'x' | 'y'
  /** 拖动时数值增长的方向：1 = 向右/下变大，-1 = 向左变大（右侧栏、底部栏） */
  sign: 1 | -1
}

/**
 * 栏宽规格。
 *
 * 侧栏默认 280 而不是 250：侧栏里最挤的是连接列表（`user@host` 一行，
 * 加分组缩进和右侧的状态点），250 时 `root@192.168.100.120` 会被截断成
 * `root@192.168.100.…`，一行里认不出是哪台设备。
 *
 * 命令栏默认 380 / 下限 340：命令墙固定一行三个按钮（这是用户明确要的
 * 「一眼扫到三列」），卡片里最窄要放得下「图标 20 + 间隔 6 + 圆角内边距 16」，
 * 再给中文名留 4~5 个字，三列合计不能低于 330 左右，否则每个名字都是省略号。
 * 上限 600：再宽不如直接收起命令栏，把宽度还给终端。
 */
export const PANE_SPECS: Record<PaneKey, PaneSpec> = {
  sidebar: { default: 280, min: 220, max: 520, axis: 'x', sign: 1 },
  commandRail: { default: 380, min: 340, max: 600, axis: 'x', sign: -1 }
}

export const DEFAULT_LAYOUT: Required<LayoutSizes> = {
  sidebar: PANE_SPECS.sidebar.default,
  commandRail: PANE_SPECS.commandRail.default
}

/** 全部可拖区域（顺序即「设置 → 界面」里的展示顺序） */
export const KEYS: PaneKey[] = ['sidebar', 'commandRail']

/** 区域的中文名（分隔条 aria-label、设置面板共用） */
export const PANE_LABEL: Record<PaneKey, string> = {
  sidebar: '侧边栏',
  commandRail: '命令栏'
}

/** 把任意输入夹到该栏的合法区间；非数字/NaN 回退默认值 */
export function clampPane(key: PaneKey, value: number | undefined | null): number {
  const spec = PANE_SPECS[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return spec.default
  return Math.round(Math.min(spec.max, Math.max(spec.min, value)))
}

/** 合并已存尺寸与默认值，保证每个键都有合法数值 */
export function resolveLayout(saved: LayoutSizes | undefined): Required<LayoutSizes> {
  return {
    sidebar: clampPane('sidebar', saved?.sidebar),
    commandRail: clampPane('commandRail', saved?.commandRail)
  }
}

/**
 * 把一次拖拽的像素位移换算成新的栏尺寸。
 * @param start 拖拽开始时的尺寸
 * @param delta 鼠标位移（px，已按当前指针位置与起点相减）
 */
export function applyDrag(key: PaneKey, start: number, delta: number): number {
  const spec = PANE_SPECS[key]
  return clampPane(key, start + delta * spec.sign)
}

/**
 * 键盘微调（分隔条聚焦后按方向键）：一次 ±step。
 * 符合 aria 的 separator 语义，也让无法精确拖拽的用户有路径。
 *
 * direction 是「分隔条要往哪边挪」：1 = 向右/向下，-1 = 向左/向上。
 * 左侧栏（sign=1）往右挪 = 变宽；右侧命令栏（sign=-1）往右挪 = 变窄。
 */
export function nudgePane(key: PaneKey, current: number, direction: -1 | 1, step = 16): number {
  const spec = PANE_SPECS[key]
  return clampPane(key, current + direction * step * spec.sign)
}

/** 尺寸是否已回到默认（用于决定分隔条是否显示「已自定义」指示） */
export function isDefaultPane(key: PaneKey, value: number): boolean {
  return clampPane(key, value) === PANE_SPECS[key].default
}
