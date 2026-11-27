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
import { tNow } from '@/i18n/core'
import { call } from '@/lib/ipc'
import { uid } from '@/lib/utils'
import { notifyTask } from '@/lib/taskNotify'
import { pickSshSession } from './sessionStore'
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
    const list = await call(window.api.diag.sections(), {
      errorTitle: tNow('panel.diag.loadSectionsError')
    })
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
    const saved = await call(window.api.diag.saveSection(input), {
      errorTitle: tNow('panel.diag.saveSectionError')
    })
    if (saved) {
      await get().loadSections()
      useToastStore.getState().push({
        kind: 'success',
        title: input.id ? tNow('panel.diag.sectionUpdated') : tNow('panel.diag.sectionCreated')
      })
    }
    return saved
  },

  removeSection: async (id) => {
    const ok = await call(window.api.diag.removeSection(id), {
      errorTitle: tNow('panel.diag.removeSectionError')
    })
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
      useToastStore.getState().push({ kind: 'warning', title: tNow('panel.diag.selectAtLeastOne') })
      return
    }

    // 串口会话没有 shell，诊断只认 SSH
    const session = pickSshSession()
    if (!session) {
      useToastStore.getState().push({
        kind: 'warning',
        title: tNow('panel.diag.noConnectedTitle'),
        detail: tNow('panel.diag.noConnectedDetail')
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
      errorTitle: tNow('panel.diag.runError')
    })
    // 同 discoveryStore：进度事件一到 done 就能开下一轮，旧轮的收尾不能清掉新轮状态
    if (get().runId !== runId) return
    set({ running: false, runId: null, progress: null })
    if (report) {
      set({ lastReport: report })
      // 巡检 31 项串行跑，十几秒起步；同样走通知（失焦时升级为系统通知）
      void notifyTask({
        kind: 'diag',
        title: tNow('panel.diag.notifyTitle', {
          ok: report.okCount,
          total: report.sectionCount
        }),
        detail: tNow('panel.diag.notifyDetail'),
        connectionId: session.connectionId,
        sessionId: session.id
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
      // 上一轮在途事件会污染新一轮的进度条与结果表
      if (e.runId !== s.runId) return s
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
    const report = await call(window.api.diag.readReport(id), {
      errorTitle: tNow('panel.diag.readReportError')
    })
    if (report) set({ viewing: report, tab: 'reports' })
  },

  closeReport: () => set({ viewing: null }),

  exportReport: async (id, format) => {
    const res = await call(window.api.diag.exportReport(id, format), {
      errorTitle: tNow('panel.diag.exportReportError')
    })
    if (res && !res.canceled) {
      useToastStore.getState().push({
        kind: 'success',
        title:
          format === 'html' ? tNow('panel.diag.exportedHtml') : tNow('panel.diag.exportedMd'),
        detail: res.path
      })
    }
  },

  copyMarkdown: async (id) => {
    const text = await call(window.api.diag.reportText(id, 'md'), {
      errorTitle: tNow('panel.diag.reportTextError')
    })
    if (text === null) return
    const ok = await call(window.api.clip.write(text), {
      errorTitle: tNow('panel.diag.copyError')
    })
    if (ok !== null) {
      useToastStore.getState().push({ kind: 'success', title: tNow('panel.diag.copiedMd') })
    }
  }
}))
