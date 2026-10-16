import type { MetricsEvent } from '@shared/types'
import { METRICS_SAMPLE_COMMAND, parseSample, type ProcSnapshot } from '../util/parseProcSample'
import { execCollect } from './exec'
import { sessionManager } from './sessionManager'

/**
 * 资源仪表盘采样器 —— 在监控中的会话上周期性执行轻量采样命令。
 *
 * - 一帧只跑一条组合命令（cat /proc/* + df + thermal），对嵌入式设备负担小；
 * - 连续 3 次采样失败自动停止并上报错误（设备掉线 / 命令被限制等）；
 * - 会话关闭时由 sessionManager.setOnClosed 钩子自动停表。
 */

const DEFAULT_INTERVAL_MS = 3000
const SAMPLE_TIMEOUT_MS = 5000
const MAX_CONSECUTIVE_FAILURES = 3

type EventHandler = (event: MetricsEvent) => void

interface Monitor {
  intervalMs: number
  timer: NodeJS.Timeout
  snapshot: ProcSnapshot | null
  busy: boolean
  failures: number
}

class MetricsSampler {
  private monitors = new Map<string, Monitor>()
  private onEvent: EventHandler | null = null

  setEventHandler(cb: EventHandler): void {
    this.onEvent = cb
  }

  /** 正在监控的会话 id 列表（渲染层初始化时同步） */
  states(): string[] {
    return [...this.monitors.keys()]
  }

  async start(sessionId: string, intervalMs = DEFAULT_INTERVAL_MS): Promise<void> {
    if (this.monitors.has(sessionId)) return
    const interval = Math.min(Math.max(intervalMs || DEFAULT_INTERVAL_MS, 1000), 60000)

    const monitor: Monitor = {
      intervalMs: interval,
      timer: setInterval(() => void this.tick(sessionId), interval),
      snapshot: null,
      busy: false,
      failures: 0
    }
    this.monitors.set(sessionId, monitor)
    // 立即出一帧（首帧无差分字段，但内存/磁盘/温度/负载即时可见）
    await this.tick(sessionId)
  }

  stop(sessionId: string, error?: string): void {
    const monitor = this.monitors.get(sessionId)
    if (!monitor) return
    clearInterval(monitor.timer)
    this.monitors.delete(sessionId)
    this.onEvent?.({ sessionId, running: false, error })
  }

  onSessionClosed(sessionId: string): void {
    this.stop(sessionId, '会话已断开，监控已停止')
  }

  private async tick(sessionId: string): Promise<void> {
    const monitor = this.monitors.get(sessionId)
    if (!monitor || monitor.busy) return
    monitor.busy = true

    try {
      await sessionManager.waitUntilReady(sessionId, 10000)
      const client = sessionManager.getClient(sessionId)
      if (!client) throw new Error('会话不可用')

      const out = await execCollect(client, METRICS_SAMPLE_COMMAND, SAMPLE_TIMEOUT_MS, undefined, 64 * 1024)
      if (out.status !== 'done') {
        throw new Error(out.status === 'timeout' ? '采样超时' : (out.error ?? '采样失败'))
      }

      const { snapshot, metrics } = parseSample(out.stdout, monitor.snapshot)
      if (!snapshot) {
        // /proc/stat 都读不到：设备环境不支持
        throw new Error('无法读取 /proc/stat（设备可能不支持或权限受限）')
      }
      monitor.snapshot = snapshot
      monitor.failures = 0
      this.onEvent?.({ sessionId, running: true, sample: { ts: Date.now(), ...metrics } })
    } catch (err) {
      monitor.failures += 1
      if (monitor.failures >= MAX_CONSECUTIVE_FAILURES) {
        this.stop(sessionId, err instanceof Error ? err.message : String(err))
      }
    } finally {
      const current = this.monitors.get(sessionId)
      if (current) current.busy = false
    }
  }
}

export const metricsSampler = new MetricsSampler()
