import { create } from 'zustand'
import type { DiscoverHost, DiscoverProgressEvent, MdnsService, NetInterfaceInfo } from '@shared/types'
import { call } from '@/lib/ipc'
import { uid } from '@/lib/utils'
import { useToastStore } from './toastStore'
import { useUiStore } from './uiStore'

/**
 * 设备发现状态：网段扫描（TCP 探针）+ mDNS 服务发现。
 * 扫描在运行 Workbench 的电脑局域网侧进行；发现结果可直接转成新连接。
 */

type DiscoveryTab = 'scan' | 'mdns'

interface DiscoveryState {
  panelOpen: boolean
  tab: DiscoveryTab

  ifaces: NetInterfaceInfo[]
  cidr: string
  portsText: string
  scanTimeoutMs: number
  runId: string | null
  scanning: boolean
  scanned: number
  total: number
  hosts: DiscoverHost[]

  mdnsRunning: boolean
  mdnsServices: MdnsService[]
  mdnsDone: boolean

  togglePanel: () => void
  setTab: (tab: DiscoveryTab) => void
  loadIfaces: () => Promise<void>
  setCidr: (cidr: string) => void
  setPortsText: (text: string) => void
  setScanTimeoutMs: (ms: number) => void
  startScan: () => Promise<void>
  cancelScan: () => Promise<void>
  applyProgress: (e: DiscoverProgressEvent) => void
  runMdns: () => Promise<void>
  makeConnection: (host: string, port?: number) => void
}

export const useDiscoveryStore = create<DiscoveryState>()((set, get) => ({
  panelOpen: false,
  tab: 'scan',

  ifaces: [],
  cidr: '',
  portsText: '22, 80, 443',
  scanTimeoutMs: 350,
  runId: null,
  scanning: false,
  scanned: 0,
  total: 0,
  hosts: [],

  mdnsRunning: false,
  mdnsServices: [],
  mdnsDone: false,

  togglePanel: () => {
    const next = !get().panelOpen
    set({ panelOpen: next })
    if (next && get().ifaces.length === 0) void get().loadIfaces()
  },

  setTab: (tab) => set({ tab }),

  loadIfaces: async () => {
    const list = await call(window.api.discovery.interfaces(), { errorTitle: '读取网卡信息失败' })
    if (!list) return
    set((s) => ({
      ifaces: list,
      cidr: s.cidr || list[0]?.cidr || ''
    }))
  },

  setCidr: (cidr) => set({ cidr }),
  setPortsText: (portsText) => set({ portsText }),
  setScanTimeoutMs: (scanTimeoutMs) => set({ scanTimeoutMs }),

  startScan: async () => {
    const { cidr, portsText, scanTimeoutMs, scanning } = get()
    if (scanning) return

    const ports = portsText
      .split(/[,\s]+/)
      .map((x) => Number(x))
      .filter((n) => Number.isInteger(n) && n > 0 && n <= 65535)
    if (ports.length === 0) {
      useToastStore.getState().push({ kind: 'warning', title: '请填写要探测的端口（如 22, 80）' })
      return
    }
    if (!cidr.trim()) {
      useToastStore.getState().push({ kind: 'warning', title: '请填写要扫描的网段（如 192.168.1.0/24）' })
      return
    }

    const runId = uid()
    set({ runId, scanning: true, scanned: 0, total: 0, hosts: [] })

    const hosts = await call(
      window.api.discovery.scan(runId, cidr.trim(), ports, scanTimeoutMs),
      { errorTitle: '扫描失败' }
    )
    set({ scanning: false, runId: null })
    if (hosts) {
      set({ hosts })
      useToastStore.getState().push({
        kind: hosts.length > 0 ? 'success' : 'info',
        title: hosts.length > 0 ? `发现 ${hosts.length} 台设备` : '扫描完成：没有发现开放目标端口的设备',
        detail: hosts.length === 0 ? '可尝试增加端口（如 23/8080）或确认网段是否正确' : undefined
      })
    }
  },

  cancelScan: async () => {
    const { runId } = get()
    if (!runId) return
    await call(window.api.discovery.cancel(runId), { silent: true })
  },

  applyProgress: (e) =>
    set({ scanned: e.scanned, total: e.total, hosts: e.found, scanning: !e.done }),

  runMdns: async () => {
    if (get().mdnsRunning) return
    set({ mdnsRunning: true, mdnsServices: [], mdnsDone: false })
    const services = await call(window.api.discovery.mdns(6000), { errorTitle: 'mDNS 发现失败' })
    set({ mdnsRunning: false, mdnsDone: true, mdnsServices: services ?? [] })
  },

  makeConnection: (host, port = 22) => {
    set({ panelOpen: false })
    useUiStore.getState().openConnEditor(null, {
      name: `发现设备 ${host}`,
      host,
      port,
      username: 'root',
      group: '发现设备',
      tags: ['自动发现']
    })
  }
}))
