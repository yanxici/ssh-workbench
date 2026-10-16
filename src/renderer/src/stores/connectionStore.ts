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
  toggleGroup: (group: string) => void
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

  toggleGroup: (group) =>
    set((s) => ({ collapsed: { ...s.collapsed, [group]: !s.collapsed[group] } }))
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
