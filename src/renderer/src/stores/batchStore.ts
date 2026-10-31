import { create } from 'zustand'
import type { BatchProgressEvent, BatchSessionResult, BatchStatus } from '@shared/types'
import { call } from '@/lib/ipc'
import { uid } from '@/lib/utils'
import { useToastStore } from './toastStore'

/**
 * 多设备批量执行面板状态。
 * 选择多个在线会话 → 广播同一条命令 → 并行执行、分别收集输出（卡片 / 对比两种视图）。
 */

type BatchView = 'cards' | 'columns'

interface BatchState {
  panelOpen: boolean
  selectedSessionIds: string[]
  command: string
  timeoutMs: number
  view: BatchView

  runId: string | null
  running: boolean
  statuses: Record<string, BatchStatus>
  results: Record<string, BatchSessionResult>
  /** 本次运行的目标会话顺序 */
  runOrder: string[]

  togglePanel: () => void
  toggleSession: (id: string) => void
  setSelected: (ids: string[]) => void
  setCommand: (cmd: string) => void
  setTimeoutMs: (ms: number) => void
  setView: (view: BatchView) => void
  start: () => Promise<void>
  cancel: () => Promise<void>
  clearResults: () => void
  applyProgress: (e: BatchProgressEvent) => void
}

export const useBatchStore = create<BatchState>()((set, get) => ({
  panelOpen: false,
  selectedSessionIds: [],
  command: '',
  timeoutMs: 15000,
  view: 'cards',

  runId: null,
  running: false,
  statuses: {},
  results: {},
  runOrder: [],

  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  toggleSession: (id) =>
    set((s) => ({
      selectedSessionIds: s.selectedSessionIds.includes(id)
        ? s.selectedSessionIds.filter((x) => x !== id)
        : [...s.selectedSessionIds, id]
    })),
  setSelected: (selectedSessionIds) => set({ selectedSessionIds }),
  setCommand: (command) => set({ command }),
  setTimeoutMs: (timeoutMs) => set({ timeoutMs }),
  setView: (view) => set({ view }),

  start: async () => {
    const { selectedSessionIds, command, timeoutMs, running } = get()
    if (running) return
    if (selectedSessionIds.length === 0) {
      useToastStore.getState().push({ kind: 'warning', title: '请先勾选要执行的设备会话' })
      return
    }
    if (!command.trim()) {
      useToastStore.getState().push({ kind: 'warning', title: '请输入要执行的命令' })
      return
    }

    const runId = uid()
    const statuses: Record<string, BatchStatus> = {}
    for (const id of selectedSessionIds) statuses[id] = 'running'

    set({
      runId,
      running: true,
      runOrder: [...selectedSessionIds],
      statuses,
      results: {}
    })

    const results = await call(
      window.api.batch.run(runId, selectedSessionIds, command, timeoutMs),
      { errorTitle: '批量执行失败' }
    )
    set({ running: false, runId: null })
    if (results) {
      const ok = results.filter((r) => r.status === 'done').length
      useToastStore.getState().push({
        kind: ok === results.length ? 'success' : 'info',
        title: `批量执行完成：${ok}/${results.length} 台正常返回`
      })
    }
  },

  cancel: async () => {
    const { runId } = get()
    if (!runId) return
    await call(window.api.batch.cancel(runId), { silent: true })
  },

  clearResults: () => set({ statuses: {}, results: {}, runOrder: [] }),

  applyProgress: (e) =>
    set((s) => {
      /*
       * 单调短路：批量执行时每个会话有多个阶段事件（connect → exec → done），
       * N 个会话 × M 个阶段都会进这里。旧写法每次都 `{ ...s.statuses }` 浅拷整个
       * 状态表，BatchPanel 每行又订阅 `s.results[sessionId]` / `s.statuses[sessionId]`，
       * 对象一换新引用，所有行的 selector 全部重跑 —— 12 会话时是 12 倍的无效重渲染。
       *
       * 现在只有值真的变了才重建：
       * - status 与已有值相同、且没有新 result → 原样返回 s，zustand 不做任何通知
       * - status 变了 → 只重建 statuses，results 引用保持不变（没结果的行不会重跑）
       * - 来了 result → 才重建 results
       */
      const prevStatus = s.statuses[e.sessionId]
      const hasNewResult = e.result !== undefined && s.results[e.sessionId] !== e.result

      if (prevStatus === e.status && !hasNewResult) return s

      const statuses = prevStatus === e.status ? s.statuses : { ...s.statuses, [e.sessionId]: e.status }
      if (hasNewResult) {
        return { statuses, results: { ...s.results, [e.sessionId]: e.result! } }
      }
      return { statuses }
    })
}))
