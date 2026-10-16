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
      const statuses = { ...s.statuses, [e.sessionId]: e.status }
      if (e.result) {
        return { statuses, results: { ...s.results, [e.sessionId]: e.result } }
      }
      return { statuses }
    })
}))
