import { create } from 'zustand'
import type { TftpLogEvent, TftpServerState } from '@shared/types'
import { call } from '@/lib/ipc'
import { tNow } from '@/i18n/core'
import { notifyTask } from '@/lib/taskNotify'

/**
 * 内置 TFTP 服务端的界面状态。
 *
 * 这个 store 只服务一件事：刷 7628 时让 U-Boot 能把固件拉走。
 * 所以状态刻意做得很薄 —— 一个服务端快照 + 一串日志，没有队列、没有重试策略。
 *
 * 进度不轮询：主进程每次收发都会推 EVT_TFTP_LOG，applyLog 收到后再拉一次
 * state 拿 transferred。U-Boot 的 TFTP 传输是秒级的，多问一次接口比在
 * 渲染层跑 setInterval 便宜得多，也不会在服务停掉后留下野定时器。
 */

const MAX_LOGS = 200

/**
 * 从日志文本里认出「这次传输结束了」。
 *
 * 为什么不给 TFTP 加一个专门的完成事件：主进程那边唯一的收口是
 * closeTransfer(reason)，成功路径传 null、失败路径传中文原因，两种都会落到
 * 一条日志上。在这里按文本判定虽然不如结构体干净，但它复用了现成的日志通道，
 * 不必为一个秒级动作新开一条 IPC。
 *
 * 返回 null 表示这条日志与「结束」无关。
 */
function completionOf(message: string): { ok: boolean; detail: string } | null {
  if (message.startsWith('\u56fa\u4ef6\u4f20\u8f93\u5b8c\u6210')) return { ok: true, detail: message }
  // 失败收口：'传输结束：超时' / '传输出错' / '对端中止' / '新的请求到达，放弃旧传输'
  const m = /^\u4f20\u8f93\u7ed3\u675f[:\uff1a](.+)$/.exec(message)
  if (m) return { ok: false, detail: m[1] }
  return null
}

interface TftpState {
  /** 服务端快照；未查询过为 null */
  server: TftpServerState | null
  logs: TftpLogEvent[]
  busy: boolean

  /** 拉一次状态（面板打开、或收到日志后） */
  refresh: () => Promise<void>
  /** 用某个本地固件起服务；port 省略则 69 */
  start: (filePath: string, port?: number) => Promise<boolean>
  stop: () => Promise<void>
  /** 主进程推来的日志 */
  applyLog: (event: TftpLogEvent) => void
  clearLogs: () => void
}

export const useTftpStore = create<TftpState>((set, get) => ({
  server: null,
  logs: [],
  busy: false,

  refresh: async () => {
    const next = await call(window.api.tftp.state(), { silent: true })
    if (next) set({ server: next })
  },

  start: async (filePath, port) => {
    set({ busy: true })
    const next = await call(window.api.tftp.start(filePath, port), {
      errorTitle: tNow('term.tftp.startFailed')
    })
    set({ busy: false })
    if (!next) return false
    set({ server: next })
    return true
  },

  stop: async () => {
    set({ busy: true })
    const next = await call(window.api.tftp.stop(), {
      errorTitle: tNow('term.tftp.stopFailed')
    })
    set({ busy: false })
    if (next) set({ server: next })
  },

  applyLog: (event) => {
    const logs = [...get().logs, event]
    set({ logs: logs.length > MAX_LOGS ? logs.slice(logs.length - MAX_LOGS) : logs })
    // 传输进度只在主进程知道，收到日志就顺手同步一次快照
    void get().refresh()
    /*
     * TFTP 刷固件是"点了按钮去泡杯咖啡"的典型场景：整个传输 30 秒到几分钟，
     * 期间界面只有日志在滚。所以结束必须主动喊人 —— 尤其失败时（超时/对端中止）
     * 用户往往已经离开了屏幕，回来只看到一行红字，还要自己回想刷到哪了。
     */
    if (event.level === 'info') {
      const done = completionOf(event.message)
      if (done) {
        void notifyTask({
          kind: 'tftp',
          title: done.ok ? tNow('term.tftp.done') : tNow('term.tftp.incomplete'),
          detail: done.detail
        })
      }
    }
  },

  clearLogs: () => set({ logs: [] })
}))
