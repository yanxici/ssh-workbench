/**
 * 每个会话的「终端当前目录」。
 *
 * 数据来源只有三处（都在 `@/lib/shellCwd` 里解析，这里只负责存）：
 *   1. 用户敲的那行 `cd`（乐观值，0 延迟）；
 *   2. 远端 shell 上报的 OSC 7（权威值，配了 shell-integration 才有）；
 *   3. 会话初始的 home（只做相对路径的基准，不覆盖已有值）。
 *
 * 为什么要有 seq：`cd /a` → 用户手动在侧栏逛到 /etc → 再 `cd /a`，
 * 路径没变但「用户又 cd 了一次」这个事件必须让侧栏重新跳回去。只比较路径串
 * 是看不出这次事件的，所以每次写入都递增一个序号，订阅方以序号变化为准。
 *
 * 为什么不放进 sessionStore：`cd` 一次就写一次，sessionStore 的订阅者（标签栏、
 * 状态栏、技能面板……）会被无谓唤醒；而且 cwd 是「终端运行态」，不参与持久化。
 */
import { create } from 'zustand'
import {
  createInputTracker,
  parseOsc7,
  resolveCdPath,
  containsCdCommand,
  type InputTracker
} from '@/lib/shellCwd'
import { call } from '@/lib/ipc'
import { cachedHome, forgetHome, rememberHome } from '@/lib/remoteHome'
import { normalizeRemoteDir } from '@/lib/uploadDir'

interface CwdState {
  /** sessionId → 绝对路径 */
  path: Record<string, string>
  /** sessionId → 写入序号（订阅方用它判断「有没有发生过 cd」） */
  seq: Record<string, number>
  /** 直接落一个已知路径（OSC 7 / 内部兜底） */
  setPath: (sessionId: string, dir: string) => void
  /** 只在还没有值时落基准（不递增 seq，不触发跟随） */
  seedPath: (sessionId: string, dir: string) => void
  forget: (sessionId: string) => void
}

export const useCwdStore = create<CwdState>()((set, get) => ({
  path: {},
  seq: {},

  setPath: (sessionId, dir) => {
    const next = normalizeRemoteDir(dir)
    if (!next) return
    // 路径没变也照样递增 seq：这是一次「明确发生了 cd」的事件，侧栏该跳回去
    set((s) => ({
      path: { ...s.path, [sessionId]: next },
      seq: { ...s.seq, [sessionId]: (s.seq[sessionId] ?? 0) + 1 }
    }))
  },

  seedPath: (sessionId, dir) => {
    const next = normalizeRemoteDir(dir)
    if (!next) return
    if (get().path[sessionId]) return
    set((s) => ({ path: { ...s.path, [sessionId]: next } }))
  },

  forget: (sessionId) => {
    trackers.delete(sessionId)
    set((s) => {
      const path = { ...s.path }
      const seq = { ...s.seq }
      delete path[sessionId]
      delete seq[sessionId]
      return { path, seq }
    })
  }
}))

/* ------------------------------------------------------------------ *
 *  输入追踪：把每一行命令喂进来，遇到 cd 就更新 cwd
 * ------------------------------------------------------------------ */

const trackers = new Map<string, InputTracker>()

function trackerOf(sessionId: string): InputTracker {
  let t = trackers.get(sessionId)
  if (!t) {
    t = createInputTracker()
    trackers.set(sessionId, t)
  }
  return t
}

/**
 * 把用户输入喂给追踪器；遇到回车且这一行能确定是 `cd <已知路径>` 时更新 cwd。
 *
 * @param data xterm onData 的原始字节（也允许调用方把「程序代发的一条命令 + \r」塞进来）
 */
export function feedTerminalInput(sessionId: string, data: string): void {
  const line = trackerOf(sessionId).feed(data)
  if (!line) return
  void applyCommandLine(sessionId, line)
}

async function applyCommandLine(sessionId: string, line: string): Promise<void> {
  if (!containsCdCommand(line)) return

  const store = useCwdStore.getState()
  let home = cachedHome(sessionId)
  const base = store.path[sessionId] || home || ''

  let target = resolveCdPath(line, base, home)
  if (!target && !home) {
    /*
     * `cd` 不带参数或 `cd ~` 需要 home 才能解析。这一步很便宜（主进程有缓存），
     * 而且只在这种「确实有 cd、但我们还缺基准」的行上才发生。
     */
    const got = normalizeRemoteDir(await call(window.api.sftp.home(sessionId), { silent: true }))
    if (!got) return
    home = got
    rememberHome(sessionId, home)
    target = resolveCdPath(line, base || home, home)
  }
  if (target) store.setPath(sessionId, target)
}

/**
 * OSC 7 到达：`file://host/path`。
 *
 * 远端 shell 配了 shell-integration（`/etc/profile.d/vte.sh`、oh-my-zsh 的
 * osc7 插件等）时会主动上报，这是比本地解析更权威的值，直接覆盖。
 */
export function applyOsc7(sessionId: string, payload: string): void {
  const dir = parseOsc7(payload)
  if (dir) useCwdStore.getState().setPath(sessionId, dir)
}

/** 会话开始时把 home 落成相对路径的基准（已有值不覆盖） */
export function seedCwdFromHome(sessionId: string, home: string): void {
  useCwdStore.getState().seedPath(sessionId, home)
}

/**
 * 会话结束时把它的 cwd 与输入追踪器一起丢掉。
 *
 * 不丢的后果不是「多占几 KB」而是**串台**：重连会沿用同一个 sessionId，
 * 新连上的机器第一次打开文件面板就会停在上一条连接最后待的目录上。
 */
export function forgetCwd(sessionId: string): void {
  useCwdStore.getState().forget(sessionId)
  forgetHome(sessionId)
}
