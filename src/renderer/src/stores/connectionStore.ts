import { create } from 'zustand'
import type { Connection, ConnectionInput } from '@shared/types'
import { call } from '@/lib/ipc'
import { useSettingsStore } from './settingsStore'
import { useToastStore } from './toastStore'

/**
 * 连接分组的两套来源：
 * 1. 连接对象自带 group 字段（数据本身）；
 * 2. settings.connectionGroups 里登记的空分组（新建了还没放连接）。
 * 显式登记过的分组按 connectionGroupOrder 排，其余按名称排。
 */

function savedGroups(): string[] {
  return useSettingsStore.getState().settings.connectionGroups ?? []
}

function savedOrder(): string[] {
  return useSettingsStore.getState().settings.connectionGroupOrder ?? []
}

async function writeOrder(order: string[]): Promise<void> {
  const next = [...new Set(order.filter(Boolean))]
  // 先本地乐观写入，避免拖拽后要等一次 IPC 往返才落位
  useSettingsStore.setState((s) => ({
    settings: { ...s.settings, connectionGroupOrder: next }
  }))
  await useSettingsStore.getState().update({ connectionGroupOrder: next })
}

interface ConnectionState {
  connections: Connection[]
  loaded: boolean
  keyword: string
  /** 分组折叠状态，key = 分组名 */
  collapsed: Record<string, boolean>

  load: () => Promise<void>
  save: (input: ConnectionInput) => Promise<Connection | null>
  remove: (id: string) => Promise<boolean>
  setKeyword: (kw: string) => void
  /**
   * 折叠/展开一个分组。
   * currentlyCollapsed 必须传「界面当前的视觉状态」——超长分组是默认折叠但
   * collapsed[group] 仍是 undefined，若只按 !collapsed[group] 取反，
   * 第一次点击会把它设成「折叠」，看起来像点了没反应。
   */
  toggleGroup: (group: string, currentlyCollapsed?: boolean) => void

  /** 新建一个空分组（还不含连接），返回是否成功 */
  createGroup: (name: string) => Promise<boolean>
  /** 重命名分组：整组连接一次迁移 */
  renameGroup: (oldName: string, newName: string) => Promise<void>
  /** 删除分组及其下全部连接，返回删除的连接数；null 表示失败 */
  deleteGroup: (group: string) => Promise<number | null>
  /** 批量把连接移到另一个分组（用于「移到分组」菜单） */
  moveToGroup: (ids: string[], group: string) => Promise<number>
  /** 设置分组显示顺序 */
  setGroupOrder: (order: string[]) => Promise<void>
}

export const useConnectionStore = create<ConnectionState>()((set, get) => ({
  connections: [],
  loaded: false,
  keyword: '',
  collapsed: {},

  load: async () => {
    const list = await call(window.api.conn.list(), { silent: true })
    set({ connections: list ?? [], loaded: true })
  },

  save: async (input) => {
    const saved = await call(window.api.conn.save(input), { errorTitle: '保存连接失败' })
    if (saved) {
      set((s) => {
        const idx = s.connections.findIndex((c) => c.id === saved.id)
        const next = [...s.connections]
        if (idx >= 0) next[idx] = saved
        else next.push(saved)
        return { connections: next }
      })
      // 保存到新分组名时，把它登记进分组表，否则空分组一刷新就消失
      const g = (saved.group || '默认').trim()
      if (g && !savedGroups().includes(g) && !savedOrder().includes(g)) {
        await useSettingsStore.getState().update({ connectionGroups: [...savedGroups(), g] })
      }
    }
    return saved
  },

  remove: async (id) => {
    const res = await call(window.api.conn.remove(id), { silent: true })
    if (res === null) return false
    set((s) => ({ connections: s.connections.filter((c) => c.id !== id) }))
    return true
  },

  setKeyword: (keyword) => set({ keyword }),

  toggleGroup: (group, currentlyCollapsed) =>
    set((s) => ({
      collapsed: {
        ...s.collapsed,
        // 有显式状态就按它取反（这是默认折叠分组第一次点击的正确行为）
        [group]: currentlyCollapsed !== undefined ? !currentlyCollapsed : !s.collapsed[group]
      }
    })),

  createGroup: async (name) => {
    const g = name.trim()
    if (!g) return false
    const exists =
      get().connections.some((c) => (c.group || '默认') === g) || savedGroups().includes(g)
    if (exists) {
      useToastStore.getState().push({ kind: 'warning', title: `分组「${g}」已存在` })
      return false
    }
    await useSettingsStore.getState().update({ connectionGroups: [...savedGroups(), g] })
    return true
  },

  renameGroup: async (oldName, newName) => {
    const g = newName.trim()
    if (!g || g === oldName) return
    // 目标名已被占用：拒绝并提示，避免两组合并成一组这种意外
    const clash =
      get().connections.some((c) => (c.group || '默认') === g) ||
      savedGroups().includes(g)
    if (clash) {
      useToastStore.getState().push({ kind: 'warning', title: `分组「${g}」已存在` })
      return
    }

    // 主进程一次读改写完成，避免逐条保存
    const moved = await call(window.api.conn.renameGroup(oldName, g), {
      errorTitle: '重命名分组失败'
    })
    if (moved === null) return

    const groups = savedGroups().filter((x) => x !== oldName)
    if (!groups.includes(g)) groups.push(g)
    await useSettingsStore.getState().update({ connectionGroups: groups })

    // 排序位置随名称一起迁移（改名后不跑到末尾）
    const order = savedOrder()
    if (order.includes(oldName)) {
      await writeOrder([...new Set(order.map((x) => (x === oldName ? g : x)))])
    }

    // 折叠状态跟随名称迁移
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
    const removed = await call(window.api.conn.deleteGroup(group), {
      errorTitle: '删除分组失败'
    })
    if (removed === null) return null
    if (savedGroups().includes(group)) {
      await useSettingsStore
        .getState()
        .update({ connectionGroups: savedGroups().filter((x) => x !== group) })
    }
    if (savedOrder().includes(group)) {
      await writeOrder(savedOrder().filter((x) => x !== group))
    }
    await get().load()
    return removed
  },

  moveToGroup: async (ids, group) => {
    const g = group.trim()
    if (!g || ids.length === 0) return 0
    const targets = get().connections.filter((c) => ids.includes(c.id))
    let moved = 0
    for (const c of targets) {
      if ((c.group || '默认') === g) continue
      const saved = await call(
        window.api.conn.save({
          id: c.id,
          name: c.name,
          host: c.host,
          port: c.port,
          username: c.username,
          authType: c.authType,
          privateKeyPath: c.privateKeyPath,
          group: g,
          tags: c.tags,
          color: c.color,
          remark: c.remark,
          proxyJump: c.proxyJump,
          proxy: c.proxy
        }),
        { errorTitle: '移动分组失败' }
      )
      if (saved) moved++
    }
    if (moved > 0) {
      if (!savedGroups().includes(g)) {
        await useSettingsStore.getState().update({ connectionGroups: [...savedGroups(), g] })
      }
      await get().load()
    }
    return moved
  },

  setGroupOrder: async (order) => {
    await writeOrder(order)
  }
}))

export interface ConnectionGroup {
  group: string
  items: Connection[]
}

/**
 * 过滤 + 按分组聚合并排序（最近使用的排前面）。
 *
 * 空分组也要出现在列表里 —— 用户新建分组后立刻能看到并往里放连接，
 * 否则「新建分组」点了像没反应。空分组只来自 settings.connectionGroups。
 */
export function groupConnections(
  connections: Connection[],
  keyword: string,
  extraGroups: string[] = [],
  order: string[] = []
): ConnectionGroup[] {
  const kw = keyword.trim().toLowerCase()
  const filtered = kw
    ? connections.filter(
        (c) =>
          c.name.toLowerCase().includes(kw) ||
          c.host.toLowerCase().includes(kw) ||
          c.username.toLowerCase().includes(kw) ||
          c.group.toLowerCase().includes(kw) ||
          c.tags.some((t) => t.toLowerCase().includes(kw))
      )
    : connections

  const map = new Map<string, Connection[]>()
  for (const c of filtered) {
    const key = c.group || '默认'
    const list = map.get(key)
    if (list) list.push(c)
    else map.set(key, [c])
  }

  /*
   * 搜索时只显示有命中的分组：空分组在搜索语境下是噪音，
   * 用户找的是某条连接，不是某个还没放东西的目录。
   */
  if (!kw) {
    for (const g of extraGroups) {
      if (g && g.trim() && !map.has(g)) map.set(g, [])
    }
  }

  const rank = new Map(order.map((g, i) => [g, i]))
  const byName = (a: string, b: string): number => {
    const ra = rank.get(a)
    const rb = rank.get(b)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return a.localeCompare(b, 'zh-CN')
  }

  return [...map.entries()]
    .sort(([a], [b]) => byName(a, b))
    .map(([group, items]) => ({
      group,
      items: [...items].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    }))
}
