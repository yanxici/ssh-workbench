import { create } from 'zustand'
import type { PersistedPane, SplitLayoutMap } from '@shared/types'
import { uid } from '@/lib/utils'
import { useSessionStore } from './sessionStore'
import { useSettingsStore } from './settingsStore'
import { useToastStore } from './toastStore'
import { resetPaneIndex, setPaneOwner } from '@/lib/paneRegistry'
import {
  MAX_PANES,
  countLeaves,
  isLeaf,
  leafIds,
  removeLeaf,
  replaceLeaf,
  setRatio,
  type PaneDir,
  type PaneNode
} from '@/lib/paneTree'

/**
 * 分屏状态：一个标签 = 一棵 pane 树。
 *
 * 树按**标签自身的 sessionId**（owner）存。会话列表仍然是唯一的「有哪些终端」，
 * 树只描述「这一屏里怎么摆」。因此：
 *   - 不在任何树里的会话 = 单格标签（绝大多数情况，零额外开销）；
 *   - 树里只剩一格时直接把树删掉，那一格重新变成普通标签（不需要「折叠」这个动作）。
 *
 * 为什么不做跨连接分屏：新格是靠 session.openShell 复用**同一条 SSH 连接**开的
 * （与「新建终端（复用此连接）」完全同一条链路）。跨连接要再建一条独立连接，
 * 还要处理两套重连/延迟/断开遮罩的差异，收益远小于复杂度。
 */

interface SplitState {
  /** owner sessionId -> 树 */
  trees: Record<string, PaneNode>
  /**
   * 同步输入开关：owner sessionId -> 是否开启。
   *
   * 按**标签**存而不是按会话存：同步是「这一屏里所有格子一起收字」的临时状态，
   * 焦点在哪一格不影响它属于哪个标签。刻意不持久化 —— 下次启动的标签是新的
   * sessionId，恢复出来的开关会指向不存在的标签，等于给下一次开机埋一个
   * 「敲字进了四台机器」的惊喜。
   */
  syncByTab: Record<string, boolean>
  /**
   * 正在拖分隔条。TerminalView 的 fit 会查这个开关直接跳过 ——
   * 拖动期间每帧 fit 会让 xterm 重排整屏，画面抖得没法用。
   */
  draggingSplit: boolean
  /** 拖拽结束后自增，所有已挂载终端据此各 fit 一次 */
  refitTick: number

  splitPane: (sessionId: string, dir: PaneDir) => string | null
  closePane: (sessionId: string) => void
  closeTab: (ownerId: string) => void
  closeOtherTabs: (ownerId: string) => void
  setSplitRatio: (ownerId: string, splitId: string, ratio: number) => void
  setDragging: (dragging: boolean) => void
  /** 切换某标签的同步输入；单窗格时直接拒绝（没有「其他格子」可同步） */
  toggleSync: (ownerId: string) => void
  /** 关掉某标签的同步输入（关分屏 / 关标签时自动调用） */
  clearSync: (ownerId: string) => void
  /** 会话列表变了之后清掉指向已消失会话的格子 */
  reconcile: () => void
  /** 从持久化结构恢复某标签的分屏（由 App 在会话连上后调用） */
  restoreFor: (sessionId: string) => void
}

/** 把树里所有叶子重新登记到共享索引（每次 set 之后调一次） */
function reindex(trees: Record<string, PaneNode>): void {
  resetPaneIndex()
  for (const [ownerId, node] of Object.entries(trees)) {
    for (const id of leafIds(node)) setPaneOwner(id, ownerId)
  }
}

function ownerFor(trees: Record<string, PaneNode>, sessionId: string): string | null {
  for (const [ownerId, node] of Object.entries(trees)) {
    if (leafIds(node).includes(sessionId)) return ownerId
  }
  return null
}

/* ------------------------------------------------------------------ *
 *  持久化：树里存 connectionId，不存 sessionId
 * ------------------------------------------------------------------ */

/**
 * 为什么存 connectionId：sessionId 每次启动都是新的（uid()），存它下次启动
 * 一个都对不上。connectionId 是用户资产，跨启动稳定。
 * 代价是恢复时要把 connectionId 换回「这次启动新建的会话」——
 * 由于分屏只在同一连接内，恢复顺序是确定的：第一个叶子复用标签自身的会话，
 * 其余按顺序各开一个 shell。
 */
function encodeTree(node: PaneNode, connOf: (sessionId: string) => string | null): PersistedPane | null {
  if (isLeaf(node)) {
    const c = connOf(node.sessionId)
    return c ? { t: 'l', c } : null
  }
  const a = encodeTree(node.children[0], connOf)
  const b = encodeTree(node.children[1], connOf)
  if (!a || !b) return null
  return { t: 's', d: node.dir, r: node.ratio, k: [a, b] }
}

function persistedOwnerConnection(ownerId: string): string | null {
  const conn = useSessionStore.getState().sessions.find((s) => s.id === ownerId)?.connectionId
  return conn ?? null
}

/** 把当前全部树写回设置（合并：只覆盖本次有树的连接，其余保持原样） */
function persist(trees: Record<string, PaneNode>): void {
  const { sessions } = useSessionStore.getState()
  const connOf = (sessionId: string): string | null =>
    sessions.find((s) => s.id === sessionId)?.connectionId ?? null

  /*
   * 在**已有**布局上合并，不要用当前打开的树整张覆盖：
   * 用户这一刻只开了 A 连接的分屏，B/C 的分屏记录不该因为「没打开」就被抹掉。
   * 反过来，某连接当前是单格（没有树）时必须把它那条删掉，否则把分屏合回去
   * 之后重启又会按旧记录重新裂开。
   */
  const layout: SplitLayoutMap = { ...(useSettingsStore.getState().settings.splitLayout ?? {}) }
  const splitConns = new Set<string>()
  /*
   * 注意下面收集 splitConns 时**也要算上副窗格所属的连接**：
   * 删旧记录的判据是「当前没有树」，而分屏的另一半（connB 开成 connA 里的
   * 副窗格）本来就没有自己的树 —— 旧实现会把它的记录一起删掉，
   * 用户把 connB 从分屏里拆出来后，它曾经的分屏布局已经凭空没了。
   */
  for (const [ownerId, node] of Object.entries(trees)) {
    const conn = persistedOwnerConnection(ownerId)
    if (!conn) continue
    const enc = encodeTree(node, connOf)
    if (enc) {
      layout[conn] = enc
      splitConns.add(conn)
      // 副窗格所属的连接也算「有分屏记录」，别被下面的清理误删
      for (const id of leafIds(node)) {
        const leafConn = connOf(id)
        if (leafConn) splitConns.add(leafConn)
      }
    }
  }
  for (const s of sessions) {
    if (!splitConns.has(s.connectionId)) delete layout[s.connectionId]
  }
  /*
   * 先同步乐观更新内存里的 settings，再发异步 IPC。
   *
   * 这条顺序是必须的：update() 要等主进程回包才 set，期间 settings.splitLayout
   * 还是旧值。关掉 2 格分屏里的一格后，React 立刻提交 sessions=[s2] 的那一帧，
   * App 的恢复 effect 读到的 layout 仍是那份 2 格记录、trees[s2] 又已被删掉，
   * 于是当场 restoreFor(s2) 把刚关掉的分屏再裂一遍 —— 窗格「复活」。
   * 自己写第一手，读到的就永远是最新意图。
   */
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, splitLayout: layout } }))
  /*
   * 只有树（多格）才有必要存；单格标签下次照常由 lastOpenSessions 恢复。
   * 这里刻意不 await：拖拽松手时落盘不能卡住 UI。
   */
  void useSettingsStore.getState().update({ splitLayout: layout })
}

export const useSplitStore = create<SplitState>()((set, get) => ({
  trees: {},
  syncByTab: {},
  draggingSplit: false,
  refitTick: 0,

  splitPane: (sessionId, dir) => {
    const { trees } = get()
    const ownerId = ownerFor(trees, sessionId) ?? sessionId
    const base = trees[ownerId] ?? { type: 'leaf', sessionId }
    if (countLeaves(base) >= MAX_PANES) {
      useToastStore.getState().push({
        kind: 'warning',
        title: `最多 ${MAX_PANES} 个分屏`,
        detail: '再分下去每格宽度不足 300px，先关掉一个再分'
      })
      return null
    }
    // 复用同一连接开新 shell；失败（未连接）会自己 toast，这里直接放弃
    const newId = useSessionStore.getState().openTerminal(sessionId)
    if (!newId) return null

    const next = replaceLeaf(base, sessionId, {
      type: 'split',
      id: uid(),
      dir,
      ratio: 0.5,
      children: [{ type: 'leaf', sessionId }, { type: 'leaf', sessionId: newId }]
    })
    const out = { ...trees, [ownerId]: next }
    reindex(out)
    set({ trees: out })
    persist(out)
    return newId
  },

  closePane: (sessionId) => {
    const { trees } = get()
    const ownerId = ownerFor(trees, sessionId)
    // 不在树里 = 单格标签，等价于关标签
    if (!ownerId) {
      useSessionStore.getState().close(sessionId)
      return
    }
    const node = trees[ownerId]
    const next = removeLeaf(node, sessionId)
    /*
     * 焦点交接必须在 close() 之前判断：close() 会顺手把 activeId 挪到相邻
     * 会话上，而那可能正好是刚变成隐藏嵌套格的那一个，事后再比对永不成立。
     */
    const wasActive = useSessionStore.getState().activeId === sessionId
    useSessionStore.getState().close(sessionId)

    const out = { ...trees }
    delete out[ownerId]
    if (!next || isLeaf(next)) {
      /*
       * 缩回单窗格 = 没有「其他格子」可同步了，开关必须跟着消失。
       * 留着它会变成一颗哑弹：下次在同一标签里再分屏，用户以为自己开的是
       * 一次新的同步，实际上上一次的开启状态还在，敲的字直接进了所有窗格。
       */
      get().clearSync(ownerId)
    } else {
      const rootId = rootKeyFor(ownerId, next)
      moveSyncFlag(ownerId, rootId)
      out[rootId] = next
    }

    /*
     * 顺序很关键：先把新树写进 store 并刷新映射，再交接焦点。
     * 旧实现先 setActive 后 reindex，paneOwnerOf 在这中间读到的是旧树 ——
     * 焦点落在一个已经不存在的窗格上，下一次分屏会按错的 owner 建树。
     */
    reindex(out)
    set({ trees: out })
    persist(out)
    // 焦点接管：关掉的那格如果是焦点，交给剩下的第一格
    if (wasActive && next) {
      const fallback = leafIds(next)[0]
      if (fallback) useSessionStore.getState().setActive(fallback)
    }
  },

  closeTab: (ownerId) => {
    const { trees } = get()
    const node = trees[ownerId]
    if (!node) {
      useSessionStore.getState().close(ownerId)
      return
    }
    /*
     * 整标签一次摘掉，不能复用 closePane 逐格关。
     *
     * 逐格关时关掉第 1 格、树上还剩 1 格，persist 走「单格 = 没有分屏」分支
     * 把 settings.splitLayout[connId] 删掉 —— 用户只是关标签，下次重开这个连接
     * 就再也拿不回自己的分屏了。关整标签必须保留布局记录。
     *
     * 做法：先把树从 store 里摘掉（persist 只会看到「这个连接没有树」，
     * 而它的 session 也刚被关掉，清理循环不会碰它），再逐个关 shell。
     */
    const ids = leafIds(node)
    const out = { ...trees }
    delete out[ownerId]
    reindex(out)
    get().clearSync(ownerId)
    set({ trees: out })
    // 每个 shell 都要单独 session.close，一次性从 sessions 里抹掉会漏掉主进程侧
    for (const id of ids) useSessionStore.getState().close(id)
    persist(out)
  },

  closeOtherTabs: (ownerId) => {
    const { trees } = get()
    const { closeTab } = get()
    const keep = new Set(trees[ownerId] ? leafIds(trees[ownerId]) : [ownerId])
    for (const s of useSessionStore.getState().sessions) {
      if (!keep.has(s.id) && !isNestedPaneLocal(trees, s.id, keep)) closeTab(s.id)
    }
  },

  setSplitRatio: (ownerId, splitId, ratio) => {
    const { trees } = get()
    const node = trees[ownerId]
    if (!node) return
    const next = setRatio(node, splitId, ratio)
    if (next === node) return
    const out = { ...trees, [ownerId]: next }
    set({ trees: out })
  },

  setDragging: (dragging) => {
    set(dragging ? { draggingSplit: true } : { draggingSplit: false, refitTick: get().refitTick + 1 })
    // 松手才落盘：拖拽期间每帧写 settings.json 是纯浪费
    if (!dragging) persist(get().trees)
  },

  toggleSync: (ownerId) => {
    const { trees, syncByTab } = get()
    const node = trees[ownerId]
    // 单窗格没有「其他格子」，开了只会让用户以为同步生效了
    if (!node || isLeaf(node)) return
    const next = { ...syncByTab }
    if (next[ownerId]) delete next[ownerId]
    else next[ownerId] = true
    set({ syncByTab: next })
  },

  clearSync: (ownerId) => {
    const { syncByTab } = get()
    if (!syncByTab[ownerId]) return
    const next = { ...syncByTab }
    delete next[ownerId]
    set({ syncByTab: next })
  },

  reconcile: () => {
    const { trees } = get()
    const alive = new Set(useSessionStore.getState().sessions.map((s) => s.id))
    let changed = false
    const out: Record<string, PaneNode> = {}
    for (const [ownerId, node] of Object.entries(trees)) {
      let cur: PaneNode | null = node
      for (const id of leafIds(node)) {
        if (!alive.has(id)) cur = cur ? removeLeaf(cur, id) : null
      }
      if (!cur || isLeaf(cur)) {
        changed = true
        // 会话掉线后树被收缩成单格：同步开关同样失效（理由见 closePane）
        if (get().syncByTab[ownerId]) get().clearSync(ownerId)
        continue
      }
      if (cur !== node) changed = true
      /*
       * 树根可能是一格已经消失的会话（owner 自己先死了）。继续拿死 id 当键，
       * reindex 会把剩下的格子全登记成「别人的嵌套格」，TabBar / 工作区按
       * isNestedPane 过滤后整个标签从界面上消失。换到还活着的第一格。
       */
      const rootId = rootKeyFor(ownerId, cur)
      if (rootId !== ownerId) {
        changed = true
        moveSyncFlag(ownerId, rootId)
      }
      out[rootId] = cur
    }
    if (!changed) return
    reindex(out)
    set({ trees: out })
  },

  restoreFor: (sessionId) => {
    const { trees } = get()
    if (trees[sessionId]) return
    /*
     * 已经是别人树里的一格就直接放弃。分屏格同样会 connected、同样带
     * connectionId，放它进来就会按同一个布局再开一整棵树（s3、s4……无限）。
     */
    if (ownerFor(trees, sessionId)) return
    const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
    if (!session) return
    const saved = useSettingsStore.getState().settings.splitLayout?.[session.connectionId]
    if (!saved) return
    // 单格布局没有恢复价值（就是普通标签）
    if (saved.t !== 's') return

    /*
     * 按顺序补开 shell。
     * openTerminal 是同步插入会话、异步建连的，所以这里可以连续调用 ——
     * 第一格的 sessionId 直接用标签自身的，后面每格各要一个新 id。
     * 任一步返回 null（未连接/失败）就停在当前格数，不把半成品树写进 store。
     */
    const ids: string[] = [sessionId]
    const need = persistedLeafCount(saved) - 1
    for (let i = 0; i < need; i++) {
      const id = useSessionStore.getState().openTerminal(sessionId)
      if (!id) break
      ids.push(id)
    }
    if (ids.length < 2) return

    let cursor = 0
    const build = (p: PersistedPane): PaneNode | null => {
      if (p.t === 'l') {
        const id = ids[cursor++]
        return id ? { type: 'leaf', sessionId: id } : null
      }
      const a = build(p.k[0])
      const b = build(p.k[1])
      if (!a || !b) return null
      return { type: 'split', id: uid(), dir: p.d, ratio: p.r, children: [a, b] }
    }
    const node = build(saved)
    if (!node || isLeaf(node)) return
    const out = { ...trees, [sessionId]: node }
    reindex(out)
    set({ trees: out })
  }
}))

function persistedLeafCount(p: PersistedPane): number {
  if (p.t === 'l') return 1
  return persistedLeafCount(p.k[0]) + persistedLeafCount(p.k[1])
}

/**
 * 树根的键必须是这一屏里还活着的一格。
 * 关掉原来的标签（树根那格）后，剩下的 split 子树不能继续挂在死 id 下 ——
 * 否则所有叶子都会被登记成「别人的分屏格」而被界面过滤掉。
 */
function rootKeyFor(ownerId: string, node: PaneNode): string {
  const ids = leafIds(node)
  if (ids.includes(ownerId)) return ownerId
  return ids[0] ?? ownerId
}

/** 树换了根键时把同步开关跟着搬过去（开关按标签存） */
function moveSyncFlag(from: string, to: string): void {
  if (from === to) return
  const { syncByTab } = useSplitStore.getState()
  if (!syncByTab[from]) return
  const next = { ...syncByTab }
  delete next[from]
  next[to] = true
  useSplitStore.setState({ syncByTab: next })
}

/** closeOtherTabs 内部用：判断某会话是否在「要保留的格子集合」里 */
function isNestedPaneLocal(
  trees: Record<string, PaneNode>,
  sessionId: string,
  keep: Set<string>
): boolean {
  if (keep.has(sessionId)) return true
  for (const node of Object.values(trees)) {
    if (leafIds(node).includes(sessionId) && leafIds(node).every((id) => keep.has(id))) return true
  }
  return false
}
