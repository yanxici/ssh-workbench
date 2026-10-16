import { create } from 'zustand'
import type { BackupDetail, BackupDiffResult, BackupMeta } from '@shared/types'
import { call } from '@/lib/ipc'
import { useSessionStore } from './sessionStore'
import { useToastStore } from './toastStore'

/**
 * 配置备份对比状态：备份列表 + 详情 + 与设备当前内容的差异。
 * 备份内容由主进程内联存储（userData/backups/*.json）。
 */

interface BackupState {
  panelOpen: boolean
  loading: boolean
  backups: BackupMeta[]
  selectedId: string | null
  detail: BackupDetail | null

  /** 用于「与设备对比」的在线会话 */
  compareSessionId: string | null
  diffPath: string | null
  diff: BackupDiffResult | null
  diffing: boolean
  /** 每个文件的对比结果（path -> result） */
  diffs: Record<string, BackupDiffResult>
  diffAllRunning: boolean

  createOpen: boolean

  togglePanel: () => void
  load: () => Promise<void>
  select: (id: string) => Promise<void>
  remove: (id: string) => Promise<void>
  setCompareSessionId: (id: string) => void
  runDiff: (path: string) => Promise<void>
  diffAll: () => Promise<void>
  restore: (paths: string[]) => Promise<void>
  setCreateOpen: (open: boolean) => void
  create: (sessionId: string, name: string, paths: string[]) => Promise<boolean>
}

export const useBackupStore = create<BackupState>()((set, get) => ({
  panelOpen: false,
  loading: false,
  backups: [],
  selectedId: null,
  detail: null,

  compareSessionId: null,
  diffPath: null,
  diff: null,
  diffing: false,
  diffs: {},
  diffAllRunning: false,

  createOpen: false,

  togglePanel: () => {
    const next = !get().panelOpen
    set({ panelOpen: next })
    if (next) {
      void get().load()
      // 默认对比会话 = 当前活动在线会话
      if (!get().compareSessionId) {
        const { sessions, activeId } = useSessionStore.getState()
        const target =
          sessions.find((s) => s.id === activeId && s.status === 'connected') ??
          sessions.find((s) => s.status === 'connected')
        if (target) set({ compareSessionId: target.id })
      }
    }
  },

  load: async () => {
    set({ loading: true })
    const list = await call(window.api.backups.list(), { errorTitle: '加载备份列表失败' })
    set({ loading: false, backups: list ?? [] })
  },

  select: async (id) => {
    set({ selectedId: id, detail: null, diff: null, diffPath: null, diffs: {} })
    const detail = await call(window.api.backups.detail(id), { errorTitle: '读取备份失败' })
    // 防止竞态：读取期间用户又点了别的备份
    if (detail && get().selectedId === id) set({ detail })
  },

  remove: async (id) => {
    const ok = await call(window.api.backups.remove(id), { errorTitle: '删除备份失败' })
    if (ok !== null) {
      set((s) => ({
        backups: s.backups.filter((b) => b.id !== id),
        selectedId: s.selectedId === id ? null : s.selectedId,
        detail: s.selectedId === id ? null : s.detail
      }))
    }
  },

  setCompareSessionId: (compareSessionId) => {
    set({ compareSessionId, diff: null, diffPath: null, diffs: {} })
  },

  runDiff: async (path) => {
    const { selectedId, compareSessionId } = get()
    if (!selectedId || !compareSessionId) {
      useToastStore.getState().push({ kind: 'warning', title: '请先选择用于对比的在线会话' })
      return
    }
    set({ diffing: true })
    const diff = await call(window.api.backups.diff(selectedId, path, compareSessionId), {
      errorTitle: '对比失败'
    })
    const stillSame = get().selectedId === selectedId
    set({ diffing: false })
    if (diff && stillSame) {
      set((s) => ({ diff, diffPath: path, diffs: { ...s.diffs, [path]: diff } }))
    }
  },

  diffAll: async () => {
    const { selectedId, compareSessionId, detail, diffAllRunning } = get()
    if (!selectedId || !compareSessionId || !detail?.files || diffAllRunning) {
      if (!compareSessionId) {
        useToastStore.getState().push({ kind: 'warning', title: '请先选择用于对比的在线会话' })
      }
      return
    }
    set({ diffAllRunning: true })
    // 小并发拉取：配置数量一般不多，4 路并发兼顾速度与设备负载
    const queue = [...detail.files]
    const worker = async (): Promise<void> => {
      for (;;) {
        const file = queue.shift()
        if (!file || get().selectedId !== selectedId) return
        const diff = await call(window.api.backups.diff(selectedId, file.path, compareSessionId), {
          silent: true
        })
        if (diff && get().selectedId === selectedId) {
          set((s) => ({ diffs: { ...s.diffs, [file.path]: diff } }))
        }
      }
    }
    await Promise.all(Array.from({ length: 4 }, worker))
    set({ diffAllRunning: false })
  },

  restore: async (paths) => {
    const { selectedId, compareSessionId } = get()
    if (!selectedId || !compareSessionId) {
      useToastStore.getState().push({ kind: 'warning', title: '请先选择用于还原的在线会话' })
      return
    }
    const res = await call(window.api.backups.restore(selectedId, compareSessionId, paths), {
      errorTitle: '还原失败'
    })
    if (res) {
      useToastStore.getState().push(
        res.failed.length === 0
          ? {
              kind: 'success',
              title: `已还原 ${res.restored} 个文件`,
              detail: '设备上的原文件已自动改名为 .bak'
            }
          : {
              kind: 'warning',
              title: `还原完成：成功 ${res.restored} / 失败 ${res.failed.length}`,
              detail: res.failed.map((f) => `${f.path}：${f.error}`).join('\n')
            }
      )
      // 还原后刷新差异视图
      const { diffPath } = get()
      if (diffPath) void get().runDiff(diffPath)
    }
  },

  setCreateOpen: (createOpen) => set({ createOpen }),

  create: async (sessionId, name, paths) => {
    const cleanPaths = paths.map((p) => p.trim()).filter(Boolean)
    if (!sessionId || cleanPaths.length === 0) {
      useToastStore.getState().push({ kind: 'warning', title: '请选择设备并至少填写一个路径' })
      return false
    }
    const detail = await call(window.api.backups.create(sessionId, name, cleanPaths), {
      errorTitle: '创建备份失败'
    })
    if (!detail) return false
    await get().load()
    set({
      selectedId: detail.id,
      detail,
      createOpen: false,
      diffs: {},
      diff: null,
      diffPath: null
    })
    useToastStore.getState().push({
      kind: 'success',
      title: `备份完成：${detail.fileCount} 个文件（${(detail.totalSize / 1024).toFixed(1)} KB）`,
      detail: detail.files.some((f) => f.error)
        ? `有 ${detail.files.filter((f) => f.error).length} 个路径读取失败，详情见文件列表`
        : undefined
    })
    return true
  }
}))
