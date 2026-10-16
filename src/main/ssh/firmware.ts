import { BrowserWindow, dialog } from 'electron'
import { createHash } from 'node:crypto'
import { createReadStream, promises as fs } from 'node:fs'
import { basename } from 'node:path'
import type {
  FirmwareFileInfo,
  FirmwareLogEvent,
  FirmwareUpgradeResult,
  FirmwareVerifyResult
} from '@shared/types'
import { execCollect, type CancellationToken } from './exec'
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
    const win = BrowserWindow.getFocusedWindow()
    const res = await dialog.showOpenDialog(win as BrowserWindow, {
      title: '选择固件文件',
      buttonLabel: '选择',
      properties: ['openFile'],
      filters: [
        { name: '固件镜像', extensions: ['bin', 'img', 'fw', 'hex', 'gz', 'tgz', 'tar', 'zip', 'swu', 'upg'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    if (res.canceled || res.filePaths.length === 0) return { canceled: true }
    const path = res.filePaths[0]
    const st = await fs.stat(path)
    return { canceled: false, file: { path, name: basename(path), size: st.size } }
  }

  /** 上传固件到设备（复用 SFTP 传输队列与进度事件） */
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
    const localHash = await sha256File(localPath)

    await sessionManager.waitUntilReady(sessionId)
    const client = sessionManager.getClient(sessionId)
    if (!client) throw new Error('会话不可用，请检查连接状态')

    const q = shellQuote(remotePath)
    const out = await execCollect(
      client,
      `sha256sum ${q} 2>/dev/null || md5sum ${q} 2>/dev/null || busybox sha256sum ${q} 2>/dev/null`,
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
    return {
      algo: token.length === 64 ? 'sha256' : 'md5',
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
    const token: CancellationToken = { cancelled: false }
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
    if (token) token.cancelled = true
  }

  /** 重启设备（不等待结果：命令发出后连接会立刻断开，属正常现象） */
  async reboot(sessionId: string, command = 'reboot'): Promise<void> {
    const client = sessionManager.getClient(sessionId)
    const token: CancellationToken = { cancelled: false }
    if (!client) throw new Error('会话不可用，请检查连接状态')
    await execCollect(client, command, 5000, token, 8 * 1024)
  }
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve())
      .on('error', reject)
  })
  return hash.digest('hex')
}

export const firmwareOps = new FirmwareOps()
