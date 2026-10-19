import { create } from 'zustand'
import type {
  LocalFile,
  RemoteFile,
  TransferProgressEvent,
  TransferTask
} from '@shared/types'
import { call } from '@/lib/ipc'
import { localDirname, localJoin, remoteDirname, remoteJoin } from '@/lib/utils'
import { useToastStore } from './toastStore'

interface SftpState {
  open: boolean
  sessionId: string | null
  sessionTitle: string

  /** 本地（左栏） */
  localDir: string
  localFiles: LocalFile[]
  localLoading: boolean
  localSel: string[]

  /** 远程（右栏） */
  remoteDir: string
  remoteFiles: RemoteFile[]
  remoteLoading: boolean
  remoteSel: string[]

  /** 传输队列 */
  transfers: TransferTask[]
  /** 全局传输进度浮层：折叠为小条 */
  dockCollapsed: boolean
  /** 用户手动关掉了浮层；新任务开始时会自动重新出现 */
  dockClosed: boolean
  setDockCollapsed: (collapsed: boolean) => void
  showDock: () => void
  closeDock: () => void
  dismissTask: (id: string) => void

  /** 远程编辑器 */
  editing: { path: string; content: string } | null

  /** 文件树刷新版本号（bump 后所有已挂载的树层级重新加载自身目录） */
  treeVersion: number
  bumpTree: () => void

  openFor: (sessionId: string, title: string) => Promise<void>
  close: () => void

  navLocal: (dir: string) => Promise<void>
  navRemote: (dir: string) => Promise<void>
  refreshLocal: () => Promise<void>
  refreshRemote: () => Promise<void>
  setLocalSel: (paths: string[]) => void
  setRemoteSel: (paths: string[]) => void

  uploadPaths: (localPaths: string[], remoteDir?: string) => Promise<void>
  downloadPaths: (remotePaths: string[], localDir?: string) => Promise<void>
  applyProgress: (e: TransferProgressEvent) => void
  clearFinished: () => void

  openEditor: (path: string) => Promise<void>
  closeEditor: () => void
  saveEditor: (content: string) => Promise<void>

  removeRemote: (path: string) => Promise<void>
  removeLocal: (path: string) => Promise<void>
  mkdirRemote: (name: string) => Promise<void>
  mkdirLocal: (name: string) => Promise<void>
  renameRemote: (path: string, newName: string) => Promise<void>
  renameLocal: (path: string, newName: string) => Promise<void>
  chmodRemote: (path: string, mode: number) => Promise<void>
}

export const useSftpStore = create<SftpState>()((set, get) => ({
  open: false,
  sessionId: null,
  sessionTitle: '',

  localDir: '',
  localFiles: [],
  localLoading: false,
  localSel: [],

  remoteDir: '',
  remoteFiles: [],
  remoteLoading: false,
  remoteSel: [],

  transfers: [],
  dockCollapsed: false,
  dockClosed: false,
  editing: null,
  treeVersion: 0,

  bumpTree: () => set((s) => ({ treeVersion: s.treeVersion + 1 })),

  /* ---------------- 开关 ---------------- */

  openFor: async (sessionId, title) => {
    set({ open: true, sessionId, sessionTitle: title, localSel: [], remoteSel: [] })

    if (!get().localDir) {
      const home = await call(window.api.local.home(), { silent: true })
      if (home) await get().navLocal(home)
    } else {
      await get().refreshLocal()
    }

    const remoteHome = await call(window.api.sftp.home(sessionId), {
      errorTitle: '无法打开文件管理（请确认会话已连接）'
    })
    if (remoteHome) await get().navRemote(remoteHome)
  },

  close: () => set({ open: false, editing: null }),

  /* ---------------- 导航与刷新 ---------------- */

  navLocal: async (dir) => {
    set({ localLoading: true })
    const files = await call(window.api.local.list(dir), { errorTitle: '读取本地目录失败' })
    if (files) set({ localDir: dir, localFiles: files, localSel: [] })
    set({ localLoading: false })
  },

  navRemote: async (dir) => {
    const sessionId = get().sessionId
    if (!sessionId) return
    set({ remoteLoading: true })
    const files = await call(window.api.sftp.list(sessionId, dir), {
      errorTitle: '读取远程目录失败'
    })
    if (files) set({ remoteDir: dir, remoteFiles: files, remoteSel: [] })
    set({ remoteLoading: false })
  },

  refreshLocal: async () => {
    const { localDir } = get()
    if (localDir) await get().navLocal(localDir)
  },

  refreshRemote: async () => {
    const { remoteDir } = get()
    if (remoteDir) await get().navRemote(remoteDir)
  },

  setLocalSel: (paths) => set({ localSel: paths }),
  setRemoteSel: (paths) => set({ remoteSel: paths }),

  /* ---------------- 传输 ---------------- */

  uploadPaths: async (localPaths, remoteDir) => {
    const sessionId = get().sessionId
    const target = remoteDir ?? get().remoteDir
    if (!sessionId || localPaths.length === 0 || !target) return
    const ids = await call(window.api.sftp.upload(sessionId, localPaths, target), {
      errorTitle: '上传失败'
    })
    if (ids) {
      useToastStore.getState().push({
        kind: 'info',
        title: `已加入 ${ids.length} 个上传任务`,
        detail: `目标：${target}`
      })
    }
  },

  downloadPaths: async (remotePaths, localDir) => {
    const sessionId = get().sessionId
    const target = localDir ?? get().localDir
    if (!sessionId || remotePaths.length === 0 || !target) return
    const ids = await call(window.api.sftp.download(sessionId, remotePaths, target), {
      errorTitle: '下载失败'
    })
    if (ids) {
      useToastStore.getState().push({
        kind: 'info',
        title: `已加入 ${ids.length} 个下载任务`,
        detail: `目标：${target}`
      })
    }
  },

  applyProgress: (e) => {
    set((s) => {
      const idx = s.transfers.findIndex((t) => t.id === e.taskId)
      const base: TransferTask =
        idx >= 0
          ? s.transfers[idx]
          : {
              id: e.taskId,
              sessionId: e.sessionId,
              direction: e.direction,
              localPath: e.localPath,
              remotePath: e.remotePath,
              transferred: 0,
              total: 0,
              status: 'pending',
              startedAt: Date.now()
            }

      const finished = e.status === 'done' || e.status === 'error' || e.status === 'canceled'
      const updated: TransferTask = {
        ...base,
        // 传输是单调递增的：晚到的旧事件（节流队列）不能把进度条往回拉
        transferred:
          e.status === 'pending'
            ? base.transferred
            : Math.max(base.transferred, Math.max(0, e.transferred || 0)),
        total: e.total > 0 ? e.total : base.total,
        unit: e.unit ?? base.unit,
        status: e.status,
        error: e.error,
        speedBps: e.speedBps,
        finishedAt: finished ? Date.now() : base.finishedAt
      }

      const next = [...s.transfers]
      if (idx >= 0) next[idx] = updated
      else next.push(updated)
      // 新任务出现时，即使上次手动关掉了浮层也要重新展示进度
      return { transfers: next, dockClosed: idx >= 0 ? s.dockClosed : false }
    })

    // 传输完成后刷新对应侧的列表，让新文件马上可见
    if (e.status === 'done') {
      if (e.direction === 'upload') void get().refreshRemote()
      else void get().refreshLocal()
    }
  },

  setDockCollapsed: (collapsed) => set({ dockCollapsed: collapsed }),

  showDock: () => set({ dockClosed: false, dockCollapsed: false }),

  closeDock: () =>
    set((s) => ({
      dockClosed: true,
      transfers: s.transfers.filter((t) => t.status === 'pending' || t.status === 'running')
    })),

  dismissTask: (id) =>
    set((s) => ({ transfers: s.transfers.filter((t) => t.id !== id) })),

  clearFinished: () =>
    set((s) => ({
      transfers: s.transfers.filter(
        (t) => t.status === 'pending' || t.status === 'running'
      )
    })),

  /* ---------------- 远程编辑器 ---------------- */

  openEditor: async (path) => {
    const sessionId = get().sessionId
    if (!sessionId) return
    const content = await call(window.api.sftp.readText(sessionId, path), {
      errorTitle: '无法打开文件'
    })
    if (content !== null) set({ editing: { path, content } })
  },

  closeEditor: () => set({ editing: null }),

  saveEditor: async (content) => {
    const { sessionId, editing } = get()
    if (!sessionId || !editing) return
    const done = await call(window.api.sftp.writeText(sessionId, editing.path, content), {
      errorTitle: '保存失败'
    })
    if (done !== null) {
      useToastStore.getState().push({
        kind: 'success',
        title: '已保存到远端',
        detail: `原文件已自动备份为 ${editing.path}.bak`
      })
      set({ editing: null })
      await get().refreshRemote()
    }
  },

  /* ---------------- 远程操作 ---------------- */

  removeRemote: async (path) => {
    const sessionId = get().sessionId
    if (!sessionId) return
    const done = await call(window.api.sftp.remove(sessionId, path), {
      errorTitle: '删除失败'
    })
    if (done !== null) {
      useToastStore.getState().push({ kind: 'success', title: '已删除' })
      await get().refreshRemote()
    }
  },

  mkdirRemote: async (name) => {
    const { sessionId, remoteDir } = get()
    if (!sessionId) return
    const done = await call(window.api.sftp.mkdir(sessionId, remoteJoin(remoteDir, name)), {
      errorTitle: '新建文件夹失败'
    })
    if (done !== null) await get().refreshRemote()
  },

  renameRemote: async (path, newName) => {
    const sessionId = get().sessionId
    if (!sessionId) return
    const done = await call(
      window.api.sftp.rename(sessionId, path, remoteJoin(remoteDirname(path), newName)),
      { errorTitle: '重命名失败' }
    )
    if (done !== null) await get().refreshRemote()
  },

  chmodRemote: async (path, mode) => {
    const sessionId = get().sessionId
    if (!sessionId) return
    const done = await call(window.api.sftp.chmod(sessionId, path, mode), {
      errorTitle: '修改权限失败'
    })
    if (done !== null) {
      useToastStore.getState().push({ kind: 'success', title: `权限已更新为 ${mode.toString(8)}` })
      await get().refreshRemote()
    }
  },

  /* ---------------- 本地操作 ---------------- */

  removeLocal: async (path) => {
    const done = await call(window.api.local.remove([path]), { errorTitle: '删除失败' })
    if (done !== null) {
      useToastStore.getState().push({ kind: 'success', title: '本地文件已删除' })
      await get().refreshLocal()
    }
  },

  mkdirLocal: async (name) => {
    const { localDir } = get()
    if (!localDir) return
    const done = await call(window.api.local.mkdir(localDir, name), {
      errorTitle: '新建文件夹失败'
    })
    if (done !== null) await get().refreshLocal()
  },

  renameLocal: async (path, newName) => {
    const done = await call(window.api.local.rename(path, localJoin(localDirname(path), newName)), {
      errorTitle: '重命名失败'
    })
    if (done !== null) await get().refreshLocal()
  }
}))
