import type { SFTPWrapper, Stats } from 'ssh2'
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { RemoteFile, TransferProgressEvent } from '@shared/types'
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

/* ------------------------------ 管理器 ------------------------------ */

/** 导出类供回归脚本驱动（生产只使用下方的单例） */
export class SftpManager {
  private wrappers = new Map<string, SFTPWrapper>()
  /** 正在挂载中的 SFTP 通道（并发请求共享同一次挂载，避免重复 sftp 子系统） */
  private pendingMounts = new Map<string, Promise<SFTPWrapper>>()
  private onProgress: ProgressHandler | null = null
  /** 传输串行队列 */
  private chain: Promise<void> = Promise.resolve()

  setProgressHandler(handler: ProgressHandler): void {
    this.onProgress = handler
  }

  /** 会话关闭时清理对应 SFTP 通道 */
  clearSession(sessionId: string): void {
    this.pendingMounts.delete(sessionId)
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
    const sftp = await this.getSftp(sessionId)
    return new Promise((resolve, reject) => {
      sftp.realpath('.', (err, abs) => {
        if (err) reject(new Error(`无法获取远端主目录：${err.message}`))
        else resolve(abs)
      })
    })
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
        async () => {
          const sftp = await this.getSftp(sessionId)
          const st = await fs.stat(localPath).catch(() => null)
          if (st?.isDirectory()) {
            await transferUploadDir(sftp, sessionId, taskId, localPath, remotePath, (e) =>
              this.emit(e)
            )
          } else {
            await transferUpload(
              sftp,
              sessionId,
              taskId,
              localPath,
              remotePath,
              (e) => this.emit(e),
              st?.isFile() ? st.size : 0
            )
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
        async () => {
          const sftp = await this.getSftp(sessionId)
          const st = await pStat(sftp, remotePath).catch(() => null)
          if (st?.isDirectory()) {
            await transferDownloadDir(sftp, sessionId, taskId, remotePath, localPath, (e) =>
              this.emit(e)
            )
          } else {
            await transferDownload(
              sftp,
              sessionId,
              taskId,
              remotePath,
              localPath,
              (e) => this.emit(e),
              st?.isFile() ? st.size : 0
            )
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

  /** 串行排队 */
  private enqueue(
    task: () => Promise<void>,
    sessionId: string,
    taskId: string,
    direction: 'upload' | 'download',
    localPath: string,
    remotePath: string
  ): void {
    this.emit({
      taskId,
      sessionId,
      direction,
      localPath,
      remotePath,
      transferred: 0,
      total: 0,
      status: 'pending'
    })
    const run = async (): Promise<void> => {
      try {
        await task()
      } catch (err) {
        this.emit({
          taskId,
          sessionId,
          direction,
          localPath,
          remotePath,
          transferred: 0,
          total: 0,
          status: 'error',
          error: err instanceof Error ? err.message : String(err)
        })
      }
    }
    this.chain = this.chain.then(run, run)
  }

  private emit(event: TransferProgressEvent): void {
    this.onProgress?.(event)
  }
}

async function transferUpload(
  sftp: SFTPWrapper,
  sessionId: string,
  taskId: string,
  localPath: string,
  remotePath: string,
  emit: (e: TransferProgressEvent) => void,
  knownTotal = 0
): Promise<void> {
  const startedAt = Date.now()
  const total = Math.max(knownTotal, 0)

  let transferred = 0
  let lastEmit = Date.now()
  let lastBytes = 0
  // stat 失败时已知总量为 0，首帧只能画空槽；一旦 step 回调给出总量就立刻发一帧，
  // 不再等节流窗口，否则进度条会一直停在 0%。
  let publishedTotal = total > 0

  // 先把已知总大小发出去：渲染层第一帧就能画出 0% 的完整进度条，
  // 而不是显示一个 total=0、永远停在 0% 的空槽。
  emit({
    taskId,
    sessionId,
    direction: 'upload',
    localPath,
    remotePath,
    transferred: 0,
    total,
    status: 'running',
    speedBps: 0,
    unit: 'bytes'
  })

  try {
    await new Promise<void>((resolve, reject) => {
      sftp.fastPut(
        localPath,
        remotePath,
        {
          step: (bytes, _chunk, stepTotal) => {
            transferred = Math.max(transferred, bytes)
            const now = Date.now()
            const needTotal = !publishedTotal && (stepTotal || 0) > 0
            if (!needTotal && now - lastEmit < PROGRESS_THROTTLE_MS) return
            if (needTotal) publishedTotal = true
            const speed = (transferred - lastBytes) / Math.max((now - lastEmit) / 1000, 0.001)
            lastEmit = now
            lastBytes = transferred
            emit({
              taskId,
              sessionId,
              direction: 'upload',
              localPath,
              remotePath,
              transferred,
              total: total || stepTotal || 0,
              status: 'running',
              speedBps: Math.round(speed),
              unit: 'bytes'
            })
          }
        },
        (err) => (err ? reject(err) : resolve())
      )
    })
    // 结束时以总大小为准确值：大文件传输的最后一次 step 可能被节流吞掉，
    // 小文件则可能一次 step 都没有，沿用 lastBytes 会让进度条停在 0%。
    const finalBytes = Math.max(transferred, total)
    emit({
      taskId,
      sessionId,
      direction: 'upload',
      localPath,
      remotePath,
      transferred: finalBytes,
      total: finalBytes,
      status: 'done',
      speedBps: Math.round(finalBytes / Math.max((Date.now() - startedAt) / 1000, 0.001)),
      unit: 'bytes'
    })
  } catch (err) {
    emit({
      taskId,
      sessionId,
      direction: 'upload',
      localPath,
      remotePath,
      transferred,
      total: total || transferred,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      unit: 'bytes'
    })
  }
}

async function transferDownload(
  sftp: SFTPWrapper,
  sessionId: string,
  taskId: string,
  remotePath: string,
  localPath: string,
  emit: (e: TransferProgressEvent) => void,
  knownTotal = 0
): Promise<void> {
  const startedAt = Date.now()
  const total = Math.max(knownTotal, 0)

  let transferred = 0
  let lastEmit = Date.now()
  let lastBytes = 0
  // 同 upload：stat 失败时首帧 total=0，靠第一次 step 的总量把进度条补满。
  let publishedTotal = total > 0

  emit({
    taskId,
    sessionId,
    direction: 'download',
    localPath,
    remotePath,
    transferred: 0,
    total,
    status: 'running',
    speedBps: 0,
    unit: 'bytes'
  })

  try {
    await new Promise<void>((resolve, reject) => {
      sftp.fastGet(
        remotePath,
        localPath,
        {
          step: (bytes, _chunk, stepTotal) => {
            transferred = Math.max(transferred, bytes)
            const now = Date.now()
            const needTotal = !publishedTotal && (stepTotal || 0) > 0
            if (!needTotal && now - lastEmit < PROGRESS_THROTTLE_MS) return
            if (needTotal) publishedTotal = true
            const speed = (transferred - lastBytes) / Math.max((now - lastEmit) / 1000, 0.001)
            lastEmit = now
            lastBytes = transferred
            emit({
              taskId,
              sessionId,
              direction: 'download',
              localPath,
              remotePath,
              transferred,
              total: total || stepTotal || 0,
              status: 'running',
              speedBps: Math.round(speed),
              unit: 'bytes'
            })
          }
        },
        (err) => (err ? reject(err) : resolve())
      )
    })
    const finalBytes = Math.max(transferred, total)
    emit({
      taskId,
      sessionId,
      direction: 'download',
      localPath,
      remotePath,
      transferred: finalBytes,
      total: finalBytes,
      status: 'done',
      speedBps: Math.round(finalBytes / Math.max((Date.now() - startedAt) / 1000, 0.001)),
      unit: 'bytes'
    })
  } catch (err) {
    emit({
      taskId,
      sessionId,
      direction: 'download',
      localPath,
      remotePath,
      transferred,
      total: total || transferred,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      unit: 'bytes'
    })
  }
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

function fastPutP(sftp: SFTPWrapper, local: string, remote: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastPut(local, remote, (err) => (err ? reject(err) : resolve()))
  })
}

function fastGetP(sftp: SFTPWrapper, remote: string, local: string): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remote, local, (err) => (err ? reject(err) : resolve()))
  })
}

/** 上传目录：进度按"已完成文件数 / 总文件数" */
async function transferUploadDir(
  sftp: SFTPWrapper,
  sessionId: string,
  taskId: string,
  localDir: string,
  remoteDir: string,
  emit: (e: TransferProgressEvent) => void
): Promise<void> {
  const files = await walkLocal(localDir)
  const total = files.length
  emit({
    taskId,
    sessionId,
    direction: 'upload',
    localPath: localDir,
    remotePath: remoteDir,
    transferred: 0,
    total,
    status: 'running',
    unit: 'files'
  })

  let done = 0
  let lastEmit = 0
  try {
    for (const f of files) {
      const target = joinRemote(remoteDir, f.rel)
      await ensureRemoteDir(sftp, target.slice(0, target.lastIndexOf('/')) || '/')
      await fastPutP(sftp, f.full, target)
      done += 1
      const now = Date.now()
      if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
        lastEmit = now
        emit({
          taskId,
          sessionId,
          direction: 'upload',
          localPath: localDir,
          remotePath: remoteDir,
          transferred: done,
          total,
          status: 'running',
          unit: 'files'
        })
      }
    }
    emit({
      taskId,
      sessionId,
      direction: 'upload',
      localPath: localDir,
      remotePath: remoteDir,
      transferred: total,
      total,
      status: 'done',
      unit: 'files'
    })
  } catch (err) {
    emit({
      taskId,
      sessionId,
      direction: 'upload',
      localPath: localDir,
      remotePath: remoteDir,
      transferred: done,
      total,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      unit: 'files'
    })
  }
}

/** 下载目录：进度按"已完成文件数 / 总文件数" */
async function transferDownloadDir(
  sftp: SFTPWrapper,
  sessionId: string,
  taskId: string,
  remoteDir: string,
  localDir: string,
  emit: (e: TransferProgressEvent) => void
): Promise<void> {
  const files = await walkRemote(sftp, remoteDir)
  const total = files.length
  emit({
    taskId,
    sessionId,
    direction: 'download',
    localPath: localDir,
    remotePath: remoteDir,
    transferred: 0,
    total,
    status: 'running',
    unit: 'files'
  })

  let done = 0
  let lastEmit = 0
  try {
    for (const f of files) {
      const target = join(localDir, basename(remoteDir), ...f.rel.split('/'))
      await fs.mkdir(dirname(target), { recursive: true })
      await fastGetP(sftp, f.full, target)
      done += 1
      const now = Date.now()
      if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
        lastEmit = now
        emit({
          taskId,
          sessionId,
          direction: 'download',
          localPath: localDir,
          remotePath: remoteDir,
          transferred: done,
          total,
          status: 'running',
          unit: 'files'
        })
      }
    }
    emit({
      taskId,
      sessionId,
      direction: 'download',
      localPath: localDir,
      remotePath: remoteDir,
      transferred: total,
      total,
      status: 'done',
      unit: 'files'
    })
  } catch (err) {
    emit({
      taskId,
      sessionId,
      direction: 'download',
      localPath: localDir,
      remotePath: remoteDir,
      transferred: done,
      total,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
      unit: 'files'
    })
  }
}

export const sftpManager = new SftpManager()
