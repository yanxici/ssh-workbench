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
import { cn, formatRelativeTime } from '@/lib/utils'
import { useTransferStore, isFailedRecord, isLiveRecord } from '@/stores/transferStore'
import { useSftpStore } from '@/stores/sftpStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useToastStore } from '@/stores/toastStore'
import { amountText, basename, locateKind, parentOf, STATUS_CLASS, STATUS_LABEL } from '@/lib/transferFormat'

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

const FILTERS: Array<{ key: TabFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'upload', label: '上传' },
  { key: 'download', label: '下载' },
  { key: 'failed', label: '失败' }
]

export function TransferTab(): React.JSX.Element {
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
                'flex h-[22px] items-center gap-1 rounded-sm px-1.5 text-2xs transition-colors duration-150',
                filter === f.key
                  ? 'bg-app font-medium text-ink shadow-[0_1px_2px_rgb(0_0_0/0.06)]'
                  : 'text-ink-3 hover:text-ink-2'
              )}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
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
          title={loading ? '正在读取…' : '重新读取记录'}
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
              {records.length === 0 ? '还没有传输记录' : '没有符合条件的记录'}
            </div>
            <div className="max-w-[220px] text-3xs leading-4 text-ink-3/70">
              上传与下载各在这里留一条记录，点行尾的按钮可定位文件
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
  const [dir, setDir] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void call(window.api.sftp.downloadsDir(), { silent: true }).then((d) => {
      if (d) setDir(d)
    })
  }, [])

  const pick = async (): Promise<void> => {
    setBusy(true)
    const res = await call(window.api.sftp.pickDownloadDir(), { errorTitle: '选择下载目录失败' })
    setBusy(false)
    if (!res || res.canceled) return
    setDir(res.dir)
    useToastStore.getState().push({
      kind: 'success',
      title: '下载目录已更改',
      detail: res.dir
    })
  }

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-edge px-2 py-1">
      <Download size={11} className="shrink-0 text-ink-3" />
      <span className="min-w-0 flex-1 truncate font-mono text-3xs text-ink-3" title={dir}>
        {dir || '读取中…'}
      </span>
      <button
        className="shrink-0 rounded-sm px-1 py-0.5 text-3xs text-ink-3 transition-colors hover:bg-hover hover:text-ink disabled:opacity-40"
        disabled={busy}
        onClick={() => void pick()}
      >
        更改
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  行
 * ------------------------------------------------------------------ */

function TabRow({ record }: { record: TransferRecord }): React.JSX.Element {
  const retry = useTransferStore((s) => s.retry)
  const reveal = useTransferStore((s) => s.reveal)
  const openDir = useTransferStore((s) => s.openDir)
  const live = isLiveRecord(record)
  const where = locateKind(record)
  const name = record.fileName || basename(record.remotePath || record.localPath) || '（未知文件）'

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
            {record.connectionName || record.target || '未知连接'}
          </span>
          <span className="shrink-0 font-mono">{live ? <LiveAmount record={record} /> : amountText(record)}</span>
          <span className="shrink-0">{formatRelativeTime(record.finishedAt ?? record.startedAt)}</span>
        </div>
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

      {/* 行内动作：平时藏起来，hover 才出现，避免 280px 宽度里全是图标 */}
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {where === 'local-file' && (
          <button className="btn-icon h-5 w-5" title="在文件管理器中显示" onClick={() => void reveal(record.localPath)}>
            <FolderOpen size={11} />
          </button>
        )}
        {where === 'local-dir' && (
          <button className="btn-icon h-5 w-5" title="打开所在文件夹" onClick={() => void openDir(record.localPath)}>
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
                ? 'trzsz / ZMODEM 由远端发起，需回终端重新操作'
                : '按原路径重试'
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

/** 活任务按 id 单独订阅：整表订阅会被每 150ms 一次的事件拖着重渲 */
function LiveAmount({ record }: { record: TransferRecord }): React.JSX.Element {
  const task = useSftpStore((s) => s.transfers.find((t) => t.id === record.id))
  if (!task) return <span title={STATUS_LABEL[record.status]}>进行中</span>
  if (task.unit === 'files') return <span>{Math.min(task.transferred, task.total)} / {task.total} 个</span>
  if (task.total <= 0) return <span>{task.speedBps ? `${Math.round(task.speedBps / 1024)} KB/s` : '计算中'}</span>
  return <span>{Math.min(100, Math.round((task.transferred / task.total) * 100))}%</span>
}

function RemoteLocate({ record }: { record: TransferRecord }): React.JSX.Element {
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
      title={online ? '在远端打开该目录' : '该连接当前未建立'}
      disabled={!online}
      onClick={onClick}
    >
      <FolderOpen size={11} />
    </button>
  )
}
