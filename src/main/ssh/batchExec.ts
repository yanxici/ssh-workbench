import type { BatchProgressEvent, BatchSessionResult } from '@shared/types'
import { createCancelToken, execCollect, type CancellationToken } from './exec'
import { sessionManager } from './sessionManager'

/**
 * 多设备批量执行 —— 向多个会话广播同一条命令，并行执行、分别收集输出。
 *
 * - 各会话互不阻塞（Promise.all 并发），单会话失败不影响其他会话；
 * - 支持取消：已取消的会话标记 cancelled（保留部分输出），运行中的通道被关闭；
 * - 结果按传入顺序返回，便于 UI 稳定对比。
 */

type ProgressHandler = (event: BatchProgressEvent) => void

/**
 * 批量执行的并发上限。
 * 与 diagnostics 的 4 同源考虑（单连接上通道打满会让 open failed），
 * 但批量场景对总时长更敏感，取 8 留出 MaxSessions 余量。
 */
const BATCH_CONCURRENCY = 8

class BatchRunner {
  private runs = new Map<string, { token: CancellationToken }>()
  private onProgress: ProgressHandler | null = null

  setProgressHandler(cb: ProgressHandler): void {
    this.onProgress = cb
  }

  cancel(runId: string): void {
    const run = this.runs.get(runId)
    // 用 cancel() 广播给所有在跑的任务，而不是只置一个标志等它们自己轮询到
    if (run && run.token.cancel) run.token.cancel()
    else if (run) run.token.cancelled = true
  }

  async run(
    runId: string,
    sessionIds: string[],
    command: string,
    timeoutMs: number
  ): Promise<BatchSessionResult[]> {
    const token = createCancelToken()
    this.runs.set(runId, { token })

    try {
      /*
       * 受控并发。
       *
       * 原来是无闸门 Promise.all：批量 50 台设备就是在同一瞬间开 50 个
       * exec channel + 50 个 StringDecoder + 50 个取消定时器。服务端的
       * MaxSessions 通常只有 10 左右，打满后反而出现 open failed ——
       * diagnostics.ts 早就为此写了 CONCURRENCY = 4 并注明理由，
       * 批量执行这条路径漏了。这里取 8：批量场景对总时长更敏感，
       * 又留出了 MaxSessions 的余量。
       *
       * 用下标占位保证结果顺序仍等于传入顺序（不依赖 Promise.all 的保序，
       * 信号量调度下完成顺序本身就是乱的）。
       */
      const slots: Array<BatchSessionResult | undefined> = new Array<BatchSessionResult | undefined>(
        sessionIds.length
      )
      let cursor = 0
      const worker = async (): Promise<void> => {
        for (;;) {
          const i = cursor
          cursor += 1
          if (i >= sessionIds.length) return
          slots[i] = await this.runOne(runId, sessionIds[i], command, timeoutMs, token)
        }
      }
      await Promise.all(
        Array.from({ length: Math.min(BATCH_CONCURRENCY, sessionIds.length) }, () => worker())
      )
      return slots.filter((r): r is BatchSessionResult => r !== undefined)
    } finally {
      // 异常/取消路径也要摘掉登记项，否则 runs 里永久残留一条 token
      this.runs.delete(runId)
    }
  }

  /** 单个会话的执行单元（失败只影响自己，返回 error 项） */
  private async runOne(
    runId: string,
    sessionId: string,
    command: string,
    timeoutMs: number,
    token: CancellationToken
  ): Promise<BatchSessionResult> {
    const info = sessionManager.list().find((s) => s.id === sessionId)
    const base = {
      sessionId,
      sessionTitle: info?.title ?? sessionId,
      host: info?.host ?? '',
      username: info?.username ?? ''
    }

    this.onProgress?.({ runId, sessionId, status: 'running' })

    const finish = (result: BatchSessionResult): BatchSessionResult => {
      this.onProgress?.({ runId, sessionId, status: result.status, result })
      return result
    }

    try {
      await sessionManager.waitUntilReady(sessionId)
      const client = sessionManager.getClient(sessionId)
      if (!client) throw new Error('会话不可用，请检查连接状态')

      const t0 = Date.now()
      const out = await execCollect(client, command, timeoutMs, token, 256 * 1024)

      return finish({
        ...base,
        status: out.status === 'error' ? 'error' : out.status,
        stdout: out.stdout,
        stderr: out.stderr,
        exitCode: out.exitCode,
        durationMs: Date.now() - t0,
        error: out.error
      })
    } catch (err) {
      return finish({
        ...base,
        status: token.cancelled ? 'cancelled' : 'error',
        stdout: '',
        stderr: '',
        exitCode: null,
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
}

export const batchRunner = new BatchRunner()
