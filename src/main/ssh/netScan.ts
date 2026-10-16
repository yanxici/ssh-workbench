import { execFile } from 'node:child_process'
import dns from 'node:dns'
import os from 'node:os'
import { promisify } from 'node:util'
import type { DiscoverHost, DiscoverProgressEvent, NetInterfaceInfo } from '@shared/types'
import { parseArpTable } from '../util/arp'
import { cidrFromAddress, expandCidrHosts } from '../util/cidr'
import { probePort } from '../util/tcpProbe'

const execFileAsync = promisify(execFile)

/**
 * 局域网设备发现（从运行 Workbench 的电脑侧发起）。
 *
 * 探测方式：TCP 连接探针（不需要管理员权限/原始套接字）——
 * 对目标网段逐个 IP 的常用端口建连，能连上即认为是"设备"，
 * 随后从系统 ARP 表补 MAC（含厂商识别）与反向 DNS 补主机名。
 */

type ProgressHandler = (event: DiscoverProgressEvent) => void

const CONCURRENCY = 48
const PROGRESS_THROTTLE_MS = 400

class NetScanner {
  private runs = new Map<string, { cancelled: boolean }>()
  private onProgress: ProgressHandler | null = null

  setProgressHandler(cb: ProgressHandler): void {
    this.onProgress = cb
  }

  /** 本机 IPv4 网卡 → 建议扫描网段 */
  interfaces(): NetInterfaceInfo[] {
    const out: NetInterfaceInfo[] = []
    for (const [name, list] of Object.entries(os.networkInterfaces())) {
      for (const info of list ?? []) {
        if (info.family !== 'IPv4' || info.internal) continue
        try {
          const cidr = cidrFromAddress(info.address, info.netmask)
          const prefix = Number(cidr.split('/')[1])
          out.push({
            name,
            address: info.address,
            netmask: info.netmask,
            cidr,
            hostCount: Math.max(2 ** (32 - prefix) - 2, 0)
          })
        } catch {
          /* 跳过异常网卡 */
        }
      }
    }
    return out
  }

  async scan(
    runId: string,
    cidr: string,
    ports: number[],
    timeoutMs = 350
  ): Promise<DiscoverHost[]> {
    const token = { cancelled: false }
    this.runs.set(runId, token)

    try {
      const hosts = expandCidrHosts(cidr)
      const total = hosts.length
      const found: DiscoverHost[] = []
      const queue = [...hosts]
      let scanned = 0
      let lastEmit = 0

      const emit = (done: boolean): void => {
        this.onProgress?.({ runId, scanned, total, found: [...found], done })
      }

      const worker = async (): Promise<void> => {
        for (;;) {
          if (token.cancelled) return
          const ip = queue.shift()
          if (!ip) return

          const openPorts: number[] = []
          let latencyMs: number | undefined
          for (const port of ports) {
            if (token.cancelled) return
            const t0 = Date.now()
            if (await probePort(ip, port, timeoutMs)) {
              openPorts.push(port)
              if (latencyMs === undefined) latencyMs = Date.now() - t0
            }
          }
          scanned += 1
          if (openPorts.length > 0) found.push({ ip, openPorts, latencyMs })

          const now = Date.now()
          if (now - lastEmit >= PROGRESS_THROTTLE_MS) {
            lastEmit = now
            emit(false)
          }
        }
      }

      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, hosts.length) }, worker))

      if (!token.cancelled) {
        // 扫描过后 ARP 表已缓存可达主机：补 MAC
        const arp = await readArpTable()
        for (const host of found) {
          const mac = arp[host.ip]
          if (mac) host.mac = mac
        }
        // 反向 DNS 补主机名（并行、单个 800ms 上限）
        await Promise.all(
          found.map(async (host) => {
            host.hostname = await reverseDns(host.ip)
          })
        )
      }

      emit(true)
      return found
    } finally {
      this.runs.delete(runId)
    }
  }

  cancel(runId: string): void {
    const run = this.runs.get(runId)
    if (run) run.cancelled = true
  }
}

/** 读取系统 ARP/邻居表（跨平台，失败静默） */
async function readArpTable(): Promise<Record<string, string>> {
  const attempts: Array<[string, string[]]> =
    process.platform === 'win32'
      ? [['arp', ['-a']]]
      : [
          ['ip', ['neigh']],
          ['arp', ['-an']]
        ]

  for (const [cmd, args] of attempts) {
    try {
      const { stdout } = await execFileAsync(cmd, args, { timeout: 5000, windowsHide: true })
      const table = parseArpTable(stdout)
      if (Object.keys(table).length > 0) return table
    } catch {
      /* 尝试下一种方式 */
    }
  }
  return {}
}

function reverseDns(ip: string): Promise<string | undefined> {
  return Promise.race([
    dns.promises.reverse(ip).then((names) => names[0]),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 800))
  ]).catch(() => undefined)
}

export const netScanner = new NetScanner()
