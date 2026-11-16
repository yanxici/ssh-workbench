/**
 * 分屏（pane 树）的纯几何/结构逻辑。
 *
 * 为什么把这些放进单独一个零依赖文件：树形结构的增删改 + 百分比矩形计算
 * 是整个分屏功能里唯一「想错了就整块错」的部分 —— 渲染、拖拽、焦点移动、
 * 持久化全都建立在它上面。抽出来之后可以用 esbuild 直接打成 CJS 跑断言
 * （见 scripts/verify-pane-tree.cjs），不必起 Electron 就能覆盖边界情况。
 *
 * 坐标一律用**百分比**（0~100），不含 px：
 * 分屏容器宽度随窗口变，写死 px 在窗口缩放后要重算一遍所有节点；
 * 百分比让 CSS 自己跟着走，JS 只在拖拽时把指针位移换算成比例。
 */

export type PaneDir = 'row' | 'col'

export interface PaneLeaf {
  type: 'leaf'
  sessionId: string
}

export interface PaneSplit {
  type: 'split'
  /** 分隔条拖拽与 ratio 更新都按 id 定位，避免在嵌套树里传「第几个孩子」的路径 */
  id: string
  /** row = 左右并排（竖分隔条）；col = 上下堆叠（横分隔条） */
  dir: PaneDir
  /** 第一个孩子占的比例，0~1 */
  ratio: number
  children: [PaneNode, PaneNode]
}

export type PaneNode = PaneLeaf | PaneSplit

export interface PaneRect {
  x: number
  y: number
  w: number
  h: number
}

export interface PaneDivider {
  id: string
  dir: PaneDir
  /** 分隔条自身的位置（一条线，宽或高由渲染层给 6px 热区） */
  rect: PaneRect
  /**
   * 所属 split 节点的完整矩形。
   * 拖拽时必须按它换算比例，而不是按整个容器 —— 嵌套时内层 split 只占
   * 一小块，用容器宽度算会把指针位移放大约一倍，拖动会「飞出去」。
   */
  splitRect: PaneRect
}

/** 一格标签里最多几个 pane。超过 4 个每格不到 300px，80 列都放不下 */
export const MAX_PANES = 4

/** 比例上下限：拖到 0 或 1 会让一格彻底消失，且再也拖不回来 */
export const MIN_RATIO = 0.15
export const MAX_RATIO = 0.85

export function isLeaf(node: PaneNode): node is PaneLeaf {
  return node.type === 'leaf'
}

export function normalizeRatio(value: number): number {
  if (!Number.isFinite(value)) return 0.5
  if (value < MIN_RATIO) return MIN_RATIO
  if (value > MAX_RATIO) return MAX_RATIO
  return value
}

/** 树里所有叶子（顺序 = 从左到右、从上到下） */
export function leafIds(node: PaneNode): string[] {
  if (isLeaf(node)) return [node.sessionId]
  return [...leafIds(node.children[0]), ...leafIds(node.children[1])]
}

export function countLeaves(node: PaneNode): number {
  return leafIds(node).length
}

export function containsSession(node: PaneNode, sessionId: string): boolean {
  if (isLeaf(node)) return node.sessionId === sessionId
  return containsSession(node.children[0], sessionId) || containsSession(node.children[1], sessionId)
}

/**
 * 计算每个叶子的矩形与所有分隔条。
 *
 * 不扣 gap：格子之间的缝由渲染层用 padding 让出来。
 * 如果在这里扣 gap，比例换算就多了一个「减去几像素」的常量，
 * 拖到最右时会差几个像素对不齐 —— 视觉上的缝不值得换这个复杂度。
 */
export function layoutPaneTree(node: PaneNode): {
  rects: Map<string, PaneRect>
  dividers: PaneDivider[]
} {
  const rects = new Map<string, PaneRect>()
  const dividers: PaneDivider[] = []

  const walk = (cur: PaneNode, rect: PaneRect): void => {
    if (isLeaf(cur)) {
      rects.set(cur.sessionId, rect)
      return
    }
    const ratio = normalizeRatio(cur.ratio)
    if (cur.dir === 'row') {
      const wA = rect.w * ratio
      walk(cur.children[0], { x: rect.x, y: rect.y, w: wA, h: rect.h })
      walk(cur.children[1], { x: rect.x + wA, y: rect.y, w: rect.w - wA, h: rect.h })
      dividers.push({
        id: cur.id,
        dir: 'row',
        rect: { x: rect.x + wA, y: rect.y, w: 0, h: rect.h },
        splitRect: rect
      })
    } else {
      const hA = rect.h * ratio
      walk(cur.children[0], { x: rect.x, y: rect.y, w: rect.w, h: hA })
      walk(cur.children[1], { x: rect.x, y: rect.y + hA, w: rect.w, h: rect.h - hA })
      dividers.push({
        id: cur.id,
        dir: 'col',
        rect: { x: rect.x, y: rect.y + hA, w: rect.w, h: 0 },
        splitRect: rect
      })
    }
  }

  walk(node, { x: 0, y: 0, w: 100, h: 100 })
  return { rects, dividers }
}

/** 把某个叶子换成新节点（分屏就是「把叶子换成 split」） */
export function replaceLeaf(node: PaneNode, sessionId: string, next: PaneNode): PaneNode {
  if (isLeaf(node)) return node.sessionId === sessionId ? next : node
  return {
    ...node,
    children: [
      replaceLeaf(node.children[0], sessionId, next),
      replaceLeaf(node.children[1], sessionId, next)
    ]
  }
}

/**
 * 删掉一个叶子，并把因此只剩一个孩子的 split 塌缩掉。
 * 返回 null 表示整棵树空了（最后一个 pane 也没了 —— 调用方据此把标签折叠成单终端）。
 */
export function removeLeaf(node: PaneNode, sessionId: string): PaneNode | null {
  if (isLeaf(node)) return node.sessionId === sessionId ? null : node
  const a = removeLeaf(node.children[0], sessionId)
  const b = removeLeaf(node.children[1], sessionId)
  if (a === null) return b
  if (b === null) return a
  return { ...node, children: [a, b] }
}

/** 按 split 的 id 更新比例；找不到就原样返回（拖拽期间高频调用，不能抛错） */
export function setRatio(node: PaneNode, id: string, ratio: number): PaneNode {
  if (isLeaf(node)) return node
  if (node.id === id) return { ...node, ratio: normalizeRatio(ratio) }
  const a = setRatio(node.children[0], id, ratio)
  const b = setRatio(node.children[1], id, ratio)
  if (a === node.children[0] && b === node.children[1]) return node
  return { ...node, children: [a, b] }
}

/**
 * 找某个格子在指定方向上的邻居。
 *
 * 判据：中心点在目标方向的半平面内，且与该方向的边界不重叠。
 * 在候选里优先「有正交方向重叠」（看得见的邻居），其次按中心距最近。
 * 不用 DOM 的 getBoundingClientRect —— 焦点移动要能在树结构上算，
 * 才和渲染顺序、隐藏标签（display:none 拿不到 rect）解耦。
 */
export function neighbor(
  rects: Map<string, PaneRect>,
  sessionId: string,
  dir: 'left' | 'right' | 'up' | 'down'
): string | null {
  const from = rects.get(sessionId)
  if (!from) return null
  const cx = from.x + from.w / 2
  const cy = from.y + from.h / 2

  let best: { id: string; score: number; overlap: number } | null = null
  for (const [id, r] of rects) {
    if (id === sessionId) continue
    const rx = r.x + r.w / 2
    const ry = r.y + r.h / 2
    let ok = false
    let score = 0
    let overlap = 0
    if (dir === 'left') {
      ok = rx < cx - 0.01
      score = cx - rx
      overlap = overlapLen(from.y, from.y + from.h, r.y, r.y + r.h)
    } else if (dir === 'right') {
      ok = rx > cx + 0.01
      score = rx - cx
      overlap = overlapLen(from.y, from.y + from.h, r.y, r.y + r.h)
    } else if (dir === 'up') {
      ok = ry < cy - 0.01
      score = cy - ry
      overlap = overlapLen(from.x, from.x + from.w, r.x, r.x + r.w)
    } else {
      ok = ry > cy + 0.01
      score = ry - cy
      overlap = overlapLen(from.x, from.x + from.w, r.x, r.x + r.w)
    }
    if (!ok) continue
    /*
     * 候选排序：正交换方向上「有重叠」优先于「只是斜对角的」，
     * 同一档里再比中心距。
     *
     * 不分档的话，斜对角那一格的位移更短，会把焦点抢过去 ——
     * 2×2 分屏里从左上按右键，本该到右上，实际跳到右下。
     */
    if (!best) {
      best = { id, score, overlap }
      continue
    }
    const strictSide = overlap > 0 && best.overlap <= 0
    const sameSide = overlap > 0 === best.overlap > 0
    if (strictSide || (sameSide && score < best.score)) best = { id, score, overlap }
  }
  return best?.id ?? null
}

function overlapLen(a1: number, a2: number, b1: number, b2: number): number {
  return Math.max(0, Math.min(a2, b2) - Math.max(a1, b1))
}
