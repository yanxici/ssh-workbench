/**
 * 全局传输进度浮层。
 *
 * 文件树 / 双栏面板 / 拖拽触发的上传下载都走同一条 SFTP 队列，这里统一展示：
 * - 右下角常驻（不依赖文件管理面板是否打开），新任务开始时自动重新出现；
 * - 单文件显示字节进度、实时速度与剩余时间，长文件一眼能看出还要多久；
 * - 目录传输按"已完成文件数 / 总文件数"显示，不把文件数误当字节数；
 * - 每个任务都能暂停 / 继续 / 终止：主进程在分块边界检查控制标志，
 *   终止后本地半截文件会被清理；
 * - 全部结束后保留几秒再自动消失，失败记录保留更久，可单条移除；
 * - 折叠后仍保留总进度条，底部状态栏另有入口。
 */

import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Ban,
  Loader2,
  Pause,
  Play,
  X
} from 'lucide-react'
import type { TransferTask } from '@shared/types'
import { useSftpStore } from '@/stores/sftpStore'
import { cn, formatBytes } from '@/lib/utils'

/** 超过该大小或持续该时长，才认为值得弹出进度浮层（避免小文件一闪而过） */
const LONG_TASK_BYTES = 8 * 1024 * 1024
const LONG_TASK_MS = 1200

/** 仍在队列里的状态（paused 不是终态，计时清空时必须算作活动） */
const LIVE: TransferTask['status'][] = ['pending', 'running', 'paused']

function isLive(task: TransferTask): boolean {
  return LIVE.includes(task.status)
}

function fileName(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? p
}

function taskPercent(task: TransferTask): number {
  if (task.status === 'done') return 100
  if (task.total <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((task.transferred / task.total) * 100)))
}

function etaText(task: TransferTask): string | null {
  if (task.status !== 'running' || !task.speedBps || task.speedBps <= 0) return null
  if (task.total <= 0 || task.transferred >= task.total) return null
  const seconds = (task.total - task.transferred) / task.speedBps
  if (!Number.isFinite(seconds) || seconds <= 0) return null
  if (seconds < 60) return `剩余 ${Math.max(1, Math.round(seconds))} 秒`
  if (seconds < 3600) return `剩余 ${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`
  return `剩余 ${Math.floor(seconds / 3600)} 小时 ${Math.round((seconds % 3600) / 60)} 分`
}

/** 传输量文案：字节任务与目录任务（文件数）分开表达 */
function amountText(task: TransferTask): { left: string; right: string } {
  if (task.unit === 'files') {
    return {
      left: `${Math.min(task.transferred, task.total)} / ${task.total} 个文件`,
      right: task.status === 'running' ? etaText(task) ?? '' : ''
    }
  }
  if (task.total <= 0) {
    return {
      left: task.transferred > 0 ? formatBytes(task.transferred) : '等待开始',
      right: task.status === 'running' ? '计算中…' : ''
    }
  }
  return {
    left: `${formatBytes(task.transferred)} / ${formatBytes(task.total)}`,
    right:
      task.status === 'running'
        ? [task.speedBps ? `${formatBytes(task.speedBps)}/s` : null, etaText(task)]
            .filter(Boolean)
            .join(' · ')
        : task.status === 'paused'
          ? '已暂停，可继续'
          : ''
  }
}

function statusText(task: TransferTask): string {
  if (task.status === 'pending') return '排队中'
  if (task.status === 'running') return `${taskPercent(task)}%`
  if (task.status === 'paused') return '已暂停'
  if (task.status === 'done') return '完成'
  if (task.status === 'canceled') return '已取消'
  return '失败'
}

export function TransferProgressDock(): JSX.Element | null {
  const transfers = useSftpStore((s) => s.transfers)
  const collapsed = useSftpStore((s) => s.dockCollapsed)
  const closed = useSftpStore((s) => s.dockClosed)
  const setCollapsed = useSftpStore((s) => s.setDockCollapsed)
  const closeDock = useSftpStore((s) => s.closeDock)
  const clearFinished = useSftpStore((s) => s.clearFinished)
  const dismissTask = useSftpStore((s) => s.dismissTask)

  /** 是否已经见过"值得展示"的传输（长文件或持续超过 1.2 秒） */
  const [worthShowing, setWorthShowing] = useState(false)

  const active = transfers.filter(isLive)
  const failed = transfers.filter((t) => t.status === 'error')
  const done = transfers.filter((t) => t.status === 'done')
  const pausedCount = transfers.filter((t) => t.status === 'paused').length

  // 总进度按"已完成量 / 总已知量"加权：排队中(total 未知)的任务不会把比例拉到 0%，
  // 也不会出现主文件 57% 而标题写 28% 的割裂感。
  const knownTotal = active.reduce((sum, t) => sum + (t.total > 0 ? t.total : 0), 0)
  const knownDone = active.reduce(
    (sum, t) => sum + (t.total > 0 ? Math.min(t.transferred, t.total) : 0),
    0
  )
  const overall =
    knownTotal > 0
      ? Math.round((knownDone / knownTotal) * 100)
      : active.length > 0
        ? Math.round(
            (active.reduce((sum, t) => sum + taskPercent(t) / 100, 0) / active.length) * 100
          )
        : 100

  // 大文件立即展示；小文件若拖过 1.2 秒也展示（说明网络慢，用户需要看到进度）
  useEffect(() => {
    if (worthShowing) return
    if (transfers.length === 0) return
    const now = Date.now()
    const isLong = transfers.some((t) => isLive(t) && (t.total >= LONG_TASK_BYTES || now - t.startedAt >= LONG_TASK_MS))
    if (isLong) {
      setWorthShowing(true)
      return
    }
    const pending = transfers.filter(isLive)
    if (pending.length === 0) return
    const remain = Math.min(
      ...pending.map((t) => Math.max(0, LONG_TASK_MS - (Date.now() - t.startedAt)))
    )
    const timer = setTimeout(() => setWorthShowing(true), remain)
    return () => clearTimeout(timer)
  }, [transfers, worthShowing])

  useEffect(() => {
    if (transfers.length === 0) setWorthShowing(false)
  }, [transfers])

  // 全部结束后自动收起：成功保留 5 秒，失败保留 12 秒方便看原因。
  // 暂停中的任务不算结束，否则浮层会在暂停期间自己消失。
  useEffect(() => {
    if (transfers.length === 0) return
    if (transfers.some(isLive)) return
    const t = setTimeout(
      () => clearFinished(),
      transfers.some((x) => x.status === 'error') ? 12000 : 5000
    )
    return () => clearTimeout(t)
  }, [transfers, clearFinished])

  if (closed) return null
  if (transfers.length === 0) return null
  // 小文件速传不弹层，避免进度条一闪而过
  if (!worthShowing && active.length === 0) return null

  const finished = active.length === 0

  return (
    <div
      className={cn(
        'fixed bottom-[34px] right-3 z-[35] animate-slide-up',
        collapsed ? 'w-[250px]' : 'w-[380px] max-w-[calc(100vw-24px)]'
      )}
    >
      <div className="overflow-hidden rounded-lg border border-edge bg-panel/95 shadow-pop backdrop-blur">
        {/* 标题栏：点击折叠 / 展开 */}
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          <button
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            title={collapsed ? '展开传输进度' : '折叠传输进度'}
            onClick={() => setCollapsed(!collapsed)}
          >
            {active.length > 0 ? (
              <Loader2
                size={14}
                className={cn(
                  'shrink-0 text-accent',
                  pausedCount === active.length ? '' : 'animate-spin'
                )}
              />
            ) : failed.length > 0 ? (
              <AlertTriangle size={14} className="shrink-0 text-danger" />
            ) : (
              <CheckCircle2 size={14} className="shrink-0 text-success" />
            )}
            <span className="shrink-0 text-xs font-semibold">
              {active.length > 0
                ? pausedCount === active.length
                  ? '已暂停'
                  : '传输中'
                : failed.length > 0
                  ? '传输失败'
                  : '传输完成'}
            </span>
            {active.length > 0 ? (
              <span className="truncate text-2xs text-ink-3">
                {active.length} 项 · {overall}%
                {pausedCount > 0 && pausedCount < active.length
                  ? ` · ${pausedCount} 项暂停`
                  : ''}
              </span>
            ) : (
              <span className="truncate text-2xs text-ink-3">
                {done.length} 个完成{failed.length > 0 ? ` · ${failed.length} 个失败` : ''}
              </span>
            )}
            <span className="flex-1" />
            {collapsed ? (
              <ChevronUp size={13} className="shrink-0 text-ink-3" />
            ) : (
              <ChevronDown size={13} className="shrink-0 text-ink-3" />
            )}
          </button>
          <button
            className="btn-icon h-5 w-5 shrink-0"
            title={active.length > 0 ? '隐藏浮层（传输继续，可在状态栏重新打开）' : '关闭'}
            onClick={closeDock}
          >
            <X size={12} />
          </button>
        </div>

        {/* 总进度：折叠时也保留，保证任何状态下都能看到长文件进度 */}
        {active.length > 0 && (
          <div className="h-1.5 bg-raised">
            <div
              className={cn(
                'h-full rounded-r-full transition-[width] duration-200',
                pausedCount === active.length ? 'bg-ink-3' : 'bg-accent'
              )}
              style={{ width: `${Math.max(overall, 1)}%` }}
            />
          </div>
        )}

        {!collapsed && (
          <div className="scroll-thin max-h-[248px] space-y-1 overflow-y-auto border-t border-edge-soft p-1.5">
            {transfers.map((task) => (
              <TransferRow key={task.id} task={task} onDismiss={() => dismissTask(task.id)} />
            ))}
          </div>
        )}

        {!collapsed && finished && (
          <div className="flex items-center gap-2 border-t border-edge-soft px-2.5 py-1">
            <span className="flex-1 text-2xs text-ink-3">传输队列已结束</span>
            <button
              className="text-2xs text-ink-3 transition-colors hover:text-ink"
              onClick={clearFinished}
            >
              清除记录
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

function TransferRow({
  task,
  onDismiss
}: {
  task: TransferTask
  onDismiss: () => void
}): JSX.Element {
  const pauseTask = useSftpStore((s) => s.pauseTask)
  const resumeTask = useSftpStore((s) => s.resumeTask)
  const cancelTask = useSftpStore((s) => s.cancelTask)

  const pct = taskPercent(task)
  const name = fileName(task.direction === 'upload' ? task.localPath : task.remotePath)
  const amount = amountText(task)
  const failed = task.status === 'error'
  const paused = task.status === 'paused'
  const canPause = task.status === 'running'
  const canResume = paused
  const canCancel = isLive(task)

  const barColor = failed
    ? 'bg-danger'
    : task.status === 'done'
      ? 'bg-success'
      : task.status === 'canceled'
        ? 'bg-ink-3/50'
        : paused
          ? 'bg-ink-3'
          : task.status === 'pending'
            ? 'bg-ink-3/60'
            : 'bg-accent'

  return (
    <div className="group rounded-md px-1.5 py-1 transition-colors hover:bg-raised/60">
      <div className="flex items-center gap-1.5">
        {task.direction === 'upload' ? (
          <ArrowUpFromLine size={11} className="shrink-0 text-accent" />
        ) : (
          <ArrowDownToLine size={11} className="shrink-0 text-success" />
        )}
        <span
          className="min-w-0 flex-1 truncate text-2xs text-ink-2"
          title={`${task.direction === 'upload' ? '上传' : '下载'}\n${task.localPath} ⇄ ${task.remotePath}${
            task.error ? `\n${task.error}` : ''
          }`}
        >
          {name}
        </span>
        <span
          className={cn(
            'shrink-0 font-mono text-2xs',
            failed
              ? 'text-danger'
              : task.status === 'done'
                ? 'text-success'
                : paused
                  ? 'text-warning'
                  : 'text-ink-3'
          )}
        >
          {statusText(task)}
        </span>

        {/* 传输控制：暂停 / 继续 / 终止 */}
        {canResume && (
          <button
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-ink-3 transition-colors hover:bg-hover hover:text-accent"
            title="继续传输"
            onClick={() => void resumeTask(task.id)}
          >
            <Play size={10} />
          </button>
        )}
        {canPause && (
          <button
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-ink-3 transition-colors hover:bg-hover hover:text-accent"
            title="暂停传输"
            onClick={() => void pauseTask(task.id)}
          >
            <Pause size={10} />
          </button>
        )}
        {canCancel && (
          <button
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-ink-3 transition-colors hover:bg-hover hover:text-danger"
            title="终止传输（已传输的部分会丢弃）"
            onClick={() => void cancelTask(task.id)}
          >
            <Ban size={10} />
          </button>
        )}

        <button
          className={cn(
            'shrink-0 text-ink-3 opacity-0 transition-opacity hover:text-ink group-hover:opacity-100',
            isLive(task) ? 'invisible' : ''
          )}
          title="从列表移除"
          onClick={onDismiss}
        >
          <X size={10} />
        </button>
      </div>

      <div className="mt-1 h-1 overflow-hidden rounded-full bg-raised">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-200',
            barColor,
            task.status === 'pending' && 'animate-pulse-soft'
          )}
          style={{
            width: `${task.status === 'done' ? 100 : Math.max(pct, task.status === 'running' ? 1 : 0)}%`
          }}
        />
      </div>

      <div className="mt-0.5 flex items-center gap-2 font-mono text-[10px] leading-3 text-ink-3">
        <span className="min-w-0 flex-1 truncate">
          {failed ? task.error ?? '传输失败' : amount.left}
        </span>
        {!failed && amount.right && (
          <span className="shrink-0 whitespace-nowrap">{amount.right}</span>
        )}
      </div>
    </div>
  )
}
