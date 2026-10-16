import type { BatchProgressEvent, BatchSessionResult } from '@shared/types'
import { execCollect, type CancellationToken } from './exec'
import { sessionManager } from './sessionManager'

/**
 * 多设备批量执行 —— 向多个会话广播同一条命令，并行执行、分别收集输出。
 *
 * - 各会话互不阻塞（Promise.all 并发），单会话失败不影响其他会话；
 * - 支持取消：已取消的会话标记 cancelled（保留部分输出），运行中的通道被关闭；
 * - 结果按传入顺序返回，便于 UI 稳定对比。
 */

type ProgressHandler = (event: BatchProgressEvent) => void

class BatchRunner {
  private runs = new Map<string, { token: CancellationToken }>()
  private onProgress: ProgressHandler | null = null

  setProgressHandler(cb: ProgressHandler): void {
    this.onProgress = cb
  }

  cancel(runId: string): void {
    const run = this.runs.get(runId)
    if (run) run.token.cancelled = true
  }

  async run(
    runId: string,
    sessionIds: string[],
    command: string,
    timeoutMs: number
  ): Promise<BatchSessionResult[]> {
    const token: CancellationToken = { cancelled: false }
    this.runs.set(runId, { token })

    const results = await Promise.all(
      sessionIds.map(async (sessionId): Promise<BatchSessionResult> => {
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
      })
    )

    this.runs.delete(runId)
    return results
  }
}

export const batchRunner = new BatchRunner()
