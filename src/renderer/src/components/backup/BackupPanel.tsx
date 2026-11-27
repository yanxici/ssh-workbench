import type * as React from 'react'
import { useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  FileText,
  FolderOpen,
  GitCompare,
  Plus,
  RefreshCw,
  Trash2,
  X
} from 'lucide-react'
import type { BackupDiffResult, BackupMeta } from '@shared/types'
import { useI18n } from '@/i18n'
import { cn, formatBytes, formatTime } from '@/lib/utils'
import { useOverlayEscape } from '@/lib/overlayKeys'
import { ConfirmDialog, EmptyState, Field, Modal } from '@/components/ui'
import { useBackupStore } from '@/stores/backupStore'
import { useSshSessions } from '@/stores/sessionStore'
import { useToastStore } from '@/stores/toastStore'

/**
 * 配置备份对比（覆盖主区域）：
 * 备份设备配置文件到本地 → 与设备当前内容逐文件对比（行级 diff）→ 一键还原（自动留 .bak）。
 */
export function BackupPanel(): React.JSX.Element | null {
  const { t } = useI18n()
  const panelOpen = useBackupStore((s) => s.panelOpen)
  const backups = useBackupStore((s) => s.backups)
  const selectedId = useBackupStore((s) => s.selectedId)

  const close = (): void => useBackupStore.setState({ panelOpen: false })
  // 面板按钮上写着「关闭 (Esc)」，这里必须真的响应 Esc
  useOverlayEscape(panelOpen, close)
  if (!panelOpen) return null

  return (
    <div className="panel-shell fixed inset-x-0 z-30 flex flex-col bg-app">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3">
        <Archive size={14} className="text-accent" />
        <span className="text-xs font-semibold">{t('panel.backup.title')}</span>
        <span className="text-2xs text-ink-3">
          {t('panel.backup.count', { count: backups.length })}
        </span>
        <span className="flex-1" />
        <button className="btn h-7 px-3 text-xs" onClick={() => useBackupStore.getState().setCreateOpen(true)}>
          <Plus size={12} />
          {t('panel.backup.newBackup')}
        </button>
        <button
          className="btn-icon"
          title={t('panel.backup.openDir')}
          onClick={() => void window.api.backups.openDir()}
        >
          <FolderOpen size={14} />
        </button>
        <button
          className="btn-icon"
          title={t('panel.backup.refresh')}
          onClick={() => void useBackupStore.getState().load()}
        >
          <RefreshCw size={14} />
        </button>
        <button className="btn-icon" title={t('panel.backup.closeEsc')} onClick={close}>
          <X size={14} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/*
         * 左：备份列表
         */}
        <div className="scroll-thin w-[280px] shrink-0 overflow-y-auto border-r border-edge bg-panel p-1.5">
          {backups.length === 0 && (
            <div className="px-2 py-4 text-2xs leading-relaxed text-ink-3">
              {t('panel.backup.emptyList')}
            </div>
          )}
          {backups.map((b) => (
            <BackupRow key={b.id} backup={b} selected={b.id === selectedId} />
          ))}
        </div>

        {/*
         * 右：详情
         */}
        <div className="min-w-0 flex-1">
          {selectedId ? (
            <BackupDetailView />
          ) : (
            <EmptyState
              icon={<Archive size={30} />}
              title={t('panel.backup.emptyDetailTitle')}
              hint={t('panel.backup.emptyDetailHint')}
            />
          )}
        </div>
      </div>

      <CreateBackupModal />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  左侧行
 * ------------------------------------------------------------------ */

function BackupRow({ backup, selected }: { backup: BackupMeta; selected: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const [confirming, setConfirming] = useState(false)
  return (
    <div
      className={cn(
        'group mb-0.5 flex cursor-default items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors',
        selected ? 'bg-accent/15' : 'hover:bg-hover/60'
      )}
      onClick={() => void useBackupStore.getState().select(backup.id)}
    >
      <Archive size={12} className={cn('shrink-0', selected ? 'text-accent' : 'text-ink-3')} />
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-xs', selected ? 'text-ink' : 'text-ink-2')}>
          {backup.name}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-3xs text-ink-3">
          <span className="truncate">{backup.host}</span>
          <span>·</span>
          <span>{formatTime(backup.createdAt)}</span>
          <span>·</span>
          <span className="font-mono">{t('panel.backup.fileCount', { count: backup.fileCount })}</span>
        </div>
      </div>
      <button
        className="btn-icon h-5 w-5 shrink-0 opacity-0 hover:text-danger group-hover:opacity-100"
        title={t('panel.backup.deleteTitle')}
        onClick={(e) => {
          e.stopPropagation()
          setConfirming(true)
        }}
      >
        <Trash2 size={11} />
      </button>

      <ConfirmDialog
        open={confirming}
        title={t('panel.backup.deleteTitle')}
        danger
        confirmText={t('panel.backup.deleteConfirm')}
        message={
          <>
            {t('panel.backup.deletePrefix')}
            <span className="font-medium text-ink">
              {t('panel.backup.deleteQuoted', { name: backup.name })}
            </span>
            {t('panel.backup.deleteSuffix')}
          </>
        }
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          void useBackupStore.getState().remove(backup.id)
        }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  右侧详情
 * ------------------------------------------------------------------ */

function BackupDetailView(): React.JSX.Element {
  const { t } = useI18n()
  const detail = useBackupStore((s) => s.detail)
  const diffs = useBackupStore((s) => s.diffs)
  const diffPath = useBackupStore((s) => s.diffPath)
  const diff = useBackupStore((s) => s.diff)
  const diffing = useBackupStore((s) => s.diffing)
  const diffAllRunning = useBackupStore((s) => s.diffAllRunning)

  const sessions = useSshSessions()
  const connected = sessions.filter((s) => s.status === 'connected')
  const compareSessionId = useBackupStore((s) => s.compareSessionId)
  // 还原真正写的是「对比会话」，不是备份来源；确认框必须点名真实的写入目标
  const restoreTarget = connected.find((s) => s.id === compareSessionId) ?? null

  const [confirmRestoreAll, setConfirmRestoreAll] = useState(false)
  const [pendingRestore, setPendingRestore] = useState<string | null>(null)

  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-2xs text-ink-3">
        <RefreshCw size={12} className="animate-spin" />
        {t('panel.backup.loadingDetail')}
      </div>
    )
  }

  const restorable = detail.files.filter((f) => f.content !== undefined)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-edge-soft px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-ink">{detail.name}</span>
          <span className="font-mono text-2xs text-ink-3">
            {t('panel.backup.detailMeta', { name: detail.connectionName, host: detail.host })} ·{' '}
            {formatTime(detail.createdAt)} · {formatBytes(detail.totalSize)}
          </span>
          <span className="flex-1" />
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <span className="text-2xs text-ink-3">{t('panel.backup.compareSession')}</span>
          <select
            className="input h-7 w-[240px]"
            value={compareSessionId ?? ''}
            onChange={(e) => useBackupStore.getState().setCompareSessionId(e.target.value)}
          >
            <option value="">{t('panel.backup.selectDevice')}</option>
            {connected.map((s) => (
              <option key={s.id} value={s.id}>
                {t('panel.backup.detailMeta', { name: s.title, host: s.target })}
              </option>
            ))}
          </select>
          <button
            className="btn h-7 px-3 text-xs"
            disabled={!compareSessionId || diffAllRunning}
            onClick={() => void useBackupStore.getState().diffAll()}
          >
            <GitCompare size={12} />
            {diffAllRunning ? t('panel.backup.diffing') : t('panel.backup.diffAll')}
          </button>
          <span className="flex-1" />
          <button
            className="btn h-7 px-3 text-xs"
            disabled={!compareSessionId || restorable.length === 0}
            onClick={() => setConfirmRestoreAll(true)}
          >
            <ArchiveRestore size={12} />
            {t('panel.backup.restoreAll', { count: restorable.length })}
          </button>
        </div>

        <div className="mt-1.5 flex flex-wrap gap-1">
          {detail.paths.map((p) => (
            <span key={p} className="rounded bg-raised px-1.5 py-px font-mono text-3xs text-ink-3">
              {p}
            </span>
          ))}
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {detail.files.length === 0 && (
          <div className="px-3 py-4 text-2xs text-ink-3">{t('panel.backup.noFiles')}</div>
        )}
        {detail.files.map((f) => {
          const d = diffs[f.path]
          return (
            <div
              key={f.path}
              className={cn(
                'flex cursor-default items-center gap-2 border-b border-edge-soft/60 px-3 py-1.5 hover:bg-hover/40',
                diffPath === f.path && 'bg-accent/10'
              )}
              onClick={() => {
                if (!d && !f.error && compareSessionId) void useBackupStore.getState().runDiff(f.path)
                else if (d) useBackupStore.setState({ diffPath: f.path, diff: d })
              }}
            >
              <FileText size={12} className="shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-2">
                {f.path}
              </span>
              <span className="shrink-0 font-mono text-3xs text-ink-3">
                {f.size > 0 ? formatBytes(f.size) : ''}
              </span>
              <DiffStatusChip entry={f.error} diff={d} />
              <button
                className="btn h-6 shrink-0 px-2 text-2xs"
                disabled={f.content === undefined || !compareSessionId}
                title={t('panel.backup.restoreTooltip')}
                onClick={(e) => {
                  e.stopPropagation()
                  setPendingRestore(f.path)
                }}
              >
                {t('panel.backup.restoreBtn')}
              </button>
            </div>
          )
        })}
      </div>

      {diffPath && (
        <div className="flex h-[42%] min-h-[200px] shrink-0 flex-col border-t border-edge">
          <div className="flex shrink-0 items-center gap-2 border-b border-edge-soft bg-panel px-3 py-1">
            <span className="font-mono text-2xs text-ink-2">{diffPath}</span>
            {diff && (
              <span className="text-3xs text-ink-3">
                {diff.status === 'same' && t('panel.backup.diffSame')}
                {diff.status === 'changed' && (
                  <>
                    <span className="text-success">+{diff.added}</span> /{' '}
                    <span className="text-danger">-{diff.removed}</span>
                  </>
                )}
                {diff.status === 'remote-missing' && t('panel.backup.diffMissing')}
                {diff.status === 'error' && t('panel.backup.diffError')}
              </span>
            )}
            {diffing && <RefreshCw size={11} className="animate-spin text-accent" />}
            <span className="flex-1" />
            <span className="text-3xs text-ink-3">{t('panel.backup.diffLegend')}</span>
            <button
              className="btn h-6 px-2 text-2xs"
              disabled={!compareSessionId}
              onClick={() => void useBackupStore.getState().runDiff(diffPath)}
            >
              <RefreshCw size={11} />
              {t('panel.backup.reDiff')}
            </button>
            <button className="btn-icon h-6 w-6" onClick={() => useBackupStore.setState({ diffPath: null })}>
              <X size={11} />
            </button>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-auto bg-app px-2 py-1.5 font-mono text-2xs leading-normal">
            {!diff && <div className="text-ink-3">{t('panel.backup.diffing')}</div>}
            {diff?.status === 'same' && (
              <div className="py-3 text-center text-ink-3">{t('panel.backup.diffMatchFull')}</div>
            )}
            {diff?.error && <div className="py-2 text-danger">{diff.error}</div>}
            {diff?.lines.map((line, i) => (
              <div
                key={i}
                className={cn(
                  'whitespace-pre-wrap break-words px-1',
                  line.type === 'add' && 'bg-success/10 text-success',
                  line.type === 'del' && 'bg-danger/10 text-danger',
                  line.type === 'same' && 'text-ink-3'
                )}
              >
                {line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  '}
                {line.text}
              </div>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingRestore !== null}
        title={t('panel.backup.restoreOneTitle')}
        danger
        confirmText={t('panel.backup.restoreOneConfirm')}
        message={
          <>
            {t('panel.backup.restoreOnePrefix')}
            <span className="font-medium text-ink">
              {restoreTarget?.target ?? t('panel.backup.unselected')}
            </span>
            {/*
             * 单文件还原同样要提示跨主机：写错机器上同名路径是真实丢配置的场景
             */}
            {restoreTarget && restoreTarget.host !== detail.host ? (
              <span className="text-danger">
                {t('panel.backup.crossHostWarn', { host: detail.host })}
              </span>
            ) : null}
            {t('panel.backup.colon')}
            <div className="mt-1 selectable break-all font-mono text-2xs text-ink-3">{pendingRestore}</div>
            <div className="mt-2 text-2xs text-ink-3">
              {t('panel.backup.bakHintBefore')}
              <span className="font-mono">.bak</span>
              {t('panel.backup.bakHintAfter')}
            </div>
          </>
        }
        onCancel={() => setPendingRestore(null)}
        onConfirm={() => {
          const path = pendingRestore
          setPendingRestore(null)
          if (path) void useBackupStore.getState().restore([path])
        }}
      />

      <ConfirmDialog
        open={confirmRestoreAll}
        title={t('panel.backup.restoreAllTitle')}
        danger
        confirmText={t('panel.backup.restoreAllConfirm', { count: restorable.length })}
        message={
          <>
            {t('panel.backup.restoreAllPrefix', { count: restorable.length })}
            <span className="font-medium text-ink">
              {restoreTarget?.target ?? t('panel.backup.unselected')}
            </span>
            {/*
             * 比 host 而不是 target：target 是 user@host，跟备份里的纯 host 永远不相等，
             * 每次同机还原都会误报跨主机，警告变成狼来了。
             */}
            {restoreTarget && restoreTarget.host !== detail.host
              ? t('panel.backup.crossHostWarn', { host: detail.host })
              : ''}
            {t('panel.backup.period')}
            <div className="mt-2 text-2xs text-danger">
              {t('panel.backup.restoreAllWarn')}
            </div>
          </>
        }
        onCancel={() => setConfirmRestoreAll(false)}
        onConfirm={() => {
          setConfirmRestoreAll(false)
          void useBackupStore.getState().restore(restorable.map((f) => f.path))
        }}
      />
    </div>
  )
}

function DiffStatusChip({
  entry,
  diff
}: {
  entry?: string
  diff?: BackupDiffResult
}): React.JSX.Element {
  const { t } = useI18n()
  if (entry) {
    return (
      <span
        className="shrink-0 rounded-sm bg-warning/10 px-1 py-px text-3xs text-warning"
        title={entry}
      >
        {t('panel.backup.chipReadFail')}
      </span>
    )
  }
  if (!diff) {
    return (
      <span className="shrink-0 rounded-sm bg-raised px-1 py-px text-3xs text-ink-3">
        {t('panel.backup.chipUntested')}
      </span>
    )
  }
  const map = {
    same: ['bg-success/10 text-success', t('panel.backup.chipSame')],
    changed: [
      'bg-warning/10 text-warning',
      t('panel.backup.chipChanged', { added: diff.added, removed: diff.removed })
    ],
    'remote-missing': ['bg-danger/10 text-danger', t('panel.backup.chipMissing')],
    error: ['bg-danger/10 text-danger', t('panel.backup.chipReadFail')]
  } as const
  const [cls, label] = map[diff.status]
  return <span className={cn('shrink-0 rounded px-1 py-px text-3xs', cls)}>{label}</span>
}

/* ------------------------------------------------------------------ *
 *  新建备份
 * ------------------------------------------------------------------ */

const DEFAULT_PATHS = '/etc/config\n/etc/network/interfaces\n/etc/hosts'

function CreateBackupModal(): React.JSX.Element {
  const { t } = useI18n()
  const open = useBackupStore((s) => s.createOpen)
  const sessions = useSshSessions()
  const connected = sessions.filter((s) => s.status === 'connected')

  const [sessionId, setSessionId] = useState('')
  const [name, setName] = useState('')
  const [paths, setPaths] = useState(DEFAULT_PATHS)
  const [saving, setSaving] = useState(false)

  const chosen = connected.find((s) => s.id === sessionId)

  const submit = async (): Promise<void> => {
    if (!sessionId) {
      useToastStore.getState().push({ kind: 'warning', title: t('panel.backup.pickSessionWarn') })
      return
    }
    setSaving(true)
    const ok = await useBackupStore
      .getState()
      .create(
        sessionId,
        name.trim() ||
          t('panel.backup.defaultName', {
            title: chosen?.title ?? t('panel.backup.defaultDeviceName')
          }),
        paths.split('\n')
      )
    setSaving(false)
    if (ok) {
      setName('')
      setPaths(DEFAULT_PATHS)
    }
  }

  return (
    <Modal
      open={open}
      title={t('panel.backup.modalTitle')}
      onClose={() => useBackupStore.getState().setCreateOpen(false)}
      footer={
        <>
          <button className="btn h-7 px-3 text-xs" onClick={() => useBackupStore.getState().setCreateOpen(false)}>
            {t('panel.backup.cancel')}
          </button>
          <button className="btn btn-primary h-7 px-3.5 text-xs" disabled={saving} onClick={() => void submit()}>
            {saving ? t('panel.backup.collecting') : t('panel.backup.startBackup')}
          </button>
        </>
      }
    >
      <div className="space-y-3.5">
        <Field label={t('panel.backup.fieldSession')}>
          <select className="input selectable" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
            <option value="">{t('panel.backup.selectDevice')}</option>
            {connected.map((s) => (
              <option key={s.id} value={s.id}>
                {t('panel.backup.detailMeta', { name: s.title, host: s.target })}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('panel.backup.fieldName')}>
          <input
            className="input selectable"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={
              chosen
                ? t('panel.backup.defaultName', { title: chosen.title })
                : t('panel.backup.fieldNamePlaceholder')
            }
          />
        </Field>
        <Field
          label={t('panel.backup.fieldPaths')}
          hint={t('panel.backup.fieldPathsHint')}
        >
          <textarea
            className="textarea selectable min-h-[88px] font-mono text-2xs leading-relaxed"
            value={paths}
            onChange={(e) => setPaths(e.target.value)}
            placeholder={'/etc/config\n/etc/network/interfaces'}
          />
        </Field>
      </div>
    </Modal>
  )
}
