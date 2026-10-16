import type { DiagProgressEvent, DiagReport, DiagSectionResult } from '@shared/types'
import { listDiagSections } from '../store/repository'
import { saveReport } from '../store/reports'
import { execCollect, type CancellationToken } from './exec'
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
    if (run) run.token.cancelled = true
  }

  async run(runId: string, sessionId: string, sectionIds: string[]): Promise<DiagReport> {
    const token: CancellationToken = { cancelled: false }
    this.runs.set(runId, { token })

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

    const startedAt = Date.now()
    const results: DiagSectionResult[] = []
    const total = picked.length

    for (let i = 0; i < picked.length; i++) {
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
        results.push(skipped)
        this.onProgress?.({
          runId,
          sectionId: section.id,
          status: 'skipped',
          index: i + 1,
          total,
          result: skipped
        })
        continue
      }

      this.onProgress?.({ runId, sectionId: section.id, status: 'running', index: i + 1, total })

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
      results.push(result)
      this.onProgress?.({
        runId,
        sectionId: section.id,
        status,
        index: i + 1,
        total,
        result
      })
    }

    this.runs.delete(runId)
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
