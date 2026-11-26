import type * as React from 'react'
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CircleDot,
  FolderInput,
  GitBranch,
  Unplug
} from 'lucide-react'
import type { ConnStatus, TransferTask } from '@shared/types'
import { useSessionById, useSessionStore } from '@/stores/sessionStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { useSftpStore } from '@/stores/sftpStore'
import { useTrzszStore } from '@/stores/trzszStore'
import { call } from '@/lib/ipc'
import { cn, latencyLevel } from '@/lib/utils'

/**
 * 传输聚合。
 *
 * 为什么不能直接订阅 `s.transfers`：传输进行中主进程每 150ms 推一次进度
 * （sftpManager.ts:67 的 PROGRESS_THROTTLE_MS），每次 applyProgress 都
 * `[...s.transfers]` 重建数组（sftpStore.ts:424）。StatusBar 是常驻组件，
 * 订阅整个数组等于每秒跟着重渲染 6.7 次，而且 filter + 两次 reduce 跑在
 * 渲染函数体里，每次重渲染都要重算。
 *
 * 解法：把 filter/reduce 移进 selector，只返回渲染真正用到的四个标量，
 * 用 useShallow 比较。进度推进时如果这四项没变（例如只有 speedBps 变了），
 * 引用不变 → 不重渲染。传输结束、状态切换、百分比变化时才重渲染。
 *
 * 为什么保留 activeCount / activePct 两个派生值而不是订阅原始数组：
 * 渲染只用到 `active.length`、`active[0].direction`、`activePct`，
 * 数组本身从头到尾没被渲染 —— 订阅它就是纯浪费。
 */
interface TransferSummary {
  activeCount: number
  activePct: number
  /** 第一个活动任务的传输方向，决定状态栏图标 */
  firstDirection: TransferTask['direction'] | null
}

const IDLE: TransferSummary = { activeCount: 0, activePct: 0, firstDirection: null }

function summarizeTransfers(list: TransferTask[]): TransferSummary {
  let activeCount = 0
  let knownTotal = 0
  let knownDone = 0
  let ratioSum = 0
  let firstDirection: TransferTask['direction'] | null = null

  for (const t of list) {
    if (t.status !== 'running' && t.status !== 'pending' && t.status !== 'paused') continue
    if (activeCount === 0) firstDirection = t.direction
    activeCount++
    if (t.total > 0) {
      knownTotal += t.total
      knownDone += Math.min(t.transferred, t.total)
      ratioSum += Math.min(t.transferred / t.total, 1)
    }
  }

  let activePct = 0
  if (knownTotal > 0) activePct = Math.round((knownDone / knownTotal) * 100)
  else if (activeCount > 0) activePct = Math.round((ratioSum / activeCount) * 100)

  return { activeCount, activePct, firstDirection }
}

const STATUS_TEXT: Record<ConnStatus, string> = {
  connecting: '连接中',
  connected: '已连接',
  disconnected: '已断开',
  error: '连接错误'
}

/*
 * 连接中阶段的细分文案。
 *
 * 为什么值得区分：用户看到「连接中」卡住时，下一步动作完全取决于卡在哪 ——
 * tcp 未通要查网络/防火墙，auth 卡住要查凭据或键盘交互，jump 卡住要查跳板机。
 * 只说「连接中」等于什么都没说。
 */
const PHASE_LABEL: Record<string, string> = {
  tcp: '建立 TCP…',
  handshake: '握手 / 协商…',
  auth: '认证中…',
  jump: '经跳板机…',
  shell: '打开终端…'
}
function STATUS_PHASE_TEXT(phase: string): string | undefined {
  return PHASE_LABEL[phase]
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
function Sep(): React.JSX.Element {
  return <span className="h-[9px] w-px shrink-0 bg-edge" />
}

/**
 * 底部状态栏（26px，面板底 + 极细上边框，与 --size-statusbar 同口径）。
 *
 * 左：SSH 连接状态 · 会话名 · 延迟 · Git 分支
 * 右：传输进度 · 编码 · 换行符 · Shell · 终端尺寸
 *
 * Git 分支的获取方式：在活动会话上跑一次 `git rev-parse --abbrev-ref HEAD`。
 * 不能每次渲染都问，所以按 sessionId 缓存，并在切换活动会话时才重查。
 * 非 Git 目录 / 未连接时静默不显示 —— 这里不该出现「not a git repository」这种噪音。
 */
export function StatusBar(): React.JSX.Element {
  const activeId = useSessionStore((s) => s.activeId)
  // 只订阅当前会话本身；旧写法会在任意会话变化时重跑 find
  const session = useSessionById(activeId)
  const count = useSessionStore((s) => s.sessions.length)
  // 延迟单独从 latencyById 取：只有这里会因延迟变化重渲染，
  // 不会像旧实现那样把整个 sessions 数组换掉、连带终端全量重跑
  const latencyMs = useSessionStore((s) => (s.activeId ? s.latencyById[s.activeId] : undefined))
  const savedCount = useConnectionStore((s) => s.connections.length)
  // 只订阅聚合标量，不订阅 transfers 数组本身：进度事件每 150ms 重建数组，
  // 订阅数组会让这个常驻组件跟着每秒重渲染 6.7 次（详见 summarizeTransfers 注释）
  const transfer = useSftpStore(
    useShallow((s): TransferSummary => {
      const list = s.transfers
      if (list.length === 0) return IDLE
      return summarizeTransfers(list)
    })
  )
  const showDock = useSftpStore((s) => s.showDock)


  const sessionId = session?.id ?? null
  const connected = session?.status === 'connected'
  /*
   * trzsz 传输条：只订阅「当前活动会话」那一条状态。
   *
   * 不订阅整个 bySession：别的标签在传大文件时每秒改好几次状态，
   * 状态栏是常驻组件，会跟着白重渲染，而它要显示的只是当前这一格。
   * 没在传时返回 undefined —— zustand 用 === 比较，
   * 于是别的会话的更新不会惊动这里。
   */
  const trzsz = useTrzszStore((s) => (sessionId ? s.bySession[sessionId] : undefined))
  const [branch, setBranch] = useState<string | null>(null)

  /* ---------- Git 分支：活动会话变更或有连接时查一次 ---------- */
  useEffect(() => {
    // 串口设备没有 shell，拿它跑 git 每切一次标签就刷一条错误日志
    if (!sessionId || !connected || session?.kind === 'serial') {
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
    // session?.kind 也要进依赖：串口/SSH 之间切换时不能复用上一份分支名
  }, [sessionId, connected, session?.kind])

  const { activeCount, activePct, firstDirection } = transfer
  const serialCfg = session?.kind === 'serial' ? session.serialConfig : undefined
  const serialFrame = serialCfg
    ? `${serialCfg.baudRate ?? 115200} ${serialCfg.dataBits ?? 8}${(serialCfg.parity ?? 'none')[0].toUpperCase()}${serialCfg.stopBits ?? 1}`
    : null

  return (
    <footer className="statusbar">
      {/* ---------- 左：SSH 状态 + Git 分支 ---------- */}
      {session ? (
        <>
          <span
            className={cn(
              'flex items-center gap-1.5',
              connected && 'rounded-full bg-accent/10 px-1.5 py-px text-accent'
            )}
          >
            <span className={cn('h-1.5 w-1.5 rounded-full', STATUS_DOT[session.status])} />
            <span className={cn(connected ? 'font-medium text-accent' : 'text-ink-2')}>
              {(session.phase && STATUS_PHASE_TEXT(session.phase)) || STATUS_TEXT[session.status]}
            </span>
          </span>

          <Sep />

          <span className="flex items-center gap-1 text-ink-2">
            <CircleDot size={10} className="text-ink-3" />
            <span className="max-w-[180px] truncate">
              {session.target}
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
      {activeCount > 0 && (
        <>
          <button
            className="flex items-center gap-1 rounded px-1 py-0.5 text-accent transition-colors duration-150 hover:bg-hover"
            title="查看传输进度"
            onClick={showDock}
          >
            {firstDirection === 'upload' ? (
              <ArrowUpFromLine size={10} />
            ) : (
              <ArrowDownToLine size={10} />
            )}
            <span className="tabular-nums">
              {activeCount} 项 · {activePct}%
            </span>
          </button>
          <Sep />
        </>
      )}

      {trzsz && (
        <>
          <span
            className="flex min-w-0 items-center gap-1 text-accent"
            title={trzsz.file ? `trzsz 正在接收：${trzsz.file}` : 'trzsz 正在传输'}
          >
            <FolderInput size={10} className="shrink-0" />
            <span className="max-w-[160px] truncate">{trzsz.file ?? 'trzsz'}</span>
            {trzsz.percent !== undefined && (
              <span className="tabular-nums">{trzsz.percent}%</span>
            )}
          </span>
          <Sep />
        </>
      )}

      {count > 1 && (
        <>
          <span className="tabular-nums">{count} 个会话</span>
          <Sep />
        </>
      )}

      {session?.kind === 'serial' ? (
        <>
          <span className="rounded bg-chrome px-1.5 py-px font-mono text-3xs font-medium text-ink-2">
            SERIAL
          </span>
          {serialFrame && (
            <>
              <Sep />
              <span className="font-mono tabular-nums">{serialFrame}</span>
            </>
          )}
          <Sep />
          <span className="font-mono">{(serialCfg?.charset ?? 'utf-8').toUpperCase()}</span>
          <Sep />
          <span className="font-mono">{(serialCfg?.newline ?? 'cr').toUpperCase()}</span>
          <Sep />
          <span className="font-mono tabular-nums">
            {session.cols}×{session.rows}
          </span>
        </>
      ) : session ? (
        <>
          <span className="rounded bg-chrome px-1.5 py-px font-mono text-3xs font-medium text-ink-2">
            SSH
          </span>
          <Sep />
          <span>UTF-8</span>
          <Sep />
          <span className="font-mono tabular-nums">
            {session.cols}×{session.rows}
          </span>
        </>
      ) : (
        <span className="font-medium tracking-[-0.01em] text-ink-3">Portix</span>
      )}
    </footer>
  )
}