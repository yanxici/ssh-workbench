import { create } from 'zustand'
import type { BatchProgressEvent, BatchSessionResult, BatchStatus } from '@shared/types'
import { call } from '@/lib/ipc'
import { uid } from '@/lib/utils'
import { useToastStore } from './toastStore'
import { notifyTask } from '@/lib/taskNotify'
import { useSessionStore } from './sessionStore'

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
    // 快照必须在 await 之前拿：await 之后 get().selectedSessionIds 可能已被
    // 用户改掉，那份"这次跑了哪些"的信息就丢了
    const runOrderSnapshot = [...selectedSessionIds]
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
      /*
       * 走 notifyTask 而不是直接 push toast：
       * 批量执行是最典型的长任务（20 台设备各跑一条命令，动辄一两分钟），
       * 用户发起后基本都会切走。窗口失焦时由 notifyTask 升级成系统通知，
       * 聚焦时仍是原来那条 toast，文案保持一致。
       *
       * 归属连接取「第一次选中的那台」—— 通知点击后落到哪个标签都合理，
       * 取第一台是因为 runOrder 的第一项就是用户勾选顺序里的第一个。
       */
      const firstId = runOrderSnapshot[0]
      const firstSess = useSessionStore.getState().sessions.find((s) => s.id === firstId)
      void notifyTask({
        kind: 'batch',
        title: `批量执行完成：${ok}/${results.length} 台正常返回`,
        detail: ok === results.length ? undefined : `${results.length - ok} 台异常，详见批量面板`,
        connectionId: firstSess?.connectionId,
        sessionId: firstId
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
