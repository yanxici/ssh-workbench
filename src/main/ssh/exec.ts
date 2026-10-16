import type { Client, ClientChannel } from 'ssh2'
import { StringDecoder } from 'node:string_decoder'

/**
 * 在已建连接上执行一条命令并收集输出（诊断巡检 / 批量执行共用）。
 *
 * 设计要点：
 * - 独立于交互式 shell：走 SSH exec 通道，命令与终端互不干扰；
 * - 输出上限保护（默认 512KB，超出截断并提示），避免 dmesg / cat 大文件把 IPC 撑爆；
 * - 超时与主动取消都会关闭通道，返回已完成的部分输出；
 * - StringDecoder 保证多字节 UTF-8 跨块不被截断。
 */

export type ExecStatus = 'done' | 'timeout' | 'cancelled' | 'error'

export interface ExecOutcome {
  status: ExecStatus
  exitCode: number | null
  stdout: string
  stderr: string
  /** status = error 时的说明 */
  error?: string
}

export interface CancellationToken {
  cancelled: boolean
}

const DEFAULT_MAX_OUTPUT = 512 * 1024
/** 超限截断时的提示尾巴 */
const TRUNCATE_NOTE = '\n\n...（输出超过上限，已截断）'

export function execCollect(
  client: Client,
  command: string,
  timeoutMs: number,
  token?: CancellationToken,
  maxOutput = DEFAULT_MAX_OUTPUT,
  /** 实时输出回调（固件升级等长任务用来推送进度日志） */
  onChunk?: (stream: 'out' | 'err', chunk: string) => void
): Promise<ExecOutcome> {
  return new Promise<ExecOutcome>((resolve) => {
    let settled = false
    let stream: ClientChannel | null = null
    let stdout = ''
    let stderr = ''
    const decOut = new StringDecoder('utf8')
    const decErr = new StringDecoder('utf8')

    const finish = (status: ExecStatus, exitCode: number | null, error?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (poll) clearInterval(poll)
      let out = stdout + decOut.end()
      let err = stderr + decErr.end()
      if (out.length > maxOutput) out = out.slice(0, maxOutput) + TRUNCATE_NOTE
      if (err.length > 64 * 1024) err = err.slice(0, 64 * 1024) + TRUNCATE_NOTE
      resolve({ status, exitCode, stdout: out, stderr: err, error })
    }

    const closeStream = (): void => {
      try {
        stream?.close()
      } catch {
        /* ignore */
      }
    }

    const timer = setTimeout(() => {
      closeStream()
      finish('timeout', null)
    }, timeoutMs)

    const poll = token
      ? setInterval(() => {
          if (token.cancelled) {
            closeStream()
            finish('cancelled', null)
          }
        }, 120)
      : null

    try {
      client.exec(command, (err, s) => {
        if (err) {
          finish('error', null, `无法执行命令：${err.message}`)
          return
        }
        stream = s
        // 取消/超时可能发生在 exec 回调返回之前
        if (settled) {
          try {
            s.close()
          } catch {
            /* ignore */
          }
          return
        }
        s.on('data', (chunk: Buffer) => {
          if (stdout.length < maxOutput + 4096) {
            const text = decOut.write(chunk)
            stdout += text
            if (text && onChunk) onChunk('out', text)
          }
        })
        s.stderr.on('data', (chunk: Buffer) => {
          if (stderr.length < 96 * 1024) {
            const text = decErr.write(chunk)
            stderr += text
            if (text && onChunk) onChunk('err', text)
          }
        })
        s.on('close', (code: number | null) => finish('done', code ?? null))
      })
    } catch (err) {
      finish('error', null, err instanceof Error ? err.message : String(err))
    }
  })
}
