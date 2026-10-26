import { create } from 'zustand'
import type { UpdateStatus } from '@shared/types'
import { call } from '@/lib/ipc'

/**
 * 应用内更新的渲染层状态。
 *
 * 主进程是唯一的状态源（它才知道 electron-updater 的真实进展），
 * 这里只做两件事：
 *   1. 缓存主进程推来的最后一份 UpdateStatus；
 *   2. 把「点按钮 → 调 IPC」这一层包装好，避免每个组件各写一遍 try/catch。
 *
 * 刻意不在渲染层推导 phase（比如自己算「有新版 = latestVersion > currentVersion」）：
 * 版本比较有预发布、降级、跳过版本等分支，交给主进程的 electron-updater 判定，
 * 两边各算一次只会算不一致。
 */

interface UpdateState {
  /** 主进程推来的状态；null 表示还没拿到过 */
  status: UpdateStatus | null
  /** 下拉面板 / 更新对话框是否展开 */
  panelOpen: boolean

  /** 首帧对齐：主动拉一次当前状态 */
  sync: () => Promise<void>
  /** 接收主进程推送 */
  applyEvent: (status: UpdateStatus) => void

  setPanelOpen: (open: boolean) => void
  /** 手动检查（设置面板里的「立即检查」） */
  check: () => Promise<void>
  /** 点「更新」：开始下载 */
  download: () => Promise<void>
  /** 点「重启安装」 */
  install: () => Promise<void>
  /** 点「稍后」：本会话收起提示 */
  later: () => Promise<void>
  /** 打开发布页 */
  openRelease: () => Promise<void>
}

export const useUpdateStore = create<UpdateState>()((set) => ({
  status: null,
  panelOpen: false,

  sync: async () => {
    const status = await call(window.api.update.state(), { silent: true })
    if (status) set({ status })
  },

  applyEvent: (status) => set({ status }),

  setPanelOpen: (open) => set({ panelOpen: open }),

  check: async () => {
    const status = await call(window.api.update.check(true), {
      errorTitle: '检查更新失败'
    })
    if (status) set({ status })
  },

  download: async () => {
    const status = await call(window.api.update.download(), {
      errorTitle: '下载更新失败'
    })
    if (status) set({ status })
  },

  install: async () => {
    await call(window.api.update.install(), { errorTitle: '启动安装失败' })
    // 成功时进程即将退出，不需要回写状态
  },

  later: async () => {
    const status = await call(window.api.update.later(), { silent: true })
    set({ status, panelOpen: false })
  },

  openRelease: async () => {
    await call(window.api.update.openRelease(), { errorTitle: '打开发布页失败' })
    set({ panelOpen: false })
  }
}))

/* ------------------------------------------------------------------ *\
 *  派生选择器
 * ------------------------------------------------------------------ */

/** 是否该在标题栏显示更新入口 */
export function isUpdateVisible(status: UpdateStatus | null): boolean {
  if (!status) return false
  if (status.phase === 'checking') return true
  if (status.phase === 'downloading') return true
  if (status.phase === 'downloaded') return true
  if (status.phase === 'available') return status.dismissed !== true
  return false
}

/** 把字节数格式化成 MB（一位小数），用于「12.3 / 78.6 MB」 */
export function formatMB(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '0 MB'
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** 剩余时间（秒 → 「约 3 分钟」） */
export function formatRemaining(
  transferred: number | undefined,
  total: number | undefined,
  bytesPerSecond: number | undefined
): string | null {
  if (!transferred || !total || !bytesPerSecond || bytesPerSecond <= 0) return null
  const seconds = Math.max(0, (total - transferred) / bytesPerSecond)
  if (!Number.isFinite(seconds) || seconds > 3600) return null
  if (seconds < 60) return '不到 1 分钟'
  return `约 ${Math.round(seconds / 60)} 分钟`
}
