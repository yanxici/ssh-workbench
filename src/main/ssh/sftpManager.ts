import type { OpenMode, SFTPWrapper, Stats } from 'ssh2'
import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RemoteFile, TransferProgressEvent, TransferTask } from '@shared/types'
import { sessionManager } from './sessionManager'

/**
 * SFTP 文件管理 —— 在已建立的 SSH 会话上挂载 SFTP 子系统。
 *
 * 设计：
 * - 每个会话懒创建并缓存一个 SFTPWrapper，会话断开后自动失效重建；
 * - 传输任务串行排队（避免多任务争抢带宽/连接），进度以节流事件推送到渲染层；
 * - 上传下载基于 ssh2 的 fastPut/fastGet（分块并发，嵌入式设备兼容性好），
 *   通过 step 回调驱动进度（约 150ms 节流一次）；
 * - 远程文本编辑：保存前自动把原文件改名为 <name>.bak（覆盖旧备份）。
 */

type ProgressHandler = (event: TransferProgressEvent) => void

const PROGRESS_THROTTLE_MS = 150
const EDIT_SIZE_LIMIT = 2 * 1024 * 1024

/** 分块传输：单块大小与在途并发数（兼顾吞吐与可中断粒度） */
const CHUNK_SIZE = 256 * 1024
const CHUNK_INFLIGHT = 6
/** 同时进行的传输任务数（暂停中的任务不会挡住队列里的其他任务） */
const MAX_CONCURRENT_TRANSFERS = 3

/**
 * 传输控制块：暂停/继续/取消都作用在这里。
 *
 * ssh2 的 fastGet/fastPut 是一次性调用、无法中断，所以文件传输改成
 * 「open → 分块 read/write → close」引擎，块与块之间检查这里的标志：
 * - paused  → 停在循环里等唤醒（句柄保留，继续时原地续传）
 * - cancelled → 抛出 TransferCancelledError，清理半截文件
 * - halt    → 出错时让其余并发块尽快退出
 */
interface TransferControl {
  sessionId: string
  direction: 'upload' | 'download'
  localPath: string
  remotePath: string
  transferred: number
  total: number
  unit: 'bytes' | 'files'
  paused: boolean
  cancelled: boolean
  halt: boolean
  waiters: Array<() => void>
}

class TransferCancelledError extends Error {
  constructor() {
    super('传输已取消')
    this.name = 'TransferCancelledError'
  }
}

class TransferAbortedError extends Error {
  constructor() {
    super('传输已中断')
    this.name = 'TransferAbortedError'
  }
}

/** 唤醒所有挂在暂停点上的等待者 */
function wake(ctl: TransferControl): void {
  const waiters = ctl.waiters.splice(0)
  for (const w of waiters) w()
}

/** 暂停点：可在每个分块之间调用 */
async function checkpoint(ctl: TransferControl): Promise<void> {
  if (ctl.cancelled) throw new TransferCancelledError()
  if (ctl.halt) throw new TransferAbortedError()
  while (ctl.paused && !ctl.cancelled && !ctl.halt) {
    await new Promise<void>((resolve) => ctl.waiters.push(resolve))
  }
  if (ctl.cancelled) throw new TransferCancelledError()
  if (ctl.halt) throw new TransferAbortedError()
}

/* ------------------------------ 工具 ------------------------------ */

/** 远端 POSIX 路径拼接 */
function joinRemote(dir: string, name: string): string {
  if (dir === '/') return `/${name}`
  return `${dir.replace(/\/+$/, '')}/${name}`
}

function formatMode(mode: number): string {
  const perm = (m: number): string =>
    `${m & 4 ? 'r' : '-'}${m & 2 ? 'w' : '-'}${m & 1 ? 'x' : '-'}`
  const type = mode & 0o40000 ? 'd' : mode & 0o120000 ? 'l' : '-'
  return type + perm((mode >> 6) & 7) + perm((mode >> 3) & 7) + perm(mode & 7)
}

function pStat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.stat(path, (err, stats) => (err ? reject(err) : resolve(stats)))
  })
}

function pReaddir(sftp: SFTPWrapper, path: string): Promise<Array<{ filename: string; attrs: Stats }>> {
  return new Promise((resolve, reject) => {
    sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list)))
  })
}

function pUnlink(sftp: SFTPWrapper, path: string, isDir: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const cb = (err: Error | undefined | null): void => (err ? reject(err) : resolve())
    if (isDir) sftp.rmdir(path, cb)
    else sftp.unlink(path, cb)
  })
}

function pRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
  })
}

/* --------------------------- 分块读写原语 --------------------------- */

function pOpen(sftp: SFTPWrapper, path: string, mode: OpenMode): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    sftp.open(path, mode, (err, handle) => (err ? reject(err) : resolve(handle)))
  })
}

function pClose(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return new Promise((resolve) => {
    sftp.close(handle, () => resolve())
  })
}

function pFstat(sftp: SFTPWrapper, handle: Buffer): Promise<Stats> {
  return new Promise((resolve, reject) => {
    sftp.fstat(handle, (err, stats) => (err ? reject(err) : resolve(stats)))
  })
}

function pRead(
  sftp: SFTPWrapper,
  handle: Buffer,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    sftp.read(handle, buffer, offset, length, position, (err, bytesRead) => {
      if (err) reject(err)
      else resolve(bytesRead)
    })
  })
}

function pWrite(
  sftp: SFTPWrapper,
  handle: Buffer,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.write(handle, buffer, offset, length, position, (err) =>
      err ? reject(err) : resolve()
    )
  })
}

/** 删除传输失败/取消后残留的半截文件（失败无所谓） */
async function silentUnlinkLocal(path: string): Promise<void> {
  await fs.unlink(path).catch(() => undefined)
}

async function silentUnlinkRemote(sftp: SFTPWrapper, path: string): Promise<void> {
  await new Promise<void>((resolve) => {
    sftp.unlink(path, () => resolve())
  })
}

/**
 * 进度上报器：节流 + 平均速度。所有传输路径共用，保证渲染层看到的事件形状一致。
 */
function makeReporter(
  ctl: TransferControl,
  taskId: string,
  emit: (e: TransferProgressEvent) => void
): { report: (force?: boolean) => void; elapsed: () => number } {
  const startedAt = Date.now()
  let lastEmit = 0
  let lastBytes = 0
  const base = (): Omit<TransferProgressEvent, 'status' | 'speedBps'> => ({
    taskId,
    sessionId: ctl.sessionId,
    direction: ctl.direction,
    localPath: ctl.localPath,
    remotePath: ctl.remotePath,
    transferred: ctl.transferred,
    total: ctl.total,
    unit: ctl.unit
  })

  return {
    report: (force?: boolean): void => {
      const now = Date.now()
      if (!force && now - lastEmit < PROGRESS_THROTTLE_MS) return
      const span = Math.max(now - (lastEmit || startedAt), 1)
      const speed = ((ctl.transferred - lastBytes) * 1000) / span
      lastEmit = now
      lastBytes = ctl.transferred
      emit({ ...base(), status: 'running', speedBps: Math.max(0, Math.round(speed)) })
    },
    elapsed: (): number => Date.now() - startedAt
  }
}

/* ------------------------------ 管理器 ------------------------------ */

/** 导出类供回归脚本驱动（生产只使用下方的单例） */
export class SftpManager {
  private wrappers = new Map<string, SFTPWrapper>()
  /** 正在挂载中的 SFTP 通道（并发请求共享同一次挂载，避免重复 sftp 子系统） */
  private pendingMounts = new Map<string, Promise<SFTPWrapper>>()
  /**
   * 每个会话的远端 home 绝对路径缓存。
   * home() 走一次 realpath，打开文件面板时至少多点一次往返；
   * home 在一个会话生命周期内不会变，缓存到断开为止即可。
   */
  private homes = new Map<string, string>()
  private onProgress: ProgressHandler | null = null
  /** 在途/排队中的传输控制块：暂停、继续、取消都从这里找 */
  private controls = new Map<string, TransferControl>()
  /** 传输并发度（同时进行的任务数）；暂停中的任务仍占用一个位，避免队列无限漂移 */
  private running = 0
  private waiters: Array<() => void> = []
  setProgressHandler(handler: ProgressHandler): void {
    this.onProgress = handler
  }

  /* ------------------------------ 传输控制 ------------------------------ */

  /** 暂停某个传输任务（排队中的任务也可以先暂停，轮到它时直接停住） */
  pauseTransfer(taskId: string): boolean {
    const ctl = this.controls.get(taskId)
    if (!ctl || ctl.cancelled) return false
    if (ctl.paused) return true
    ctl.paused = true
    this.emit({
      taskId,
      sessionId: ctl.sessionId,
      direction: ctl.direction,
      localPath: ctl.localPath,
      remotePath: ctl.remotePath,
      transferred: ctl.transferred,
      total: ctl.total,
      status: 'paused',
      unit: ctl.unit
    })
    return true
  }

  /** 继续被暂停的传输 */
  resumeTransfer(taskId: string): boolean {
    const ctl = this.controls.get(taskId)
    if (!ctl || ctl.cancelled || !ctl.paused) return false
    ctl.paused = false
    wake(ctl)
    this.emit({
      taskId,
      sessionId: ctl.sessionId,
      direction: ctl.direction,
      localPath: ctl.localPath,
      remotePath: ctl.remotePath,
      transferred: ctl.transferred,
      total: ctl.total,
      status: 'running',
      unit: ctl.unit
    })
    return true
  }

  /** 终止传输（排队中的会直接跳过；传输中的在下一个分块边界退出并清理半截文件） */
  cancelTransfer(taskId: string): boolean {
    const ctl = this.controls.get(taskId)
    if (!ctl || ctl.cancelled) return false
    ctl.cancelled = true
    ctl.paused = false
    wake(ctl)
    // 立刻回一帧 canceled：排队中的任务可能要等并发位空出来才真正退出，
    // 界面不该在这段时间里继续显示"传输中"。
    this.emit({
      taskId,
      sessionId: ctl.sessionId,
      direction: ctl.direction,
      localPath: ctl.localPath,
      remotePath: ctl.remotePath,
      transferred: ctl.transferred,
      total: ctl.total,
      status: 'canceled',
      unit: ctl.unit
    })
    return true
  }

  /** 是否还有任务在跑（供测试/诊断使用） */
  hasActiveTransfers(): boolean {
    return this.controls.size > 0
  }

  /** 会话关闭时清理对应 SFTP 通道 */
  clearSession(sessionId: string): void {
    this.pendingMounts.delete(sessionId)
    this.homes.delete(sessionId)
    const wrapper = this.wrappers.get(sessionId)
    if (!wrapper) return
    this.wrappers.delete(sessionId)
    try {
      wrapper.end()
    } catch {
      /* ignore */
    }
  }

  private async getSftp(sessionId: string): Promise<SFTPWrapper> {
    const cached = this.wrappers.get(sessionId)
    if (cached) return cached

    const inflight = this.pendingMounts.get(sessionId)
    if (inflight) return inflight

    const mounting = (async (): Promise<SFTPWrapper> => {
      // 会话可能仍在握手（连接瞬间就打开了文件树）—— 等到 connected 再挂载，
      // 否则会在未连接的占位客户端上直接失败
      await sessionManager.waitUntilReady(sessionId)
      const client = sessionManager.getClient(sessionId)
      if (!client) throw new Error('会话不存在或已断开，请先打开 SSH 连接')

      const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
        client.sftp((err, wrapper) => {
          if (err) reject(new Error(`无法启动 SFTP 子系统：${err.message}`))
          else resolve(wrapper)
        })
      })

      this.wrappers.set(sessionId, sftp)
      sftp.on('close', () => {
        if (this.wrappers.get(sessionId) === sftp) this.wrappers.delete(sessionId)
      })
      return sftp
    })()

    this.pendingMounts.set(sessionId, mounting)
    try {
      return await mounting
    } finally {
      if (this.pendingMounts.get(sessionId) === mounting) this.pendingMounts.delete(sessionId)
    }
  }

  /** 出错后使缓存的通道失效（例如会话已断开） */
  private invalidate(sessionId: string): void {
    this.clearSession(sessionId)
  }

  /* ------------------------------ 目录与文件 ------------------------------ */

  async home(sessionId: string): Promise<string> {
    const cached = this.homes.get(sessionId)
    if (cached) return cached
    const sftp = await this.getSftp(sessionId)
    const abs = await new Promise<string>((resolve, reject) => {
      sftp.realpath('.', (err, path) => {
        if (err) reject(new Error(`无法获取远端主目录：${err.message}`))
        else resolve(path)
      })
    })
    this.homes.set(sessionId, abs)
    return abs
  }

  /**
   * 预挂载 SFTP 子系统（方案 B）。
   *
   * 首次点开文件面板时，getSftp() 要单独做一次 client.sftp() 握手，
   * 真实服务器上常见 200~800ms，而且这次握手与随后的 readdir 是串行的 ——
   * 用户看到的就是「点了要等一会」。
   *
   * SSH 连接建立后立刻在后台预热，把这段时间提前吃掉；同时把 home 也解析好，
   * 打开面板时直接命中缓存。失败静默：预热只是优化，不该影响连接主流程。
   */
  async prewarm(sessionId: string): Promise<void> {
    try {
      await this.getSftp(sessionId)
      // 顺手解析 home，打开面板时不用再等一次 realpath
      await this.home(sessionId)
    } catch {
      /* 预热失败不影响主流程，后续按需挂载即可 */
    }
  }

  async list(sessionId: string, dir: string): Promise<RemoteFile[]> {
    const sftp = await this.getSftp(sessionId)
    try {
      const entries = await pReaddir(sftp, dir)
      const files: RemoteFile[] = entries.map((e) => {
        const attrs = e.attrs
        const isDir = attrs.isDirectory()
        const isLink = attrs.isSymbolicLink()
        return {
          name: e.filename,
          path: joinRemote(dir, e.filename),
          type: isDir ? 'directory' : isLink ? 'symlink' : 'file',
          size: attrs.size ?? 0,
          mode: attrs.mode ?? 0,
          modeStr: formatMode(attrs.mode ?? 0),
          uid: attrs.uid ?? 0,
          gid: attrs.gid ?? 0,
          mtime: (attrs.mtime ?? 0) * 1000,
          isLink
        }
      })
      // 目录在前，再按名称排序
      files.sort((a, b) => {
        const aDir = a.type === 'directory'
        const bDir = b.type === 'directory'
        if (aDir !== bDir) return aDir ? -1 : 1
        return a.name.localeCompare(b.name, 'zh-CN')
      })
      return files
    } catch (err) {
      this.invalidate(sessionId)
      throw new Error(`读取目录失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async mkdir(sessionId: string, path: string): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    await new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, (err) => {
        if (err) reject(new Error(`创建目录失败：${err.message}`))
        else resolve()
      })
    })
  }

  /** 递归删除（文件或目录） */
  async remove(sessionId: string, path: string): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    await this.removeRecursive(sftp, path)
  }

  private async removeRecursive(sftp: SFTPWrapper, path: string): Promise<void> {
    const st = await pStat(sftp, path)
    if (st.isDirectory()) {
      const entries = await pReaddir(sftp, path)
      for (const e of entries) {
        await this.removeRecursive(sftp, joinRemote(path, e.filename))
      }
      await pUnlink(sftp, path, true)
    } else {
      await pUnlink(sftp, path, false)
    }
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    await pRename(sftp, from, to)
  }

  async chmod(sessionId: string, path: string, mode: number): Promise<void> {
    const sftp = await this.getSftp(sessionId)
    await new Promise<void>((resolve, reject) => {
      sftp.chmod(path, mode, (err) => {
        if (err) reject(new Error(`修改权限失败：${err.message}`))
        else resolve()
      })
    })
  }

  /* ------------------------------ 远程编辑 ------------------------------ */

  async readText(sessionId: string, path: string): Promise<string> {
    const sftp = await this.getSftp(sessionId)
    const st = await pStat(sftp, path)
    if (st.size > EDIT_SIZE_LIMIT) {
      throw new Error(
        `文件过大（${(st.size / 1048576).toFixed(1)} MB），请下载到本地后再编辑（上限 2 MB）`
      )
    }
    const buf = await new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(path, (err, data) => (err ? reject(new Error(`读取失败：${err.message}`)) : resolve(data)))
    })
    if (buf.includes(0)) throw new Error('该文件看起来是二进制文件，无法以文本方式编辑')
    return buf.toString('utf-8')
  }

  /** 保存远程文本：原文件先备份为 <path>.bak，再写入新内容 */
  async writeText(sessionId: string, path: string, content: string): Promise<void> {
    const sftp = await this.getSftp(sessionId)

    // 备份原文件（若存在）
    try {
      await pStat(sftp, path)
      const bak = `${path}.bak`
      try {
        await pUnlink(sftp, bak, false)
      } catch {
        /* 旧备份不存在 */
      }
      await pRename(sftp, path, bak)
    } catch {
      /* 目标不存在：全新文件，无需备份 */
    }

    await new Promise<void>((resolve, reject) => {
      sftp.writeFile(path, content, (err) => {
        if (err) reject(new Error(`写入失败：${err.message}`))
        else resolve()
      })
    })
  }

  /* ------------------------------ 传输 ------------------------------ */

  upload(sessionId: string, localPaths: string[], remoteDir: string): string[] {
    const taskIds: string[] = []
    for (const localPath of localPaths) {
      const taskId = randomUUID()
      taskIds.push(taskId)
      const remotePath = joinRemote(remoteDir, basename(localPath))
      this.enqueue(
        async (ctl) => {
          const sftp = await this.getSftp(sessionId)
          const st = await fs.stat(localPath).catch(() => null)
          if (st?.isDirectory()) {
            await transferUploadDir(sftp, ctl, taskId, (e) => this.emit(e))
          } else {
            await transferUpload(sftp, ctl, taskId, (e) => this.emit(e))
          }
        },
        sessionId,
        taskId,
        'upload',
        localPath,
        remotePath
      )
    }
    return taskIds
  }

  download(sessionId: string, remotePaths: string[], localDir: string): string[] {
    const taskIds: string[] = []
    for (const remotePath of remotePaths) {
      const taskId = randomUUID()
      taskIds.push(taskId)
      const localPath = join(localDir, basename(remotePath))
      this.enqueue(
        async (ctl) => {
          const sftp = await this.getSftp(sessionId)
          const st = await pStat(sftp, remotePath).catch(() => null)
          if (st?.isDirectory()) {
            await transferDownloadDir(sftp, ctl, taskId, (e) => this.emit(e))
          } else {
            await transferDownload(sftp, ctl, taskId, (e) => this.emit(e))
          }
        },
        sessionId,
        taskId,
        'download',
        localPath,
        remotePath
      )
    }
    return taskIds
  }

  /** 注册任务并按并发度调度（暂停/继续/取消都靠 controls 里的控制块） */
  private enqueue(
    build: (ctl: TransferControl) => Promise<void>,
    sessionId: string,
    taskId: string,
    direction: 'upload' | 'download',
    localPath: string,
    remotePath: string
  ): void {
    const ctl: TransferControl = {
      sessionId,
      direction,
      localPath,
      remotePath,
      transferred: 0,
      total: 0,
      unit: 'bytes',
      paused: false,
      cancelled: false,
      halt: false,
      waiters: []
    }
    this.controls.set(taskId, ctl)
    this.emit({ ...this.baseEvent(ctl, taskId), status: 'pending' })

    const run = async (): Promise<void> => {
      // 排队期间就被取消：不占并发位，直接落终态
      if (ctl.cancelled) {
        this.controls.delete(taskId)
        this.emit({ ...this.baseEvent(ctl, taskId), status: 'canceled' })
        return
      }
      await this.acquire()
      try {
        await build(ctl)
        this.emit({ ...this.baseEvent(ctl, taskId), status: 'done' })
      } catch (err) {
        if (err instanceof TransferCancelledError) {
          this.emit({ ...this.baseEvent(ctl, taskId), status: 'canceled' })
        } else if (err instanceof TransferAbortedError) {
          this.emit({
            ...this.baseEvent(ctl, taskId),
            status: 'error',
            error: '传输已中断'
          })
        } else {
          this.emit({
            ...this.baseEvent(ctl, taskId),
            status: 'error',
            error: err instanceof Error ? err.message : String(err)
          })
        }
      } finally {
        this.controls.delete(taskId)
        this.release()
      }
    }
    void run()
  }

  /** 并发闸门：同时最多 MAX_CONCURRENT_TRANSFERS 个任务 */
  private acquire(): Promise<void> {
    if (this.running < MAX_CONCURRENT_TRANSFERS) {
      this.running += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.running += 1
        resolve()
      })
    })
  }

  private release(): void {
    this.running = Math.max(0, this.running - 1)
    const next = this.waiters.shift()
    if (next) next()
  }

  private baseEvent(
    ctl: TransferControl,
    taskId: string
  ): Omit<TransferProgressEvent, 'status'> {
    return {
      taskId,
      sessionId: ctl.sessionId,
      direction: ctl.direction,
      localPath: ctl.localPath,
      remotePath: ctl.remotePath,
      transferred: ctl.transferred,
      total: ctl.total,
      unit: ctl.unit
    }
  }

  private emit(event: TransferProgressEvent): void {
    this.onProgress?.(event)
  }
}

/* ------------------------------ 分块传输引擎 ------------------------------ */

/**
 * 单文件以「open → 批量 read/write → close」方式传输。
 *
 * 为什么不用 fastGet/fastPut：那是一次性调用，只有 step 回调，没有任何中断句柄，
 * 暂停/终止无从下手。这里在每批分块之间调用 checkpoint(ctl)，暂停时原地等待，
 * 取消时抛 TransferCancelledError，随后清理半截文件。
 *
 * 一批 = CHUNK_INFLIGHT 个 CHUNK_SIZE 块（≈1.5MB），吞吐接近 fastGet，中断粒度可接受。
 */

function eventOf(
  ctl: TransferControl,
  taskId: string,
  status: TransferTask['status'],
  extra: Partial<TransferProgressEvent> = {}
): TransferProgressEvent {
  return {
    taskId,
    sessionId: ctl.sessionId,
    direction: ctl.direction,
    localPath: ctl.localPath,
    remotePath: ctl.remotePath,
    transferred: ctl.transferred,
    total: ctl.total,
    unit: ctl.unit,
    status,
    ...extra
  }
}

/** 上传单个文件（本地 → 远端），返回实际写入字节数 */
async function uploadFileChunked(
  sftp: SFTPWrapper,
  ctl: TransferControl,
  localPath: string,
  remotePath: string,
  onBytes: (transferred: number, total: number) => void
): Promise<number> {
  const local = await fs.open(localPath, 'r')
  let handle: Buffer | null = null
  let written = 0
  try {
    const st = await local.stat()
    const total = st.size
    onBytes(0, total)
    handle = await pOpen(sftp, remotePath, 'w')
    let pos = 0
    for (;;) {
      await checkpoint(ctl)
      const batch: Array<{ pos: number; bytes: number; buf: Buffer }> = []
      for (let i = 0; i < CHUNK_INFLIGHT && pos < total; i += 1) {
        const len = Math.min(CHUNK_SIZE, total - pos)
        const buf = Buffer.allocUnsafe(len)
        const { bytesRead } = await local.read(buf, 0, len, pos)
        if (bytesRead <= 0) break
        batch.push({ pos, bytes: bytesRead, buf })
        pos += bytesRead
        if (bytesRead < len) break
      }
      if (batch.length === 0) break
      await Promise.all(
        batch.map((c) => pWrite(sftp, handle as Buffer, c.buf, 0, c.bytes, c.pos))
      )
      written += batch.reduce((n, c) => n + c.bytes, 0)
      onBytes(written, total)
    }
    return written
  } catch (err) {
    if (handle) await silentUnlinkRemote(sftp, remotePath)
    throw err
  } finally {
    if (handle) await pClose(sftp, handle)
    await local.close().catch(() => undefined)
  }
}

/** 下载单个文件（远端 → 本地），返回实际写入字节数 */
async function downloadFileChunked(
  sftp: SFTPWrapper,
  ctl: TransferControl,
  remotePath: string,
  localPath: string,
  onBytes: (transferred: number, total: number) => void
): Promise<number> {
  await fs.mkdir(dirname(localPath), { recursive: true })
  let handle: Buffer | null = null
  let local: FileHandle | null = null
  let pos = 0
  try {
    handle = await pOpen(sftp, remotePath, 'r')
    // stat 可能因权限失败，fstat 拿句柄更可靠；都拿不到就靠读到 EOF 定位总量
    const st = await pFstat(sftp, handle).catch(() => null)
    const total = st && st.isFile() ? st.size : 0
    local = await fs.open(localPath, 'w')
    onBytes(0, total)
    for (;;) {
      await checkpoint(ctl)
      const pending: Array<Promise<{ pos: number; bytes: number; buf: Buffer }>> = []
      for (let i = 0; i < CHUNK_INFLIGHT; i += 1) {
        const chunkPos = pos + i * CHUNK_SIZE
        if (total > 0 && chunkPos >= total) break
        const len = total > 0 ? Math.min(CHUNK_SIZE, total - chunkPos) : CHUNK_SIZE
        const buf = Buffer.allocUnsafe(len)
        pending.push(
          pRead(sftp, handle as Buffer, buf, 0, len, chunkPos).then((bytes) => ({
            pos: chunkPos,
            bytes,
            buf
          }))
        )
      }
      if (pending.length === 0) break
      const chunks = await Promise.all(pending)
      let eof = false
      for (const c of chunks) {
        if (c.bytes <= 0) {
          eof = true
          break
        }
        await (local as FileHandle).write(c.buf, 0, c.bytes, c.pos)
        pos = c.pos + c.bytes
        onBytes(pos, total)
      }
      if (eof) break
    }
    return pos
  } catch (err) {
    if (local) {
      await local.close().catch(() => undefined)
      local = null
    }
    await silentUnlinkLocal(localPath)
    throw err
  } finally {
    if (local) await local.close().catch(() => undefined)
    if (handle) await pClose(sftp, handle)
  }
}

/* ------------------------------ 单文件任务 ------------------------------ */

async function transferUpload(
  sftp: SFTPWrapper,
  ctl: TransferControl,
  taskId: string,
  emit: (e: TransferProgressEvent) => void
): Promise<void> {
  ctl.unit = 'bytes'
  ctl.transferred = 0
  ctl.total = 0
  const reporter = makeReporter(ctl, taskId, emit)
  // 首帧必须带上真实总量：本地 stat 一拿到就强制发一帧，否则进度条会先空槽再跳。
  let announced = false
  const onBytes = (transferred: number, total: number): void => {
    ctl.transferred = transferred
    if (total > 0) ctl.total = total
    const force = !announced && ctl.total > 0
    if (force) announced = true
    reporter.report(force)
  }
  const written = await uploadFileChunked(sftp, ctl, ctl.localPath, ctl.remotePath, onBytes)
  if (!announced) reporter.report(true)
  ctl.transferred = Math.max(written, ctl.total)
  ctl.total = ctl.transferred
}

async function transferDownload(
  sftp: SFTPWrapper,
  ctl: TransferControl,
  taskId: string,
  emit: (e: TransferProgressEvent) => void
): Promise<void> {
  ctl.unit = 'bytes'
  ctl.transferred = 0
  ctl.total = 0
  const reporter = makeReporter(ctl, taskId, emit)
  let announced = false
  const onBytes = (transferred: number, total: number): void => {
    ctl.transferred = transferred
    if (total > 0) ctl.total = total
    const force = !announced && ctl.total > 0
    if (force) announced = true
    reporter.report(force)
  }
  const written = await downloadFileChunked(sftp, ctl, ctl.remotePath, ctl.localPath, onBytes)
  if (!announced) reporter.report(true)
  ctl.transferred = Math.max(written, ctl.total)
  ctl.total = ctl.transferred
}

/* ------------------------------ 目录递归传输 ------------------------------ */

/** 本地目录递归遍历，返回相对路径与绝对路径 */
async function walkLocal(root: string): Promise<Array<{ rel: string; full: string }>> {
  const out: Array<{ rel: string; full: string }> = []
  const stack: Array<{ dir: string; rel: string }> = [{ dir: root, rel: '' }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break
    const entries = await fs.readdir(current.dir, { withFileTypes: true })
    for (const e of entries) {
      const full = join(current.dir, e.name)
      const rel = current.rel ? `${current.rel}/${e.name}` : e.name
      if (e.isDirectory()) stack.push({ dir: full, rel })
      else out.push({ rel, full })
    }
  }
  return out
}

/** 远端目录递归遍历 */
async function walkRemote(
  sftp: SFTPWrapper,
  root: string
): Promise<Array<{ rel: string; full: string }>> {
  const out: Array<{ rel: string; full: string }> = []
  const stack: Array<{ dir: string; rel: string }> = [{ dir: root, rel: '' }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break
    const entries = await pReaddir(sftp, current.dir)
    for (const e of entries) {
      const full = joinRemote(current.dir, e.filename)
      const rel = current.rel ? `${current.rel}/${e.filename}` : e.filename
      if (e.attrs.isDirectory()) stack.push({ dir: full, rel })
      else out.push({ rel, full })
    }
  }
  return out
}

/** 远端逐级创建目录（已存在的层级忽略） */
async function ensureRemoteDir(sftp: SFTPWrapper, dirPath: string): Promise<void> {
  const parts = dirPath.split('/').filter(Boolean)
  let current = dirPath.startsWith('/') ? '' : '.'
  for (const part of parts) {
    current = `${current}/${part}`
    try {
      await pStat(sftp, current)
    } catch {
      await new Promise<void>((resolve) => {
        sftp.mkdir(current, () => resolve())
      })
    }
  }
}

/** 上传目录：进度按"已完成文件数 / 总文件数"，每个文件内部同样可分块暂停/取消 */
async function transferUploadDir(
  sftp: SFTPWrapper,
  ctl: TransferControl,
  taskId: string,
  emit: (e: TransferProgressEvent) => void
): Promise<void> {
  const localDir = ctl.localPath
  // ctl.remotePath = 目标目录 + 本地目录名；目录上传的语义是把本地目录内容铺进目标目录，
  // 所以这里取它的父目录（与旧实现 joinRemote(remoteDir, f.rel) 保持一致）。
  const remoteDir = ctl.remotePath.slice(0, ctl.remotePath.lastIndexOf('/')) || '/'
  const files = await walkLocal(localDir)
  ctl.unit = 'files'
  ctl.total = files.length
  ctl.transferred = 0
  emit(eventOf(ctl, taskId, 'running'))

  let done = 0
  for (const f of files) {
    await checkpoint(ctl)
    const target = joinRemote(remoteDir, f.rel)
    const targetDir = target.slice(0, target.lastIndexOf('/')) || '/'
    await ensureRemoteDir(sftp, targetDir)
    await uploadFileChunked(sftp, ctl, f.full, target, () => undefined)
    done += 1
    ctl.transferred = done
    emit(eventOf(ctl, taskId, 'running'))
  }
  ctl.transferred = ctl.total
}

/** 下载目录：进度按"已完成文件数 / 总文件数" */
async function transferDownloadDir(
  sftp: SFTPWrapper,
  ctl: TransferControl,
  taskId: string,
  emit: (e: TransferProgressEvent) => void
): Promise<void> {
  const remoteDir = ctl.remotePath
  // ctl.localPath 已经是"目标目录/远端目录名"，目录内文件直接铺在它下面
  const localDir = ctl.localPath
  const files = await walkRemote(sftp, remoteDir)
  ctl.unit = 'files'
  ctl.total = files.length
  ctl.transferred = 0
  emit(eventOf(ctl, taskId, 'running'))

  let done = 0
  for (const f of files) {
    await checkpoint(ctl)
    const target = join(localDir, ...f.rel.split('/'))
    await downloadFileChunked(sftp, ctl, f.full, target, () => undefined)
    done += 1
    ctl.transferred = done
    emit(eventOf(ctl, taskId, 'running'))
  }
  ctl.transferred = ctl.total
}

export const sftpManager = new SftpManager()
