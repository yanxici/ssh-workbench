import { create } from 'zustand'
import type { Command, CommandInput } from '@shared/types'
import { call } from '@/lib/ipc'
import { sortGroupNames } from '@/lib/groupOrder'
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
    }))
}))

export interface CommandGroup {
  group: string
  items: Command[]
}

/**
 * 过滤 + 分组（组内保持 sortOrder）。
 * extraGroups 为手动新建的分组，无关键字时空分组也显示；
 * groupOrder 为自定义分组顺序，未列出的分组排在后面按名称排列。
 */
export function groupCommands(
  commands: Command[],
  keyword: string,
  extraGroups: string[] = [],
  groupOrder: string[] = []
): CommandGroup[] {
  const kw = keyword.trim().toLowerCase()
  const filtered = kw
    ? commands.filter(
        (c) =>
          c.name.toLowerCase().includes(kw) ||
          c.command.toLowerCase().includes(kw) ||
          (c.description ?? '').toLowerCase().includes(kw) ||
          c.group.toLowerCase().includes(kw)
      )
    : commands

  const map = new Map<string, Command[]>()
  for (const c of filtered) {
    const key = c.group || '默认'
    const list = map.get(key)
    if (list) list.push(c)
    else map.set(key, [c])
  }
  if (!kw) {
    for (const g of extraGroups) if (g && !map.has(g)) map.set(g, [])
  }

  return sortGroupNames([...map.keys()], groupOrder).map((group) => ({
    group,
    items: [...(map.get(group) ?? [])].sort((a, b) => a.sortOrder - b.sortOrder)
  }))
}
