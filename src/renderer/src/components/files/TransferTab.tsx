import type * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  Download,
  FolderOpen,
  Loader2,
  RefreshCw,
  RotateCcw,
  X
} from 'lucide-react'
import type { TransferRecord } from '@shared/types'
import { call } from '@/lib/ipc'
import { cn, formatBytes, formatRelativeTime } from '@/lib/utils'
import { useTransferStore, isFailedRecord, isLiveRecord } from '@/stores/transferStore'
import { useSftpStore } from '@/stores/sftpStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useToastStore } from '@/stores/toastStore'
import { amountText, basename, locateKind, parentOf, STATUS_CLASS, statusLabel } from '@/lib/transferFormat'
import { getZmodemRecordProgress, watchZmodem, type ZmodemProgress } from '@/lib/zmodem'
import { type I18nKey, useI18n } from '@/i18n'

/**
 * 侧栏「传输」Tab —— 上传 / 下载的记录，点一行就能定位到文件。
 *
 * 为什么在侧栏再做一份（主区域已经有 TransferPanel）：
 *   主面板是「翻旧账」的全屏账本，适合一次看很多条；但用户真正的问题往往是
 *   「我刚下的那个文件跑哪去了」，那一步就在侧栏、在文件树旁边，不该为此
 *   关掉文件面板再开一个全屏面板。
 *
 * 分工与主面板一致：已结束的记录纯读记录；status 仍是 running 的行按 id
 * 回查活任务（同一行一个订阅，不让整表跟着 150ms 进度事件重渲）。
 */
type TabFilter = 'all' | 'upload' | 'download' | 'failed'

const FILTERS: Array<{ key: TabFilter; labelKey: I18nKey }> = [
  { key: 'all', labelKey: 'files.ui.transfer.filterAll' },
  { key: 'upload', labelKey: 'files.ui.transfer.filterUpload' },
  { key: 'download', labelKey: 'files.ui.transfer.filterDownload' },
  { key: 'failed', labelKey: 'files.ui.transfer.filterFailed' }
]

export function TransferTab(): React.JSX.Element {
  const { t } = useI18n()
  const records = useTransferStore((s) => s.records)
  const loading = useTransferStore((s) => s.loading)
  const load = useTransferStore((s) => s.load)
  const [filter, setFilter] = useState<TabFilter>('all')

  /*
   * 挂载即认领一个「有人在看」的位：主进程只在记录变更时发信号，
   * 没人看的时候不该有渲染层跟着拉数据（见 transferStore.applyChanged）。
   */
  useEffect(() => {
    useTransferStore.getState().attachView()
    void load()
    return () => useTransferStore.getState().detachView()
  }, [load])

  const shown = useMemo(() => {
    return records.filter((r) => {
      if (filter === 'upload' && r.direction !== 'upload') return false
      if (filter === 'download' && r.direction !== 'download') return false
      if (filter === 'failed' && !isFailedRecord(r)) return false
      return true
    })
  }, [records, filter])

  const counts = useMemo(
    () => ({
      live: records.filter(isLiveRecord).length,
      failed: records.filter(isFailedRecord).length
    }),
    [records]
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 border-b border-edge px-2 py-1.5">
        <div className="flex items-center gap-0.5 rounded-md bg-raised p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={cn(
                'flex h-6 items-center gap-1 whitespace-nowrap rounded-sm px-1.5 text-2xs transition-colors duration-150',
                filter === f.key
                  ? 'bg-app font-medium text-ink shadow-[0_1px_2px_rgb(0_0_0/0.06)]'
                  : 'text-ink-3 hover:text-ink-2'
              )}
              onClick={() => setFilter(f.key)}
            >
              {t(f.labelKey)}
              {f.key === 'all' && counts.live > 0 && (
                <span className="font-mono text-3xs text-accent">{counts.live}</span>
              )}
              {f.key === 'failed' && counts.failed > 0 && (
                <span className="font-mono text-3xs text-danger">{counts.failed}</span>
              )}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <button
          className="btn-icon h-6 w-6"
          title={loading ? t('files.ui.reading') : t('files.ui.transfer.reloadTitle')}
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw size={12} className={cn(loading && 'animate-spin')} />
        </button>
      </div>

      <DownloadDirRow />

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto py-0.5">
        {shown.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
            <Download size={18} className="text-ink-3/50" />
            <div className="text-2xs text-ink-3">
              {records.length === 0 ? t('files.ui.transfer.empty') : t('files.ui.transfer.noMatch')}
            </div>
            <div className="max-w-[220px] text-3xs leading-4 text-ink-3/70">
              {t('files.ui.transfer.tabEmptyHint')}
            </div>
          </div>
        ) : (
          shown.map((r) => <TabRow key={r.id} record={r} />)
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  下载落点
 * ------------------------------------------------------------------ */

/**
 * 下载目录一行。
 *
 * 现场笔记本的「下载」往往在小容量系统盘，客户资料得落到 D 盘或移动硬盘 ——
 * 每次下载手动选目录等于每次多点三次，所以把落点做成可见、可改的一项。
 */
function DownloadDirRow(): React.JSX.Element {
  const { t } = useI18n()
  const [dir, setDir] = useState('')
  const [busy, setBusy] = useState(false)
  const downloadDir = useSettingsStore((s) => s.settings.downloadDir)
  const update = useSettingsStore((s) => s.update)

  /*
   * 订阅 settings.downloadDir：设置页改成别的目录后，这里要跟着刷新。
   * 原来用空依赖只拉一次，两侧各写各的，改了一边另一边永远是开面板时的旧值。
   */
  useEffect(() => {
    void call(window.api.sftp.downloadsDir(), { silent: true }).then((d) => {
      if (d) setDir(d)
    })
  }, [downloadDir])

  const pick = async (): Promise<void> => {
    setBusy(true)
    const res = await call(window.api.sftp.pickDownloadDir(), {
      errorTitle: t('files.ui.err.pickDownloadDir')
    })
    setBusy(false)
    if (!res || res.canceled) return
    // 必须落盘，只 setDir 的话重启就回去了，设置页也永远不显示「恢复默认」
    await update({ downloadDir: res.dir })
    setDir(res.dir)
    useToastStore.getState().push({
      kind: 'success',
      title: t('files.ui.toast.downloadDirChanged'),
      detail: res.dir
    })
  }

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-edge px-2 py-1">
      <Download size={11} className="shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 truncate font-mono text-3xs text-ink-3" title={dir}>
        {dir || t('files.ui.reading')}
      </span>
      <button
        className="shrink-0 rounded-sm px-1 py-0.5 text-3xs text-ink-3 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
        disabled={busy}
        onClick={() => void pick()}
      >
        {t('files.ui.transfer.changeDir')}
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  行
 * ------------------------------------------------------------------ */

function TabRow({ record }: { record: TransferRecord }): React.JSX.Element {
  const { t } = useI18n()
  const retry = useTransferStore((s) => s.retry)
  const reveal = useTransferStore((s) => s.reveal)
  const openDir = useTransferStore((s) => s.openDir)
  const live = isLiveRecord(record)
  const zm = useZmodemLive(record, live)
  const where = locateKind(record)
  const name =
    record.fileName || basename(record.remotePath || record.localPath) || t('files.ui.transfer.unknownFile')

  return (
    <div className="group flex items-start gap-1.5 px-2 py-1 transition-colors hover:bg-hover/60">
      {record.direction === 'upload' ? (
        <ArrowUpFromLine size={11} className="mt-0.5 shrink-0 text-accent" />
      ) : (
        <ArrowDownToLine size={11} className="mt-0.5 shrink-0 text-success" />
      )}

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1">
          <span className="min-w-0 flex-1 truncate text-xs text-ink" title={record.remotePath || record.localPath}>
            {name}
          </span>
          <StatusDot record={record} />
        </div>
        <div className="flex items-center gap-1 text-3xs text-ink-3">
          <span className="min-w-0 flex-1 truncate" title={record.connectionName ?? record.target ?? ''}>
            {record.connectionName || record.target || t('files.ui.transfer.unknownConn')}
          </span>
          <span className="shrink-0 font-mono">{live ? <LiveAmount record={record} zm={zm} /> : amountText(record)}</span>
          <span className="shrink-0">{formatRelativeTime(record.finishedAt ?? record.startedAt)}</span>
        </div>
        {live && <LiveProgressBar record={record} zm={zm} />}
        {(record.error || record.note) && (
          <div
            className={cn(
              'mt-0.5 flex items-start gap-1 text-3xs leading-4',
              record.error ? 'text-danger' : 'text-warning'
            )}
          >
            {record.error && <AlertTriangle size={9} className="mt-0.5 shrink-0" />}
            <span className="min-w-0 flex-1 break-all">{record.error || record.note}</span>
          </div>
        )}
      </div>

      {/*
       * 行内动作：平时藏起来，hover 才出现，避免 280px 宽度里全是图标
       */}
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {where === 'local-file' && (
          <button
            className="btn-icon h-5 w-5"
            title={t('files.ui.dock.revealLocal')}
            onClick={() => void reveal(record.localPath)}
          >
            <FolderOpen size={11} />
          </button>
        )}
        {where === 'local-dir' && (
          <button
            className="btn-icon h-5 w-5"
            title={t('files.ui.transfer.openContainingDir')}
            onClick={() => void openDir(record.localPath)}
          >
            <FolderOpen size={11} />
          </button>
        )}
        {where === 'remote' && <RemoteLocate record={record} />}
        {!live && (
          <button
            className="btn-icon h-5 w-5 disabled:opacity-30"
            disabled={record.via !== 'sftp'}
            title={
              record.via !== 'sftp'
                ? t('files.ui.transfer.remoteRetryHint')
                : t('files.ui.transfer.retryPath')
            }
            onClick={() => void retry(record)}
          >
            <RotateCcw size={11} />
          </button>
        )}
      </div>
    </div>
  )
}

function StatusDot({ record }: { record: TransferRecord }): React.JSX.Element {
  if (record.status === 'running' || record.status === 'pending') {
    return <Loader2 size={10} className={cn('shrink-0 animate-spin', STATUS_CLASS[record.status])} />
  }
  if (record.status === 'done') {
    return <CheckCircle2 size={10} className={cn('shrink-0', STATUS_CLASS.done)} />
  }
  if (record.status === 'error' || record.status === 'interrupted') {
    return <AlertTriangle size={10} className={cn('shrink-0', STATUS_CLASS[record.status])} />
  }
  return <X size={10} className={cn('shrink-0', STATUS_CLASS[record.status])} />
}

/** 订阅单条 ZMODEM 进行中记录的实时进度（仅在活任务行启用，避免每行重复订阅或空订阅） */
function useZmodemLive(record: TransferRecord, enabled: boolean): ZmodemProgress | null {
  const sessionId = enabled && record.via === 'zmodem' ? record.sessionId : undefined
  const [zm, setZm] = useState<ZmodemProgress | null>(() =>
    sessionId ? getZmodemRecordProgress(sessionId, record.id) : null
  )
  useEffect(() => {
    if (!sessionId) {
      setZm(null)
      return
    }
    setZm(getZmodemRecordProgress(sessionId, record.id))
    return watchZmodem(sessionId, (p) => {
      if (p.transferId !== record.id) return
      setZm(p.phase === 'active' ? p : null)
    })
  }, [sessionId, record.id])
  return zm
}

/** 活任务按 id 单独订阅：整表订阅会被每 150ms 一次的事件拖着重渲 */
function LiveAmount({
  record,
  zm
}: {
  record: TransferRecord
  zm: ZmodemProgress | null
}): React.JSX.Element {
  const { t } = useI18n()
  const task = useSftpStore((s) =>
    record.via === 'sftp' ? s.transfers.find((t) => t.id === record.id) : undefined
  )
  if (zm) {
    const batch = zm.fileCount && zm.fileCount > 1 ? `${zm.fileIndex ?? 1}/${zm.fileCount} · ` : ''
    if (zm.bytesTotal <= 0) {
      return <span className="text-accent">{batch}{formatBytes(zm.bytesDone)}</span>
    }
    const pct = Math.min(100, Math.round((zm.bytesDone / zm.bytesTotal) * 100))
    return <span className="text-accent">{batch}{pct}%</span>
  }
  if (!task) return <span title={statusLabel(record.status)}>{t('files.ui.transfer.status.running')}</span>
  if (task.unit === 'files') {
    return (
      <span>
        {t('files.ui.transfer.liveCountShort', {
          done: Math.min(task.transferred, task.total),
          total: task.total
        })}
      </span>
    )
  }
  if (task.total <= 0) {
    return (
      <span>
        {task.speedBps
          ? `${Math.round(task.speedBps / 1024)} KB/s`
          : t('files.ui.dock.calculatingShort')}
      </span>
    )
  }
  return <span>{Math.min(100, Math.round((task.transferred / task.total) * 100))}%</span>
}

function LiveProgressBar({
  record,
  zm
}: {
  record: TransferRecord
  zm: ZmodemProgress | null
}): React.JSX.Element | null {
  const task = useSftpStore((s) =>
    record.via === 'sftp' ? s.transfers.find((t) => t.id === record.id) : undefined
  )
  let pct: number | null = null
  if (zm && zm.bytesTotal > 0) {
    pct = Math.min(100, Math.round((zm.bytesDone / zm.bytesTotal) * 100))
  } else if (task && task.total > 0) {
    pct = Math.min(100, Math.round((task.transferred / task.total) * 100))
  }
  if (pct === null) return null
  return (
    <div className="mt-1 h-1 overflow-hidden rounded-full bg-raised">
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-150"
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

function RemoteLocate({ record }: { record: TransferRecord }): React.JSX.Element {
  const { t } = useI18n()
  const online = useSessionStore((s) =>
    s.sessions.some((x) => x.connectionId === record.connectionId && x.status === 'connected')
  )
  const onClick = (): void => {
    const session = useSessionStore
      .getState()
      .sessions.find((x) => x.connectionId === record.connectionId && x.status === 'connected')
    if (!session) return
    const dir = parentOf(record.remotePath)
    void useSftpStore.getState().openFor(session.id, session.target).then(() => {
      if (dir) void useSftpStore.getState().navRemote(dir)
    })
  }
  return (
    <button
      className="btn-icon h-5 w-5 disabled:opacity-30"
      title={online ? t('files.ui.transfer.openRemoteDir') : t('files.ui.transfer.disconnected')}
      disabled={!online}
      onClick={onClick}
    >
      <FolderOpen size={11} />
    </button>
  )
}
