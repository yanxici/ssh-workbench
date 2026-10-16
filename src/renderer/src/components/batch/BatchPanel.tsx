import { useMemo, useState } from 'react'
import {
  Boxes,
  CheckCircle2,
  CheckSquare,
  Columns3,
  Copy,
  LayoutList,
  Loader2,
  MinusCircle,
  Square,
  TimerOff,
  X,
  XCircle
} from 'lucide-react'
import type { BatchStatus } from '@shared/types'
import { call } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/ui'
import { useBatchStore } from '@/stores/batchStore'
import { useCommandStore } from '@/stores/commandStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useToastStore } from '@/stores/toastStore'

/**
 * 多设备批量执行面板（覆盖主区域）。
 * 勾选多个在线会话 → 广播同一条命令 → 并行执行、分别收集输出。
 * 卡片视图看单台详情；对比视图把各设备输出并排排列，方便找差异。
 */
export function BatchPanel(): JSX.Element | null {
  const panelOpen = useBatchStore((s) => s.panelOpen)
  if (!panelOpen) return null

  const close = (): void => useBatchStore.setState({ panelOpen: false })

  return (
    <div className="fixed inset-x-0 bottom-[26px] top-[38px] z-30 flex flex-col bg-app">
      {/* 标题栏 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3">
        <Boxes size={14} className="text-accent" />
        <span className="text-xs font-semibold">批量执行</span>
        <span className="text-2xs text-ink-3">多设备广播命令，分别收集输出并对比</span>
        <span className="flex-1" />
        <button className="btn-icon" title="关闭 (Esc)" onClick={close}>
          <X size={14} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <SessionPicker />
        <CommandAndResults />
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  左：设备会话选择
 * ------------------------------------------------------------------ */

function SessionPicker(): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions)
  const selected = useBatchStore((s) => s.selectedSessionIds)

  const connected = useMemo(() => sessions.filter((s) => s.status === 'connected'), [sessions])
  const selSet = new Set(selected)

  return (
    <div className="flex w-[248px] shrink-0 flex-col border-r border-edge bg-panel">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-edge-soft px-2.5 py-1.5">
        <span className="text-2xs font-semibold text-ink-2">目标设备</span>
        <span className="text-2xs text-ink-3">
          {selected.length}/{connected.length}
        </span>
        <span className="flex-1" />
        <button
          className="text-2xs text-ink-3 transition-colors hover:text-ink"
          onClick={() => useBatchStore.getState().setSelected(connected.map((s) => s.id))}
        >
          全选在线
        </button>
        <span className="text-2xs text-ink-3/50">|</span>
        <button
          className="text-2xs text-ink-3 transition-colors hover:text-ink"
          onClick={() => useBatchStore.getState().setSelected([])}
        >
          清空
        </button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1.5">
        {sessions.length === 0 && (
          <div className="px-2 py-4 text-2xs leading-relaxed text-ink-3">
            还没有打开任何会话。先在左侧打开多个 SSH 连接，再回到这里批量执行。
          </div>
        )}
        {sessions.map((s) => {
          const selectable = s.status === 'connected'
          const on = selSet.has(s.id)
          return (
            <div
              key={s.id}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors',
                selectable
                  ? 'cursor-default text-ink-2 hover:bg-hover/60'
                  : 'cursor-not-allowed text-ink-3/70'
              )}
              title={selectable ? `${s.username}@${s.host}` : '会话未连接，无法参与批量执行'}
              onClick={() => selectable && useBatchStore.getState().toggleSession(s.id)}
            >
              {on ? (
                <CheckSquare size={11} className="shrink-0 text-accent" />
              ) : (
                <Square size={11} className="shrink-0 text-ink-3/60" />
              )}
              <span className="min-w-0 flex-1 truncate text-xs">{s.title}</span>
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  s.status === 'connected' && 'bg-success',
                  s.status === 'connecting' && 'animate-pulse bg-warning',
                  s.status === 'error' && 'bg-danger',
                  s.status === 'disconnected' && 'bg-ink-3/40'
                )}
              />
            </div>
          )
        })}
      </div>

      <div className="shrink-0 border-t border-edge-soft px-2.5 py-1.5 text-[10px] leading-relaxed text-ink-3">
        命令将在每台设备上独立执行，互不影响；输出按设备分别收集。
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  右：命令输入 + 结果
 * ------------------------------------------------------------------ */

function CommandAndResults(): JSX.Element {
  const command = useBatchStore((s) => s.command)
  const timeoutMs = useBatchStore((s) => s.timeoutMs)
  const running = useBatchStore((s) => s.running)
  const view = useBatchStore((s) => s.view)
  const runOrder = useBatchStore((s) => s.runOrder)
  const selectedCount = useBatchStore((s) => s.selectedSessionIds.length)

  const commands = useCommandStore((s) => s.commands)

  const insertCommand = (id: string): void => {
    const cmd = commands.find((c) => c.id === id)
    if (!cmd) return
    const next = command.trim() ? `${command.replace(/\s+$/, '')}\n${cmd.command}` : cmd.command
    useBatchStore.getState().setCommand(next)
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      {/* 命令区 */}
      <div className="shrink-0 border-b border-edge-soft p-3 pb-2">
        <textarea
          className="textarea selectable min-h-[64px] font-mono text-xs leading-relaxed"
          placeholder="输入要在所有选中设备上执行的命令，例如：uname -a && uptime"
          value={command}
          onChange={(e) => useBatchStore.getState().setCommand(e.target.value)}
        />
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <select
            className="input h-7 w-[190px]"
            value=""
            onChange={(e) => {
              insertCommand(e.target.value)
              e.target.value = ''
            }}
          >
            <option value="">插入常用命令…</option>
            {commands.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-2xs text-ink-3">
            超时
            <input
              className="input h-7 w-[64px] font-mono"
              value={String(timeoutMs)}
              onChange={(e) =>
                useBatchStore
                  .getState()
                  .setTimeoutMs(Number(e.target.value.replace(/[^\d]/g, '')) || 0)
              }
              onBlur={() => {
                const v = Math.min(Math.max(timeoutMs || 15000, 1000), 300000)
                useBatchStore.getState().setTimeoutMs(v)
              }}
            />
            ms
          </label>

          <span className="flex-1" />
          {runOrder.length > 0 && !running && (
            <button
              className="btn h-7 px-2.5 text-2xs"
              onClick={() => useBatchStore.getState().clearResults()}
            >
              清空结果
            </button>
          )}
          {running ? (
            <button
              className="btn h-7 px-3 text-xs"
              onClick={() => void useBatchStore.getState().cancel()}
            >
              <X size={12} />
              取消
            </button>
          ) : (
            <button
              className="btn btn-primary h-7 px-3.5 text-xs"
              disabled={selectedCount === 0 || !command.trim()}
              onClick={() => void useBatchStore.getState().start()}
            >
              <Boxes size={12} />
              执行（{selectedCount} 台）
            </button>
          )}
        </div>
      </div>

      {/* 结果工具条 */}
      {runOrder.length > 0 && (
        <div className="flex shrink-0 items-center gap-2 border-b border-edge-soft px-3 py-1">
          <span className="text-2xs text-ink-3">结果</span>
          <span className="flex-1" />
          <div className="flex items-center gap-0.5 rounded border border-edge bg-app p-0.5">
            <button
              className={cn(
                'flex items-center gap-1 rounded px-2 py-0.5 text-2xs transition-colors',
                view === 'cards' ? 'bg-accent/15 text-accent' : 'text-ink-3 hover:text-ink-2'
              )}
              onClick={() => useBatchStore.getState().setView('cards')}
            >
              <LayoutList size={11} />
              卡片
            </button>
            <button
              className={cn(
                'flex items-center gap-1 rounded px-2 py-0.5 text-2xs transition-colors',
                view === 'columns' ? 'bg-accent/15 text-accent' : 'text-ink-3 hover:text-ink-2'
              )}
              onClick={() => useBatchStore.getState().setView('columns')}
            >
              <Columns3 size={11} />
              对比
            </button>
          </div>
        </div>
      )}

      {/* 结果区 */}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">
        {runOrder.length === 0 ? (
          <EmptyState
            icon={<Boxes size={30} />}
            title="准备就绪"
            hint="在左侧勾选多台在线设备，输入一条命令并执行 —— 输出会按设备分别收集，可用「对比」视图并排查看"
          />
        ) : view === 'cards' ? (
          <div className="space-y-2">
            {runOrder.map((id) => (
              <BatchResultCard key={id} sessionId={id} />
            ))}
          </div>
        ) : (
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}
          >
            {runOrder.map((id) => (
              <BatchColumn key={id} sessionId={id} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  结果视图组件
 * ------------------------------------------------------------------ */

function BatchStatusIcon({ status }: { status: BatchStatus | undefined }): JSX.Element {
  switch (status) {
    case 'running':
      return <Loader2 size={13} className="shrink-0 animate-spin text-accent" />
    case 'done':
      return <CheckCircle2 size={13} className="shrink-0 text-success" />
    case 'error':
      return <XCircle size={13} className="shrink-0 text-danger" />
    case 'timeout':
      return <TimerOff size={13} className="shrink-0 text-warning" />
    case 'cancelled':
      return <MinusCircle size={13} className="shrink-0 text-ink-3" />
    default:
      return <Loader2 size={13} className="shrink-0 animate-spin text-ink-3/50" />
  }
}

function statusText(status: BatchStatus | undefined): string {
  switch (status) {
    case 'running':
      return '执行中'
    case 'done':
      return '完成'
    case 'error':
      return '失败'
    case 'timeout':
      return '超时'
    case 'cancelled':
      return '已取消'
    default:
      return '等待'
  }
}

function BatchResultCard({ sessionId }: { sessionId: string }): JSX.Element {
  const result = useBatchStore((s) => s.results[sessionId])
  const status = useBatchStore((s) => s.statuses[sessionId])
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId))
  const [open, setOpen] = useState(false)

  const title = result?.sessionTitle ?? session?.title ?? sessionId
  const isProblem = result ? result.status !== 'done' : false
  const expanded = open || isProblem

  const copyOutput = (): void => {
    const text = result ? (result.stdout || result.stderr || result.error || '') : ''
    void call(window.api.clip.write(text), { silent: true }).then(() =>
      useToastStore.getState().push({ kind: 'success', title: `已复制「${title}」输出` })
    )
  }

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border bg-panel',
        isProblem ? 'border-danger/40' : 'border-edge-soft'
      )}
    >
      <div
        className="flex cursor-default items-center gap-2 px-3 py-2 transition-colors hover:bg-hover/40"
        onClick={() => setOpen((v) => !v)}
      >
        <BatchStatusIcon status={status} />
        <span className="text-xs font-medium text-ink">{title}</span>
        <span className="font-mono text-[10px] text-ink-3">
          {result ? `${result.username}@${result.host}` : (session?.host ?? '')}
        </span>
        <span className="flex-1" />
        <span className="font-mono text-[10px] text-ink-3">
          {statusText(status)}
          {result ? ` · ${result.durationMs}ms · exit ${result.exitCode ?? '-'}` : ''}
        </span>
        <button
          className="btn-icon h-5 w-5"
          title="复制输出"
          onClick={(e) => {
            e.stopPropagation()
            copyOutput()
          }}
        >
          <Copy size={11} />
        </button>
      </div>
      {expanded && (
        <div className="border-t border-edge-soft">
          <pre className="scroll-thin max-h-[320px] overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed text-ink-2">
            {result
              ? result.stdout.trim() === ''
                ? result.stderr.trim() === ''
                  ? '（无输出）'
                  : ''
                : result.stdout
              : ''}
          </pre>
          {result && result.stderr.trim() !== '' && (
            <pre className="scroll-thin max-h-[140px] overflow-auto whitespace-pre-wrap break-words border-t border-danger/20 bg-danger/5 px-3 py-1.5 font-mono text-[10px] leading-relaxed text-danger/90">
              {result.stderr}
            </pre>
          )}
          {result?.error && (
            <div className="border-t border-danger/20 bg-danger/5 px-3 py-1.5 text-2xs text-danger/90">
              {result.error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function BatchColumn({ sessionId }: { sessionId: string }): JSX.Element {
  const result = useBatchStore((s) => s.results[sessionId])
  const status = useBatchStore((s) => s.statuses[sessionId])
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === sessionId))
  const title = result?.sessionTitle ?? session?.title ?? sessionId

  return (
    <div className="flex min-w-0 flex-col overflow-hidden rounded-lg border border-edge-soft bg-panel">
      <div className="flex shrink-0 items-center gap-2 border-b border-edge-soft px-2.5 py-1.5">
        <BatchStatusIcon status={status} />
        <span className="min-w-0 flex-1 truncate text-xs text-ink">{title}</span>
        <span className="shrink-0 font-mono text-[10px] text-ink-3">
          {result ? `exit ${result.exitCode ?? '-'}` : statusText(status)}
        </span>
      </div>
      <pre className="scroll-thin max-h-[420px] min-h-[120px] flex-1 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-ink-2">
        {result
          ? result.stdout.trim() === ''
            ? result.stderr.trim() || '（无输出）'
            : result.stdout
          : '执行中…'}
      </pre>
    </div>
  )
}
