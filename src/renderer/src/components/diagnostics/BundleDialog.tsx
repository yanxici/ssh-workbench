import type * as React from 'react'
import { useEffect, useState } from 'react'
import { FolderOpen, Loader2, Package, Sparkles } from 'lucide-react'
import type { BundlePreview } from '@shared/types'
import { tNow, useI18n } from '@/i18n'
import { call } from '@/lib/ipc'
import { cn, formatBytes } from '@/lib/utils'
import { Modal, Toggle } from '@/components/ui'
import { useToastStore } from '@/stores/toastStore'

/**
 * 诊断打包对话框：报告 + 会话日志 + 命令历史 + 配置备份 → 一个 zip。
 * 发给研发/客户即可复现现场，任何解压工具可打开。
 */
export function BundleDialog({
  reportId,
  onClose
}: {
  reportId: string
  onClose: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const [preview, setPreview] = useState<BundlePreview | null>(null)
  const [includeLogs, setIncludeLogs] = useState(true)
  const [includeHistory, setIncludeHistory] = useState(true)
  const [includeBackups, setIncludeBackups] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState<{ path: string; size: number; entries: number } | null>(null)

  /*
   * 预览失败时必须落到一个「已结束」的状态，否则按钮永远 disabled（!preview），
   * 用户看到的就是一个转不出来的对话框，只能关掉重试。
   */
  const [previewFailed, setPreviewFailed] = useState(false)
  useEffect(() => {
    setPreviewFailed(false)
    void call(window.api.diag.bundlePreview(reportId), {
      errorTitle: tNow('panel.bundle.previewError')
    }).then((p) => {
      if (p) setPreview(p)
      else setPreviewFailed(true)
    })
  }, [reportId])

  const runExport = async (): Promise<void> => {
    setExporting(true)
    const res = await call(
      window.api.diag.bundleExport(reportId, { includeLogs, includeHistory, includeBackups }),
      { errorTitle: t('panel.bundle.exportError') }
    )
    setExporting(false)
    if (res && !res.canceled && res.path) {
      setResult({ path: res.path, size: res.size ?? 0, entries: res.entries ?? 0 })
      useToastStore.getState().push({ kind: 'success', title: t('panel.bundle.exported') })
    }
  }

  return (
    <Modal
      open
      title={result ? t('panel.bundle.doneTitle') : t('panel.bundle.title')}
      onClose={onClose}
      footer={
        result ? (
          <>
            <button className="btn h-7 px-3 text-xs" onClick={onClose}>
              {t('panel.bundle.close')}
            </button>
            <button
              className="btn btn-primary h-7 px-3.5 text-xs"
              onClick={() => void call(window.api.diag.bundleReveal(result.path), { silent: true })}
            >
              <FolderOpen size={12} />
              {t('panel.bundle.reveal')}
            </button>
          </>
        ) : (
          <>
            <button className="btn h-7 px-3 text-xs" onClick={onClose}>
              {t('panel.bundle.cancel')}
            </button>
            <button
              className="btn btn-primary h-7 px-3.5 text-xs"
              disabled={exporting || !preview}
              onClick={() => void runExport()}
            >
              {exporting ? <Loader2 size={12} className="animate-spin" /> : <Package size={12} />}
              {exporting ? t('panel.bundle.exporting') : t('panel.bundle.exportZip')}
            </button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-2.5">
          <div className="flex items-center gap-2 rounded-lg border border-success/40 bg-success/5 px-3 py-2.5">
            <Sparkles size={14} className="shrink-0 text-success" />
            <div className="min-w-0 text-xs text-ink">
              {t('panel.bundle.exportedCount', {
                entries: result.entries,
                size: formatBytes(result.size)
              })}
            </div>
          </div>
          <div className="selectable break-all rounded-md border border-edge bg-app px-2.5 py-2 font-mono text-2xs text-ink-3">
            {result.path}
          </div>
          <div className="text-2xs leading-relaxed text-ink-3">
            {t('panel.bundle.resultHint')}
          </div>
        </div>
      ) : previewFailed ? (
        <div className="rounded-md border border-warning/40 bg-warning/5 px-3 py-2.5 text-2xs leading-relaxed text-ink-3">
          {t('panel.bundle.previewFailedHint')}
        </div>
      ) : !preview ? (
        <div className="flex items-center justify-center gap-2 py-6 text-2xs text-ink-3">
          <Loader2 size={12} className="animate-spin" />
          {t('panel.bundle.loading')}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-md border border-edge bg-app px-3 py-2 text-2xs leading-relaxed text-ink-3">
            {t('panel.bundle.reportLabel')}
            <span className="text-ink-2">{preview.reportTitle}</span>
            <br />
            {t('panel.bundle.deviceLabel')}
            {t('panel.bundle.deviceValue', {
              name: preview.connectionName,
              host: preview.host
            })}
            {preview.profileName && (
              <>
                {t('panel.bundle.profilePrefix')}
                <span className="text-ink-2">{preview.profileName}</span>
              </>
            )}
          </div>

          <BundleRow
            label={t('panel.bundle.rowReportLabel')}
            detail={t('panel.bundle.rowReportDetail')}
            checked
            disabled
            onChange={() => undefined}
          />
          <BundleRow
            label={t('panel.bundle.rowLogsLabel')}
            detail={
              preview.logFiles > 0
                ? t('panel.bundle.rowLogsDetail', {
                    count: preview.logFiles,
                    size: formatBytes(preview.logBytes)
                  })
                : t('panel.bundle.rowLogsEmpty')
            }
            checked={includeLogs && preview.logFiles > 0}
            disabled={preview.logFiles === 0}
            onChange={setIncludeLogs}
          />
          <BundleRow
            label={t('panel.bundle.rowHistoryLabel')}
            detail={
              preview.historyCount > 0
                ? t('panel.bundle.rowHistoryDetail', { count: preview.historyCount })
                : t('panel.bundle.rowHistoryEmpty')
            }
            checked={includeHistory && preview.historyCount > 0}
            disabled={preview.historyCount === 0}
            onChange={setIncludeHistory}
          />
          <BundleRow
            label={t('panel.bundle.rowBackupsLabel')}
            detail={
              preview.backups > 0
                ? t('panel.bundle.rowBackupsDetail', { count: preview.backups })
                : t('panel.bundle.rowBackupsEmpty')
            }
            checked={includeBackups && preview.backups > 0}
            disabled={preview.backups === 0}
            onChange={setIncludeBackups}
          />
        </div>
      )}
    </Modal>
  )
}

function BundleRow({
  label,
  detail,
  checked,
  disabled,
  onChange
}: {
  label: string
  detail: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-md border border-edge-soft px-3 py-2',
        disabled && 'opacity-70'
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-xs text-ink-2">{label}</div>
        <div className="mt-0.5 text-3xs text-ink-3">{detail}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  )
}
