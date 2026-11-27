import type * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  ArrowLeft,
  CheckCircle2,
  CheckSquare,
  ClipboardCopy,
  Copy,
  Eye,
  FileCode2,
  FileText,
  FolderOpen,
  Loader2,
  MinusCircle,
  MinusSquare,
  Package,
  Pencil,
  Plus,
  RefreshCw,
  Square,
  TimerOff,
  Trash2,
  X,
  XCircle
} from 'lucide-react'
import type { DiagReport, DiagSection, DiagSectionResult, DiagSectionStatus } from '@shared/types'
import { useI18n } from '@/i18n'
import { call } from '@/lib/ipc'
import { cn, formatBytes, formatTime } from '@/lib/utils'
import { useOverlayEscape } from '@/lib/overlayKeys'
import { ConfirmDialog, EmptyState } from '@/components/ui'
import { useDiagStore } from '@/stores/diagStore'
import { useSessionStore, useSshSessions } from '@/stores/sessionStore'
import { useToastStore } from '@/stores/toastStore'
import { DiagSectionEditor } from './DiagSectionEditor'
import { BundleDialog } from './BundleDialog'

/**
 * 一键诊断巡检面板（覆盖主区域）。
 * - 运行诊断：左侧勾选诊断项（内置 + 自定义），右侧实时展示逐节采集结果；
 * - 报告库：历史报告的查看 / 导出（Markdown / HTML）/ 删除。
 */
export function DiagnosticsPanel(): React.JSX.Element | null {
  const { t } = useI18n()
  const panelOpen = useDiagStore((s) => s.panelOpen)
  const tab = useDiagStore((s) => s.tab)
  const setTab = useDiagStore((s) => s.setTab)
  const viewing = useDiagStore((s) => s.viewing)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<DiagSection | null>(null)
  /** 一键打包（zip）的目标报告 */
  const [bundleFor, setBundleFor] = useState<string | null>(null)

  useEffect(() => {
    if (panelOpen) void useDiagStore.getState().loadSections()
  }, [panelOpen])

  const close = (): void => useDiagStore.setState({ panelOpen: false })
  // 面板按钮上写着「关闭 (Esc)」，这里必须真的响应 Esc
  useOverlayEscape(panelOpen, close)
  if (!panelOpen) return null

  return (
    <div className="panel-shell fixed inset-x-0 z-30 flex flex-col bg-app">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3">
        <Activity size={14} className="text-accent" />
        <span className="text-xs font-semibold">{t('panel.diag.title')}</span>
        {viewing && tab === 'reports' && (
          <>
            <span className="text-2xs text-ink-3">/</span>
            <span className="max-w-[240px] truncate text-2xs text-ink-3">{viewing.title}</span>
          </>
        )}
        <div className="ml-3 flex items-center gap-0.5 rounded-md border border-edge bg-app p-0.5">
          {(
            [
              { key: 'run', label: t('panel.diag.tabRun') },
              { key: 'reports', label: t('panel.diag.tabReports') }
            ] as const
          ).map((item) => (
            <button
              key={item.key}
              className={cn(
                'rounded-sm px-2.5 py-1 text-2xs transition-colors',
                tab === item.key ? 'bg-accent/15 text-accent' : 'text-ink-3 hover:text-ink-2'
              )}
              onClick={() => setTab(item.key)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <button
          className="btn-icon"
          title={t('panel.diag.openDir')}
          onClick={() => void call(window.api.diag.openDir(), { silent: true })}
        >
          <FolderOpen size={14} />
        </button>
        <button className="btn-icon" title={t('panel.diag.closeEsc')} onClick={close}>
          <X size={14} />
        </button>
      </div>

      {tab === 'run' && (
        <RunView
          onEditSection={(s) => {
            setEditing(s)
            setEditorOpen(true)
          }}
        />
      )}
      {tab === 'reports' &&
        (viewing ? (
          <ReportDetailView report={viewing} onBundle={setBundleFor} />
        ) : (
          <ReportsListView onBundle={setBundleFor} />
        ))}

      <DiagSectionEditor open={editorOpen} initial={editing} onClose={() => setEditorOpen(false)} />
      {bundleFor && <BundleDialog reportId={bundleFor} onClose={() => setBundleFor(null)} />}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  运行诊断视图
 * ------------------------------------------------------------------ */

function RunView({ onEditSection }: { onEditSection: (s: DiagSection | null) => void }): React.JSX.Element {
  const { t } = useI18n()
  const sections = useDiagStore((s) => s.sections)
  const selected = useDiagStore((s) => s.selected)
  const running = useDiagStore((s) => s.running)
  const progress = useDiagStore((s) => s.progress)
  const runOrder = useDiagStore((s) => s.runOrder)
  const statuses = useDiagStore((s) => s.statuses)
  const lastReport = useDiagStore((s) => s.lastReport)

  const sessions = useSshSessions()
  const activeId = useSessionStore((s) => s.activeId)
  const targetSession =
    sessions.find((s) => s.id === activeId && s.status === 'connected') ??
    sessions.find((s) => s.status === 'connected')

  const grouped = useMemo(() => {
    const map = new Map<string, DiagSection[]>()
    for (const s of sections) {
      const arr = map.get(s.group) ?? []
      arr.push(s)
      map.set(s.group, arr)
    }
    return [...map.entries()]
  }, [sections])

  const selectedSet = new Set(selected)

  return (
    <div className="flex min-h-0 flex-1">
      {/*
       * 左：诊断项清单
       */}
      <div className="flex w-[300px] shrink-0 flex-col border-r border-edge bg-panel">
        <div className="flex shrink-0 items-center gap-1.5 border-b border-edge-soft px-2.5 py-1.5">
          <span className="text-2xs font-semibold text-ink-2">{t('panel.diag.sections')}</span>
          <span className="text-2xs text-ink-3">
            {selected.length}/{sections.length}
          </span>
          <span className="flex-1" />
          <button
            className="text-2xs text-ink-3 transition-colors hover:text-ink"
            onClick={() => useDiagStore.getState().selectAll(true)}
          >
            {t('panel.diag.selectAll')}
          </button>
          <span className="text-2xs text-ink-3/50">|</span>
          <button
            className="text-2xs text-ink-3 transition-colors hover:text-ink"
            onClick={() => useDiagStore.getState().selectAll(false)}
          >
            {t('panel.diag.clear')}
          </button>
          <button
            className="btn-icon ml-1 h-5 w-5"
            title={t('panel.diag.newSection')}
            onClick={() => onEditSection(null)}
          >
            <Plus size={12} />
          </button>
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1.5">
          {grouped.map(([group, items]) => {
            const selCount = items.filter((i) => selectedSet.has(i.id)).length
            const allSel = selCount === items.length
            const someSel = selCount > 0 && !allSel
            return (
              <div key={group} className="mb-1">
                <button
                  className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-hover/60"
                  onClick={() => useDiagStore.getState().setGroupSelected(group, !allSel)}
                >
                  {allSel ? (
                    <CheckSquare size={12} className="shrink-0 text-accent" />
                  ) : someSel ? (
                    <MinusSquare size={12} className="shrink-0 text-accent/70" />
                  ) : (
                    <Square size={12} className="shrink-0 text-ink-3" />
                  )}
                  <span className="text-2xs font-semibold text-ink-2">{group}</span>
                  <span className="text-3xs text-ink-3">
                    {selCount}/{items.length}
                  </span>
                </button>

                {items.map((item) => {
                  const on = selectedSet.has(item.id)
                  const status = statuses[item.id]
                  return (
                    <div
                      key={item.id}
                      className={cn(
                        'group flex cursor-default items-center gap-1.5 rounded-md py-1 pl-4 pr-1 transition-colors',
                        on ? 'text-ink-2 hover:bg-hover/50' : 'text-ink-3 hover:bg-hover/40'
                      )}
                      onClick={() => useDiagStore.getState().toggleSection(item.id)}
                      title={item.description ?? item.command}
                    >
                      {on ? (
                        <CheckSquare size={11} className="shrink-0 text-accent" />
                      ) : (
                        <Square size={11} className="shrink-0 text-ink-3/60" />
                      )}
                      <span className="min-w-0 flex-1 truncate text-xs">{item.name}</span>
                      {status === 'running' && (
                        <Loader2 size={10} className="shrink-0 animate-spin text-accent" />
                      )}
                      {item.builtin ? (
                        <button
                          className="btn-icon h-5 w-5 opacity-0 group-hover:opacity-100"
                          title={t('panel.diag.copyCustom')}
                          onClick={(e) => {
                            e.stopPropagation()
                            onEditSection(item)
                          }}
                        >
                          <Copy size={10} />
                        </button>
                      ) : (
                        <button
                          className="btn-icon h-5 w-5 opacity-0 group-hover:opacity-100"
                          title={t('panel.diag.editCustom')}
                          onClick={(e) => {
                            e.stopPropagation()
                            onEditSection(item)
                          }}
                        >
                          <Pencil size={10} />
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>

      {/*
       * 右：执行与结果
       */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-edge-soft px-3 py-1.5">
          <span className="text-2xs text-ink-3">
            {t('panel.diag.targetSession')}
            {targetSession ? (
              <span className="text-ink-2">
                {t('panel.diag.targetValue', {
                  title: targetSession.title,
                  target: targetSession.target
                })}
              </span>
            ) : (
              <span className="text-warning">{t('panel.diag.noSshSession')}</span>
            )}
          </span>
          <span className="flex-1" />
          {running && progress && (
            <span className="font-mono text-2xs text-accent">
              {progress.index}/{progress.total}
            </span>
          )}
          {running ? (
            <button
              className="btn h-7 px-3 text-xs"
              onClick={() => void useDiagStore.getState().cancel()}
            >
              <X size={12} />
              {t('panel.diag.cancel')}
            </button>
          ) : (
            <button
              className="btn btn-primary h-7 px-3.5 text-xs"
              disabled={!targetSession || selected.length === 0}
              onClick={() => void useDiagStore.getState().start()}
            >
              <Activity size={12} />
              {t('panel.diag.start')}
            </button>
          )}
          {lastReport && !running && (
            <>
              <span className="mx-0.5 h-4 w-px bg-edge-soft" />
              <button
                className="btn h-7 px-2.5 text-xs"
                title={t('panel.diag.exportMdHint')}
                onClick={() => void useDiagStore.getState().exportReport(lastReport.id, 'md')}
              >
                <FileText size={12} />
                Markdown
              </button>
              <button
                className="btn h-7 px-2.5 text-xs"
                title={t('panel.diag.exportHtmlHint')}
                onClick={() => void useDiagStore.getState().exportReport(lastReport.id, 'html')}
              >
                <FileCode2 size={12} />
                HTML
              </button>
              <button
                className="btn h-7 px-2.5 text-xs"
                title={t('panel.diag.copyMdHint')}
                onClick={() => void useDiagStore.getState().copyMarkdown(lastReport.id)}
              >
                <ClipboardCopy size={12} />
                {t('panel.diag.copy')}
              </button>
            </>
          )}
        </div>

        {running && progress && (
          <div className="h-0.5 shrink-0 bg-raised">
            <div
              className="h-full bg-accent transition-[width] duration-150"
              style={{ width: `${(progress.index / Math.max(progress.total, 1)) * 100}%` }}
            />
          </div>
        )}

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">
          {runOrder.length === 0 ? (
            <EmptyState
              icon={<Activity size={30} />}
              title={t('panel.diag.readyTitle')}
              hint={
                targetSession
                  ? t('panel.diag.readyHintOnline')
                  : t('panel.diag.readyHintOffline')
              }
            />
          ) : (
            <div className="space-y-2">
              {lastReport && !running && (
                <SummaryBar report={lastReport} />
              )}
              {runOrder.map((id) => (
                <LiveResultCard key={id} sectionId={id} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function SummaryBar({ report }: { report: DiagReport }): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="flex items-center gap-2 rounded-lg border border-edge bg-panel px-3 py-2">
      <CheckCircle2 size={14} className="text-success" />
      <span className="text-xs text-ink">
        {t('panel.diag.summary', {
          total: report.sectionCount,
          ok: report.okCount,
          problem: report.problemCount
        })}
      </span>
      <span className="flex-1" />
      <button
        className="text-2xs text-accent transition-colors hover:text-ink"
        onClick={() => void useDiagStore.getState().viewReport(report.id)}
      >
        {t('panel.diag.viewFullReport')}
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  逐节结果卡片
 * ------------------------------------------------------------------ */

function LiveResultCard({ sectionId }: { sectionId: string }): React.JSX.Element | null {
  const section = useDiagStore((s) => s.sections.find((x) => x.id === sectionId))
  const status = useDiagStore((s) => s.statuses[sectionId])
  const result = useDiagStore((s) => s.results[sectionId])

  if (result) return <ResultCard result={result} />
  if (!section) return null
  return <PlaceholderCard name={section.name} group={section.group} status={status ?? 'pending'} />
}

function PlaceholderCard({
  name,
  group,
  status
}: {
  name: string
  group: string
  status: DiagSectionStatus
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="flex items-center gap-2 rounded-lg border border-edge-soft bg-panel/60 px-3 py-2">
      <StatusIcon status={status} />
      <span className="text-xs text-ink-2">{name}</span>
      <span className="rounded bg-raised px-1 py-px text-3xs text-ink-3">{group}</span>
      <span className="flex-1" />
      <span className="text-2xs text-ink-3">
        {status === 'running' ? t('panel.diag.running') : t('panel.diag.pending')}
      </span>
    </div>
  )
}

function StatusIcon({ status }: { status: DiagSectionStatus }): React.JSX.Element {
  switch (status) {
    case 'running':
      return <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
    case 'done':
      return <CheckCircle2 size={13} className="shrink-0 text-success" />
    case 'error':
      return <XCircle size={13} className="shrink-0 text-danger" />
    case 'timeout':
      return <TimerOff size={13} className="shrink-0 text-warning" />
    case 'skipped':
      return <MinusCircle size={13} className="shrink-0 text-ink-3" />
    default:
      return <Square size={12} className="shrink-0 text-ink-3/60" />
  }
}

function ResultCard({ result, defaultOpen = false }: { result: DiagSectionResult; defaultOpen?: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(defaultOpen || result.status === 'error' || result.status === 'timeout')

  const copyOutput = (): void => {
    void call(window.api.clip.write(result.output || result.error || ''), { silent: true }).then((ok) => {
      if (ok !== null) {
        useToastStore.getState().push({
          kind: 'success',
          title: t('panel.diag.copiedSection', { name: result.name })
        })
      }
    })
  }

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-panel',
        result.status === 'done' ? 'border-edge-soft' : 'border-danger/40'
      )}
    >
      <div
        className="flex cursor-default items-center gap-2 px-3 py-2 transition-colors hover:bg-hover/40"
        onClick={() => setOpen((v) => !v)}
      >
        <StatusIcon status={result.status} />
        <span className="text-xs font-medium text-ink">{result.name}</span>
        <span className="rounded bg-raised px-1 py-px text-3xs text-ink-3">{result.group}</span>
        <span className="flex-1" />
        <span className="font-mono text-3xs text-ink-3">
          {result.durationMs}ms · exit {result.exitCode ?? '-'}
        </span>
        <button
          className="btn-icon h-5 w-5"
          title={t('panel.diag.copySection')}
          onClick={(e) => {
            e.stopPropagation()
            copyOutput()
          }}
        >
          <Copy size={11} />
        </button>
      </div>

      {open && (
        <div className="border-t border-edge-soft">
          <div className="border-b border-edge-soft bg-app px-3 py-1.5 font-mono text-3xs leading-relaxed text-accent/90">
            $ {result.command}
          </div>
          <pre className="scroll-thin max-h-[380px] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-2xs leading-relaxed text-ink-2">
            {result.output.trim() === '' ? t('panel.diag.noOutput') : result.output}
          </pre>
          {result.error && result.error.trim() !== '' && (
            <pre className="scroll-thin max-h-[160px] overflow-auto whitespace-pre-wrap break-words border-t border-danger/20 bg-danger/5 px-3 py-1.5 font-mono text-3xs leading-relaxed text-danger/90">
              {result.error}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  报告库
 * ------------------------------------------------------------------ */

function ReportsListView({ onBundle }: { onBundle: (id: string) => void }): React.JSX.Element {
  const { t } = useI18n()
  const reports = useDiagStore((s) => s.reports)
  const [keyword, setKeyword] = useState('')
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)

  useEffect(() => {
    void useDiagStore.getState().loadReports()
  }, [])

  const kw = keyword.trim().toLowerCase()
  const filtered = kw
    ? reports.filter(
        (r) => r.title.toLowerCase().includes(kw) || r.host.toLowerCase().includes(kw)
      )
    : reports

  return (
    <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">
      <div className="mb-2 flex items-center gap-2">
        <input
          className="input max-w-[260px]"
          placeholder={t('panel.diag.searchReports')}
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
        />
        <span className="flex-1" />
        <button
          className="btn h-7 px-2.5 text-xs"
          onClick={() => void useDiagStore.getState().loadReports()}
        >
          <RefreshCw size={12} />
          {t('panel.diag.refresh')}
        </button>
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon={<FileText size={28} />}
          title={reports.length === 0 ? t('panel.diag.emptyReports') : t('panel.diag.emptySearchReports')}
          hint={
            reports.length === 0
              ? t('panel.diag.emptyReportsHint')
              : t('panel.diag.emptySearchHint')
          }
        />
      ) : (
        <div className="space-y-1.5">
          {filtered.map((r) => (
            <div
              key={r.id}
              className="group flex items-center gap-2.5 rounded-lg border border-edge-soft bg-panel px-3 py-2 transition-colors hover:bg-hover/40"
            >
              <FileText size={14} className="shrink-0 text-accent/80" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-ink">{r.title}</div>
                <div className="mt-0.5 flex items-center gap-2 text-3xs text-ink-3">
                  <span>{formatTime(r.startedAt)}</span>
                  <span className="font-mono">{formatBytes(r.size)}</span>
                  <span
                    className={cn(
                      'rounded px-1 py-px',
                      r.problemCount > 0 ? 'bg-danger/10 text-danger' : 'bg-success/10 text-success'
                    )}
                  >
                    {t('panel.diag.reportCounts', { ok: r.okCount, problem: r.problemCount })}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                <button
                  className="btn-icon h-6 w-6"
                  title={t('panel.diag.view')}
                  onClick={() => void useDiagStore.getState().viewReport(r.id)}
                >
                  <Eye size={12} />
                </button>
                <button
                  className="btn-icon h-6 w-6"
                  title={t('panel.diag.exportMd')}
                  onClick={() => void useDiagStore.getState().exportReport(r.id, 'md')}
                >
                  <FileText size={12} />
                </button>
                <button
                  className="btn-icon h-6 w-6"
                  title={t('panel.diag.exportHtml')}
                  onClick={() => void useDiagStore.getState().exportReport(r.id, 'html')}
                >
                  <FileCode2 size={12} />
                </button>
                <button
                  className="btn-icon h-6 w-6"
                  title={t('panel.diag.copyMd')}
                  onClick={() => void useDiagStore.getState().copyMarkdown(r.id)}
                >
                  <ClipboardCopy size={12} />
                </button>
                <button
                  className="btn-icon h-6 w-6"
                  title={t('panel.diag.bundleTooltip')}
                  onClick={() => onBundle(r.id)}
                >
                  <Package size={12} />
                </button>
                <button
                  className="btn-icon h-6 w-6 hover:text-danger"
                  title={t('panel.diag.delete')}
                  onClick={() => setPendingDelete(r.id)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('panel.diag.deleteReportTitle')}
        danger
        confirmText={t('panel.diag.deleteReportConfirm')}
        message={t('panel.diag.deleteReportMsg')}
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const id = pendingDelete
          setPendingDelete(null)
          if (!id) return
          void call(window.api.diag.removeReport(id), {
            errorTitle: t('panel.diag.deleteReportError')
          }).then(() => useDiagStore.getState().loadReports())
        }}
      />
    </div>
  )
}

function ReportDetailView({
  report,
  onBundle
}: {
  report: DiagReport
  onBundle: (id: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  const closeReport = useDiagStore((s) => s.closeReport)
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge-soft px-3 py-1.5">
        <button className="btn h-7 px-2 text-2xs" onClick={closeReport}>
          <ArrowLeft size={12} />
          {t('panel.diag.backToReports')}
        </button>
        <span className="text-2xs text-ink-3">
          {report.host} · {formatTime(report.startedAt)} ~ {formatTime(report.finishedAt)}
        </span>
        <span className="flex-1" />
        <button
          className="btn h-7 px-2.5 text-2xs"
          onClick={() => void useDiagStore.getState().exportReport(report.id, 'md')}
        >
          <FileText size={12} />
          Markdown
        </button>
        <button
          className="btn h-7 px-2.5 text-2xs"
          onClick={() => void useDiagStore.getState().exportReport(report.id, 'html')}
        >
          <FileCode2 size={12} />
          HTML
        </button>
        <button
          className="btn h-7 px-2.5 text-2xs"
          onClick={() => void useDiagStore.getState().copyMarkdown(report.id)}
        >
          <ClipboardCopy size={12} />
          {t('panel.diag.copy')}
        </button>
        <button
          className="btn h-7 px-2.5 text-2xs"
          title={t('panel.diag.bundleTitle')}
          onClick={() => onBundle(report.id)}
        >
          <Package size={12} />
          {t('panel.diag.bundleBtn')}
        </button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">
        <SummaryBar report={report} />
        <div className="mt-2 space-y-2">
          {report.sections.map((r) => (
            <ResultCard key={r.sectionId} result={r} />
          ))}
        </div>
      </div>
    </div>
  )
}
