import { dialog } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { basename } from 'node:path'
import type {
  FirmwareFileInfo,
  FirmwareLogEvent,
  FirmwareUpgradeResult,
  FirmwareVerifyResult
} from '@shared/types'
import { dialogDefaultPath, rememberDialogPick } from '../util/dialogDirs'
import { dialogParent } from '../windowRef'
import { createCancelToken, execCollect, type CancellationToken } from './exec'
import { sessionManager } from './sessionManager'
import { sftpManager } from './sftpManager'

/**
 * 固件升级助手 —— 上传 / 校验 / 升级（流式日志）/ 重启 / 等待上线。
 *
 * 设计原则：
 * - "升级命令"交给使用方配置（不同厂商脚本差异大），这里只保证执行、流式回显与安全取消；
 * - 校验采用「本机流式 SHA256 + 设备端 sha256sum/md5sum」双端比对，防止传输损坏刷入变砖；
 * - 重启后设备必然掉线：用 TCP 探针等待服务端口重新可达，替代笨重的 SSH 重连轮询。
 */

type LogHandler = (event: FirmwareLogEvent) => void

/** shell 单引号转义（文件名/路径里可能有空格或特殊字符） */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

class FirmwareOps {
  private onLog: LogHandler | null = null
  private runs = new Map<string, CancellationToken>()

  setLogHandler(cb: LogHandler): void {
    this.onLog = cb
  }

  /** 选择本地固件文件（系统对话框），并返回基本信息 */
  async pickFile(): Promise<{ canceled: boolean; file?: FirmwareFileInfo }> {
    /*
     * dialogParent() 在没有聚焦窗口时返回 undefined，不能像旧实现那样直接 as BrowserWindow：
     * 此时把 undefined 传给 showOpenDialog，Electron 会当成「不是 parent」按无父窗口处理，
     * 但在某些平台上等价于传了 null 而抛 TypeError，选固件直接失败。
     * 有窗口才带 parent，没有就不带。
     */
    const win = dialogParent()
    const options = {
      title: '选择固件文件',
      buttonLabel: '选择',
      defaultPath: dialogDefaultPath('firmware'),
      properties: ['openFile' as const],
      filters: [
        { name: '固件镜像', extensions: ['bin', 'img', 'fw', 'hex', 'gz', 'tgz', 'tar', 'zip', 'swu', 'upg'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    }
    const res = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    if (res.canceled || res.filePaths.length === 0) return { canceled: true }
    const path = res.filePaths[0]
    rememberDialogPick('firmware', path, false)
    const st = await fs.stat(path)
    return { canceled: false, file: { path, name: basename(path), size: st.size } }
  }

  /**
   * 上传固件到设备（复用 SFTP 传输队列与进度事件）。
   *
   * 保持 async 是有意的：它同步入队后立刻返回 taskId，但接口约定是 Promise
   * （调用方一律 await，与 verify/upgrade 等兄弟方法一致）。这条
   * require-await 是误报 —— 去掉 async 会让 IPC handler 的返回类型对不上。
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- 见方法注释：契约是 Promise
  async upload(
    sessionId: string,
    localPath: string,
    remoteDir: string
  ): Promise<{ taskId: string; remotePath: string }> {
    const remotePath = `${remoteDir.replace(/\/+$/, '')}/${basename(localPath)}`
    const [taskId] = sftpManager.upload(sessionId, [localPath], remoteDir)
    if (!taskId) throw new Error('无法创建上传任务')
    return { taskId, remotePath }
  }

  /** 双端哈希比对 */
  async verify(
    sessionId: string,
    localPath: string,
    remotePath: string
  ): Promise<FirmwareVerifyResult> {
    await sessionManager.waitUntilReady(sessionId)
    const client = sessionManager.getClient(sessionId)
    if (!client) throw new Error('会话不可用，请检查连接状态')

    const q = shellQuote(remotePath)
    const out = await execCollect(
      client,
      `sha256sum ${q} 2>/dev/null || busybox sha256sum ${q} 2>/dev/null || md5sum ${q} 2>/dev/null`,
      30000,
      undefined,
      64 * 1024
    )
    const token = out.stdout.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    if (!/^[0-9a-f]{32}$|^[0-9a-f]{64}$/.test(token)) {
      throw new Error(
        `设备端无法计算校验值（sha256sum/md5sum 不可用？）：${(out.stderr || out.stdout || '无输出').trim().slice(0, 200)}`
      )
    }
    const algo = token.length === 64 ? 'sha256' : 'md5'
    /*
     * 本机必须用「和设备端同一种算法」重算。旧实现本地恒算 SHA-256（64 位），
     * 设备端只有 md5sum 时拿 32 位 MD5 去比 64 位 SHA-256，永远不相等 ——
     * 用户看到的是一份传输完好、却被判「校验失败」的固件。
     */
    const localHash = await hashFile(localPath, algo)
    return {
      algo,
      localHash,
      remoteHash: token,
      match: token === localHash,
      remotePath
    }
  }

  /** 执行升级命令（流式回显，可取消） */
  async upgrade(
    runId: string,
    sessionId: string,
    command: string,
    timeoutMs = 600000
  ): Promise<FirmwareUpgradeResult> {
    /*
     * 必须用 createCancelToken：execCollect 只订阅 token.onCancel，
     * 裸的 { cancelled: false } 没有这个回调，点「取消」永不生效。
     */
    const token = createCancelToken()
    this.runs.set(runId, token)

    const started = Date.now()
    try {
      await sessionManager.waitUntilReady(sessionId)
      const client = sessionManager.getClient(sessionId)
      if (!client) throw new Error('会话不可用，请检查连接状态')

      const out = await execCollect(
        client,
        command,
        timeoutMs,
        token,
        512 * 1024,
        (stream, chunk) => this.onLog?.({ runId, stream, chunk })
      )

      return {
        runId,
        status: out.status,
        exitCode: out.exitCode,
        output: out.stdout,
        error: out.error ?? (out.stderr.trim() || undefined),
        durationMs: Date.now() - started
      }
    } catch (err) {
      return {
        runId,
        status: 'error',
        exitCode: null,
        output: '',
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started
      }
    } finally {
      this.runs.delete(runId)
    }
  }

  cancel(runId: string): void {
    const token = this.runs.get(runId)
    if (!token) return
    if (token.cancel) token.cancel()
    else token.cancelled = true
  }

  /**
   * 重启设备（不等待结果：命令发出后连接会立刻断开，属正常现象）。
   *
   * 「不等待结果」不等于「不看结果」：execCollect 超时/连接已断时返回
   * status='error' 而**不抛**，旧实现直接忽略返回值，界面照样弹「重启命令已下发」，
   * 实际一个字都没发出去，用户只能对着失联的设备干等。
   */
  async reboot(sessionId: string, command = 'reboot'): Promise<void> {
    const client = sessionManager.getClient(sessionId)
    if (!client) throw new Error('会话不可用，请检查连接状态')
    const out = await execCollect(client, command, 5000, undefined, 8 * 1024)
    if (out.status === 'error') {
      throw new Error(out.error ?? '重启命令发送失败')
    }
  }
}

/** 流式算本机文件哈希：算法必须与设备端一致，否则比对毫无意义 */
async function hashFile(path: string, algo: 'sha256' | 'md5'): Promise<string> {
  const hash = createHash(algo)
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject)
  })
  return hash.digest('hex')
}

export const firmwareOps = new FirmwareOps()
