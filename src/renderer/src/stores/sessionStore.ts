import { create } from 'zustand'
import type { ConnStatus } from '@shared/types'
import type { Terminal } from '@xterm/xterm'
import type { FitAddon } from '@xterm/addon-fit'
import type { SearchAddon } from '@xterm/addon-search'
import { uid } from '@/lib/utils'
import { useToastStore } from './toastStore'

/**
 * 终端实例注册表：TerminalView 挂载时注册，卸载时注销。
 * 会话事件（EVT_SESSION_DATA）到达时按 sessionId 直接写入对应 xterm。
 */
export interface TerminalEntry {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
}

export const terminalRegistry = new Map<string, TerminalEntry>()

export interface SessionUi {
  id: string
  connectionId: string
  connectionName: string
  host: string
  username: string
  title: string
  status: ConnStatus
  error?: string
  latencyMs?: number
  cols: number
  rows: number
  createdAt: number
}

export type SidebarView = 'connections' | 'history' | 'logs' | 'tunnels'

interface SessionState {
  sessions: SessionUi[]
  activeId: string | null
  panelVisible: boolean
  /** 终端左侧的文件树面板 */
  fileTreeVisible: boolean
  sidebarView: SidebarView

  open: (conn: { id: string; name: string; host: string; username: string }) => string
  /** 断开 / 失败的会话原地重连（同一标签、保留终端内容） */
  reconnect: (id: string) => void
  /** 在指定会话的 SSH 连接上新建一个终端标签（免重新登录），返回新会话 id */
  openTerminal: (hostId: string) => string | null
  close: (id: string) => void
  closeOthers: (id: string) => void
  setActive: (id: string) => void
  setTitle: (id: string, title: string) => void
  updateStatus: (id: string, status: ConnStatus, error?: string) => void
  updateLatency: (id: string, ms: number) => void
  setSize: (id: string, cols: number, rows: number) => void
  reorder: (from: number, to: number) => void
  cycle: (delta: 1 | -1) => void
  togglePanel: () => void
  toggleFileTree: () => void
  setSidebarView: (view: SidebarView) => void
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  activeId: null,
  panelVisible: true,
  fileTreeVisible: false,
  sidebarView: 'connections',

  open: (conn) => {
    const id = uid()
    const session: SessionUi = {
      id,
      connectionId: conn.id,
      connectionName: conn.name,
      host: conn.host,
      username: conn.username,
      title: conn.name,
      status: 'connecting',
      cols: 80,
      rows: 24,
      createdAt: Date.now()
    }
    // 连接即打开左侧文件树（与 XTerminal 一致的使用习惯）
    set((s) => ({ sessions: [...s.sessions, session], activeId: id, fileTreeVisible: true }))

    // 后台建立连接；终端挂载后会把真实尺寸通过 resize 同步过去
    void window.api.session
      .open({ sessionId: id, connectionId: conn.id, cols: 80, rows: 24 })
      .then((res) => {
        if (!res.ok) {
          get().updateStatus(id, 'error', res.error)
          useToastStore.getState().push({
            kind: 'error',
            title: `连接失败：${conn.name}`,
            detail: res.error
          })
        }
      })

    return id
  },

  reconnect: (id) => {
    const s = get().sessions.find((x) => x.id === id)
    if (!s || s.status === 'connecting' || s.status === 'connected') return
    get().updateStatus(id, 'connecting')
    terminalRegistry.get(id)?.term.write('\r\n\x1b[90m—— 正在重新连接 ——\x1b[0m\r\n')
    // 复用同一 sessionId：xterm 实例、滚动内容、文件树都保留
    void window.api.session
      .open({ sessionId: id, connectionId: s.connectionId, cols: s.cols, rows: s.rows })
      .then((res) => {
        if (!res.ok) {
          get().updateStatus(id, 'error', res.error)
          useToastStore.getState().push({
            kind: 'error',
            title: `重连失败：${s.connectionName}`,
            detail: res.error
          })
        }
      })
  },

  openTerminal: (hostId) => {
    const { sessions } = get()
    const hostIdx = sessions.findIndex((x) => x.id === hostId)
    const host = sessions[hostIdx]
    if (!host) return null
    if (host.status !== 'connected') {
      useToastStore.getState().push({
        kind: 'warning',
        title: '当前会话未连接',
        detail: '请先重新连接，再新建终端'
      })
      return null
    }
    const id = uid()
    const n = sessions.filter((x) => x.connectionId === host.connectionId).length + 1
    const session: SessionUi = {
      id,
      connectionId: host.connectionId,
      connectionName: host.connectionName,
      host: host.host,
      username: host.username,
      title: `${host.connectionName} (${n})`,
      status: 'connecting',
      cols: host.cols,
      rows: host.rows,
      createdAt: Date.now()
    }
    // 新标签紧跟在所属会话后面
    const next = [...sessions]
    next.splice(hostIdx + 1, 0, session)
    set({ sessions: next, activeId: id })

    void window.api.session
      .openShell({
        sessionId: id,
        connectionId: host.connectionId,
        hostSessionId: hostId,
        cols: host.cols,
        rows: host.rows
      })
      .then((res) => {
        if (!res.ok) {
          get().updateStatus(id, 'error', res.error)
          useToastStore.getState().push({
            kind: 'error',
            title: '新建终端失败',
            detail: res.error
          })
        }
      })
    return id
  },

  close: (id) => {
    void window.api.session.close(id)
    const { sessions, activeId } = get()
    const idx = sessions.findIndex((s) => s.id === id)
    const next = sessions.filter((s) => s.id !== id)
    let nextActive = activeId
    if (activeId === id) {
      nextActive = next[Math.min(idx, next.length - 1)]?.id ?? null
    }
    set({ sessions: next, activeId: nextActive })
  },

  closeOthers: (id) => {
    const { sessions, close } = get()
    for (const s of sessions) {
      if (s.id !== id) close(s.id)
    }
  },

  setActive: (id) => {
    if (get().sessions.some((s) => s.id === id)) set({ activeId: id })
  },

  setTitle: (id, title) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, title } : x))
    })),

  updateStatus: (id, status, error) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, status, error } : x))
    })),

  updateLatency: (id, ms) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, latencyMs: ms } : x))
    })),

  setSize: (id, cols, rows) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, cols, rows } : x))
    })),

  reorder: (from, to) =>
    set((s) => {
      if (from === to || from < 0 || to < 0 || from >= s.sessions.length || to >= s.sessions.length) {
        return {}
      }
      const next = [...s.sessions]
      const [moved] = next.splice(from, 1)
      next.splice(to, 0, moved)
      return { sessions: next }
    }),

  cycle: (delta) => {
    const { sessions, activeId } = get()
    if (sessions.length < 2) return
    const idx = sessions.findIndex((s) => s.id === activeId)
    const next = sessions[(idx + delta + sessions.length) % sessions.length]
    if (next) set({ activeId: next.id })
  },

  togglePanel: () => set((s) => ({ panelVisible: !s.panelVisible })),
  toggleFileTree: () => set((s) => ({ fileTreeVisible: !s.fileTreeVisible })),
  setSidebarView: (sidebarView) => set({ sidebarView })
}))

/** 取当前活动会话（非 hook，供事件处理使用） */
export function activeSession(): SessionUi | null {
  const s = useSessionStore.getState()
  return s.sessions.find((x) => x.id === s.activeId) ?? null
}
