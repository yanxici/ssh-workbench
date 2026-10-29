import { create } from 'zustand'
import type {
  LocalFile,
  RemoteFile,
  TransferProgressEvent,
  TransferTask
} from '@shared/types'
import { call } from '@/lib/ipc'
import { localDirname, localJoin, remoteDirname, remoteJoin } from '@/lib/utils'
import { normalizeRemoteDir, rememberUploadDir, resolveUploadDir } from '@/lib/uploadDir'
import { clearDirCache, invalidateDir, loadDir, peekDir } from '@/lib/dirCache'
import { useToastStore } from './toastStore'

/** 一次「选本地 → 上传」的结果：入队数 + 实际落点 */
export interface UploadResult {
  count: number
  /** 远端目标目录 */
  target: string
}

/**
 * 上传执行链路的唯一实现：解析目标目录 → 记住 → 弹系统对话框 → 入队 → 失效缓存 → 提示。
 *
 * 抽出来之前，文件侧栏、会话文件树、双栏远程栏各自写了一遍（每份 19–26 行），
 * 改一处行为（比如目录解析兜底）就得同步改 4 个地方，漏一个就是「有的入口好使、有的不好使」。
 *
 * 用参数注入 get 而不是直接 useSftpStore.getState()：避免本模块在
 * 自身初始化期间引用自己的导出（circular），也让这个函数可以被单测直接驱动。
 */
async function pickAndUpload(
  get: () => {
    sessionId: string | null
    remoteDir: string
    uploadRequest: { localPaths: string[]; defaultDir: string } | null
  },
  remoteDir: string | undefined,
  kind: 'file' | 'folder'
): Promise<UploadResult | null> {
  const sessionId = get().sessionId
  if (!sessionId) return null

  // 目标目录：显式指定 → 当前目录 → 上次用过 → 远端 home
  const target =
    normalizeRemoteDir(remoteDir ?? get().remoteDir) || (await resolveUploadDir(sessionId))
  if (!target) {
    useToastStore.getState().push({
      kind: 'warning',
      title: '没有可用的目标目录',
      detail:
        kind === 'folder'
          ? '请先进入远端的一个目录，再上传文件夹'
          : '请先进入远端的一个目录，再上传文件'
    })
    return null
  }
  rememberUploadDir(sessionId, target)

  const label = kind === 'folder' ? '上传文件夹' : '上传文件'
  const res =
    kind === 'folder'
      ? await call(window.api.sftp.uploadFolderDialog(sessionId, target, true), {
          errorTitle: `${label}失败`
        })
      : await call(window.api.sftp.uploadDialog(sessionId, target), {
          errorTitle: `${label}失败`
        })
  if (!res || res.canceled) return null

  // 目标目录内容会变：先失效缓存，各面板按需重绘（它们自己决定刷新哪个树）
  invalidateDir(sessionId, target)
  useToastStore.getState().push({
    kind: 'info',
    title:
      kind === 'folder'
        ? `已加入 ${res.count} 个文件夹上传任务`
        : `已加入 ${res.count} 个上传任务`,
    detail: kind === 'folder' ? `目标：${target}（远端保留同名目录）` : `目标：${target}`
  })
  return { count: res.count, target }
}

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

  /**
   * 上传一批本地路径到远端目录。
   * @param keepRoot 目录项是否在远端保留本地目录名（「上传文件夹」= true；
   *                 拖拽沿用历史语义 false，把目录内容铺进目标目录）
   */
  uploadPaths: (localPaths: string[], remoteDir?: string, keepRoot?: boolean) => Promise<void>
  /**
   * 弹系统对话框上传文件（可多选），落到 resolved 目标目录。
   *
   * 这一步以前在每个面板里各写一遍（解析目录 → 记住 → 弹框 → toast → 刷新），
   * 5 个面板就是 5 份几乎相同的 20 行。现在执行链路只留在这里，
   * 面板只负责「按钮点了调用它」和「成功后重绘自己」。
   *
   * @returns 实际入队的任务数；用户取消或没有可用目录时返回 null
   */
  uploadFileDialog: (remoteDir?: string) => Promise<UploadResult | null>
  /** 弹系统目录对话框上传文件夹（可多选，远端保留同名目录） */
  uploadFolder: (remoteDir?: string) => Promise<UploadResult | null>
  /**
   * 请求上传：先解析默认目标目录并挂起一个待确认请求，
   * 由 FileManagerPanel 渲染目标目录选择框，用户确认后才真正开始传输。
   */
  requestUpload: (localPaths: string[], preferredDir?: string) => Promise<void>
  /** 待确认的上传请求（null = 没有） */
  uploadRequest: { localPaths: string[]; defaultDir: string } | null
  /** 关闭待确认请求（用户取消） */
  cancelUploadRequest: () => void
  /**
   * 下载一批远端路径到指定的本地目录（不弹对话框）。
   * @returns 入队数；没有可用目录/空选择时返回 null
   */
  downloadPaths: (remotePaths: string[], localDir?: string) => Promise<UploadResult | null>
  /**
   * 下载：给了本地目录就直接入队，没给就弹系统对话框选保存位置。
   * 目录的递归遍历在主进程（sftpManager），渲染层不需要预先展开。
   */
  downloadTo: (remotePaths: string[], localDir?: string) => Promise<UploadResult | null>
  /** 一键下载到本机「下载」文件夹（不弹对话框） */
  downloadToDefault: (remotePaths: string[]) => Promise<UploadResult | null>
  applyProgress: (e: TransferProgressEvent) => void
  /** 暂停 / 继续 / 终止单个传输任务（主进程负责真正停住分块循环） */
  pauseTask: (id: string) => Promise<void>
  resumeTask: (id: string) => Promise<void>
  cancelTask: (id: string) => Promise<void>
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

  uploadRequest: null,

  bumpTree: () => set((s) => ({ treeVersion: s.treeVersion + 1 })),

  /* ---------------- 开关 ---------------- */

  openFor: async (sessionId, title) => {
    // 会话切换：旧会话的目录缓存不再有意义，清掉避免串味
    if (get().sessionId !== sessionId) clearDirCache()
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

    /*
     * 先看缓存：有就直接上屏，不让界面空着等往返。
     * 过期缓存也先用（stale-while-revalidate），随后后台补新数据。
     */
    const { cached, fresh } = peekDir(sessionId, dir)
    if (cached) {
      set({ remoteDir: dir, remoteFiles: cached.files, remoteSel: [], remoteLoading: !fresh })
      if (fresh) return
    } else {
      set({ remoteLoading: true })
    }

    const files = await loadDir(sessionId, dir, () =>
      call(window.api.sftp.list(sessionId, dir), { errorTitle: '读取远程目录失败' })
    )
    // 后台刷新返回时用户可能已经切到别的目录，只认当前目录的结果
    if (files && get().sessionId === sessionId && (get().remoteDir === dir || !cached)) {
      set({ remoteDir: dir, remoteFiles: files, remoteSel: get().remoteSel })
    }
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

  uploadPaths: async (localPaths, remoteDir, keepRoot) => {
    const sessionId = get().sessionId
    if (!sessionId || localPaths.length === 0) return

    // 目标目录按「显式指定 → 当前目录 → 上次目录 → 远端 home」解析；
    // 全都拿不到时不再静默 return（以前就是这样，用户点了没反应），
    // 而是弹出一个空白的目录选择框让用户自己填。
    const target = normalizeRemoteDir(remoteDir ?? get().remoteDir) || (await resolveUploadDir(sessionId))
    if (!target) {
      set({ uploadRequest: { localPaths, defaultDir: '' } })
      return
    }

    rememberUploadDir(sessionId, target)
    const ids = await call(
      window.api.sftp.upload(sessionId, localPaths, target, keepRoot ? { keepRoot: true } : undefined),
      { errorTitle: '上传失败' }
    )
    if (ids) {
      // 上传会改变目标目录内容：失效该目录并在完成后刷新，避免看到旧列表
      invalidateDir(sessionId, target)
      useToastStore.getState().push({
        kind: 'info',
        title: `已加入 ${ids.length} 个上传任务`,
        detail: `目标：${target}`
      })
    }
  },

  uploadFileDialog: async (remoteDir) =>
    pickAndUpload(get, remoteDir, 'file'),
  uploadFolder: async (remoteDir) =>
    pickAndUpload(get, remoteDir, 'folder'),

  requestUpload: async (localPaths, preferredDir) => {
    const sessionId = get().sessionId
    if (!sessionId || localPaths.length === 0) return
    const { remoteDir } = get()
    const defaultDir = await resolveUploadDir(sessionId, preferredDir ?? remoteDir)
    set({ uploadRequest: { localPaths, defaultDir } })
  },

  cancelUploadRequest: () => set({ uploadRequest: null }),

  downloadPaths: async (remotePaths, localDir) => {
    const sessionId = get().sessionId
    const target = localDir ?? get().localDir
    if (!sessionId || remotePaths.length === 0 || !target) return null
    const ids = await call(window.api.sftp.download(sessionId, remotePaths, target), {
      errorTitle: '下载失败'
    })
    if (!ids) return null
    useToastStore.getState().push({
      kind: 'info',
      title: `已加入 ${ids.length} 个下载任务`,
      detail: `目标：${target}`
    })
    return { count: ids.length, target }
  },

  downloadTo: async (remotePaths, localDir) => {
    const sessionId = get().sessionId
    if (!sessionId || remotePaths.length === 0) return null
    // 给了目录就走上面那条（本地栏拖拽、右键「下载到左侧目录」）；
    // 没给就弹系统对话框，落点由用户临时决定
    if (localDir) return get().downloadPaths(remotePaths, localDir)
    const res = await call(window.api.sftp.downloadDialog(sessionId, remotePaths), {
      errorTitle: '下载失败'
    })
    if (!res || res.canceled) return null
    useToastStore.getState().push({
      kind: 'info',
      title: `已加入 ${res.count} 个下载任务`
    })
    return { count: res.count, target: '' }
  },

  downloadToDefault: async (remotePaths) => {
    const sessionId = get().sessionId
    if (!sessionId || remotePaths.length === 0) return null
    const dir = await call(window.api.sftp.downloadsDir(), { silent: true })
    return dir ? get().downloadPaths(remotePaths, dir) : null
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

  pauseTask: async (id) => {
    // 先本地置 paused：主进程的下一个分块边界才真正停住，界面不该等着
    set((s) => ({
      transfers: s.transfers.map((t) =>
        t.id === id && (t.status === 'running' || t.status === 'pending')
          ? { ...t, status: 'paused' as const, speedBps: 0 }
          : t
      )
    }))
    await window.api.sftp.pauseTransfer(id)
  },

  resumeTask: async (id) => {
    set((s) => ({
      transfers: s.transfers.map((t) =>
        t.id === id && t.status === 'paused' ? { ...t, status: 'running' as const } : t
      )
    }))
    await window.api.sftp.resumeTransfer(id)
  },

  cancelTask: async (id) => {
    set((s) => ({
      transfers: s.transfers.map((t) =>
        t.id === id && (t.status === 'running' || t.status === 'pending' || t.status === 'paused')
          ? { ...t, status: 'canceled' as const, speedBps: 0, finishedAt: Date.now() }
          : t
      )
    }))
    await window.api.sftp.cancelTransfer(id)
  },

  showDock: () => set({ dockClosed: false, dockCollapsed: false }),

  closeDock: () =>
    set((s) => ({
      dockClosed: true,
      transfers: s.transfers.filter(
        (t) => t.status === 'pending' || t.status === 'running' || t.status === 'paused'
      )
    })),

  dismissTask: (id) =>
    set((s) => ({ transfers: s.transfers.filter((t) => t.id !== id) })),

  clearFinished: () =>
    set((s) => ({
      transfers: s.transfers.filter(
        (t) => t.status === 'pending' || t.status === 'running' || t.status === 'paused'
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
      // 写操作后必须让缓存失效，否则再进这个目录看到的是删除前的旧列表
      invalidateDir(sessionId, remoteDirname(path))
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
    if (done !== null) {
      invalidateDir(sessionId, remoteDir)
      await get().refreshRemote()
    }
  },

  renameRemote: async (path, newName) => {
    const sessionId = get().sessionId
    if (!sessionId) return
    const done = await call(
      window.api.sftp.rename(sessionId, path, remoteJoin(remoteDirname(path), newName)),
      { errorTitle: '重命名失败' }
    )
    if (done !== null) {
      invalidateDir(sessionId, remoteDirname(path))
      await get().refreshRemote()
    }
  },

  chmodRemote: async (path, mode) => {
    const sessionId = get().sessionId
    if (!sessionId) return
    const done = await call(window.api.sftp.chmod(sessionId, path, mode), {
      errorTitle: '修改权限失败'
    })
    if (done !== null) {
      invalidateDir(sessionId, remoteDirname(path))
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
