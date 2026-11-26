import type * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  ExternalLink,
  FolderOpen,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  X
} from 'lucide-react'
import type { TransferRecord, TransferTask } from '@shared/types'
import { cn, formatBytes, formatTime } from '@/lib/utils'
import { useOverlayEscape } from '@/lib/overlayKeys'
import { useSessionStore } from '@/stores/sessionStore'
import { useSftpStore } from '@/stores/sftpStore'
import { useTransferStore, isFailedRecord, type RecordFilter } from '@/stores/transferStore'
import { useTrzszStore } from '@/stores/trzszStore'
import { amountText, basename, locateKind, parentOf } from '@/lib/transferFormat'
import { getZmodemRecordProgress, watchZmodem, type ZmodemProgress } from '@/lib/zmodem'
import { closePanelsExcept } from '@/lib/panels'

/**
 * 传输记录面板（覆盖主区域，与其它工具面板同一套外壳）。
 *
 * 只对**已结束**的记录负责；仍在跑的记录会按 id 回查活任务拿实时数字
 * （SFTP 的 taskId 与记录 id 是同一个 uuid）。浮层负责进行中，
 * 面板负责翻旧账 —— 两边不重叠，也就不用同步状态。
 */
export function TransferPanel(): React.JSX.Element | null {
  const open = useTransferStore((s) => s.panelOpen)
  const close = (): void => useTransferStore.setState({ panelOpen: false })
  // 面板按钮上写着「关闭 (Esc)」，这里必须真的响应 Esc
  useOverlayEscape(open, close)
  if (!open) return null

  return (
    <div className="panel-shell fixed inset-x-0 z-30 flex flex-col bg-app">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3">
        <Clock size={14} className="text-accent" />
        <span className="text-xs font-semibold">传输记录</span>
        <span className="text-2xs text-ink-3">上传 / 下载 / ZMODEM 的历史账本，点行可定位文件</span>
        <span className="flex-1" />
        <button className="btn-icon" title="关闭 (Esc)" onClick={close}>
          <X size={14} />
        </button>
      </div>
      <Body />
    </div>
  )
}

const FILTERS: Array<{ key: RecordFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'upload', label: '上传' },
  { key: 'download', label: '下载' },
  { key: 'failed', label: '失败' }
]

function Body(): React.JSX.Element {
  const records = useTransferStore((s) => s.records)
  const loading = useTransferStore((s) => s.loading)
  const filter = useTransferStore((s) => s.filter)
  const keyword = useTransferStore((s) => s.keyword)
  const setFilter = useTransferStore((s) => s.setFilter)
  const setKeyword = useTransferStore((s) => s.setKeyword)
  const load = useTransferStore((s) => s.load)

  /*
   * 面板算一个「正在看的视图」：主进程只在记录变更时发信号，
   * transferStore 靠这个计数决定要不要跟着重拉（侧栏 Tab 也会挂一个）。
   */
  useEffect(() => {
    useTransferStore.getState().attachView()
    if (!useTransferStore.getState().loaded) void load()
    return () => useTransferStore.getState().detachView()
  }, [load])

  const shown = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    return records.filter((r) => {
      if (filter === 'upload' && r.direction !== 'upload') return false
      if (filter === 'download' && r.direction !== 'download') return false
      if (filter === 'failed' && !isFailedRecord(r)) return false
      if (!kw) return true
      return [r.fileName, r.localPath, r.remotePath, r.connectionName, r.target]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(kw))
    })
  }, [records, filter, keyword])

  const counts = useMemo(
    () => ({
      live: records.filter((r) => r.status === 'running' || r.status === 'pending').length,
      failed: records.filter(isFailedRecord).length
    }),
    [records]
  )

  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-1.5">
        <div className="flex items-center gap-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={cn('seg-item', filter === f.key && 'seg-item-active')}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              {f.key === 'failed' && counts.failed > 0 && (
                <span className="font-mono text-3xs text-danger">{counts.failed}</span>
              )}
              {f.key === 'all' && counts.live > 0 && (
                <span className="font-mono text-3xs text-accent">{counts.live}</span>
              )}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <div className="relative">
          <Search
            size={11}
            className="pointer-events-none absolute left-1.5 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            className="input h-6 w-56 pl-6 text-2xs"
            placeholder="筛选文件名 / 路径 / 连接"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <button
          className="btn-icon"
          title="重新读取"
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw size={12} className={cn(loading && 'animate-spin')} />
        </button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-1.5 text-center">
            <Clock size={22} className="text-ink-3/40" />
            <div className="text-xs text-ink-2">
              {records.length === 0 ? '还没有传输记录' : '没有符合条件的记录'}
            </div>
            <div className="max-w-[320px] text-2xs leading-relaxed text-ink-3">
              记录只在传输开始与结束时各写一条；进度不落盘，所以这里看不到中间过程。
            </div>
          </div>
        ) : (
          <div className="divide-y divide-edge-soft">
            {shown.map((r) => (
              <RecordRow key={r.id} record={r} />
            ))}
          </div>
        )}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ *
 *  行
 * ------------------------------------------------------------------ */

function RecordRow({ record }: { record: TransferRecord }): React.JSX.Element {
  const expanded = useTransferStore((s) => s.expanded === record.id)
  const toggleExpanded = useTransferStore((s) => s.toggleExpanded)
  const retry = useTransferStore((s) => s.retry)
  const reveal = useTransferStore((s) => s.reveal)
  const openDir = useTransferStore((s) => s.openDir)

  const live = record.status === 'running' || record.status === 'pending'
  const hasDetail = (record.failures?.length ?? 0) > 0
  const name = record.fileName || basename(record.remotePath || record.localPath) || '（未知文件）'
  const where = locateKind(record)

  return (
    <div className="px-3 py-1.5 transition-colors hover:bg-raised/40">
      <div className="flex items-center gap-2">
        {/* 展开箭头：有明细才可点，没有就留白保持对齐 */}
        {hasDetail ? (
          <button
            className="flex w-3 shrink-0 items-center text-ink-3 hover:text-ink"
            title={expanded ? '收起失败明细' : '展开失败明细'}
            onClick={() => toggleExpanded(record.id)}
          >
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        ) : (
          <span className="w-3 shrink-0" aria-hidden />
        )}

        {record.direction === 'upload' ? (
          <ArrowUpFromLine size={12} className="shrink-0 text-accent" />
        ) : (
          <ArrowDownToLine size={12} className="shrink-0 text-success" />
        )}

        <span className="min-w-0 flex-[2] truncate text-xs text-ink" title={name}>
          {name}
        </span>

        <span className="min-w-0 flex-1 truncate text-2xs text-ink-3" title={record.target ?? ''}>
          {record.connectionName || record.target || '未知连接'}
        </span>

        <span className="w-24 shrink-0 font-mono text-3xs text-ink-3">
          {formatTime(record.finishedAt ?? record.startedAt)}
        </span>

        {live ? (
          <LiveAmount record={record} />
        ) : (
          <span className="w-24 shrink-0 text-right font-mono text-3xs text-ink-3">
            {amountText(record)}
          </span>
        )}

        <StatusChip record={record} />

        {/* 定位：能定位就实心按钮，不能就直说，不猜路径 */}
        {where === 'local-file' && (
          <button
            className="btn-icon"
            title="在文件管理器中显示"
            onClick={() => void reveal(record.localPath)}
          >
            <ExternalLink size={11} />
          </button>
        )}
        {where === 'local-dir' && (
          <button
            className="btn-icon"
            title="打开所在文件夹"
            onClick={() => void openDir(record.localPath)}
          >
            <FolderOpen size={11} />
          </button>
        )}
        {where === 'remote' && <RemoteLocate record={record} />}
        {where === 'none' && (
          <span className="shrink-0 text-3xs text-ink-3/70" title="这条传输没有记录可定位的路径">
            原始位置未记录
          </span>
        )}

        {!live && (
          <button
            className="btn-icon disabled:opacity-30"
            /** 只有 SFTP 能按原路径重放；trzsz / ZMODEM 由对端发起，重试有意义的是提示用户回终端 */
            disabled={record.via !== 'sftp'}
            title={
              record.via !== 'sftp'
                ? 'trzsz / ZMODEM 由远端发起，需回终端重新操作'
                : record.retriedBy
                  ? `已被新任务重试过（${record.retriedBy}）`
                  : '按原路径重试'
            }
            onClick={() => void retry(record)}
          >
            <RotateCcw size={11} />
          </button>
        )}
      </div>

      {record.retriedBy && (
        <div className="mt-0.5 pl-[38px] text-3xs text-ink-3">
          已被新任务重试 → {record.retriedBy}
        </div>
      )}

      {record.status === 'error' && record.error && (
        <div className="mt-0.5 flex items-start gap-1 pl-[38px] text-3xs leading-4 text-danger">
          <AlertTriangle size={9} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1">{record.error}</span>
        </div>
      )}

      {record.note && !record.error && (
        <div className="mt-0.5 pl-[38px] text-3xs leading-4 text-warning">{record.note}</div>
      )}

      {expanded && hasDetail && <FailureDetails record={record} />}
    </div>
  )
}

/**
 * 进行中的那一行的进度。
 *
 * 只有这一行订阅 transfers：整表订阅会在每 150ms 一次的事件里换掉数组引用，
 * 500 行整表重渲。记录里的 status 是 running 就说明一定有活任务在跑，
 * 但重启后/渲染层重载后它已经不在内存里了 —— 那种情况明确写「进度未知」，
 * 不要画一个假的 0%。
 */
function LiveAmount({ record }: { record: TransferRecord }): React.JSX.Element {
  const task = useSftpStore((s) =>
    record.via === 'sftp' ? s.transfers.find((t) => t.id === record.id) : undefined
  )
  /*
   * trzsz 的进度只存在于远端重绘的进度条里，落不成字节。它按会话下发，
   * 所以这里按 sessionId 取那一条 —— 同样只在本次运行内有效。
   */
  const trzsz = useTrzszStore((s) => (record.sessionId ? s.bySession[record.sessionId] : undefined))
  const zmSessionId = record.via === 'zmodem' ? record.sessionId : undefined
  const [zm, setZm] = useState<ZmodemProgress | null>(() =>
    zmSessionId ? getZmodemRecordProgress(zmSessionId, record.id) : null
  )
  useEffect(() => {
    if (!zmSessionId) {
      setZm(null)
      return
    }
    setZm(getZmodemRecordProgress(zmSessionId, record.id))
    return watchZmodem(zmSessionId, (p) => {
      if (p.transferId !== record.id) return
      setZm(p.phase === 'active' ? p : null)
    })
  }, [zmSessionId, record.id])
  if (record.via === 'zmodem' && zm) {
    const pct = zm.bytesTotal > 0 ? Math.min(100, Math.round((zm.bytesDone / zm.bytesTotal) * 100)) : 0
    const batch = zm.fileCount && zm.fileCount > 1 ? `${zm.fileIndex ?? 1}/${zm.fileCount} · ` : ''
    return (
      <span className="w-24 shrink-0 text-right font-mono text-3xs text-accent">
        {batch}{zm.bytesTotal > 0 ? `${pct}%` : formatBytes(zm.bytesDone)}
      </span>
    )
  }
  if (record.via === 'trzsz' && trzsz) {
    const total = trzsz.files?.total
    const index = trzsz.files?.index
    const text =
      total && index ? `${index} / ${total} 个文件` : trzsz.percent !== undefined ? `${trzsz.percent}%` : '进行中'
    return (
      <span className="w-24 shrink-0 text-right font-mono text-3xs text-accent" title={trzsz.file ?? ''}>
        {text}
      </span>
    )
  }
  if (!task) {
    return (
      <span className="w-24 shrink-0 text-right text-3xs text-ink-3" title="进程已重启或记录来自上次会话">
        进行中 · 进度未知
      </span>
    )
  }
  return (
    <span className="w-24 shrink-0 text-right font-mono text-3xs text-accent">
      {progressText(task)}
    </span>
  )
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
    /*
     * 必须关自己：传输面板与文件面板同为面板层、按 App.tsx 的挂载顺序
     * 排在最后，不关就永远盖在刚打开的文件面板上面，「定位」看着没反应。
     * 关在打开之前 —— 先开再关会让文件面板闪一帧到下面去。
     */
    closePanelsExcept('sftp')
    void useSftpStore.getState().openFor(session.id, session.target).then(() => {
      if (dir) void useSftpStore.getState().navRemote(dir)
    })
  }
  return (
    <button
      className="btn-icon disabled:opacity-40"
      title={online ? '打开文件管理并进入该目录' : '该连接当前未建立'}
      disabled={!online}
      onClick={onClick}
    >
      <FolderOpen size={11} />
    </button>
  )
}

function FailureDetails({ record }: { record: TransferRecord }): React.JSX.Element {
  return (
    <div className="ml-[38px] mt-1 space-y-1 rounded-sm bg-raised/60 p-1.5">
      <div className="text-3xs text-ink-3">
        共 {record.failureCount ?? 0} 个文件失败，按原因归并：
      </div>
      {(record.failures ?? []).map((g) => (
        <div key={g.message} className="text-3xs leading-4">
          <div className="text-ink-2">
            {g.message}：{g.count} 个文件
          </div>
          <div className="mt-0.5 space-y-0.5 pl-2 font-mono text-ink-3">
            {g.sample.slice(0, 50).map((p) => (
              <div key={p} className="truncate" title={p}>
                {p}
              </div>
            ))}
            {g.count > g.sample.length && (
              <div className="text-ink-3/70">还有 {g.count - g.sample.length} 个未列出</div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  纯函数
 * ------------------------------------------------------------------ */

function StatusChip({ record }: { record: TransferRecord }): React.JSX.Element {
  const map: Record<TransferRecord['status'], { label: string; cls: string; icon: React.JSX.Element }> = {
    pending: { label: '排队中', cls: 'text-ink-3', icon: <Loader2 size={10} /> },
    running: { label: '进行中', cls: 'text-accent', icon: <Loader2 size={10} className="animate-spin" /> },
    done: { label: '完成', cls: 'text-success', icon: <CheckCircle2 size={10} /> },
    error: { label: '失败', cls: 'text-danger', icon: <AlertTriangle size={10} /> },
    canceled: { label: '已取消', cls: 'text-ink-3', icon: <Ban size={10} /> },
    interrupted: { label: '已中断', cls: 'text-warning', icon: <AlertTriangle size={10} /> }
  }
  const m = map[record.status]
  return (
    <span className={cn('flex w-14 shrink-0 items-center gap-0.5 text-3xs', m.cls)}>
      {m.icon}
      {m.label}
    </span>
  )
}

function progressText(t: TransferTask): string {
  if (t.unit === 'files') return `${Math.min(t.transferred, t.total)} / ${t.total} 个文件`
  if (t.total <= 0) return t.speedBps ? `${formatBytes(t.speedBps)}/s` : '计算中…'
  const pct = Math.min(100, Math.round((t.transferred / t.total) * 100))
  return `${pct}%${t.speedBps ? ` · ${formatBytes(t.speedBps)}/s` : ''}`
}


