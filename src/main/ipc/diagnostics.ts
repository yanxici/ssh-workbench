import { IPC } from '@shared/ipc'
import type { BundleOptions, DiagSectionInput } from '@shared/types'
import { handle } from './handle'
import { diagnosticsRunner } from '../ssh/diagnostics'
import { batchRunner } from '../ssh/batchExec'
import { deleteDiagSection, listDiagSections, saveDiagSection } from '../store/repository'
import {
  exportReport,
  listReports,
  openReportsDir,
  readReport,
  removeReport,
  reportText
} from '../store/reports'
import { bundlePreview, exportBundle, revealBundle } from '../store/bundle'

/** 一键诊断巡检 + 报告 + 排障包；以及多设备批量执行 */
export function registerDiagnosticsIpc(): void {
  handle(IPC.DIAG_SECTIONS_LIST, () => listDiagSections())
  handle(IPC.DIAG_SECTION_SAVE, (input: DiagSectionInput) => saveDiagSection(input))
  handle(IPC.DIAG_SECTION_DELETE, (id: string) => deleteDiagSection(id))
  handle(IPC.DIAG_RUN, (runId: string, sessionId: string, sectionIds: string[]) =>
    diagnosticsRunner.run(runId, sessionId, sectionIds)
  )
  handle(IPC.DIAG_CANCEL, (runId: string) => diagnosticsRunner.cancel(runId))

  handle(IPC.DIAG_REPORTS_LIST, () => listReports())
  handle(IPC.DIAG_REPORT_READ, (id: string) => readReport(id))
  handle(IPC.DIAG_REPORT_DELETE, (id: string) => removeReport(id))
  handle(IPC.DIAG_REPORT_EXPORT, (id: string, format: 'md' | 'html') =>
    exportReport(id, format)
  )
  handle(IPC.DIAG_REPORT_TEXT, (id: string, format: 'md' | 'html') => reportText(id, format))
  handle(IPC.DIAG_REPORTS_OPEN_DIR, () => openReportsDir())

  handle(IPC.DIAG_BUNDLE_PREVIEW, (reportId: string) => bundlePreview(reportId))
  handle(IPC.DIAG_BUNDLE_EXPORT, (reportId: string, options: BundleOptions) =>
    exportBundle(reportId, options)
  )
  handle(IPC.DIAG_BUNDLE_REVEAL, (filePath: string) => revealBundle(filePath))

  handle(IPC.BATCH_RUN, (runId: string, sessionIds: string[], command: string, timeoutMs: number) =>
    batchRunner.run(runId, sessionIds, command, timeoutMs)
  )
  handle(IPC.BATCH_CANCEL, (runId: string) => batchRunner.cancel(runId))
}
