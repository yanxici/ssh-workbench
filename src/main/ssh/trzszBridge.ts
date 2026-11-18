import { randomUUID } from 'node:crypto'
import { TrzszFilter } from 'trzsz'
import type { TransferRecord, TrzszTransferState } from '@shared/types'

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
  /**
   * 落一条传输记录。
   *
   * 身份字段（connectionId / connectionName / target）由 sessionManager 补齐后
   * 交给 transferRecord 落盘 —— 桥接层不认识会话表（反过来才是依赖方向）。
   * 记录只在开始/结束时各写一次，进度不落盘。
   */
  recordTransfer: (rec: Omit<TransferRecord, 'connectionId' | 'connectionName' | 'target'>) => void
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
  private current: { file?: string; percent?: number; files?: { index: number; total: number } } = {}
  private idleTimer: NodeJS.Timeout | null = null
  /**
   * 本轮传输的记录上下文。
   *
   * 为什么单独存：进度条文本只能告诉我们「第几个文件、百分之几」，
   * 方向和落盘目录只有我们自己知道（上传是按路径推的，下载是先选目录）。
   * 等 isTransferringFiles() 翻转时再回头问库已经问不出来了。
   */
  private pending: {
    direction: 'upload' | 'download'
    localPath: string
    fileName: string
    size: number
  } | null = null
  private recId: string | null = null
  private recStartedAt = 0
  /** 用户主动中断：收尾时记录成 canceled 而不是 done */
  private recCanceled = false

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
      /*
       * 下载目录顺手记下来：trzsz 库自己拿着这个目录去落盘，
       * 我们只有在这一刻才知道文件最终会写到哪里 ——
       * 记录里的「打开所在文件夹」全靠它。
       */
      chooseSaveDirectory: () => {
        const picked = this.hooks.pickSaveDirectory()
        this.pending = {
          direction: 'download',
          localPath: '',
          fileName: '',
          size: 0
        }
        return picked.then((dir) => {
          if (this.pending) this.pending.localPath = dir ?? ''
          return dir
        })
      },
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
    /*
     * 上传方向是我们自己发起的，方向和路径只有这里知道；
     * 多文件时用第一个文件做展示名，总数由进度条文本里的 (i/n) 补。
     */
    this.pending = {
      direction: 'upload',
      localPath: list[0],
      fileName: list[0].split(/[\\/]/).pop() ?? '',
      size: list.length
    }
    this.recCanceled = false
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
    if (this.filter.isTransferringFiles()) {
      // 先打标记再停：syncState 会在同一帧里收尾并落记录，晚一步就记成 done 了
      this.recCanceled = true
      this.filter.stopTransferringFiles()
    }
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
    // 会话被关掉时传输也随之中断：写 interrupted，与「用户主动取消」区分开
    if (this.transferring || this.recId) {
      this.transferring = false
      this.finishRecord('interrupted')
    }
    this.capture = null
  }

  /**
   * 传输真正开始（isTransferringFiles 翻转）时落一条 running 记录。
   *
   * 入队就写的原因和 SFTP 侧一致：进程被强杀时这条记录会停在 running，
   * 下次启动被 sweepStale 改成 interrupted —— 那是唯一事后可确定的事实。
   */
  private beginRecord(): void {
    const p = this.pending
    if (!p) return
    this.recId = randomUUID()
    this.recStartedAt = Date.now()
    this.hooks.recordTransfer({
      id: this.recId,
      direction: p.direction,
      via: 'trzsz',
      localPath: p.localPath,
      remotePath: '',
      fileName: p.fileName,
      size: p.size,
      transferred: 0,
      /*
       * trzsz 的进度只存在于远端重绘的进度条文本里，拿不到总字节数，
       * 所以按「文件个数」记账（多文件时 (i/n) 前缀能给出总数）。
       */
      unit: 'files',
      status: 'running',
      startedAt: this.recStartedAt
    })
  }

  private finishRecord(status: 'done' | 'canceled' | 'interrupted'): void {
    const p = this.pending
    const id = this.recId
    this.recId = null
    this.recCanceled = false
    this.pending = null
    if (!id) return
    const files = this.current.files
    this.hooks.recordTransfer({
      id,
      direction: p?.direction ?? 'upload',
      via: 'trzsz',
      localPath: p?.localPath ?? '',
      remotePath: '',
      fileName: p?.fileName ?? '',
      size: p?.size ?? 0,
      // 多文件时 (i/n) 的 i 就是已完成个数（当前文件也算进去，粗略但不会倒退）
      transferred: files ? files.index : 0,
      unit: 'files',
      status,
      startedAt: this.recStartedAt || Date.now(),
      finishedAt: Date.now()
    })
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
    /*
     * 进度条前缀里还藏着「(2/5) 文件名」—— 多文件传输时 trzsz 只在 fileCount > 1
     * 才输出这段。旧实现把这段连同文件名一起当文件名存了，
     * 于是面板上出现「(2/5) a.txt」这种拿不出去用的名字。
     */
    const pair = /\((\d+)\/(\d+)\)/.exec(text)
    if (pair) {
      const index = Number(pair[1])
      const total = Number(pair[2])
      if (index > 0 && total > 0) this.current.files = { index, total }
    }
    const bar = text.indexOf('[')
    if (bar > 0) {
      const name = text.slice(0, bar).trim()
      if (name) this.current.file = name
    }
    this.current.percent = percent
    const now = Date.now()
    if (now - this.lastEmitAt < STATE_EMIT_MS) return
    this.lastEmitAt = now
    this.hooks.emitState({
      active: this.transferring || this.filter.isTransferringFiles(),
      direction: this.pending?.direction,
      ...this.current
    })
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
        this.beginRecord()
        this.hooks.emitState({ active: true, direction: this.pending?.direction, ...this.current })
      }
      return
    }
    if (!this.transferring) return
    this.transferring = false
    this.finishRecord(this.recCanceled ? 'canceled' : 'done')
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
