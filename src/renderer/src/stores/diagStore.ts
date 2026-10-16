import { create } from 'zustand'
import type {
  DiagProgressEvent,
  DiagReport,
  DiagReportMeta,
  DiagSection,
  DiagSectionInput,
  DiagSectionResult,
  DiagSectionStatus
} from '@shared/types'
import { call } from '@/lib/ipc'
import { uid } from '@/lib/utils'
import { useSessionStore } from './sessionStore'
import { useToastStore } from './toastStore'

/**
 * 一键诊断巡检面板状态。
 * - 诊断项（内置 + 自定义）与报告库由主进程持久化，这里只做视图缓存；
 * - 运行中的进度通过 EVT_DIAG_PROGRESS 逐节推送，实时渲染。
 */

type DiagTab = 'run' | 'reports'

interface DiagState {
  panelOpen: boolean
  tab: DiagTab

  sections: DiagSection[]
  sectionsLoaded: boolean
  /** 选中的诊断项 id（保持展示顺序） */
  selected: string[]

  runId: string | null
  running: boolean
  /** 本次运行的项顺序 */
  runOrder: string[]
  statuses: Record<string, DiagSectionStatus>
  results: Record<string, DiagSectionResult>
  progress: { index: number; total: number } | null
  /** 最近一次完成的报告（含 id，用于导出/复制） */
  lastReport: DiagReport | null

  reports: DiagReportMeta[]
  viewing: DiagReport | null

  togglePanel: () => void
  setTab: (tab: DiagTab) => void
  loadSections: () => Promise<void>
  saveSection: (input: DiagSectionInput) => Promise<DiagSection | null>
  removeSection: (id: string) => Promise<void>
  toggleSection: (id: string) => void
  setGroupSelected: (group: string, on: boolean) => void
  selectAll: (on: boolean) => void
  start: () => Promise<void>
  cancel: () => Promise<void>
  applyProgress: (e: DiagProgressEvent) => void
  loadReports: () => Promise<void>
  viewReport: (id: string) => Promise<void>
  closeReport: () => void
  exportReport: (id: string, format: 'md' | 'html') => Promise<void>
  copyMarkdown: (id: string) => Promise<void>
}

export const useDiagStore = create<DiagState>()((set, get) => ({
  panelOpen: false,
  tab: 'run',

  sections: [],
  sectionsLoaded: false,
  selected: [],

  runId: null,
  running: false,
  runOrder: [],
  statuses: {},
  results: {},
  progress: null,
  lastReport: null,

  reports: [],
  viewing: null,

  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
  setTab: (tab) => set({ tab }),

  loadSections: async () => {
    const list = await call(window.api.diag.sections(), { errorTitle: '加载诊断项失败' })
    if (!list) return
    set((s) => {
      // 首次加载默认全选内置项；后续保持用户选择
      const selected = s.sectionsLoaded
        ? s.selected.filter((id) => list.some((x) => x.id === id))
        : list.filter((x) => x.builtin).map((x) => x.id)
      return { sections: list, sectionsLoaded: true, selected }
    })
  },

  saveSection: async (input) => {
    const saved = await call(window.api.diag.saveSection(input), { errorTitle: '保存诊断项失败' })
    if (saved) {
      await get().loadSections()
      useToastStore.getState().push({
        kind: 'success',
        title: input.id ? '诊断项已更新' : '自定义诊断项已创建'
      })
    }
    return saved
  },

  removeSection: async (id) => {
    const ok = await call(window.api.diag.removeSection(id), { errorTitle: '删除诊断项失败' })
    if (ok !== null) {
      set((s) => ({
        selected: s.selected.filter((x) => x !== id),
        sections: s.sections.filter((x) => x.id !== id)
      }))
    }
  },

  toggleSection: (id) =>
    set((s) => ({
      selected: s.selected.includes(id)
        ? s.selected.filter((x) => x !== id)
        : [...s.selected, id]
    })),

  setGroupSelected: (group, on) =>
    set((s) => {
      const ids = s.sections.filter((x) => x.group === group).map((x) => x.id)
      const next = new Set(s.selected)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      // 保持 sections 的展示顺序
      return { selected: s.sections.map((x) => x.id).filter((id) => next.has(id)) }
    }),

  selectAll: (on) =>
    set((s) => ({ selected: on ? s.sections.map((x) => x.id) : [] })),

  start: async () => {
    const { selected, running } = get()
    if (running) return
    if (selected.length === 0) {
      useToastStore.getState().push({ kind: 'warning', title: '请先选择要执行的诊断项' })
      return
    }

    const { sessions, activeId } = useSessionStore.getState()
    const session =
      sessions.find((s) => s.id === activeId && s.status === 'connected') ??
      sessions.find((s) => s.status === 'connected')
    if (!session) {
      useToastStore.getState().push({
        kind: 'warning',
        title: '没有已连接的会话',
        detail: '诊断需要在一台在线设备上执行，请先打开 SSH 连接'
      })
      return
    }

    const runId = uid()
    const statuses: Record<string, DiagSectionStatus> = {}
    for (const id of selected) statuses[id] = 'pending'

    set({
      runId,
      running: true,
      runOrder: selected,
      statuses,
      results: {},
      progress: { index: 0, total: selected.length },
      lastReport: null
    })

    const report = await call(window.api.diag.run(runId, session.id, selected), {
      errorTitle: '诊断执行失败'
    })
    set({ running: false, runId: null, progress: null })
    if (report) {
      set({ lastReport: report })
      useToastStore.getState().push({
        kind: 'success',
        title: `诊断完成：${report.okCount}/${report.sectionCount} 项正常`,
        detail: '报告已自动保存，可导出 Markdown / HTML'
      })
      void get().loadReports()
    }
  },

  cancel: async () => {
    const { runId } = get()
    if (!runId) return
    await call(window.api.diag.cancel(runId), { silent: true })
  },

  applyProgress: (e) =>
    set((s) => {
      const statuses = { ...s.statuses, [e.sectionId]: e.status }
      const progress = { index: e.index, total: e.total }
      if (e.result) {
        return { statuses, progress, results: { ...s.results, [e.sectionId]: e.result } }
      }
      return { statuses, progress }
    }),

  loadReports: async () => {
    const list = await call(window.api.diag.reports(), { silent: true })
    set({ reports: list ?? [] })
  },

  viewReport: async (id) => {
    const report = await call(window.api.diag.readReport(id), { errorTitle: '读取报告失败' })
    if (report) set({ viewing: report, tab: 'reports' })
  },

  closeReport: () => set({ viewing: null }),

  exportReport: async (id, format) => {
    const res = await call(window.api.diag.exportReport(id, format), {
      errorTitle: '导出报告失败'
    })
    if (res && !res.canceled) {
      useToastStore.getState().push({
        kind: 'success',
        title: format === 'html' ? '已导出 HTML 报告' : '已导出 Markdown 报告',
        detail: res.path
      })
    }
  },

  copyMarkdown: async (id) => {
    const text = await call(window.api.diag.reportText(id, 'md'), {
      errorTitle: '生成报告文本失败'
    })
    if (text === null) return
    const ok = await call(window.api.clip.write(text), { errorTitle: '复制失败' })
    if (ok !== null) {
      useToastStore.getState().push({ kind: 'success', title: '已复制 Markdown 报告到剪贴板' })
    }
  }
}))
