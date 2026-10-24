import { useMemo } from 'react'
import { create } from 'zustand'
import type { ConnStatus, ReconnectEvent } from '@shared/types'
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

/**
 * 侧栏视图的旧类型别名。
 * 布局状态已迁到 `stores/layoutStore.ts`（那里叫 ActivityView），
 * 这里保留别名是为了不让历史引用一次性全红；新代码请直接用 ActivityView。
 */
export type SidebarView = 'connections' | 'files' | 'history' | 'logs' | 'tunnels'

interface SessionState {
  sessions: SessionUi[]
  activeId: string | null
  /**
   * 延迟单独存放，不塞进 sessions。
   * 原因：App 层订阅的是 `s.sessions`，一旦为了更新延迟而重建整个数组，
   * 每 5 秒（探测周期）× 每个会话都会触发一次全量重渲染，终端数量一多就卡。
   * 拆出来后只有真正读延迟的 StatusBar 会重渲染。
   */
  latencyById: Record<string, number>
  /**
   * 自动重连进度：sessionId -> 事件。
   * 与 latencyById 同理拆出来，避免每次重连进度变化都重建 sessions 数组
   * 导致所有终端跟着重渲染。
   */
  reconnectById: Record<string, ReconnectEvent>

  /** 收到主进程的重连事件 */
  applyReconnect: (e: ReconnectEvent) => void
  /** 取消自动重连（用户主动关闭标签时） */
  cancelReconnect: (id: string) => void

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
  /** 取某会话的延迟（ms）；未探测到返回 undefined */
  latencyOf: (id: string) => number | undefined
}

export const useSessionStore = create<SessionState>()((set, get) => ({
  sessions: [],
  activeId: null,
  latencyById: {},
  reconnectById: {},

  applyReconnect: (e) =>
    set((s) => {
      const next = { ...s.reconnectById }
      // 重连成功或彻底放弃后不再需要显示，清掉
      if (e.phase === 'restored' || e.phase === 'gave-up') delete next[e.sessionId]
      else next[e.sessionId] = e
      return { reconnectById: next }
    }),

  cancelReconnect: (id) => {
    void window.api.session.reconnectCancel(id)
    set((s) => {
      const next = { ...s.reconnectById }
      delete next[id]
      return { reconnectById: next }
    })
  },

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
    // 会话打开不再抢占左侧栏视图。
    // 旧行为是「连接成功就自动展开文件树」，那是在文件树独占左栏的年代；
    // 现在文件只是活动栏的一个视图，自动切过去会把用户正在看的连接列表顶掉，
    // 而用户此刻最想看的恰恰是「我点的那台机器连上了没有」。
    set((s) => ({ sessions: [...s.sessions, session], activeId: id }))

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
    // 用户主动关闭：必须取消自动重连，否则标签关了还会被"重连"拉回来
    void window.api.session.reconnectCancel(id)
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

  /**
   * 延迟更新只碰 latencyById，不再重建 sessions 数组。
   * 旧实现每次探测都 map 一遍 sessions，App 层的 sessions 订阅随之重渲染，
   * 连带所有 TerminalView 一起重跑（终端一多，每 5 秒就卡一下）。
   */
  updateLatency: (id, ms) =>
    set((s) => {
      if (s.latencyById[id] === ms) return {}
      return { latencyById: { ...s.latencyById, [id]: ms } }
    }),

  latencyOf: (id) => get().latencyById[id],

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
  }
}))

/** 取当前活动会话（非 hook，供事件处理使用） */
export function activeSession(): SessionUi | null {
  const s = useSessionStore.getState()
  return s.sessions.find((x) => x.id === s.activeId) ?? null
}

/**
 * 按 id 取会话的 hook。
 *
 * 为什么不用 useSessionStore((s) => s.sessions.find(...))：
 * 那个 selector 会在**任意会话**变化时重新执行 find —— 包括每 5 秒一次的
 * 延迟探测、任意终端的输出。StatusBar / SideNav / TabBar 是常驻组件，
 * 多标签时每次都要线性扫一遍；TabBar 里每个标签还各扫一次，是 O(n²)。
 *
 * 这里只订阅「这个 id 对应的会话对象」，其余会话变化不会触发重渲染。
 * 返回的也是原引用（不是新对象），符合 zustand 的相等性判断。
 */
export function useSessionById(id: string | null): SessionUi | null {
  return useSessionStore((s) => (id ? (s.sessions.find((x) => x.id === id) ?? null) : null))
}

/** 会话 id -> 会话对象的索引，供需要遍历多个会话的场景（如侧栏状态点） */
export function useSessionIndex(): Map<string, SessionUi> {
  const sessions = useSessionStore((s) => s.sessions)
  return useMemo(() => new Map(sessions.map((x) => [x.id, x])), [sessions])
}
