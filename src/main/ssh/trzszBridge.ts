import { TrzszFilter } from 'trzsz'
import type { TrzszTransferState } from '@shared/types'

/**
 * trzsz（trz / tsz）文件传输的主进程桥接。
 *
 * 为什么放在主进程而不是渲染进程（Tabby / electerm 是放渲染层的）：
 * 1. 主进程同时拥有原始字节流、原生对话框和 fs，三样都在一处；
 * 2. 大文件不再走「base64 编 IPC → 渲染层解码 → 再 base64 回去」的往返，
 *    现有 ZMODEM 每帧都要这么绕一圈，几十 MB 就能量到明显的 CPU 占用；
 * 3. 渲染层本来就不该拿到远端命令输出的原始字节（ZMODEM 那条老路是历史包袱）。
 *
 * 与 ZMODEM 的不对称是刻意保留的：zmodem 仍然在渲染进程（lib/zmodem.ts），
 * trzsz 在主进程。两边互不认识，靠「谁先看到握手串」自然分流：
 * - 输出进 flush() 时若发现 ::TRZSZ:TRANSFER: 才创建 TrzszFilter；
 * - 未创建之前一个字节都不碰，ZMODEM 与普通终端行为完全不变。
 *
 * 进度条不自己做：trzsz 内部就是往终端写「文件名 [███░░░] 45% | 大小 | 速度 | ETA」
 * 再用 \r / ESC[nD 原地重绘，所以 writeToTerminal 的内容当普通会话数据下发即可，
 * 回滚、搜索、录制全都自动生效。我们只额外解析一个百分比给状态条。
 */

/** 协议握手串，trzsz 内部常量是 '::TRZSZ:TRANSFER:' */
const HANDSHAKE = '::TRZSZ:TRANSFER:'

/** 握手整行（S=下载 sz、R/D=上传 rz），录制时要剔掉，否则回放是一屏乱码 */
const HANDSHAKE_RE = /::TRZSZ:TRANSFER:[SRD]:\d+\.\d+\.\d+(?::\d+)?\r?\n?/g

/** 进度条限流：trzsz 自己 200ms 才重绘一次，我们比它更松一点 */
const STATE_EMIT_MS = 150

/** 远端没装 trz/tsz 时的两种证据：shell 报 command not found，或 3 秒没开始传 */
const NOT_FOUND_RE = /command not found:?\s*(?:trz|tsz)|(?:trz|tsz)(?: -d)?: (?:command )?not found/i

/**
 * 状态形状放在 @shared/types（渲染层也要读），这里只做转出，
 * 免得主进程与渲染层各写一份字段名然后悄悄漂移。
 */
export type TrzszState = TrzszTransferState

export interface TrzszBridgeHooks {
  /** 把协议帧写回远端。trzsz 发出的全是可打印文本（base64 + \n），不是二进制 */
  sendToServer: (data: string) => void
  /** 把要显示在终端里的文本送出去（进度条、Saved 文案都由 trzsz 自己拼好） */
  emitText: (text: string) => void
  /** 传输状态变化，给状态条与提示用 */
  emitState: (state: TrzszState) => void
  /** 下载时选目录（原生对话框） */
  pickSaveDirectory: () => Promise<string | undefined>
  /** 上传时选文件 / 目录（原生对话框） */
  pickSendFiles: (directory: boolean) => Promise<string[] | undefined>
}

/** 判断一段输出是否含 trzsz 握手 —— 只有这一步命中才值得为会话创建过滤器 */
export function looksLikeTrzsz(text: string): boolean {
  return text.includes(HANDSHAKE)
}

/** 从文本里剔除握手整行（只用于会话录制，终端照常显示） */
export function stripTrzszHandshake(text: string): string {
  return text.includes(HANDSHAKE) ? text.replace(HANDSHAKE_RE, '') : text
}

/**
 * 这段输出是否像「远端没装 trz / tsz」。
 *
 * 单独导出的原因：用户手动敲 `trz` 时我们还没有创建过滤器（只在看到握手才建），
 * 那条路径上没人解析输出，于是「没装」的提示永远出不来。sessionManager.flush()
 * 在无过滤器的分支上再调一次这个函数，两条路径就都能提示了。
 */
export function looksLikeTrzszMissing(text: string): boolean {
  return NOT_FOUND_RE.test(text)
}

/** writeToTerminal 的入参可能是 string / ArrayBuffer / Uint8Array / Blob，统一成 string */
function asText(output: string | ArrayBuffer | Uint8Array | Blob): string {
  if (typeof output === 'string') return output
  if (output instanceof ArrayBuffer) return Buffer.from(output).toString('utf8')
  if (ArrayBuffer.isView(output)) return Buffer.from(output.buffer, output.byteOffset, output.byteLength).toString('utf8')
  // Blob 只在浏览器分支出现，主进程不会走到；留一条兜底不抛
  return ''
}

class TrzszSession {
  private readonly filter: TrzszFilter
  /** 同步收集 writeToTerminal：flush() 期间要一次性把过滤后的文本取出来 */
  private capture: string[] | null = null
  private transferring = false
  private disposed = false
  private lastEmitAt = 0
  private current: { file?: string; percent?: number } = {}
  private idleTimer: NodeJS.Timeout | null = null

  constructor(
    private readonly hooks: TrzszBridgeHooks,
    columns: number,
    private readonly onIdle: () => void
  ) {
    this.filter = new TrzszFilter({
      writeToTerminal: (output) => this.onWrite(asText(output)),
      sendToServer: (input) => this.hooks.sendToServer(typeof input === 'string' ? input : asText(input)),
      // Node 环境下这两个回调是构造函数的硬性要求（否则直接 throw），
      // 即便我们上传时总是自己传 paths，也必须给出来。
      chooseSendFiles: (directory) => this.hooks.pickSendFiles(Boolean(directory)),
      chooseSaveDirectory: () => this.hooks.pickSaveDirectory(),
      terminalColumns: columns,
      isWindowsShell: process.platform === 'win32'
    })
  }

  get active(): boolean {
    return this.transferring
  }

  /** 服务端输出进来：过滤后返回该给终端的内容（同步，包含握手那一帧） */
  processServerOutput(text: string): string {
    if (this.disposed) return text
    this.capture = []
    let out = ''
    try {
      this.filter.processServerOutput(text)
    } finally {
      out = this.capture.join('')
      this.capture = null
    }
    this.syncState()
    return out
  }

  /** 终端输入进来：传输中 trzsz 只放行 Ctrl-C，其余全部吞掉 */
  processInput(data: string): void {
    if (this.disposed) {
      this.hooks.sendToServer(data)
      return
    }
    this.filter.processTerminalInput(data)
    this.syncState()
  }

  setColumns(cols: number): void {
    if (this.disposed || !Number.isFinite(cols) || cols <= 0) return
    this.filter.setTerminalColumns(cols)
  }

  /** 主动上传：paths 为空时弹原生文件对话框 */
  async upload(paths?: string[]): Promise<void> {
    if (this.disposed) throw new Error('会话已关闭')
    if (this.filter.isTransferringFiles()) throw new Error('已有传输在进行，等它结束再传')
    let list = paths
    if (!list || list.length === 0) list = await this.hooks.pickSendFiles(false)
    if (!list || list.length === 0) return
    try {
      await this.filter.uploadFiles(list)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (/Upload does not start/i.test(message)) {
        this.hooks.emitState({ active: false, notice: 'no-remote-trz' })
        throw new Error('远端没有响应 trz，多半是没装 trzsz（apt install trzsz / brew install trzsz）')
      }
      throw new Error(message)
    } finally {
      this.syncState()
    }
  }

  cancel(): void {
    if (this.disposed) return
    if (this.filter.isTransferringFiles()) this.filter.stopTransferringFiles()
    this.syncState()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    try {
      if (this.filter.isTransferringFiles()) this.filter.stopTransferringFiles()
    } catch {
      /* 关会话时远端可能已经不在了，停不下来也不影响清理 */
    }
    this.capture = null
  }

  private onWrite(text: string): void {
    if (!text) return
    this.scan(text)
    if (this.capture) this.capture.push(text)
    else this.hooks.emitText(text)
  }

  /** 从进度条文本里抠出文件名与百分比；顺便认「没装 trz」 */
  private scan(text: string): void {
    if (NOT_FOUND_RE.test(text)) {
      this.hooks.emitState({ active: this.transferring, notice: 'no-remote-trz' })
      return
    }
    if (!text.includes('%')) return
    const percents = [...text.matchAll(/(\d{1,3})%/g)]
    if (percents.length === 0) return
    const percent = Math.max(0, Math.min(100, Number(percents[percents.length - 1][1])))
    const bar = text.indexOf('[')
    if (bar > 0) {
      const name = text.slice(0, bar).trim()
      if (name) this.current.file = name
    }
    this.current.percent = percent
    const now = Date.now()
    if (now - this.lastEmitAt < STATE_EMIT_MS) return
    this.lastEmitAt = now
    this.hooks.emitState({ active: this.transferring || this.filter.isTransferringFiles(), ...this.current })
  }

  /** 传输开始 / 结束只在 isTransferringFiles() 翻转时广播，避免每帧都发 */
  private syncState(): void {
    if (this.disposed) return
    let active = false
    try {
      active = this.filter.isTransferringFiles()
    } catch {
      active = false
    }
    if (active) {
      if (!this.transferring) {
        this.transferring = true
        if (this.idleTimer) {
          clearTimeout(this.idleTimer)
          this.idleTimer = null
        }
        this.hooks.emitState({ active: true, ...this.current })
      }
      return
    }
    if (!this.transferring) return
    this.transferring = false
    this.hooks.emitState({ active: false, ...this.current })
    this.current = {}
    this.lastEmitAt = 0
    // 传完之后再留一小会儿：进度条收尾的 \r 重绘还在路上，
    // 立刻销毁会让最后一行停在半截，而且下一轮握手又要重建过滤器。
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.transferring) this.onIdle()
    }, 30_000)
  }
}

class TrzszManager {
  private readonly sessions = new Map<string, TrzszSession>()

  get(sessionId: string): TrzszSession | undefined {
    return this.sessions.get(sessionId)
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId)
  }

  ensure(sessionId: string, hooks: TrzszBridgeHooks, columns: number): TrzszSession {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const created = new TrzszSession(hooks, columns, () => {
      // 闲置回收：30 秒内没有新一轮传输就丢掉，之后的握手会重新创建
      if (this.sessions.get(sessionId) === created) {
        created.dispose()
        this.sessions.delete(sessionId)
      }
    })
    this.sessions.set(sessionId, created)
    return created
  }

  drop(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session.dispose()
    this.sessions.delete(sessionId)
  }

  /** 测试用：清掉全部实例 */
  reset(): void {
    for (const session of this.sessions.values()) session.dispose()
    this.sessions.clear()
  }

  size(): number {
    return this.sessions.size
  }
}

export { TrzszSession }
export const trzszManager = new TrzszManager()
