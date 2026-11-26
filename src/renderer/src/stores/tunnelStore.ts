import { create } from 'zustand'
import type {
  RemoteListeningPort,
  TunnelConfig,
  TunnelInput,
  TunnelRuntimeInfo
} from '@shared/types'
import { translate, type I18nKey } from '@/i18n'
import { call } from '@/lib/ipc'
import { useSessionStore, type SessionUi } from './sessionStore'
import { useSettingsStore } from './settingsStore'
import { useToastStore } from './toastStore'

/**
 * 端口转发 / 隧道面板状态。
 * 配置持久化在主进程（tunnels.json），运行状态由主进程事件推送。
 */

/** store 里没有 hook 上下文，词条只能按当前设置的语言直接取 */
function t(key: I18nKey, vars?: Record<string, string | number>): string {
  return translate(key, useSettingsStore.getState().settings.language ?? 'zh-CN', vars)
}

interface TunnelState {
  tunnels: TunnelConfig[]
  /** 运行状态：tunnelId -> info */
  runtimes: Record<string, TunnelRuntimeInfo>
  loaded: boolean
  keyword: string
  /** 远端监听端口探测结果：sessionId -> 端口列表（只按需拉取，不轮询） */
  discoveredBySession: Record<string, RemoteListeningPort[]>
  /** 正在探测的会话；同一时刻只探测一个，避免连着点把会话打爆 */
  discoveringSessionId: string | null

  load: () => Promise<void>
  save: (input: TunnelInput) => Promise<TunnelConfig | null>
  remove: (id: string) => Promise<void>
  start: (id: string) => Promise<void>
  stop: (id: string) => Promise<void>
  applyRuntime: (info: TunnelRuntimeInfo) => void
  setKeyword: (kw: string) => void
  /** 探测某个 SSH 会话的远端监听端口 */
  discoverPorts: (sessionId: string) => Promise<void>
  /** 把某个监听端口做成会话级临时转发（不起持久配置） */
  /** targetHost 用于同端口多网卡时精确定位要转发的那一条 */
  quickStart: (
    sessionId: string,
    port: number,
    targetHost?: string
  ) => Promise<TunnelRuntimeInfo | null>
  /** 把临时转发原地转存为持久隧道 */
  promote: (ephemeralId: string, name?: string) => Promise<TunnelConfig | null>
  /** 用系统浏览器打开本机转发端口 */
  openLocal: (port: number, protocol: 'http' | 'https') => Promise<void>
  /** 会话结束时清掉它的探测结果 */
  clearSessionDiscovery: (sessionId: string) => void
}

/** 为隧道挑选运行会话：优先其关联连接的在线会话，其次当前活动会话，再次任意在线会话 */
function pickSession(tunnel: TunnelConfig): SessionUi | null {
  const { sessions, activeId } = useSessionStore.getState()
  // 串口会话连不了 SSH 通道，端口转发在它上面必然失败
  const connected = sessions.filter((s) => s.status === 'connected' && s.kind !== 'serial')
  if (tunnel.connectionId) {
    const byConn = connected.find((s) => s.connectionId === tunnel.connectionId)
    if (byConn) return byConn
  }
  const active = connected.find((s) => s.id === activeId)
  if (active) return active
  return connected[0] ?? null
}

export const useTunnelStore = create<TunnelState>()((set, get) => ({
  tunnels: [],
  runtimes: {},
  loaded: false,
  keyword: '',
  discoveredBySession: {},
  discoveringSessionId: null,

  load: async () => {
    const list = await call(window.api.tunnel.list(), { errorTitle: '加载隧道列表失败' })
    const states = await call(window.api.tunnel.states(), { silent: true })
    const runtimes: Record<string, TunnelRuntimeInfo> = {}
    for (const s of states ?? []) runtimes[s.tunnelId] = s
    set({ tunnels: list ?? [], runtimes, loaded: true })
  },

  save: async (input) => {
    const saved = await call(window.api.tunnel.save(input), { errorTitle: '保存隧道失败' })
    if (saved) {
      await get().load()
      useToastStore.getState().push({
        kind: 'success',
        title: input.id ? '隧道已更新' : '隧道已创建'
      })
    }
    return saved
  },

  remove: async (id) => {
    const ok = await call(window.api.tunnel.remove(id), { errorTitle: '删除隧道失败' })
    if (ok !== null) {
      set((s) => {
        const runtimes = { ...s.runtimes }
        delete runtimes[id]
        return { tunnels: s.tunnels.filter((t) => t.id !== id), runtimes }
      })
    }
  },

  start: async (id) => {
    const tunnel = get().tunnels.find((t) => t.id === id)
    if (!tunnel) return
    const session = pickSession(tunnel)
    if (!session) {
      useToastStore.getState().push({
        kind: 'warning',
        title: '没有可用的 SSH 会话',
        detail: tunnel.connectionId
          ? '请先打开该连接的会话（隧道需要挂在一条在线连接上）'
          : '请先打开一个 SSH 连接'
      })
      return
    }

    set((s) => ({
      runtimes: {
        ...s.runtimes,
        [id]: { tunnelId: id, status: 'starting', connectionCount: 0 }
      }
    }))

    const info = await call(window.api.tunnel.start(id, session.id), {
      errorTitle: '启动隧道失败'
    })
    if (info) {
      get().applyRuntime(info)
      if (info.status === 'active') {
        useToastStore.getState().push({
          kind: 'success',
          title: `隧道「${tunnel.name}」已启动`,
          detail: describeEndpoint(tunnel, info)
        })
      } else if (info.status === 'error') {
        useToastStore.getState().push({
          kind: 'error',
          title: '隧道启动失败',
          detail: info.error
        })
      }
    } else {
      // IPC 层面失败（如被异常拦截），恢复为未启动
      set((s) => ({
        runtimes: {
          ...s.runtimes,
          [id]: { tunnelId: id, status: 'stopped', connectionCount: 0 }
        }
      }))
    }
  },

  stop: async (id) => {
    await call(window.api.tunnel.stop(id), { errorTitle: '停止隧道失败' })
  },

  // 主进程用 removed 通知「这条运行时已经消失」（临时转发被回收 / 持久隧道被删除），
  // 不能只当成一次普通状态更新，否则面板上会留一条永远停在最后状态的幽灵行。
  applyRuntime: (info) =>
    set((s) => {
      const runtimes = { ...s.runtimes }
      if (info.removed) delete runtimes[info.tunnelId]
      else runtimes[info.tunnelId] = info
      return { runtimes }
    }),

  setKeyword: (keyword) => set({ keyword }),

  discoverPorts: async (sessionId) => {
    /*
     * 探测要在目标机上跑 ss/netstat，会话已经不在了就别发这条 IPC
     * （主进程会因为找不到会话直接报错，用户看到的是一句莫名其妙的失败提示）。
     */
    const alive = useSessionStore
      .getState()
      .sessions.some((s) => s.id === sessionId && s.status === 'connected')
    if (!alive) {
      useToastStore.getState().push({ kind: 'warning', title: t('tunnel.discoverFailed') })
      return
    }
    set({ discoveringSessionId: sessionId })
    const list = await call(window.api.tunnel.discoverPorts(sessionId), {
      errorTitle: t('tunnel.discoverFailed')
    })
    set((s) => ({
      discoveringSessionId: s.discoveringSessionId === sessionId ? null : s.discoveringSessionId,
      discoveredBySession: list
        ? { ...s.discoveredBySession, [sessionId]: list }
        : s.discoveredBySession
    }))
  },

  quickStart: async (sessionId, port, targetHost) => {
    /*
     * 同端口可能挂在多张网卡上（uhttpd 同时监听 0.0.0.0 与 ::，
     * OpenWrt 上很常见）。只按端口找会永远命中列表里的第一条，
     * 于是点第二行的「转发」其实转发的是第一张网卡 —— 连不通。
     * 面板把该行的 targetHost 一起传进来，按端口 + 主机精确定位。
     */
    const found = (get().discoveredBySession[sessionId] ?? []).find(
      (p) => p.port === port && (targetHost === undefined || p.targetHost === targetHost)
    )
    const info = await call(
      window.api.tunnel.quickStart(sessionId, {
        /*
         * 兜底也必须用调用方给的 targetHost。
         * 探测结果被后来的刷新顶掉（found 为 undefined）时退回 127.0.0.1，
         * 用户点的是 192.168.1.1 那一行，转发却指向本机 —— 连不通且看不出原因。
         */
        targetHost: found?.targetHost ?? targetHost ?? '127.0.0.1',
        targetPort: port,
        process: found?.process
      }),
      { errorTitle: t('tunnel.quickFailed') }
    )
    if (!info) return null
    get().applyRuntime(info)
    return info
  },

  promote: async (ephemeralId, name) => {
    const res = await call(window.api.tunnel.promote(ephemeralId, name), {
      errorTitle: t('tunnel.promoteFailed')
    })
    if (!res) return null
    get().applyRuntime(res.runtime)
    await get().load()
    useToastStore.getState().push({
      kind: 'success',
      title: t('tunnel.promoted', { name: res.config.name })
    })
    return res.config
  },

  openLocal: async (port, protocol) => {
    await call(window.api.tunnel.openLocal(protocol, port), {
      errorTitle: t('tunnel.openFailed')
    })
  },

  clearSessionDiscovery: (sessionId) =>
    set((s) => {
      /*
       * 不能因为「没有缓存列表」就提前返回。
       * 探测请求还在飞、或者第一次探测就失败（列表从未写入）时，
       * 关掉会话后 discoveringSessionId 仍指着它，探测按钮永久转圈。
       */
      const next = { ...s.discoveredBySession }
      delete next[sessionId]
      return {
        discoveredBySession: next,
        discoveringSessionId:
          s.discoveringSessionId === sessionId ? null : s.discoveringSessionId
      }
    })
}))

/** 用于 Toast 的端点描述 */
export function describeEndpoint(tunnel: TunnelConfig, info?: TunnelRuntimeInfo): string {
  const port = info?.actualPort ?? tunnel.bindPort
  if (tunnel.type === 'local') {
    return `本机 ${tunnel.bindHost}:${port} → ${tunnel.targetHost}:${tunnel.targetPort}`
  }
  if (tunnel.type === 'remote') {
    return `远端 ${tunnel.bindHost}:${port} → 本机 ${tunnel.targetHost}:${tunnel.targetPort}`
  }
  return `SOCKS5 代理 ${tunnel.bindHost}:${port}`
}

/** 类型短标签 */
export const TUNNEL_TYPE_LABEL: Record<TunnelConfig['type'], string> = {
  local: '本地 -L',
  remote: '远程 -R',
  dynamic: '动态 -D'
}
