import type { DiagProgressEvent, DiagReport, DiagSection, DiagSectionResult } from '@shared/types'
import { listDiagSections } from '../store/repository'
import { saveReport } from '../store/reports'
import { createCancelToken, execCollect, type CancellationToken } from './exec'
import { sessionManager } from './sessionManager'

/**
 * 一键诊断巡检执行器。
 *
 * 流程：按选中项顺序，在目标会话上逐条 exec 采集 → 逐节推送进度 →
 * 汇总为结构化报告并自动落盘（userData/reports/）。
 * 支持取消（剩余项标记为 skipped，已采集内容仍然出报告）。
 */

type ProgressHandler = (event: DiagProgressEvent) => void

interface ActiveRun {
  token: CancellationToken
}

class DiagnosticsRunner {
  private runs = new Map<string, ActiveRun>()
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

  async run(runId: string, sessionId: string, sectionIds: string[]): Promise<DiagReport> {
    /*
     * 先校验、后登记。
     *
     * 原实现先 runs.set 再抛错，而清理只在正常路径末尾 —— 会话不存在 /
     * 客户端不可用 / 没选项目这三个 throw 都发生在 delete 之前，
     * 于是 runs 里永久残留一条 token：cancel(runId) 之后仍能命中但已无意义，
     * 长跑下来是稳定的内存泄漏。saveReport 失败（正常路径内的抛错）同理。
     * 现在所有退出路径都经过同一个 finally。
     */
    const token = createCancelToken()

    const session = sessionManager.list().find((s) => s.id === sessionId)
    if (!session) throw new Error('会话不存在，请先打开 SSH 连接')

    await sessionManager.waitUntilReady(sessionId)
    const client = sessionManager.getClient(sessionId)
    if (!client) throw new Error('会话不可用，请检查连接状态')

    // 以当前配置为准解析选中项（顺序 = 传入顺序）
    const all = await listDiagSections()
    const picked = sectionIds
      .map((id) => all.find((s) => s.id === id))
      .filter((s): s is NonNullable<typeof s> => Boolean(s))
    if (picked.length === 0) throw new Error('未选择任何诊断项')

    // 校验全部通过，正式登记本次运行（此后任何退出路径都走 finally 清理）
    this.runs.set(runId, { token })
    try {
      return await this.execute(runId, session, client, picked, token)
    } finally {
      this.runs.delete(runId)
    }
  }

  /** 真正的执行体；由 run() 统一负责登记与清理 */
  private async execute(
    runId: string,
    session: NonNullable<ReturnType<typeof sessionManager.list>[number]>,
    client: NonNullable<ReturnType<typeof sessionManager.getClient>>,
    picked: DiagSection[],
    token: CancellationToken
  ): Promise<DiagReport> {
    const startedAt = Date.now()
    const results: DiagSectionResult[] = []
    const total = picked.length

    /*
     * 受控并发执行。
     *
     * 旧实现是一条跑完再跑下一条：10 个检查项，每项都要一次 SSH 往返，
     * 总耗时 = 各项之和，巡检经常要等十几秒。
     *
     * 但也不能无脑 Promise.all —— 单个 SSH 连接上并开几十个 channel 会把
     * 服务端的 MaxSessions 打满，反而出现 open failed。
     * 所以固定 4 个并发：足够把往返延迟重叠掉，又远低于常见 MaxSessions(10)。
     */
    const CONCURRENCY = 4
    /** 按下标预占位，保证进度与结果顺序仍与传入顺序一致 */
    // new Array(n) 返回 any[]：显式标注联合类型，否则后面的赋值全是 unsafe
    const slots: Array<DiagSectionResult | undefined> = new Array<DiagSectionResult | undefined>(
      picked.length
    )
    let nextIndex = 0
    let finishedCount = 0

    const runOne = async (): Promise<void> => {
      for (;;) {
        const i = nextIndex++
        if (i >= picked.length) return
        const section = picked[i]

        if (token.cancelled) {
          const skipped: DiagSectionResult = {
            sectionId: section.id,
            name: section.name,
            group: section.group,
            command: section.command,
            status: 'skipped',
            output: '',
            exitCode: null,
            durationMs: 0
          }
          slots[i] = skipped
          finishedCount++
          this.onProgress?.({
            runId,
            sectionId: section.id,
            status: 'skipped',
            index: finishedCount,
            total,
            result: skipped
          })
          continue
        }

        this.onProgress?.({
          runId,
          sectionId: section.id,
          status: 'running',
          index: finishedCount + 1,
          total
        })

        const t0 = Date.now()
        const out = await execCollect(client, section.command, section.timeoutMs, token)
        const durationMs = Date.now() - t0

      // 状态判定：执行完成但退出码非 0 且无输出 → 异常（命令不存在/权限等）；
      // 有输出即使退出码非 0 也视为完成（grep 无匹配、条件命令等属正常语义）
      let status: DiagSectionResult['status']
      if (out.status === 'done') {
        status = out.exitCode !== 0 && out.stdout.trim() === '' ? 'error' : 'done'
      } else if (out.status === 'cancelled') {
        status = 'skipped'
      } else {
        status = out.status
      }

        const result: DiagSectionResult = {
          sectionId: section.id,
          name: section.name,
          group: section.group,
          command: section.command,
          status,
          output: out.stdout,
          error: (out.error ?? out.stderr).trim() || undefined,
          exitCode: out.exitCode,
          durationMs
        }
        slots[i] = result
        finishedCount++
        this.onProgress?.({
          runId,
          sectionId: section.id,
          status,
          index: finishedCount,
          total,
          result
        })
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, picked.length) }, () => runOne())
    )

    // 按原始顺序回收结果；理论上不会有空洞，兜底过滤掉防御性 undefined
    results.push(...slots.filter((r): r is DiagSectionResult => r !== undefined))

    const finishedAt = Date.now()
    const okCount = results.filter((r) => r.status === 'done').length

    return saveReport({
      title: `${session.connectionName} · ${session.host}`,
      connectionName: session.connectionName,
      host: session.host,
      username: session.username,
      startedAt,
      finishedAt,
      sectionCount: results.length,
      okCount,
      problemCount: results.length - okCount,
      sections: results
    })
  }
}

export const diagnosticsRunner = new DiagnosticsRunner()
