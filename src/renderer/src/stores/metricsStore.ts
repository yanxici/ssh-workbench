import { create } from 'zustand'
import type { MetricsEvent, MetricsSample } from '@shared/types'
import { call } from '@/lib/ipc'
import { useSessionStore } from './sessionStore'
import { useToastStore } from './toastStore'

/**
 * 资源仪表盘状态。
 * 主进程按会话采样并推送（EVT_METRICS），这里维护每个会话的滚动时间序列（上限 120 个点）。
 */

const MAX_POINTS = 120

export interface SessionSeries {
  sessionId: string
  samples: MetricsSample[]
  /** 异常停止时的原因 */
  error?: string
}

interface MetricsState {
  panelOpen: boolean
  monitored: Record<string, SessionSeries>
  /** 监控中的会话顺序（跨会话管理时保持稳定展示） */
  order: string[]

  togglePanel: () => void
  start: (sessionId: string) => Promise<void>
  stop: (sessionId: string) => Promise<void>
  startAllConnected: () => Promise<void>
  stopAll: () => Promise<void>
  applyEvent: (e: MetricsEvent) => void
  /** 与主进程对齐（渲染层重载后主进程可能仍在采样） */
  syncStates: () => Promise<void>
}

export const useMetricsStore = create<MetricsState>()((set, get) => ({
  panelOpen: false,
  monitored: {},
  order: [],

  togglePanel: () => {
    const next = !get().panelOpen
    set({ panelOpen: next })
    if (next) {
      void get().syncStates()
      // 首次打开：自动监控当前活动会话（单台设备，采样负担小）
      const { monitored } = get()
      if (Object.keys(monitored).length === 0) {
        const { sessions, activeId } = useSessionStore.getState()
        const target =
          sessions.find((s) => s.id === activeId && s.status === 'connected') ??
          sessions.find((s) => s.status === 'connected')
        if (target) void get().start(target.id)
      }
    }
  },

  start: async (sessionId) => {
    if (get().monitored[sessionId]) return
    // 先行占位，保证首帧事件有落点
    set((s) => ({
      monitored: {
        ...s.monitored,
        [sessionId]: { sessionId, samples: s.monitored[sessionId]?.samples ?? [] }
      },
      order: s.order.includes(sessionId) ? s.order : [...s.order, sessionId]
    }))
    const ok = await call(window.api.metrics.start(sessionId), {
      errorTitle: '无法开始监控'
    })
    if (ok === null) {
      set((s) => {
        const monitored = { ...s.monitored }
        delete monitored[sessionId]
        return { monitored, order: s.order.filter((x) => x !== sessionId) }
      })
    }
  },

  stop: async (sessionId) => {
    await call(window.api.metrics.stop(sessionId), { silent: true })
    set((s) => {
      const monitored = { ...s.monitored }
      delete monitored[sessionId]
      return { monitored, order: s.order.filter((x) => x !== sessionId) }
    })
  },

  startAllConnected: async () => {
    const connected = useSessionStore.getState().sessions.filter((s) => s.status === 'connected')
    for (const s of connected) {
      if (!get().monitored[s.id]) await get().start(s.id)
    }
  },

  stopAll: async () => {
    for (const id of [...get().order]) {
      await get().stop(id)
    }
  },

  applyEvent: (e) => {
    if (e.running && e.sample) {
      set((s) => {
        const existing = s.monitored[e.sessionId]
        const samples = [...(existing?.samples ?? []), e.sample as MetricsSample]
        return {
          monitored: {
            ...s.monitored,
            [e.sessionId]: {
              sessionId: e.sessionId,
              samples: samples.length > MAX_POINTS ? samples.slice(samples.length - MAX_POINTS) : samples
            }
          },
          order: s.order.includes(e.sessionId) ? s.order : [...s.order, e.sessionId]
        }
      })
      return
    }

    // running=false：停止（可能是异常）
    set((s) => {
      const monitored = { ...s.monitored }
      delete monitored[e.sessionId]
      return { monitored, order: s.order.filter((x) => x !== e.sessionId) }
    })

    if (e.error) {
      const title = useSessionStore.getState().sessions.find((x) => x.id === e.sessionId)?.title
      useToastStore.getState().push({
        kind: 'warning',
        title: `${title ?? '设备'} 监控已停止`,
        detail: e.error
      })
    }
  },

  syncStates: async () => {
    const running = await call(window.api.metrics.states(), { silent: true })
    if (!running) return
    set((s) => {
      const monitored = { ...s.monitored }
      for (const id of running) {
        if (!monitored[id]) monitored[id] = { sessionId: id, samples: [] }
      }
      for (const id of Object.keys(monitored)) {
        if (!running.includes(id)) delete monitored[id]
      }
      return { monitored, order: running }
    })
  }
}))
