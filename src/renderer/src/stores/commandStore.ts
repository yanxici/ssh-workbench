import { create } from 'zustand'
import type { Command, CommandInput } from '@shared/types'
import { call } from '@/lib/ipc'
import { sortGroupNames } from '@/lib/groupOrder'
import { searchCommands } from '@/lib/commandSearch'
import { useToastStore } from './toastStore'
import { useSettingsStore } from './settingsStore'

/** 手动新建的分组（设置中持久化） */
function savedGroups(): string[] {
  return useSettingsStore.getState().settings.commandGroups ?? []
}

/** 分组自定义顺序（设置中持久化） */
function savedOrder(): string[] {
  return useSettingsStore.getState().settings.commandGroupOrder ?? []
}

/** 收藏（置顶）的命令 id，持久化在设置里 */
function savedPinned(): string[] {
  return useSettingsStore.getState().settings.pinnedCommandIds ?? []
}

/** 保存分组顺序：先本地生效（拖拽无延迟），再落盘 */
async function writeOrder(order: string[]): Promise<void> {
  useSettingsStore.setState((s) => ({ settings: { ...s.settings, commandGroupOrder: order } }))
  await useSettingsStore.getState().update({ commandGroupOrder: order })
}

interface CommandState {
  commands: Command[]
  loaded: boolean
  keyword: string
  /** 分组折叠状态，key = 分组名 */
  collapsed: Record<string, boolean>

  load: () => Promise<void>
  save: (input: CommandInput) => Promise<Command | null>
  remove: (id: string) => Promise<void>
  reorder: (orderedIds: string[]) => Promise<void>
  importJson: (mode: 'merge' | 'replace') => Promise<void>
  exportJson: () => Promise<void>
  setKeyword: (kw: string) => void
  toggleGroup: (group: string) => void
  /** 新建空分组（持久化在设置里，没有命令也会显示） */
  createGroup: (name: string) => Promise<boolean>
  renameGroup: (oldName: string, newName: string) => Promise<void>
  /** 删除分组及其全部命令，返回删除的命令数（失败返回 null） */
  deleteGroup: (group: string) => Promise<number | null>
  /** 保存分组显示顺序（完整的分组名数组） */
  setGroupOrder: (order: string[]) => Promise<void>
  bumpUseCount: (id: string) => void
  /** 收藏 / 取消收藏（持久化在 settings.pinnedCommandIds） */
  togglePin: (id: string) => Promise<void>
}

export const useCommandStore = create<CommandState>()((set, get) => ({
  commands: [],
  loaded: false,
  keyword: '',
  collapsed: {},

  load: async () => {
    const list = await call(window.api.command.list(), { silent: true })
    const commands = [...(list ?? [])].sort((a, b) => a.sortOrder - b.sortOrder)
    set({ commands, loaded: true })
  },

  save: async (input) => {
    const saved = await call(window.api.command.save(input), { errorTitle: '保存命令失败' })
    if (saved) await get().load()
    return saved
  },

  remove: async (id) => {
    const res = await call(window.api.command.remove(id), { silent: true })
    if (res === null) return
    set((s) => ({ commands: s.commands.filter((c) => c.id !== id) }))
  },

  reorder: async (orderedIds) => {
    // 乐观更新本地顺序，随后落盘
    set((s) => {
      const orderMap = new Map(orderedIds.map((id, i) => [id, i]))
      const next = s.commands.map((c) => {
        const order = orderMap.get(c.id)
        return order === undefined ? c : { ...c, sortOrder: order }
      })
      next.sort((a, b) => a.sortOrder - b.sortOrder)
      return { commands: next }
    })
    await call(window.api.command.reorder(orderedIds), { silent: true })
  },

  importJson: async (mode) => {
    const res = await call(window.api.command.import(mode), { errorTitle: '导入失败' })
    if (!res) return
    if (res.canceled) return
    await get().load()
    useToastStore.getState().push({
      kind: 'success',
      title: `导入完成：新增 ${res.imported} 条`,
      detail: res.skipped > 0 ? `跳过重复/无效 ${res.skipped} 条` : undefined
    })
  },

  exportJson: async () => {
    const res = await call(window.api.command.export(), { errorTitle: '导出失败' })
    if (!res || res.canceled) return
    useToastStore.getState().push({
      kind: 'success',
      title: `已导出 ${res.count} 条常用命令`,
      detail: res.path
    })
  },

  setKeyword: (keyword) => set({ keyword }),

  toggleGroup: (group) =>
    set((s) => ({ collapsed: { ...s.collapsed, [group]: !s.collapsed[group] } })),

  createGroup: async (name) => {
    const g = name.trim()
    if (!g) return false
    const exists =
      get().commands.some((c) => (c.group || '默认') === g) || savedGroups().includes(g)
    if (exists) {
      useToastStore.getState().push({ kind: 'warning', title: `分组「${g}」已存在` })
      return false
    }
    await useSettingsStore.getState().update({ commandGroups: [...savedGroups(), g] })
    return true
  },

  renameGroup: async (oldName, newName) => {
    const g = newName.trim()
    if (!g || g === oldName) return
    // 主进程一次读改写完成，避免逐条保存
    const moved = await call(window.api.command.renameGroup(oldName, g), {
      errorTitle: '重命名分组失败'
    })
    if (moved === null) return
    const groups = savedGroups()
    if (groups.includes(oldName) || groups.includes(g)) {
      const next = [...new Set(groups.map((x) => (x === oldName ? g : x)))]
      await useSettingsStore.getState().update({ commandGroups: next })
    }
    // 排序位置随名称一起迁移（改名后不跑到末尾）
    const order = savedOrder()
    if (order.includes(oldName)) {
      await writeOrder([...new Set(order.map((x) => (x === oldName ? g : x)))])
    }
    set((s) => {
      const collapsed = { ...s.collapsed }
      if (oldName in collapsed) {
        collapsed[g] = collapsed[oldName]
        delete collapsed[oldName]
      }
      return { collapsed }
    })
    await get().load()
  },

  deleteGroup: async (group) => {
    const removed = await call(window.api.command.deleteGroup(group), {
      errorTitle: '删除分组失败'
    })
    if (removed === null) return null
    if (savedGroups().includes(group)) {
      await useSettingsStore
        .getState()
        .update({ commandGroups: savedGroups().filter((x) => x !== group) })
    }
    if (savedOrder().includes(group)) {
      await writeOrder(savedOrder().filter((x) => x !== group))
    }
    await get().load()
    return removed
  },

  setGroupOrder: async (order) => {
    await writeOrder([...new Set(order.filter(Boolean))])
  },

  /** 执行后本地自增计数（不等待落盘刷新，体感即时） */
  bumpUseCount: (id) =>
    set((s) => ({
      commands: s.commands.map((c) =>
        c.id === id ? { ...c, useCount: c.useCount + 1, lastUsedAt: Date.now() } : c
      )
    })),

  /**
   * 收藏：写进 settings.pinnedCommandIds。
   * 设置走主进程串行读改写，所以先本地乐观更新再落盘（与分组顺序同一套路），
   * 否则点击后要等一次 IPC 往返才会亮起星标。
   */
  togglePin: async (id) => {
    const cur = savedPinned()
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]
    useSettingsStore.setState((s) => ({ settings: { ...s.settings, pinnedCommandIds: next } }))
    await useSettingsStore.getState().update({ pinnedCommandIds: next })
  }
}))

export interface CommandGroup {
  group: string
  items: Command[]
}

/**
 * 过滤 + 分组（组内保持 sortOrder）。
 * extraGroups 为手动新建的分组，无关键字时空分组也显示；
 * groupOrder 为自定义分组顺序，未列出的分组排在后面按名称排列。
 *
 * 有关键字时走 fuzzy 排序：命中度高的排前面，而不是「包含就留下、顺序照旧」。
 * 旧实现只做 toLowerCase().includes，搜 `gst` 找不到 `git status`，
 * 且过滤后仍按 sortOrder 排，最相关的结果可能沉在最后一条。
 */
export function groupCommands(
  commands: Command[],
  keyword: string,
  extraGroups: string[] = [],
  groupOrder: string[] = []
): CommandGroup[] {
  const kw = keyword.trim()
  if (!kw) {
    const map = new Map<string, Command[]>()
    for (const c of commands) {
      const key = c.group || '默认'
      const list = map.get(key)
      if (list) list.push(c)
      else map.set(key, [c])
    }
    for (const g of extraGroups) if (g && !map.has(g)) map.set(g, [])
    return sortGroupNames([...map.keys()], groupOrder).map((group) => ({
      group,
      items: [...(map.get(group) ?? [])].sort((a, b) => a.sortOrder - b.sortOrder)
    }))
  }

  // 有搜索词：先按相关度排出前 N 条，再按分组归拢；组内顺序 = 相关度顺序
  const ranked = searchCommands({
    commands,
    query: kw,
    scope: { kind: 'all' },
    sort: 'smart',
    pinnedIds: savedPinned()
  }).filter((r) => r.hit)

  const map = new Map<string, Command[]>()
  for (const r of ranked) {
    const key = r.command.group || '默认'
    const list = map.get(key)
    if (list) list.push(r.command)
    else map.set(key, [r.command])
  }
  // 搜索态下组也按「组内最高分」排序：命中密集的分组排在前面
  const groupScore = new Map<string, number>()
  for (const r of ranked) {
    const key = r.command.group || '默认'
    groupScore.set(key, Math.max(groupScore.get(key) ?? 0, r.score))
  }
  return [...map.keys()]
    .sort((a, b) => (groupScore.get(b) ?? 0) - (groupScore.get(a) ?? 0))
    .map((group) => ({ group, items: map.get(group) ?? [] }))
}
