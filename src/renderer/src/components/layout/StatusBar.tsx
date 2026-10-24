import { useEffect, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleDot,
  GitBranch,
  Unplug
} from 'lucide-react'
import type { ConnStatus } from '@shared/types'
import { useSessionById, useSessionStore } from '@/stores/sessionStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { useSftpStore } from '@/stores/sftpStore'
import { call } from '@/lib/ipc'
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

/**
 * 状态栏分隔符。
 *
 * 原来写的是 `<span className="text-edge">|</span>` —— 用文字竖线假装分割线。
 * 问题是这个字符在字体的中线偏上、宽度随字号变化，相邻项一多就出现
 * 高低不齐的「锯齿」。改成 1px×9px 的纯色方块，垂直居中由 flex 保证。
 */
function Sep(): JSX.Element {
  return <span className="h-[9px] w-px shrink-0 bg-edge" />
}

/**
 * 底部状态栏（28px，浅灰底 + 极细上边框）。
 *
 * 左：SSH 连接状态 · 会话名 · 延迟 · Git 分支
 * 右：传输进度 · 编码 · 换行符 · Shell · 终端尺寸
 *
 * Git 分支的获取方式：在活动会话上跑一次 `git rev-parse --abbrev-ref HEAD`。
 * 不能每次渲染都问，所以按 sessionId 缓存，并在切换活动会话时才重查。
 * 非 Git 目录 / 未连接时静默不显示 —— 这里不该出现「not a git repository」这种噪音。
 */
export function StatusBar(): JSX.Element {
  const activeId = useSessionStore((s) => s.activeId)
  // 只订阅当前会话本身；旧写法会在任意会话变化时重跑 find
  const session = useSessionById(activeId)
  const count = useSessionStore((s) => s.sessions.length)
  // 延迟单独从 latencyById 取：只有这里会因延迟变化重渲染，
  // 不会像旧实现那样把整个 sessions 数组换掉、连带终端全量重跑
  const latencyMs = useSessionStore((s) => (s.activeId ? s.latencyById[s.activeId] : undefined))
  const savedCount = useConnectionStore((s) => s.connections.length)
  const transfers = useSftpStore((s) => s.transfers)
  const showDock = useSftpStore((s) => s.showDock)

  const sessionId = session?.id ?? null
  const connected = session?.status === 'connected'
  const [branch, setBranch] = useState<string | null>(null)

  /* ---------- Git 分支：活动会话变更或有连接时查一次 ---------- */
  useEffect(() => {
    if (!sessionId || !connected) {
      setBranch(null)
      return
    }
    let cancelled = false
    void call(window.api.exec.run(sessionId, 'git rev-parse --abbrev-ref HEAD 2>/dev/null'), {
      silent: true
    }).then((res) => {
      if (cancelled) return
      // call() 已经解包出 SshExecResult，失败时为 null
      const name = res?.stdout.trim() ?? ''
      // HEAD 游离态会返回 "HEAD"，此时不显示分支名（没有信息量）
      setBranch(name && name !== 'HEAD' ? name : null)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, connected])

  const active = transfers.filter(
    (t) => t.status === 'running' || t.status === 'pending' || t.status === 'paused'
  )
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
    <footer className="statusbar">
      {/* ---------- 左：SSH 状态 + Git 分支 ---------- */}
      {session ? (
        <>
          <span className="flex items-center gap-1.5">
            <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[session.status])} />
            <span className="text-ink-2">{STATUS_TEXT[session.status]}</span>
          </span>

          <Sep />

          <span className="flex items-center gap-1 text-ink-2">
            <CircleDot size={10} className="text-ink-3" />
            <span className="max-w-[180px] truncate">
              {session.username}@{session.host}
            </span>
          </span>

          {latencyMs !== undefined && connected && (
            <>
              <Sep />
              <span className={cn('font-mono tabular-nums', LATENCY_CLS[latencyLevel(latencyMs)])}>
                {latencyMs} ms
              </span>
            </>
          )}

          {branch && (
            <>
              <Sep />
              <span className="flex min-w-0 items-center gap-1 text-ink-2">
                <GitBranch size={10} className="shrink-0 text-ink-3" />
                <span className="max-w-[140px] truncate font-mono">{branch}</span>
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

      {/* ---------- 右：传输 · 编码 · 换行 · Shell · 尺寸 ---------- */}
      {active.length > 0 && (
        <>
          <button
            className="flex items-center gap-1 rounded px-1 py-0.5 text-accent transition-colors duration-150 hover:bg-hover"
            title="查看传输进度"
            onClick={showDock}
          >
            {active[0].direction === 'upload' ? (
              <ArrowUpFromLine size={10} />
            ) : (
              <ArrowDownToLine size={10} />
            )}
            <span className="tabular-nums">
              {active.length} 项 · {activePct}%
            </span>
          </button>
          <Sep />
        </>
      )}

      {count > 1 && (
        <>
          <span className="tabular-nums">{count} 个会话</span>
          <Sep />
        </>
      )}

      <span>UTF-8</span>
      <Sep />
      <span>LF</span>
      <Sep />
      <span className="font-mono">bash</span>

      {session && (
        <>
          <Sep />
          <span className="font-mono tabular-nums">
            {session.cols}×{session.rows}
          </span>
        </>
      )}
    </footer>
  )
}
