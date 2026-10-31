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

/**
 * 取消令牌。
 *
 * 除了轮询 cancelled 标志，还支持 onCancel 订阅 —— 原来每个 exec 任务各挂一个
 * 120ms 的 setInterval 去查 `token.cancelled`，批量 50 会话 + 巡检 4 并发 +
 * 监控 N 台时，几十上百个定时器每秒空转几百次回调，只为读一个布尔值。
 * 订阅制下取消只在真正发生时推一次，与任务数无关。
 */
export interface CancellationToken {
  cancelled: boolean
  /** 订阅取消事件，返回退订函数 */
  onCancel?: (cb: () => void) => () => void
  /** 广播取消（createCancelToken 提供；纯布尔令牌没有） */
  cancel?: () => void
}

/** 创建一个带订阅能力的取消令牌（批量/巡检共用，一处 cancel 广播给全部任务） */
export function createCancelToken(): CancellationToken & { cancel: () => void } {
  const listeners = new Set<() => void>()
  const token: CancellationToken & { cancel: () => void } = {
    cancelled: false,
    onCancel: (cb) => {
      const wrapped = (): void => cb()
      listeners.add(wrapped)
      return () => listeners.delete(wrapped)
    },
    cancel: () => {
      if (token.cancelled) return
      token.cancelled = true
      for (const cb of listeners) {
        try {
          cb()
        } catch {
          /* 单个订阅者异常不影响其它任务收到取消 */
        }
      }
      listeners.clear()
    }
  }
  return token
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
      unsubscribe?.()
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

    /*
     * 取消：订阅制，不再每任务一个 120ms 定时器。
     * 令牌没实现 onCancel（老的纯布尔令牌）时，退回一次性检查 —— 
     * 覆盖「调用方在 exec 之前就已经取消」的情形，不再持续轮询。
     */
    let unsubscribe: (() => void) | undefined
    if (token) {
      const doCancel = (): void => {
        closeStream()
        finish('cancelled', null)
      }
      if (token.cancelled) {
        // 已取消：直接结算，别白开一个通道
        finish('cancelled', null)
        return
      }
      unsubscribe = token.onCancel?.(doCancel)
    }

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
