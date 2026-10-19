import { ArrowDownToLine, ArrowUpFromLine, Unplug } from 'lucide-react'
import type { ConnStatus } from '@shared/types'
import { useSessionStore } from '@/stores/sessionStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { useSftpStore } from '@/stores/sftpStore'
import { cn, latencyLevel } from '@/lib/utils'

const STATUS_TEXT: Record<ConnStatus, string> = {
  connecting: '连接中',
  connected: '已连接',
  disconnected: '已断开',
  error: '连接错误'
}

const STATUS_DOT: Record<ConnStatus, string> = {
  connecting: 'bg-warning animate-pulse-soft',
  connected: 'bg-success',
  disconnected: 'bg-ink-3',
  error: 'bg-danger'
}

const LATENCY_CLS = {
  none: 'text-ink-3',
  good: 'text-success',
  fair: 'text-warning',
  bad: 'text-danger'
} as const

/** 底部状态栏：连接状态 / 会话名 / 延迟 / 编码 / 终端尺寸 */
export function StatusBar(): JSX.Element {
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === s.activeId) ?? null)
  const count = useSessionStore((s) => s.sessions.length)
  const savedCount = useConnectionStore((s) => s.connections.length)
  const transfers = useSftpStore((s) => s.transfers)
  const showDock = useSftpStore((s) => s.showDock)

  const active = transfers.filter((t) => t.status === 'running' || t.status === 'pending')
  const activeKnownTotal = active.reduce((sum, t) => sum + (t.total > 0 ? t.total : 0), 0)
  const activeKnownDone = active.reduce(
    (sum, t) => sum + (t.total > 0 ? Math.min(t.transferred, t.total) : 0),
    0
  )
  const activePct =
    activeKnownTotal > 0
      ? Math.round((activeKnownDone / activeKnownTotal) * 100)
      : active.length > 0
        ? Math.round(
            (active.reduce(
              (sum, t) => sum + (t.total > 0 ? Math.min(t.transferred / t.total, 1) : 0),
              0
            ) /
              active.length) *
              100
          )
        : 0

  return (
    <div className="flex h-[26px] shrink-0 items-center gap-3 border-t border-edge-soft bg-panel px-3 text-2xs text-ink-3">
      {session ? (
        <>
          <span className="flex items-center gap-1.5">
            <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[session.status])} />
            <span className="text-ink-2">{STATUS_TEXT[session.status]}</span>
          </span>

          <span className="text-edge">|</span>
          <span className="max-w-[260px] truncate text-ink-2">
            {session.title}
            <span className="ml-1.5 text-ink-3">
              {session.username}@{session.host}
            </span>
          </span>

          {session.latencyMs !== undefined && session.status === 'connected' && (
            <>
              <span className="text-edge">|</span>
              <span className={cn('font-mono', LATENCY_CLS[latencyLevel(session.latencyMs)])}>
                {session.latencyMs} ms
              </span>
            </>
          )}
        </>
      ) : (
        <span className="flex items-center gap-1.5">
          <Unplug size={11} />
          未连接
          {savedCount > 0 && <span className="text-ink-3/80">· 已保存 {savedCount} 个连接</span>}
        </span>
      )}

      <span className="flex-1" />

      {active.length > 0 && (
        <>
          <button
            className="flex items-center gap-1 rounded px-1 py-0.5 text-accent transition-colors hover:bg-hover"
            title="查看传输进度"
            onClick={showDock}
          >
            {active[0].direction === 'upload' ? (
              <ArrowUpFromLine size={10} />
            ) : (
              <ArrowDownToLine size={10} />
            )}
            <span>
              {active.length} 项 · {activePct}%
            </span>
          </button>
          <span className="text-edge">|</span>
        </>
      )}

      {count > 1 && <span>共 {count} 个会话</span>}
      <span className="text-edge">|</span>
      <span>UTF-8</span>
      <span className="text-edge">|</span>
      <span className="font-mono">{session ? `${session.cols}×${session.rows}` : '—'}</span>
    </div>
  )
}
