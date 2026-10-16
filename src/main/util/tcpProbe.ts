import net from 'node:net'
import type { NetProbeResult } from '@shared/types'

/** TCP 连通性探针：能建连即视为可达（固件等待上线 / 端口扫描共用） */
export function tcpProbe(host: string, port: number, timeoutMs = 2000): Promise<NetProbeResult> {
  return new Promise<NetProbeResult>((resolve) => {
    const started = Date.now()
    const socket = net.connect({ host, port })
    let settled = false

    const finish = (result: NetProbeResult): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }

    socket.setTimeout(timeoutMs)
    socket.on('connect', () => finish({ reachable: true, latencyMs: Date.now() - started }))
    socket.on('timeout', () => finish({ reachable: false }))
    socket.on('error', () => finish({ reachable: false }))
  })
}

/** 仅返回布尔值的简写（扫描器高频调用） */
export async function probePort(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const res = await tcpProbe(host, port, timeoutMs)
  return res.reachable
}
