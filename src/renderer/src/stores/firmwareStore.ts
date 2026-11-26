import { create } from 'zustand'
import type {
  FirmwareFileInfo,
  FirmwareLogEvent,
  FirmwareUpgradeResult,
  FirmwareVerifyResult
} from '@shared/types'
import { call } from '@/lib/ipc'
import { uid } from '@/lib/utils'
import { pickSshSession, useSessionStore } from './sessionStore'
import { useToastStore } from './toastStore'
import { notifyTask } from '@/lib/taskNotify'

/**
 * 固件升级助手状态（五步向导：选择 → 上传 → 校验 → 升级 → 重启等待）。
 * 等待上线用 TCP 探针轮询（3s 一次，上限约 5 分钟），不需要 SSH 重连。
 */

const MAX_LOG_CHARS = 200 * 1024
const WAIT_INTERVAL_MS = 3000
const WAIT_MAX_ATTEMPTS = 100

interface WaitState {
  waiting: boolean
  online: boolean
  attempts: number
  lastLatency?: number
}

let waitTimer: ReturnType<typeof setInterval> | null = null

/** shell 单引号转义：路径里可能带空格，裸拼会被拆成多个参数 */
export function shellQuotePath(p: string): string {
  return "'" + p.replace(/'/g, "'\\''") + "'"
}

/**
 * 把命令里的 {{file}} 占位符替换成（已转义的）远端固件路径。
 * 没有占位符、或还没有上传路径时原样返回 —— 用户可能就写了完整命令。
 */
export function expandFilePlaceholder(command: string, uploadedPath: string | null): string {
  if (!uploadedPath || !command.includes('{{file}}')) return command
  return command.split('{{file}}').join(shellQuotePath(uploadedPath))
}

interface FirmwareState {
  panelOpen: boolean
  sessionId: string | null

  file: FirmwareFileInfo | null
  remoteDir: string
  uploading: boolean
  uploadTaskId: string | null
  uploadedPath: string | null

  verifying: boolean
  verify: FirmwareVerifyResult | null

  upgradeCommand: string
  upgradeTimeoutMs: number
  upgrading: boolean
  upgradeRunId: string | null
  upgradeLog: string
  upgradeResult: FirmwareUpgradeResult | null

  rebootCommand: string
  rebooting: boolean

  waitPort: number
  wait: WaitState

  bootLoading: boolean
  bootLog: string | null

  togglePanel: () => void
  setSessionId: (id: string) => void
  setRemoteDir: (dir: string) => void
  pickFile: () => Promise<void>
  startUpload: () => Promise<void>
  markUploaded: (remotePath: string) => void
  startVerify: () => Promise<void>
  setUpgradeCommand: (cmd: string) => void
  setUpgradeTimeoutMs: (ms: number) => void
  startUpgrade: () => Promise<void>
  cancelUpgrade: () => Promise<void>
  applyLog: (e: FirmwareLogEvent) => void
  setRebootCommand: (cmd: string) => void
  reboot: () => Promise<void>
  setWaitPort: (port: number) => void
  startWaitOnline: () => Promise<void>
  stopWaitOnline: () => void
  fetchBootLog: () => Promise<void>
}

export const useFirmwareStore = create<FirmwareState>()((set, get) => ({
  panelOpen: false,
  sessionId: null,

  file: null,
  remoteDir: '/tmp',
  uploading: false,
  uploadTaskId: null,
  uploadedPath: null,

  verifying: false,
  verify: null,

  upgradeCommand: '',
  upgradeTimeoutMs: 600000,
  upgrading: false,
  upgradeRunId: null,
  upgradeLog: '',
  upgradeResult: null,

  rebootCommand: 'reboot',
  rebooting: false,

  waitPort: 22,
  wait: { waiting: false, online: false, attempts: 0 },

  bootLoading: false,
  bootLog: null,

  togglePanel: () => {
    const next = !get().panelOpen
    set({ panelOpen: next })
    if (next && !get().sessionId) {
      const target = pickSshSession()
      if (target) set({ sessionId: target.id })
    }
  },

  setSessionId: (sessionId) =>
    set({ sessionId, verify: null, uploadedPath: null, uploadTaskId: null, file: null }),

  setRemoteDir: (remoteDir) => set({ remoteDir }),

  pickFile: async () => {
    const res = await call(window.api.firmware.pickFile(), { errorTitle: '选择固件失败' })
    if (res && !res.canceled && res.file) {
      set({
        file: res.file,
        verify: null,
        uploadedPath: null,
        uploadTaskId: null,
        upgradeResult: null,
        upgradeLog: ''
      })
    }
  },

  startUpload: async () => {
    const { sessionId, file, remoteDir, uploading } = get()
    if (uploading) return
    if (!sessionId) {
      useToastStore.getState().push({ kind: 'warning', title: '请先选择目标设备' })
      return
    }
    if (!file) {
      useToastStore.getState().push({ kind: 'warning', title: '请先选择固件文件' })
      return
    }
    if (!remoteDir.trim()) {
      useToastStore.getState().push({ kind: 'warning', title: '请填写设备上的上传目录' })
      return
    }

    /*
     * 重新上传意味着旧的远端文件与校验结论全部作废。
     *
     * uploadTaskId 必须一起清掉：它在 sftpStore.transfers 里指向上一轮的
     * done 记录，而那个记录的 remotePath 就是旧固件。只清 uploadedPath 的话，
     * 下一帧「上传完成 → markUploaded」的判定会立刻把旧路径复活，
     * 校验与刷机静默作用在上一次的固件上。
     */
    set({
      uploading: true,
      uploadTaskId: null,
      uploadedPath: null,
      verify: null,
      upgradeResult: null,
      upgradeLog: ''
    })
    const res = await call(window.api.firmware.upload(sessionId, file.path, remoteDir.trim()), {
      errorTitle: '上传失败'
    })
    set({ uploading: false })
    if (res) {
      set({ uploadTaskId: res.taskId })
      useToastStore.getState().push({
        kind: 'info',
        title: '已加入上传队列',
        detail: res.remotePath
      })
    }
  },

  markUploaded: (uploadedPath) => set({ uploadedPath }),

  startVerify: async () => {
    const { sessionId, file, uploadedPath } = get()
    if (!sessionId || !file || !uploadedPath) return
    set({ verifying: true, verify: null })
    const res = await call(window.api.firmware.verify(sessionId, file.path, uploadedPath), {
      errorTitle: '校验失败'
    })
    set({ verifying: false })
    if (res) {
      set({ verify: res })
      useToastStore.getState().push(
        res.match
          ? { kind: 'success', title: '校验一致，固件完整' }
          : { kind: 'error', title: '校验不一致，请勿升级', detail: '请重新上传' }
      )
    }
  },

  /*
   * 升级命令里的 {{file}} 必须在这里换成真实路径。
   * 输入框的占位提示教用户写 sysupgrade -n {{file}}，但全链路从没做过替换 ——
   * 用户照着提示填，设备上执行的是一条把字面量 {{file}} 当文件名的命令。
   */
  setUpgradeCommand: (cmd) => set({ upgradeCommand: cmd }),
  setUpgradeTimeoutMs: (upgradeTimeoutMs) => set({ upgradeTimeoutMs }),

  startUpgrade: async () => {
    const { sessionId, upgradeCommand, upgradeTimeoutMs, upgrading, uploadedPath } = get()
    if (upgrading) return
    if (!sessionId) return
    if (!upgradeCommand.trim()) {
      useToastStore.getState().push({ kind: 'warning', title: '请填写升级命令' })
      return
    }

    const runId = uid()
    const command = expandFilePlaceholder(upgradeCommand, uploadedPath)
    set({ upgrading: true, upgradeRunId: runId, upgradeLog: '', upgradeResult: null })

    const result = await call(
      window.api.firmware.upgrade(runId, sessionId, command, upgradeTimeoutMs),
      { errorTitle: '升级执行失败' }
    )
    set({ upgrading: false, upgradeRunId: null })
    if (result) {
      set({ upgradeResult: result })
      /*
       * 固件升级是这里最"必须通知"的一类：刷机脚本跑起来之后终端里没有
       * 任何可交互的东西，用户只能等。成功/取消/异常三条路径都要提示，
       * 否则"刷完了没反应"会让人以为卡死而重复触发。
       */
      const connId = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
        ?.connectionId
      if (result.status === 'done' && result.exitCode === 0) {
        void notifyTask({
          kind: 'firmware',
          title: '升级命令执行成功（退出码 0）',
          connectionId: connId,
          sessionId
        })
      } else if (result.status === 'cancelled') {
        void notifyTask({
          kind: 'firmware',
          title: '升级命令已取消',
          connectionId: connId,
          sessionId
        })
      } else {
        void notifyTask({
          kind: 'firmware',
          title: '升级命令执行结束（请核对输出）',
          detail:
            result.exitCode === null ? '连接中断，升级脚本可能已重启设备' : `退出码 ${result.exitCode}`,
          connectionId: connId,
          sessionId
        })
      }
    }
  },

  cancelUpgrade: async () => {
    const { upgradeRunId } = get()
    if (!upgradeRunId) return
    await call(window.api.firmware.cancel(upgradeRunId), { silent: true })
  },

  applyLog: (e) =>
    set((s) => {
      // 上一轮的输出流会续到新一轮的日志里，看着像刷机脚本重跑了一遍
      if (e.runId !== s.upgradeRunId) return s
      const next = s.upgradeLog + e.chunk
      return { upgradeLog: next.length > MAX_LOG_CHARS ? next.slice(next.length - MAX_LOG_CHARS) : next }
    }),

  setRebootCommand: (rebootCommand) => set({ rebootCommand }),

  reboot: async () => {
    const { sessionId, rebootCommand, rebooting } = get()
    if (rebooting || !sessionId) return
    set({ rebooting: true })
    const res = await call(window.api.firmware.reboot(sessionId, rebootCommand.trim() || 'reboot'), {
      silent: true
    })
    set({ rebooting: false })
    /*
     * reboot 命令本身会让连接立刻断开，IPC 常常因此失败 —— 但失败也可能是
     * 「会话已断」或「命令根本没有发出去」，两者对用户的意义完全不同。
     * 旧实现无视返回值一律提示「重启命令已发送」，等于把失败伪装成成功。
     */
    if (res === null) {
      useToastStore.getState().push({
        kind: 'warning',
        title: '重启命令发送失败',
        detail: '连接可能已断开，请确认设备状态后重试'
      })
      return
    }
    useToastStore.getState().push({
      kind: 'info',
      title: '重启命令已发送，设备将断开连接',
      detail: '可在下方等待它重新上线'
    })
  },

  setWaitPort: (waitPort) => set({ waitPort }),

  // 保持 async：内部只起定时器（轮询探测），但接口契约是 Promise
  // （调用方 await 它，与其他 start*/stop* 方法保持一致）
  // eslint-disable-next-line @typescript-eslint/require-await -- 见上：契约是 Promise
  startWaitOnline: async () => {
    const { sessionId } = get()
    const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
    if (!session) {
      useToastStore.getState().push({ kind: 'warning', title: '找不到目标设备会话' })
      return
    }
    const host = session.host

    if (waitTimer) clearInterval(waitTimer)
    set({ wait: { waiting: true, online: false, attempts: 0 } })

    const tick = async (): Promise<void> => {
      const state = get().wait
      if (!state.waiting) return
      const res = await call(window.api.firmware.probe(host, get().waitPort, 2500), { silent: true })
      const current = get().wait
      if (!current.waiting) return

      if (res?.reachable) {
        if (waitTimer) {
          clearInterval(waitTimer)
          waitTimer = null
        }
        set({
          wait: {
            waiting: false,
            online: true,
            attempts: current.attempts + 1,
            lastLatency: res.latencyMs
          }
        })
        useToastStore.getState().push({
          kind: 'success',
          title: `${session.title} 已重新上线`,
          detail: `端口 ${get().waitPort} 可达 ${res.latencyMs}ms`
        })
        return
      }

      const attempts = current.attempts + 1
      if (attempts >= WAIT_MAX_ATTEMPTS) {
        if (waitTimer) {
          clearInterval(waitTimer)
          waitTimer = null
        }
        set({ wait: { waiting: false, online: false, attempts } })
        useToastStore.getState().push({
          kind: 'warning',
          title: '等待设备上线超时（约 5 分钟）',
          detail: '请确认设备已正常启动'
        })
        return
      }
      set({ wait: { ...current, attempts } })
    }

    void tick()
    waitTimer = setInterval(() => void tick(), WAIT_INTERVAL_MS)
  },

  stopWaitOnline: () => {
    if (waitTimer) {
      clearInterval(waitTimer)
      waitTimer = null
    }
    set((s) => ({ wait: { ...s.wait, waiting: false } }))
  },

  fetchBootLog: async () => {
    const { sessions, activeId } = useSessionStore.getState()
    /*
     * 只挑 SSH 会话：启动日志靠的是 dmesg / /proc，串口那台根本不跑 shell。
     * 不加这条，活动标签正好是串口时会把 dmesg 原文当控制字符打进串口，
     * 既抓不到日志又把设备控制台搞乱。
     */
    const usable = (s: (typeof sessions)[number]): boolean =>
      s.status === 'connected' && s.kind !== 'serial'
    const session = sessions.find((s) => s.id === activeId && usable(s)) ?? sessions.find(usable)
    if (!session) {
      useToastStore.getState().push({
        kind: 'warning',
        title: '没有已连接的会话',
        detail: '请先重新连接设备，再抓取启动日志'
      })
      return
    }
    set({ bootLoading: true, bootLog: null })
    const res = await call(
      window.api.exec.run(
        session.id,
        "dmesg 2>/dev/null | tail -n 150; echo '--- uptime(sec) ---'; cat /proc/uptime 2>/dev/null; echo '--- kernel warnings ---'; dmesg 2>/dev/null | grep -iE 'error|fail|warn|panic|oops' | tail -20",
        25000
      ),
      { errorTitle: '抓取启动日志失败' }
    )
    set({
      bootLoading: false,
      bootLog: res ? res.stdout || res.stderr || '（无输出）' : null
    })
  }
}))
