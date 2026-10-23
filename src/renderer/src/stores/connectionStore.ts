import { create } from 'zustand'
import type { Connection, ConnectionInput } from '@shared/types'
import { call } from '@/lib/ipc'

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
}

export const useConnectionStore = create<ConnectionState>()((set) => ({
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
        [group]:
          currentlyCollapsed !== undefined
            ? !currentlyCollapsed
            : !s.collapsed[group]
      }
    }))
}))

export interface ConnectionGroup {
  group: string
  items: Connection[]
}

/** 过滤 + 按分组聚合并排序（最近使用的排前面） */
export function groupConnections(connections: Connection[], keyword: string): ConnectionGroup[] {
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

  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
    .map(([group, items]) => ({
      group,
      items: [...items].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    }))
}
