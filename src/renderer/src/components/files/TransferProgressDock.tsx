import type * as React from 'react'
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
  Ban,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  FolderOpen,
  X
} from 'lucide-react'
import type { TransferTask } from '@shared/types'
import { useSftpStore } from '@/stores/sftpStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useToastStore } from '@/stores/toastStore'
import { cn, formatBytes } from '@/lib/utils'
import { closePanelsExcept } from '@/lib/panels'
import { tNow, useI18n } from '@/i18n'

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

/**
 * 结束后定位到文件。
 *
 * 下载直接调系统的「在文件夹中显示」；上传没有本机路径，
 * 打开该连接的文件管理面板并进入远端目录 —— 主进程那条 openDir
 * 只认本机路径，所以远端定位走渲染层的 navRemote。
 */
async function revealTask(task: TransferTask): Promise<void> {
  if (task.direction === 'download') {
    await window.api.transfer.reveal(task.localPath).catch(() => undefined)
    return
  }
  const dir = task.remotePath.slice(0, task.remotePath.lastIndexOf('/')) || '/'
  const session = useSessionStore
    .getState()
    .sessions.find((s) => s.id === task.sessionId && s.status === 'connected')
  if (!session) {
    useToastStore.getState().push({
      kind: 'warning',
      title: tNow('files.ui.transfer.disconnected'),
      detail: tNow('files.ui.transfer.reconnectToOpenRemote')
    })
    return
  }
  // 互斥：浮层里点定位时，底下可能还开着传输记录/固件等面板，不关就看不见文件面板
  closePanelsExcept('sftp')
  await useSftpStore.getState().openFor(session.id, session.target)
  await useSftpStore.getState().navRemote(dir)
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
  if (seconds < 60) return tNow('files.ui.dock.etaSec', { s: Math.max(1, Math.round(seconds)) })
  if (seconds < 3600) {
    return tNow('files.ui.dock.etaMinSec', {
      m: Math.floor(seconds / 60),
      s: Math.round(seconds % 60)
    })
  }
  return tNow('files.ui.dock.etaHourMin', {
    h: Math.floor(seconds / 3600),
    m: Math.round((seconds % 3600) / 60)
  })
}

/** 传输量文案：字节任务与目录任务（文件数）分开表达 */
function amountText(task: TransferTask): { left: string; right: string } {
  if (task.unit === 'files') {
    return {
      left: tNow('files.ui.transfer.filesCount', {
        done: Math.min(task.transferred, task.total),
        total: task.total
      }),
      right: task.status === 'running' ? etaText(task) ?? '' : ''
    }
  }
  if (task.total <= 0) {
    return {
      left: task.transferred > 0 ? formatBytes(task.transferred) : tNow('files.ui.dock.waitingStart'),
      right: task.status === 'running' ? tNow('files.ui.dock.calculating') : ''
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
          ? tNow('files.ui.dock.pausedResumeHint')
          : ''
  }
}

function statusText(task: TransferTask): string {
  if (task.status === 'pending') return tNow('files.ui.transfer.status.pending')
  if (task.status === 'running') return `${taskPercent(task)}%`
  if (task.status === 'paused') return tNow('files.ui.transfer.status.paused')
  if (task.status === 'done') return tNow('files.ui.transfer.status.done')
  if (task.status === 'canceled') return tNow('files.ui.transfer.status.canceled')
  return tNow('files.ui.transfer.status.error')
}

/*
 * 传输列表硬上限（阶段 3）。原实现无上限：批量上传 500 个文件就挂 500 行 DOM，
 * 每行都订阅进度事件并参与重排。200 覆盖「一次批量传一个目录」的常见规模。
 * 超出部分不渲染行，但底部汇总数字仍按全量统计（用户看到的进度是对的）。
 */
const MAX_TRANSFERS = 200

export function TransferProgressDock(): React.JSX.Element | null {
  const { t } = useI18n()
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
        'fixed bottom-[calc(var(--size-statusbar)+8px)] right-3 z-[35] animate-slide-up',
        collapsed ? 'w-[248px]' : 'w-[380px] max-w-[calc(100vw-24px)]'
      )}
    >
      <div className="overflow-hidden rounded-lg border border-edge bg-panel shadow-pop">
        {/*
         * 标题栏：点击折叠 / 展开
         */}
        <div className="flex items-center gap-2 px-2.5 py-1.5">
          <button
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            title={collapsed ? t('files.ui.dock.expand') : t('files.ui.dock.collapse')}
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
              <AlertTriangle size={14} className="shrink-0 animate-pop-in text-danger" />
            ) : (
              <CheckCircle2 size={14} className="shrink-0 animate-pop-in text-success" />
            )}
            <span className="shrink-0 text-xs font-semibold">
              {active.length > 0
                ? pausedCount === active.length
                  ? t('files.ui.transfer.status.paused')
                  : t('files.ui.dock.transferring')
                : failed.length > 0
                  ? t('files.ui.dock.failedTitle')
                  : t('files.ui.dock.doneTitle')}
            </span>
            {active.length > 0 ? (
              <span className="truncate text-2xs text-ink-3">
                {t('files.ui.dock.activeSummary', { count: active.length, pct: overall })}
                {pausedCount > 0 && pausedCount < active.length
                  ? t('files.ui.dock.pausedSuffix', { count: pausedCount })
                  : ''}
              </span>
            ) : (
              <span className="truncate text-2xs text-ink-3">
                {t('files.ui.dock.doneSummary', { count: done.length })}
                {failed.length > 0 ? t('files.ui.dock.failedSuffix', { count: failed.length }) : ''}
              </span>
            )}
            <span className="flex-1" />
            <ChevronDown
              size={13}
              className={cn('chev-rot shrink-0 text-ink-3', collapsed && 'rotate-180')}
            />
          </button>
          <button
            className="btn-icon h-5 w-5 shrink-0"
            title={active.length > 0 ? t('files.ui.dock.hideHint') : t('files.ui.close')}
            onClick={closeDock}
          >
            <X size={12} />
          </button>
        </div>

        {/*
         * 总进度：折叠时也保留，保证任何状态下都能看到长文件进度
         */}
        {active.length > 0 && (
          <div className="h-1.5 bg-raised">
            <div
              className={cn(
                'h-full rounded-r-full transition-[width] duration-150',
                pausedCount === active.length ? 'bg-ink-3' : 'bg-accent'
              )}
              style={{ width: `${Math.max(overall, 1)}%` }}
            />
          </div>
        )}

        {!collapsed && (
          <div className="motion-reveal scroll-thin max-h-[248px] space-y-1 overflow-y-auto border-t border-edge-soft p-1.5">
            {transfers.slice(0, MAX_TRANSFERS).map((task) => (
              <TransferRow key={task.id} task={task} onDismiss={() => dismissTask(task.id)} />
            ))}
          </div>
        )}

        {!collapsed && finished && (
          <div className="flex items-center gap-2 border-t border-edge-soft px-2.5 py-1">
            <span className="flex-1 text-2xs text-ink-3">{t('files.ui.dock.queueFinished')}</span>
            <button
              className="text-2xs text-ink-3 transition-colors hover:text-ink"
              onClick={clearFinished}
            >
              {t('files.ui.dock.clearFinished')}
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
}): React.JSX.Element {
  const { t } = useI18n()
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
          title={`${task.direction === 'upload' ? t('files.ui.dock.dirUpload') : t('files.ui.dock.dirDownload')}\n${task.localPath} ⇄ ${task.remotePath}${
            task.error ? `\n${task.error}` : ''
          }${task.note ? `\n${task.note}` : ''}`}
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

        {/*
         * 传输控制：暂停 / 继续 / 终止
         */}
        {canResume && (
          <button
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-ink-3 transition-colors hover:bg-hover hover:text-accent"
            title={t('files.ui.dock.resume')}
            onClick={() => void resumeTask(task.id)}
          >
            <Play size={10} />
          </button>
        )}
        {canPause && (
          <button
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-ink-3 transition-colors hover:bg-hover hover:text-accent"
            title={t('files.ui.dock.pause')}
            onClick={() => void pauseTask(task.id)}
          >
            <Pause size={10} />
          </button>
        )}
        {canCancel && (
          <button
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-ink-3 transition-colors hover:bg-hover hover:text-danger"
            title={t('files.ui.dock.cancel')}
            onClick={() => void cancelTask(task.id)}
          >
            <Ban size={10} />
          </button>
        )}

        {/*
         * 结束后能定位就定位：下载给「在文件管理器中显示」，
         * 上传给「在远端目录打开」。进行中不给 —— 那时文件还没落成成品。
         */}
        {!isLive(task) && (
          <button
            className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-ink-3 opacity-0 transition-opacity hover:bg-hover hover:text-accent group-hover:opacity-100"
            title={task.direction === 'download' ? t('files.ui.dock.revealLocal') : t('files.ui.dock.openRemote')}
            onClick={() => void revealTask(task)}
          >
            <FolderOpen size={10} />
          </button>
        )}

        <button
          className={cn(
            'shrink-0 text-ink-3 opacity-0 transition-opacity hover:text-ink group-hover:opacity-100',
            isLive(task) ? 'invisible' : ''
          )}
          title={t('files.ui.dock.dismiss')}
          onClick={onDismiss}
        >
          <X size={10} />
        </button>
      </div>

      <div className="mt-1 h-1 overflow-hidden rounded-full bg-raised">
        <div
          className={cn(
            'h-full rounded-full transition-[width] duration-150',
            barColor,
            task.status === 'pending' && 'animate-pulse-soft'
          )}
          style={{
            width: `${task.status === 'done' ? 100 : Math.max(pct, task.status === 'running' ? 1 : 0)}%`
          }}
        />
      </div>

      <div className="mt-0.5 flex items-center gap-2 font-mono text-3xs leading-3 text-ink-3">
        <span className="min-w-0 flex-1 truncate">
          {failed ? task.error ?? t('files.ui.dock.failedTitle') : amount.left}
        </span>
        {!failed && amount.right && (
          <span className="shrink-0 whitespace-nowrap">{amount.right}</span>
        )}
      </div>

      {/*
       * 断线续传的实时状态。原来是只写进 title 提示框里 —— 传输卡住时
       * 用户根本不会去 hover，看到的就是「进度条不动了」。必须显式可见。
       */}
      {!failed && task.note && isLive(task) && (
        <div className="mt-0.5 flex items-center gap-1 text-3xs leading-3 text-warning">
          <RefreshCw size={9} className="shrink-0 animate-spin" />
          <span className="min-w-0 flex-1 truncate" title={task.note}>
            {task.note}
          </span>
        </div>
      )}
    </div>
  )
}