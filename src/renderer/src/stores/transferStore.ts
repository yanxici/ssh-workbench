import { create } from 'zustand'
import type { TransferRecord } from '@shared/types'
import { call } from '@/lib/ipc'
import { tNow } from '@/i18n/core'
import { localDirname, remoteDirname } from '@/lib/utils'
import { useSessionStore } from './sessionStore'
import { useSftpStore } from './sftpStore'
import { useToastStore } from './toastStore'

/**
 * 传输记录面板状态（历史账本视图）。
 *
 * 与浮层（TransferProgressDock）的分工：浮层只管「正在进行」，本面板只管
 * 「已经结束」，两者唯一的交集是记录里 status 仍是 running 的行 ——
 * 那种行会按 id 去 sftpStore.transfers 找活任务，找到了就用实时数字，
 * 找不到（重启后、渲染层重载）就显示「进度未知」。
 *
 * 为什么不把记录和活任务合到一个数组里：活任务每 150ms 换一次引用，
 * 合进来会让整张表跟着重渲；而记录只在状态跃迁时变（一次任务两条）。
 */

export type RecordFilter = 'all' | 'upload' | 'download' | 'failed'

/*
 * 「失败」筛选只认 error / interrupted：canceled 是用户自己按停的，
 * 把它并进失败里，用户每次筛选都要重新辨认一遍「这条到底是不是真出事了」。
 */
const FAILED: TransferRecord['status'][] = ['error', 'interrupted']

export function isFailedRecord(r: TransferRecord): boolean {
  return FAILED.includes(r.status)
}

export function isLiveRecord(r: TransferRecord): boolean {
  return r.status === 'running' || r.status === 'pending'
}

interface TransferState {
  panelOpen: boolean
  records: TransferRecord[]
  loading: boolean
  loaded: boolean
  filter: RecordFilter
  keyword: string
  /** 展开了失败明细的记录 id（同时只开一条，避免整表被撑爆） */
  expanded: string | null

  togglePanel: () => void
  /**
   * 声明「现在有人在看记录」。
   *
   * 主区域面板和侧栏 Tab 会同时存在，用一个计数而不是布尔：任何一处卸载
   * 都不该把另一处的刷新关掉。计数大于 0 才跟着主进程的信号重拉。
   */
  attachView: () => void
  detachView: () => void
  setFilter: (f: RecordFilter) => void
  setKeyword: (k: string) => void
  toggleExpanded: (id: string) => void
  load: () => Promise<void>
  /** 主进程发了「记录变了」信号：重拉一次（正在拉就排队，不并发） */
  applyChanged: () => void
  retry: (record: TransferRecord) => Promise<void>
  reveal: (path: string) => Promise<void>
  openDir: (path: string) => Promise<void>
}

/** 重拉时若已经在拉，标记一次待办，等这次结束后补一次 */
let pendingReload = false

/** 有多少个界面正在显示记录（主面板 + 侧栏 Tab） */
let viewers = 0

export const useTransferStore = create<TransferState>()((set, get) => ({
  panelOpen: false,
  records: [],
  loading: false,
  loaded: false,
  filter: 'all',
  keyword: '',
  expanded: null,

  togglePanel: () => {
    const open = !get().panelOpen
    set({ panelOpen: open })
    if (open && !get().loaded) void get().load()
  },

  setFilter: (filter) => set({ filter }),
  setKeyword: (keyword) => set({ keyword }),
  toggleExpanded: (id) => set({ expanded: get().expanded === id ? null : id }),

  load: async () => {
    if (get().loading) {
      pendingReload = true
      return
    }
    set({ loading: true })
    const list = await call(window.api.transfer.list(), {
      errorTitle: tNow('files.ui.err.loadTransfers')
    })
    set({ loading: false, loaded: true, records: list ?? [] })
    if (pendingReload) {
      pendingReload = false
      void get().load()
    }
  },

  attachView: () => {
    viewers += 1
  },

  detachView: () => {
    viewers = Math.max(0, viewers - 1)
    // 没人看了：标记成「需要重读」，下次谁打开谁拉一次最新的
    if (viewers === 0) set({ loaded: false })
  },

  applyChanged: () => {
    /*
     * 没人看就不拉：记录只在被打开时读，攒到打开那一次即可。
     *
     * 判据是「有没有界面挂着」（viewers），不是「主面板开没开」——
     * 侧栏 Tab 也算一个视图，只看 panelOpen 会让侧栏那份永远不刷新。
     */
    if (viewers === 0) {
      set({ loaded: false })
      return
    }
    void get().load()
  },

  /*
   * 重试只复用**已经连上**的会话，不替用户重连。
   *
   * 记录里存的是 connectionId 快照（sessionId 每次启动都变），所以这里按
   * connectionId + status==='connected' 找当前会话。找不到就把按钮置灰 ——
   * 静默失败比按钮不可用更让人困惑。
   */
  retry: async (record) => {
    /*
     * 只重试 SFTP。
     *
     * trzsz / ZMODEM 是另一套协议（远端要装 trz、sz 要由对端发起），
     * 用 SFTP 的参数去重放只会把一个「协议不对」变成一条新的失败记录。
     */
    if (record.via !== 'sftp') {
      useToastStore.getState().push({
        kind: 'info',
        title: tNow('files.ui.transfer.cannotRetry'),
        detail:
          record.via === 'trzsz'
            ? tNow('files.ui.transfer.trzszRetryHint')
            : tNow('files.ui.transfer.zmodemRetryHint')
      })
      return
    }
    // 路径没记全（老记录、或当时就拿不到）就别猜一个目录去写
    if (!record.localPath || !record.remotePath) {
      useToastStore.getState().push({
        kind: 'warning',
        title: tNow('files.ui.transfer.missingPath'),
        detail: tNow('files.ui.transfer.missingPathHint')
      })
      return
    }
    const session = useSessionStore
      .getState()
      .sessions.find((s) => s.connectionId === record.connectionId && s.status === 'connected')
    if (!session) {
      useToastStore.getState().push({
        kind: 'warning',
        title: tNow('files.ui.transfer.disconnected'),
        detail: tNow('files.ui.transfer.reconnectToRetry')
      })
      return
    }
    if (record.direction === 'upload') {
      /*
       * 目录上传时记录里的 remotePath 是「目标目录/本地目录名」，所以
       * 父目录 + keepRoot=true 才能原样重放。用路径尾段是否同名来判断是不是
       * 目录上传：单文件上传的 remotePath 尾段同样等于文件名，但那时
       * keepRoot 没有意义（单文件不走目录分支），传 true 也无副作用。
       * 反过来说，若漏掉这个判断，重传一个目录就会把内容摊平到父目录里。
       */
      const sameTail =
        record.localPath.split(/[\\/]/).filter(Boolean).pop() ===
        record.remotePath.split('/').filter(Boolean).pop()
      await useSftpStore
        .getState()
        .uploadPaths(session.id, [record.localPath], remoteDirname(record.remotePath), sameTail)
    } else {
      await useSftpStore
        .getState()
        .downloadPaths(session.id, [record.remotePath], localDirname(record.localPath))
    }
    void get().load()
  },

  reveal: async (path) => {
    await call(window.api.transfer.reveal(path), { errorTitle: tNow('files.ui.err.reveal') })
  },

  openDir: async (path) => {
    await call(window.api.transfer.openDir(path), { errorTitle: tNow('files.ui.err.openDir') })
  }
}))
