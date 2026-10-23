import { Gauge, PauseCircle, PlayCircle, Wifi, X } from 'lucide-react'
import type { MetricsSample } from '@shared/types'
import { cn } from '@/lib/utils'
import { EmptyState } from '@/components/ui'
import { useMetricsStore, type SessionSeries } from '@/stores/metricsStore'
import { useSessionStore } from '@/stores/sessionStore'

/**
 * 资源仪表盘（覆盖主区域）：实时 CPU / 内存 / 磁盘 / 温度 / 网络曲线。
 * 采样在主进程侧进行（3s 一帧），这里只做滚动序列渲染（每会话最多 120 点）。
 */
export function MetricsPanel(): JSX.Element | null {
  const panelOpen = useMetricsStore((s) => s.panelOpen)
  const monitored = useMetricsStore((s) => s.monitored)
  const order = useMetricsStore((s) => s.order)

  if (!panelOpen) return null

  const close = (): void => useMetricsStore.setState({ panelOpen: false })

  return (
    <div className="fixed inset-x-0 bottom-[26px] top-[38px] z-30 flex flex-col bg-app">
      {/* 标题栏 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3">
        <Gauge size={14} className="text-accent" />
        <span className="text-xs font-semibold">资源仪表盘</span>
        <span className="text-2xs text-ink-3">每 3 秒一帧 · 多会话可同时监控</span>
        <span className="flex-1" />
        <button className="btn-icon" title="关闭 (Esc)" onClick={close}>
          <X size={14} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <MonitorTargets />
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-3">
          {order.length === 0 ? (
            <EmptyState
              icon={<Gauge size={30} />}
              title="还没有监控中的设备"
              hint="在左侧为在线会话开启监控（默认已自动监控当前活动会话），即可看到 CPU / 内存 / 磁盘 / 温度 / 网络 的实时曲线"
            />
          ) : (
            <div className="space-y-3">
              {order.map((id) => (
                <SessionCard key={id} series={monitored[id]} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  左：监控目标
 * ------------------------------------------------------------------ */

function MonitorTargets(): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions)
  const monitored = useMetricsStore((s) => s.monitored)

  return (
    <div className="flex w-[248px] shrink-0 flex-col border-r border-edge bg-panel">
      <div className="flex shrink-0 items-center gap-1.5 border-b border-edge-soft px-2.5 py-1.5">
        <span className="text-2xs font-semibold text-ink-2">监控目标</span>
        <span className="text-2xs text-ink-3">
          {Object.keys(monitored).length}/{sessions.filter((s) => s.status === 'connected').length}
        </span>
        <span className="flex-1" />
        <button
          className="text-2xs text-ink-3 transition-colors hover:text-ink"
          onClick={() => void useMetricsStore.getState().startAllConnected()}
        >
          全部监控
        </button>
        <span className="text-2xs text-ink-3/50">|</span>
        <button
          className="text-2xs text-ink-3 transition-colors hover:text-ink"
          onClick={() => void useMetricsStore.getState().stopAll()}
        >
          全部停止
        </button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1.5">
        {sessions.length === 0 && (
          <div className="px-2 py-4 text-2xs leading-relaxed text-ink-3">
            还没有打开任何会话。先建立 SSH 连接，再回到这里开启监控。
          </div>
        )}
        {sessions.map((s) => {
          const selectable = s.status === 'connected'
          const isMonitored = Boolean(monitored[s.id])
          return (
            <div
              key={s.id}
              className={cn(
                'mb-0.5 flex items-center gap-1.5 rounded-md px-1.5 py-1 transition-colors',
                selectable ? 'hover:bg-hover/60' : 'opacity-60'
              )}
            >
              <span
                className={cn(
                  'h-1.5 w-1.5 shrink-0 rounded-full',
                  isMonitored
                    ? 'animate-pulse bg-success'
                    : s.status === 'connected'
                      ? 'bg-success'
                      : s.status === 'connecting'
                        ? 'bg-warning'
                        : s.status === 'error'
                          ? 'bg-danger'
                          : 'bg-ink-3/40'
                )}
              />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs text-ink-2">{s.title}</div>
                <div className="truncate font-mono text-3xs text-ink-3">
                  {s.username}@{s.host}
                </div>
              </div>
              <button
                className={cn(
                  'btn-icon h-5 w-5 shrink-0',
                  isMonitored ? 'text-success' : 'text-ink-3'
                )}
                disabled={!selectable}
                title={isMonitored ? '停止监控' : '开始监控'}
                onClick={() =>
                  isMonitored
                    ? void useMetricsStore.getState().stop(s.id)
                    : void useMetricsStore.getState().start(s.id)
                }
              >
                {isMonitored ? <PauseCircle size={12} /> : <PlayCircle size={12} />}
              </button>
            </div>
          )
        })}
      </div>

      <div className="shrink-0 border-t border-edge-soft px-2.5 py-1.5 text-3xs leading-relaxed text-ink-3">
        一帧只执行一条轻量采样命令（读 /proc + df），对设备负担很小；连续 3 次失败会自动停止。
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  单会话卡片
 * ------------------------------------------------------------------ */

function SessionCard({ series }: { series?: SessionSeries }): JSX.Element | null {
  const session = useSessionStore((s) => s.sessions.find((x) => x.id === series?.sessionId))
  if (!series) return null

  const samples = series.samples
  const last: MetricsSample | undefined = samples[samples.length - 1]

  const pick = (fn: (s: MetricsSample) => number | undefined): number[] =>
    samples.map(fn).filter((v): v is number => v !== undefined)

  const cpu = pick((s) => s.cpuPercent)
  const mem = pick((s) => s.memPercent)
  const disk = pick((s) => s.diskPercent)
  const temp = pick((s) => s.tempC)
  const rx = pick((s) => s.netRxKbps)
  const tx = pick((s) => s.netTxKbps)

  const title = session?.title ?? series.sessionId
  const sessionGone = !session || session.status !== 'connected'

  return (
    <div className="rounded-lg border border-edge-soft bg-panel">
      {/* 卡片头 */}
      <div className="flex items-center gap-2 border-b border-edge-soft px-3 py-2">
        <Wifi size={13} className={cn('shrink-0', sessionGone ? 'text-ink-3' : 'text-success')} />
        <span className="text-xs font-semibold text-ink">{title}</span>
        <span className="font-mono text-3xs text-ink-3">
          {session ? `${session.username}@${session.host}` : ''}
        </span>
        <span className="flex-1" />
        <span className="font-mono text-3xs text-ink-3">
          {samples.length > 0 ? `已采样 ${samples.length} 帧` : '采样中…'}
        </span>
        <button
          className="btn-icon h-5 w-5"
          title="停止监控"
          onClick={() => void useMetricsStore.getState().stop(series.sessionId)}
        >
          <X size={11} />
        </button>
      </div>

      {/* 指标格 */}
      <div className="grid grid-cols-2 gap-2 p-2.5 xl:grid-cols-3">
        <MetricTile
          label="CPU 使用率"
          value={last?.cpuPercent !== undefined ? `${last.cpuPercent.toFixed(1)}%` : '--'}
          accent={last?.cpuPercent !== undefined && last.cpuPercent > 85 ? 'danger' : 'accent'}
          series={[{ values: cpu, token: 'accent' }]}
          max={100}
          hint={last?.load1 !== undefined ? `负载 ${last.load1}` : undefined}
        />
        <MetricTile
          label="内存"
          value={last?.memPercent !== undefined ? `${last.memPercent.toFixed(1)}%` : '--'}
          accent={last?.memPercent !== undefined && last.memPercent > 90 ? 'danger' : 'success'}
          series={[{ values: mem, token: 'success' }]}
          max={100}
          hint={
            last?.memUsedMb !== undefined && last.memTotalMb !== undefined
              ? `${last.memUsedMb} / ${last.memTotalMb} MB`
              : undefined
          }
        />
        <MetricTile
          label="根分区磁盘"
          value={last?.diskPercent !== undefined ? `${last.diskPercent.toFixed(1)}%` : '--'}
          accent={last?.diskPercent !== undefined && last.diskPercent > 90 ? 'danger' : 'warning'}
          series={[{ values: disk, token: 'warning' }]}
          max={100}
          hint={
            last?.diskUsedGb !== undefined && last.diskTotalGb !== undefined
              ? `${last.diskUsedGb} / ${last.diskTotalGb} GB`
              : undefined
          }
        />
        <MetricTile
          label="温度"
          value={last?.tempC !== undefined ? `${last.tempC.toFixed(1)}℃` : '--'}
          accent={last?.tempC !== undefined && last.tempC > 75 ? 'danger' : 'warning'}
          series={[{ values: temp, token: 'warning' }]}
          hint={undefined}
        />
        <MetricTile
          label="网络"
          value={
            last?.netRxKbps !== undefined || last?.netTxKbps !== undefined
              ? `↓${fmtKbps(last?.netRxKbps)} · ↑${fmtKbps(last?.netTxKbps)}`
              : '--'
          }
          accent="accent"
          series={[
            { values: rx, token: 'accent' },
            { values: tx, token: 'success' }
          ]}
          hint="蓝=下行 · 绿=上行"
        />
        <MetricTile
          label="系统负载"
          value={last?.load1 !== undefined ? String(last.load1) : '--'}
          accent="accent"
          series={[]}
          hint="1 分钟平均（/proc/loadavg）"
        />
      </div>
    </div>
  )
}

function fmtKbps(v?: number): string {
  if (v === undefined) return '--'
  if (v < 1024) return `${v.toFixed(1)} KB/s`
  return `${(v / 1024).toFixed(2)} MB/s`
}

/* ------------------------------------------------------------------ *
 *  指标块 + 迷你曲线（纯 SVG，无图表库）
 * ------------------------------------------------------------------ */

const ACCENT_TEXT: Record<string, string> = {
  accent: 'text-accent',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger'
}

/**
 * 曲线配色 token。
 *
 * 原来这里直接写死了 GitHub 暗色板那套十六进制值（亮蓝 / 亮绿 / 暗黄 / 橙），
 * 在浅色主题和 6 套配色下都和周围对不上 —— 换成 token，实际颜色在渲染时从
 * CSS 变量读，主题切换自动跟随，也不用再维护第二份色板。
 */
type SeriesToken = 'accent' | 'success' | 'warning' | 'danger'

/** token → 可用的 CSS 颜色（--c-* 是三通道数值，必须用 rgb() 包起来） */
const SERIES_VAR: Record<SeriesToken, string> = {
  accent: 'rgb(var(--c-accent))',
  success: 'rgb(var(--c-success))',
  warning: 'rgb(var(--c-warning))',
  danger: 'rgb(var(--c-danger))'
}

/**
 * 曲线填充用的半透明色。
 *
 * SVG 的 `fill` 属性不支持 `color-mix()` 在所有旧内核上都生效，但支持
 * `rgb(r g b / a)`；这里用 CSS 变量 + 固定透明度拼出来，避免再写死一份颜色。
 */
const SERIES_FILL: Record<SeriesToken, string> = {
  accent: 'rgb(var(--c-accent) / 0.12)',
  success: 'rgb(var(--c-success) / 0.12)',
  warning: 'rgb(var(--c-warning) / 0.12)',
  danger: 'rgb(var(--c-danger) / 0.12)'
}

function MetricTile({
  label,
  value,
  accent,
  series,
  max,
  hint
}: {
  label: string
  value: string
  accent: keyof typeof ACCENT_TEXT
  series: Array<{ values: number[]; token: SeriesToken }>
  max?: number
  hint?: string
}): JSX.Element {
  return (
    <div className="rounded-md border border-edge-soft bg-app/40 px-2.5 py-2">
      <div className="flex items-baseline gap-2">
        <span className="text-3xs tracking-wide text-ink-3">{label}</span>
      </div>
      <div className={cn('mt-0.5 font-mono text-base leading-tight', ACCENT_TEXT[accent])}>
        {value}
      </div>
      {series.length > 0 && series.some((s) => s.values.length >= 2) && (
        <Sparkline series={series} max={max} />
      )}
      {hint && <div className="mt-1 truncate font-mono text-3xs text-ink-3">{hint}</div>}
    </div>
  )
}

/**
 * 迷你趋势图：所有序列按统一点数归一化到同一 x 轴；
 * 未指定 max 时自适应（趋势更清晰），指定时用于百分比类固定量程。
 *
 * 颜色由 token 决定（见 SERIES_VAR），不接收裸色值 —— 否则主题一换就花。
 */
function Sparkline({
  series,
  max,
  height = 34
}: {
  series: Array<{ values: number[]; token: SeriesToken }>
  max?: number
  height?: number
}): JSX.Element {
  const W = 240
  const H = height
  const count = Math.max(...series.map((s) => s.values.length), 2)

  const allValues = series.flatMap((s) => s.values)
  const autoMax = Math.max(...allValues, 0)
  const upper = max ?? Math.max(autoMax * 1.15, autoMax <= 5 ? 5 : 1)

  const pathFor = (values: number[]): string => {
    if (values.length === 0) return ''
    return values
      .map((v, i) => {
        const x = (i / (count - 1)) * W
        const y = H - 2 - Math.min(Math.max(v / upper, 0), 1) * (H - 6)
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="mt-1.5 w-full"
      style={{ height: H }}
    >
      {series.map((s, idx) => {
        const points = pathFor(s.values)
        if (!points) return null
        const area = `0,${H} ${points} ${W},${H}`
        return (
          <g key={idx}>
            <polygon points={area} fill={SERIES_FILL[s.token]} />
            <polyline
              points={points}
              fill="none"
              stroke={SERIES_VAR[s.token]}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
              strokeLinejoin="round"
            />
          </g>
        )
      })}
    </svg>
  )
}
