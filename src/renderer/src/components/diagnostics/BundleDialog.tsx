import { useEffect, useState } from 'react'
import { FolderOpen, Loader2, Package, Sparkles } from 'lucide-react'
import type { BundlePreview } from '@shared/types'
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
}): JSX.Element {
  const [preview, setPreview] = useState<BundlePreview | null>(null)
  const [includeLogs, setIncludeLogs] = useState(true)
  const [includeHistory, setIncludeHistory] = useState(true)
  const [includeBackups, setIncludeBackups] = useState(true)
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState<{ path: string; size: number; entries: number } | null>(null)

  useEffect(() => {
    void call(window.api.diag.bundlePreview(reportId), { errorTitle: '读取打包信息失败' }).then(
      (p) => p && setPreview(p)
    )
  }, [reportId])

  const runExport = async (): Promise<void> => {
    setExporting(true)
    const res = await call(
      window.api.diag.bundleExport(reportId, { includeLogs, includeHistory, includeBackups }),
      { errorTitle: '打包失败' }
    )
    setExporting(false)
    if (res && !res.canceled && res.path) {
      setResult({ path: res.path, size: res.size ?? 0, entries: res.entries ?? 0 })
      useToastStore.getState().push({ kind: 'success', title: '诊断打包已导出' })
    }
  }

  return (
    <Modal
      open
      title={result ? '打包完成' : '一键打包'}
      onClose={onClose}
      footer={
        result ? (
          <>
            <button className="btn h-7 px-3 text-xs" onClick={onClose}>
              关闭
            </button>
            <button
              className="btn btn-primary h-7 px-3.5 text-xs"
              onClick={() => void call(window.api.diag.bundleReveal(result.path), { silent: true })}
            >
              <FolderOpen size={12} />
              在文件夹中显示
            </button>
          </>
        ) : (
          <>
            <button className="btn h-7 px-3 text-xs" onClick={onClose}>
              取消
            </button>
            <button
              className="btn btn-primary h-7 px-3.5 text-xs"
              disabled={exporting || !preview}
              onClick={() => void runExport()}
            >
              {exporting ? <Loader2 size={12} className="animate-spin" /> : <Package size={12} />}
              {exporting ? '打包中…' : '导出 zip'}
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
              已导出 {result.entries} 个文件（{formatBytes(result.size)}）
            </div>
          </div>
          <div className="selectable break-all rounded-md border border-edge bg-app px-2.5 py-2 font-mono text-[11px] text-ink-3">
            {result.path}
          </div>
          <div className="text-2xs leading-relaxed text-ink-3">
            包内包含：诊断报告（Markdown + HTML）、设备信息、以及勾选的日志/历史/配置备份。
            直接把 zip 发给研发或客户即可复现现场。
          </div>
        </div>
      ) : !preview ? (
        <div className="flex items-center justify-center gap-2 py-6 text-2xs text-ink-3">
          <Loader2 size={12} className="animate-spin" />
          正在统计可打包内容…
        </div>
      ) : (
        <div className="space-y-3">
          <div className="rounded-md border border-edge bg-app px-3 py-2 text-2xs leading-relaxed text-ink-3">
            报告：<span className="text-ink-2">{preview.reportTitle}</span>
            <br />
            设备：{preview.connectionName}（{preview.host}）
            {preview.profileName && (
              <>
                {' '}
                · 档案：<span className="text-ink-2">{preview.profileName}</span>
              </>
            )}
          </div>

          <BundleRow
            label="诊断报告 + 设备信息"
            detail="始终包含（Markdown / HTML / 连接与档案信息）"
            checked
            disabled
            onChange={() => undefined}
          />
          <BundleRow
            label="会话日志"
            detail={
              preview.logFiles > 0
                ? `${preview.logFiles} 个录制文件 · ${formatBytes(preview.logBytes)}`
                : '该设备暂无会话日志'
            }
            checked={includeLogs && preview.logFiles > 0}
            disabled={preview.logFiles === 0}
            onChange={setIncludeLogs}
          />
          <BundleRow
            label="命令历史"
            detail={
              preview.historyCount > 0 ? `${preview.historyCount} 条命令` : '该设备暂无命令历史'
            }
            checked={includeHistory && preview.historyCount > 0}
            disabled={preview.historyCount === 0}
            onChange={setIncludeHistory}
          />
          <BundleRow
            label="配置备份"
            detail={
              preview.backups > 0 ? `${preview.backups} 份配置备份` : '该设备暂无配置备份'
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
}): JSX.Element {
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-md border border-edge-soft px-3 py-2',
        disabled && 'opacity-70'
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-xs text-ink-2">{label}</div>
        <div className="mt-0.5 text-[10px] text-ink-3">{detail}</div>
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  )
}
