import { create } from 'zustand'
import type {
  FirmwareFileInfo,
  FirmwareLogEvent,
  FirmwareUpgradeResult,
  FirmwareVerifyResult
} from '@shared/types'
import { call } from '@/lib/ipc'
import { uid } from '@/lib/utils'
import { useSessionStore } from './sessionStore'
import { useToastStore } from './toastStore'

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
      const { sessions, activeId } = useSessionStore.getState()
      const target =
        sessions.find((s) => s.id === activeId && s.status === 'connected') ??
        sessions.find((s) => s.status === 'connected')
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

    set({ uploading: true })
    const res = await call(window.api.firmware.upload(sessionId, file.path, remoteDir.trim()), {
      errorTitle: '上传失败'
    })
    set({ uploading: false })
    if (res) {
      set({ uploadTaskId: res.taskId })
      useToastStore.getState().push({
        kind: 'info',
        title: '已加入上传队列',
        detail: `目标：${res.remotePath}`
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
          : { kind: 'error', title: '校验不一致！请勿升级', detail: '建议重新上传（可能传输中断或文件被篡改）' }
      )
    }
  },

  setUpgradeCommand: (upgradeCommand) => set({ upgradeCommand }),
  setUpgradeTimeoutMs: (upgradeTimeoutMs) => set({ upgradeTimeoutMs }),

  startUpgrade: async () => {
    const { sessionId, upgradeCommand, upgradeTimeoutMs, upgrading } = get()
    if (upgrading) return
    if (!sessionId) return
    if (!upgradeCommand.trim()) {
      useToastStore.getState().push({ kind: 'warning', title: '请填写升级命令' })
      return
    }

    const runId = uid()
    set({ upgrading: true, upgradeRunId: runId, upgradeLog: '', upgradeResult: null })

    const result = await call(
      window.api.firmware.upgrade(runId, sessionId, upgradeCommand, upgradeTimeoutMs),
      { errorTitle: '升级执行失败' }
    )
    set({ upgrading: false, upgradeRunId: null })
    if (result) {
      set({ upgradeResult: result })
      if (result.status === 'done' && result.exitCode === 0) {
        useToastStore.getState().push({ kind: 'success', title: '升级命令执行成功（退出码 0）' })
      } else if (result.status === 'cancelled') {
        useToastStore.getState().push({ kind: 'info', title: '升级命令已取消' })
      } else {
        useToastStore.getState().push({
          kind: 'warning',
          title: '升级命令执行结束（请核对输出）',
          detail:
            result.exitCode === null
              ? '连接中断：升级脚本可能已重启设备，属正常现象'
              : `退出码 ${result.exitCode}`
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
      const next = s.upgradeLog + e.chunk
      return { upgradeLog: next.length > MAX_LOG_CHARS ? next.slice(next.length - MAX_LOG_CHARS) : next }
    }),

  setRebootCommand: (rebootCommand) => set({ rebootCommand }),

  reboot: async () => {
    const { sessionId, rebootCommand, rebooting } = get()
    if (rebooting || !sessionId) return
    set({ rebooting: true })
    await call(window.api.firmware.reboot(sessionId, rebootCommand.trim() || 'reboot'), {
      silent: true
    })
    set({ rebooting: false })
    useToastStore.getState().push({
      kind: 'info',
      title: '重启命令已发送',
      detail: '设备将断开连接，属正常现象；可在下方等待它重新上线'
    })
  },

  setWaitPort: (waitPort) => set({ waitPort }),

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
          detail: `端口 ${get().waitPort} 可达（${res.latencyMs}ms）`
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
          detail: '请确认设备是否正常启动，或手动检查网络'
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
    const session =
      sessions.find((s) => s.id === activeId && s.status === 'connected') ??
      sessions.find((s) => s.status === 'connected')
    if (!session) {
      useToastStore.getState().push({
        kind: 'warning',
        title: '没有已连接的会话',
        detail: '设备重启后请重新连接（双击左侧连接），再抓取启动日志'
      })
      return
    }
    set({ bootLoading: true, bootLog: null })
    const res = await call(
      window.api.exec.run(
        session.id,
        "dmesg 2>/dev/null | tail -n 150; echo '--- uptime(秒) ---'; cat /proc/uptime 2>/dev/null; echo '--- 内核警告 ---'; dmesg 2>/dev/null | grep -iE 'error|fail|warn|panic|oops' | tail -20",
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
