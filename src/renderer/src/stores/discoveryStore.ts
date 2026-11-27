import { create } from 'zustand'
import type { DiscoverHost, DiscoverProgressEvent, MdnsService, NetInterfaceInfo } from '@shared/types'
import { tNow } from '@/i18n/core'
import { call } from '@/lib/ipc'
import { uid } from '@/lib/utils'
import { useToastStore } from './toastStore'
import { useUiStore } from './uiStore'
import { notifyTask } from '@/lib/taskNotify'

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
    const list = await call(window.api.discovery.interfaces(), {
      errorTitle: tNow('panel.discovery.ifacesError')
    })
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
      useToastStore.getState().push({ kind: 'warning', title: tNow('panel.discovery.needPorts') })
      return
    }
    if (!cidr.trim()) {
      useToastStore.getState().push({ kind: 'warning', title: tNow('panel.discovery.needCidr') })
      return
    }

    const runId = uid()
    set({ runId, scanning: true, scanned: 0, total: 0, hosts: [] })

    const hosts = await call(
      window.api.discovery.scan(runId, cidr.trim(), ports, scanTimeoutMs),
      { errorTitle: tNow('panel.discovery.scanError') }
    )
    /*
     * 只认自己这一轮的结果。
     *
     * applyProgress 收到 done: true 时已经把 scanning 置 false，用户可以在
     * 「上一轮 IPC 还没回」的窗口里立刻开第二轮；上一轮回来后无条件
     * set({ scanning: false, runId: null, hosts: 旧结果 }) 会把刚开始的
     * 第二轮直接掐死，并把旧网段的列表贴到新扫描上。
     */
    if (get().runId !== runId) return
    set({ scanning: false, runId: null })
    if (hosts) {
      set({ hosts })
      // 网段扫描按 /24 逐 IP 探活，几百个探测点几十秒跑不完，同样属于"跑完要告诉我"
      void notifyTask({
        kind: 'discover',
        title:
          hosts.length > 0
            ? tNow('panel.discovery.foundHosts', { count: hosts.length })
            : tNow('panel.discovery.scanDoneNone'),
        detail: hosts.length === 0 ? tNow('panel.discovery.scanDoneNoneDetail') : undefined
      })
    }
  },

  cancelScan: async () => {
    const { runId } = get()
    if (!runId) return
    await call(window.api.discovery.cancel(runId), { silent: true })
  },

  applyProgress: (e) =>
    set((s) => {
      // 旧扫描的 done: true 会把刚开始的新扫描直接关停，必须按 runId 过滤
      if (e.runId !== s.runId) return s
      return { scanned: e.scanned, total: e.total, hosts: e.found, scanning: !e.done }
    }),

  runMdns: async () => {
    if (get().mdnsRunning) return
    set({ mdnsRunning: true, mdnsServices: [], mdnsDone: false })
    const services = await call(window.api.discovery.mdns(6000), {
      errorTitle: tNow('panel.discovery.mdnsError')
    })
    set({ mdnsRunning: false, mdnsDone: true, mdnsServices: services ?? [] })
  },

  makeConnection: (host, port = 22) => {
    set({ panelOpen: false })
    useUiStore.getState().openConnEditor(null, {
      name: tNow('panel.discovery.newConnName', { host }),
      host,
      port,
      username: 'root',
      group: tNow('panel.discovery.newConnGroup'),
      tags: [tNow('panel.discovery.newConnTag')]
    })
  }
}))
