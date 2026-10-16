import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, FolderTree, X } from 'lucide-react'
import type { TransferTask } from '@shared/types'
import { useSftpStore } from '@/stores/sftpStore'
import { cn, formatBytes } from '@/lib/utils'
import { LocalPane } from './LocalPane'
import { RemotePane } from './RemotePane'

/**
 * SFTP 文件管理面板（覆盖主区域的双栏视图）。
 * 左：本地文件系统；右：远端设备文件系统；中间：上传/下载按钮；底部：传输队列。
 */
export function FileManagerPanel(): JSX.Element | null {
  const open = useSftpStore((s) => s.open)
  const sessionTitle = useSftpStore((s) => s.sessionTitle)
  const close = useSftpStore((s) => s.close)
  const localSel = useSftpStore((s) => s.localSel)
  const remoteSel = useSftpStore((s) => s.remoteSel)
  const uploadPaths = useSftpStore((s) => s.uploadPaths)
  const downloadPaths = useSftpStore((s) => s.downloadPaths)
  const transfers = useSftpStore((s) => s.transfers)

  if (!open) return null

  return (
    <div className="fixed inset-x-0 bottom-[26px] top-[38px] z-30 flex flex-col bg-app">
      {/* 标题栏 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3">
        <FolderTree size={14} className="text-accent" />
        <span className="text-xs font-semibold">文件管理</span>
        <span className="max-w-[280px] truncate text-2xs text-ink-3">{sessionTitle}</span>
        <span className="flex-1" />
        <span className="hidden truncate text-2xs text-ink-3 lg:block">
          双击目录进入 · 双击远程文件编辑 · 拖拽两侧互相传输
        </span>
        <button className="btn-icon" title="关闭 (Esc)" onClick={close}>
          <X size={14} />
        </button>
      </div>

      {/* 双栏 + 中间操作列 */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <LocalPane />
        </div>

        <div className="flex w-[52px] shrink-0 flex-col items-center justify-center gap-3 border-x border-edge-soft bg-panel/50">
          <button
            className="btn-icon h-8 w-8"
            title={`上传选中项到右侧目录（已选 ${localSel.length}）`}
            disabled={localSel.length === 0}
            onClick={() => void uploadPaths(localSel)}
          >
            <ArrowRight size={16} />
          </button>
          <button
            className="btn-icon h-8 w-8"
            title={`下载选中项到左侧目录（已选 ${remoteSel.length}）`}
            disabled={remoteSel.length === 0}
            onClick={() => void downloadPaths(remoteSel)}
          >
            <ArrowLeft size={16} />
          </button>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <RemotePane />
        </div>
      </div>

      {transfers.length > 0 && <TransferQueue />}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  传输队列
 * ------------------------------------------------------------------ */

function TransferQueue(): JSX.Element {
  const transfers = useSftpStore((s) => s.transfers)
  const clearFinished = useSftpStore((s) => s.clearFinished)
  const running = transfers.filter((t) => t.status === 'running' || t.status === 'pending').length

  return (
    <div className="shrink-0 border-t border-edge bg-panel/70 px-3 pb-2 pt-1.5">
      <div className="mb-1 flex items-center gap-2">
        <span className="text-2xs font-semibold text-ink-2">传输队列</span>
        {running > 0 && <span className="text-2xs text-accent">{running} 个进行中</span>}
        <span className="flex-1" />
        <button
          className="text-2xs text-ink-3 transition-colors hover:text-ink"
          onClick={clearFinished}
        >
          清除已完成
        </button>
      </div>
      <div className="scroll-thin max-h-[110px] space-y-1 overflow-y-auto pr-1">
        {transfers.map((t) => (
          <TransferRow key={t.id} task={t} />
        ))}
      </div>
    </div>
  )
}

function TransferRow({ task }: { task: TransferTask }): JSX.Element {
  const pct = task.total > 0 ? Math.round((task.transferred / task.total) * 100) : 0
  const name =
    task.direction === 'upload'
      ? (task.localPath.split(/[\\/]/).pop() ?? task.localPath)
      : (task.remotePath.split('/').pop() ?? task.remotePath)

  return (
    <div className="flex items-center gap-2 text-2xs">
      {task.direction === 'upload' ? (
        <ArrowUp size={11} className="shrink-0 text-accent" />
      ) : (
        <ArrowDown size={11} className="shrink-0 text-success" />
      )}
      <span
        className="w-[200px] shrink-0 truncate text-ink-2"
        title={task.direction === 'upload' ? task.localPath : task.remotePath}
      >
        {name}
      </span>
      <div className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-raised">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-200',
            task.status === 'error'
              ? 'bg-danger'
              : task.status === 'done'
                ? 'bg-success'
                : 'bg-accent'
          )}
          style={{ width: `${task.status === 'done' ? 100 : pct}%` }}
        />
      </div>
      <span className="w-[190px] shrink-0 text-right font-mono text-ink-3">
        {task.status === 'pending' && '排队中'}
        {task.status === 'running' &&
          `${pct}%${task.speedBps ? ` · ${formatBytes(task.speedBps)}/s` : ''}`}
        {task.status === 'done' && `完成 · ${task.total > 0 ? formatBytes(task.total) : ''}`}
        {task.status === 'error' && (
          <span className="text-danger" title={task.error}>
            失败：{task.error?.slice(0, 36)}
          </span>
        )}
      </span>
    </div>
  )
}
