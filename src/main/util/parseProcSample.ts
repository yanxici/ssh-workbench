/**
 * 设备资源采样解析（纯函数，可独立测试）。
 *
 * 采样命令一次取回六段原始数据（用 @@@ 分隔）：
 *   /proc/stat(cpu 行) @@@ /proc/loadavg @@@ /proc/meminfo @@@ /proc/net/dev @@@ df -k / @@@ thermal
 *
 * 帧间求差在本地完成：CPU 使用率 = 1 - Δidle/Δtotal；网络速率 = Δbytes/Δt。
 * 首次采样没有基准，对应字段留空（渲染层显示「--」）。
 */

/** 采样命令（BusyBox 兼容；各段失败不影响其他段） */
export const METRICS_SAMPLE_COMMAND =
  "cat /proc/stat 2>/dev/null | head -1; echo '@@@'; " +
  "cat /proc/loadavg 2>/dev/null; echo '@@@'; " +
  "head -8 /proc/meminfo 2>/dev/null; echo '@@@'; " +
  "cat /proc/net/dev 2>/dev/null; echo '@@@'; " +
  "df -k / 2>/dev/null | tail -n 1; echo '@@@'; " +
  "cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null"

export interface ProcSnapshot {
  ts: number
  cpuTotal: number
  cpuIdle: number
  netRx: number
  netTx: number
}

/** 单帧解析出的指标（不含差分字段） */
export interface SampleMetrics {
  cpuPercent?: number
  memPercent?: number
  memTotalMb?: number
  memUsedMb?: number
  diskPercent?: number
  diskUsedGb?: number
  diskTotalGb?: number
  netRxKbps?: number
  netTxKbps?: number
  tempC?: number
  load1?: number
}

function toNum(v: string | undefined): number | undefined {
  if (v === undefined) return undefined
  const t = v.trim()
  // 注意：Number('') === 0 —— 空段（如设备无温度传感器）必须视为「无数据」而不是 0
  if (t === '') return undefined
  const n = Number(t)
  return Number.isFinite(n) ? n : undefined
}

function round1(n: number): number {
  return Math.round(n * 10) / 10
}

export function parseSample(
  raw: string,
  prev: ProcSnapshot | null,
  now = Date.now()
): { snapshot: ProcSnapshot | null; metrics: SampleMetrics } {
  const parts = raw.split('@@@').map((p) => p.trim())
  const [statPart = '', loadPart = '', memPart = '', netPart = '', dfPart = '', tempPart = ''] =
    parts

  const metrics: SampleMetrics = {}

  /* ---------- CPU（jiffies 差分） ---------- */
  let snapshot: ProcSnapshot | null = null
  const cpuLine = statPart.split('\n').find((l) => l.trim().startsWith('cpu '))
  if (cpuLine) {
    const fields = cpuLine.trim().split(/\s+/).slice(1).map(Number)
    if (fields.length >= 5 && fields.every((n) => Number.isFinite(n))) {
      const total = fields.reduce((a, b) => a + b, 0)
      const idle = (fields[3] ?? 0) + (fields[4] ?? 0) // idle + iowait

      // 网络部分（同一帧一起计算，便于与 CPU 共用 prev）
      let rx = 0
      let tx = 0
      const netLines = netPart.split('\n').slice(2) // 跳过两行表头
      for (const line of netLines) {
        const idx = line.indexOf(':')
        if (idx < 0) continue
        const name = line.slice(0, idx).trim()
        if (!name || name === 'lo') continue
        const f = line.slice(idx + 1).trim().split(/\s+/).map(Number)
        if (f.length >= 9 && Number.isFinite(f[0]) && Number.isFinite(f[8])) {
          rx += f[0]
          tx += f[8]
        }
      }

      snapshot = { ts: now, cpuTotal: total, cpuIdle: idle, netRx: rx, netTx: tx }

      if (prev) {
        const dTotal = total - prev.cpuTotal
        const dIdle = idle - prev.cpuIdle
        if (dTotal > 0) {
          metrics.cpuPercent = round1(Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100)))
        }
        const dtSec = Math.max((now - prev.ts) / 1000, 0.1)
        metrics.netRxKbps = round1(Math.max(0, rx - prev.netRx) / dtSec / 1024)
        metrics.netTxKbps = round1(Math.max(0, tx - prev.netTx) / dtSec / 1024)
      }
    }
  }

  /* ---------- 负载 ---------- */
  const load1 = toNum(loadPart.split(/\s+/)[0])
  if (load1 !== undefined) metrics.load1 = round1(load1)

  /* ---------- 内存 ---------- */
  const memKeys = new Map<string, number>()
  for (const line of memPart.split('\n')) {
    const m = line.match(/^(\w+):\s+(\d+)/)
    if (m) memKeys.set(m[1], Number(m[2]))
  }
  const memTotal = memKeys.get('MemTotal')
  if (memTotal && memTotal > 0) {
    const available =
      memKeys.get('MemAvailable') ??
      (memKeys.get('MemFree') ?? 0) + (memKeys.get('Buffers') ?? 0) + (memKeys.get('Cached') ?? 0)
    const used = Math.max(0, memTotal - available)
    metrics.memTotalMb = Math.round(memTotal / 1024)
    metrics.memUsedMb = Math.round(used / 1024)
    metrics.memPercent = round1((used / memTotal) * 100)
  }

  /* ---------- 磁盘（df -k /） ---------- */
  const dfFields = dfPart.split(/\s+/).filter(Boolean)
  if (dfFields.length >= 3) {
    const totalKb = toNum(dfFields[1])
    const usedKb = toNum(dfFields[2])
    if (totalKb && totalKb > 0 && usedKb !== undefined) {
      metrics.diskTotalGb = round1(totalKb / 1024 / 1024)
      metrics.diskUsedGb = round1(usedKb / 1024 / 1024)
      metrics.diskPercent = round1((usedKb / totalKb) * 100)
    }
  }

  /* ---------- 温度（毫摄氏度） ---------- */
  const milli = toNum(tempPart.split('\n')[0])
  if (milli !== undefined && milli > -100000 && milli < 200000) {
    metrics.tempC = round1(milli / 1000)
  }

  return { snapshot, metrics }
}
