import { create } from 'zustand'
import type { BatchProgressEvent, BatchSessionResult, BatchStatus } from '@shared/types'
import { tNow } from '@/i18n/core'
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
      useToastStore.getState().push({ kind: 'warning', title: tNow('panel.batch.needSession') })
      return
    }
    if (!command.trim()) {
      useToastStore.getState().push({ kind: 'warning', title: tNow('panel.batch.needCommand') })
      return
    }

    /*
     * 勾选后会话可能已经断开或被关掉（勾选时还在线）。
     * 这些 id 发给主进程只会立刻失败，还占着「执行（N 台）」的口径 ——
     * 先按当前会话表过滤掉，全没了就提示重选。
     */
    const sessions = useSessionStore.getState().sessions
    const live = selectedSessionIds.filter(
      (id) => sessions.find((s) => s.id === id)?.status === 'connected'
    )
    if (live.length === 0) {
      useToastStore.getState().push({
        kind: 'warning',
        title: tNow('panel.batch.allOfflineTitle'),
        detail: tNow('panel.batch.allOfflineDetail')
      })
      return
    }

    const runId = uid()
    // 快照必须在 await 之前拿：await 之后 get().selectedSessionIds 可能已被
    // 用户改掉，那份"这次跑了哪些"的信息就丢了
    const runOrderSnapshot = [...live]
    const statuses: Record<string, BatchStatus> = {}
    for (const id of live) statuses[id] = 'running'

    set({
      runId,
      running: true,
      runOrder: [...live],
      statuses,
      results: {}
    })

    const results = await call(window.api.batch.run(runId, live, command, timeoutMs), {
      errorTitle: tNow('panel.batch.runError')
    })
    // 旧批次的收尾不能覆盖刚发起的下一批（runId 是唯一能区分两者的东西）
    if (get().runId !== runId) return
    if (!results) {
      /*
       * 整批失败（IPC 报错 / 主进程异常）不会有任何 progress 事件回流，
       * 每行的 status 还停在 'running' —— 面板上满是永不结束的转圈。
       * 统一标成 error，配合已经弹出的错误提示。
       */
      const failed: Record<string, BatchStatus> = {}
      for (const id of runOrderSnapshot) failed[id] = 'error'
      set({ running: false, runId: null, statuses: failed })
      return
    }
    set({ running: false, runId: null })
    if (results) {
      const ok = results.filter((r) => r.status === 'done').length
      const bad = results.length - ok
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
        title: tNow('panel.batch.doneTitle', { ok, total: results.length }),
        detail: bad === 0 ? undefined : tNow('panel.batch.doneFailDetail', { bad }),
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
      // 取消后立刻重跑时，上一轮在途事件仍会到达：只认当前 runId
      if (e.runId !== s.runId) return s
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
