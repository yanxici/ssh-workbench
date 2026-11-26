import net from 'node:net'
import type { Duplex } from 'node:stream'
import { randomUUID } from 'node:crypto'
import type { Client, ClientChannel, TcpConnectionDetails } from 'ssh2'
import type {
  EphemeralTunnelConfig,
  TunnelConfig,
  TunnelRuntimeInfo,
  TunnelStatus
} from '@shared/types'
import { getTunnel, listTunnels, saveTunnel } from '../store/repository'
import { handleSocks5 } from '../util/socks5'
import { sessionManager } from './sessionManager'

/**
 * 端口转发 / 隧道管理。
 *
 * 三种模式（与 ssh 命令行一致）：
 * - local   (-L)：本机监听 → 经 SSH 隧道 → 从远端可达的目标（访问设备 Web UI、内网服务）
 * - remote  (-R)：远端监听 → 经 SSH 隧道 → 从本机可达的目标（临时把本机服务暴露给设备）
 * - dynamic (-D)：本机 SOCKS5 代理，浏览器/工具把流量经隧道从远端出去
 *
 * 生命周期：
 * - 隧道始终挂在一个在线会话上；会话断开时所属隧道自动停止（默认状态置为 error 并提示）；
 * - 一份配置同一时刻只运行一个实例；重复 start 幂等。
 *
 * P0-3 之后多出三种运行时形态，都在这一个 Map 里统一管理：
 * - 持久隧道（配置落 tunnels.json）；
 * - 临时转发（`ephemeral: true`，只在内存里，绝不写盘）；
 * - 挂起态（`status = 'reconnecting'`）：断线但会自动重连时，隧道既不算活也不算死，
 *   等重连成功自动拉起，或等重连放弃后落 error。
 */

type StatusHandler = (info: TunnelRuntimeInfo) => void

/** 会话关闭/重连的时间线信息（由 sessionManager 决定，隧道层只消费） */
export interface TunnelSessionClosedReason {
  /** 用户主动关标签（不是意外断线） */
  byUser: boolean
  /** 断线后还会自动重连（true 时隧道挂起而不是判死） */
  willReconnect: boolean
}

interface TunnelRuntime {
  tunnelId: string
  sessionId: string
  sessionTitle?: string
  status: TunnelStatus
  error?: string
  startedAt?: number
  connectionCount: number
  actualPort?: number
  /** 临时转发（远端端口探测后一键转发）：不落盘，随会话消失 */
  ephemeral?: boolean
  /** 临时转发的配置快照（promote 时据此写盘，重连恢复时据此重建） */
  ephemeralConfig?: EphemeralTunnelConfig
  /** 断线挂起后等重连自动恢复的标记；手动 stop 会把它清掉 */
  resumeOnReconnect?: boolean
  /** local / dynamic：本机监听 server */
  server?: net.Server
  /** remote：forwardIn 的绑定信息（停止时 unforwardIn） */
  remoteBind?: { host: string; port: number }
  /** remote：注册到该客户端分派器上的处理器（停止时撤销） */
  reverseHandler?: ReverseHandler
  client?: Client
  sockets: Set<net.Socket>
  channels: Set<Duplex>
  /**
   * 已作废：stop()/dispose()/会话断开在 start/restore 的 await 期间发生时置位。
   * 启动是异步的（先等会话就绪、等 forwardIn 回调），这期间用户完全可能点了停止。
   * 不检查的话，await 返回后照样 bind 本地端口 —— 变成一个谁都关不掉的幽灵监听
   * （-D 就是一个无认证的 SOCKS5 端口，最危险）。
   */
  stale?: boolean
}

/** 去掉 IPv6 方括号与 IPv4-mapped 前缀，统一小写 */
function stripHostNoise(host: string | undefined): string {
  let h = (host ?? '').trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (h.startsWith('::ffff:')) h = h.slice(7)
  return h
}

/**
 * 绑定地址归一：空 / * / 0.0.0.0 / :: 都表示「所有地址」，返回空串。
 *
 * 回环名一律折成 127.0.0.1：服务端可能把同一个监听报成 localhost、::1 或
 * 127.0.0.1，不折成同一个值，配置里写 localhost 的 -R 会永远匹配不上。
 */
function normalizeBindHost(host: string | undefined): string {
  const h = stripHostNoise(host)
  if (!h || h === '*' || h === '0.0.0.0' || h === '::') return ''
  if (h === 'localhost' || h === '::1') return '127.0.0.1'
  return h
}

/** -R 连接处理器：由分派器统一匹配，命中后自己开本地连接 */
interface ReverseHandler {
  /** 归一化后的绑定地址；空串表示所有地址 */
  bindHost: string
  port: number
  open: (accept: () => ClientChannel, rejectConn: () => void) => void
}

interface TcpDispatcher {
  handlers: Set<ReverseHandler>
  listener: (details: TcpConnectionDetails, accept: () => ClientChannel, reject: () => void) => void
}

/**
 * 每个 SSH 客户端只注册一个 'tcp connection' 分派器。
 *
 * 之前每条 -R 隧道各挂一个监听器、各自判断「不是我就 reject」：GatewayPorts 下
 * 两条 -R 完全可以绑同端口的不同地址（0.0.0.0 与 127.0.0.1），先注册的那个会把
 * 发往另一条隧道的连接先 reject 掉，正常流量当场被掐断；即便都命中还会重复
 * accept/reject，服务端收到矛盾响应。改成单监听器两轮匹配（先精确地址、后通配
 * 地址），全部不命中才 reject 一次。
 */
const dispatchers = new WeakMap<Client, TcpDispatcher>()

function addReverseHandler(client: Client, handler: ReverseHandler): void {
  let dispatcher = dispatchers.get(client)
  if (!dispatcher) {
    const handlers = new Set<ReverseHandler>()
    const listener = (
      details: TcpConnectionDetails,
      accept: () => ClientChannel,
      reject: () => void
    ): void => {
      /*
       * 「上报了 0.0.0.0」与「压根没上报」必须分开：两种情况归一后都是空串，
       * 混在一起时一个精确绑定 127.0.0.1 的 handler 会把发往 0.0.0.0 的
       * 连接先抢走（也就是抢走了另一个隧道的全部流量）。
       */
      const destReported = stripHostNoise(details.destIP) !== ''
      const got = normalizeBindHost(details.destIP)
      let wildcard: ReverseHandler | undefined
      for (const h of handlers) {
        if (h.port !== details.destPort) continue
        // 精确地址优先；服务端没上报 destIP 时无处可比，退化成放行（同原逻辑）
        if (h.bindHost !== '' && (!destReported || got === h.bindHost)) {
          h.open(accept, reject)
          return
        }
        if (h.bindHost === '' && !wildcard) wildcard = h
      }
      if (wildcard) {
        wildcard.open(accept, reject)
        return
      }
      try {
        reject()
      } catch {
        /* 已被处理 */
      }
    }
    dispatcher = { handlers, listener }
    dispatchers.set(client, dispatcher)
    client.on('tcp connection', listener)
  }
  dispatcher.handlers.add(handler)
}

function removeReverseHandler(client: Client, handler: ReverseHandler): void {
  const dispatcher = dispatchers.get(client)
  if (!dispatcher) return
  dispatcher.handlers.delete(handler)
  if (dispatcher.handlers.size > 0) return
  try {
    client.removeListener('tcp connection', dispatcher.listener)
  } catch {
    /* ignore */
  }
  dispatchers.delete(client)
}

class TunnelManager {
  private runtimes = new Map<string, TunnelRuntime>()
  private onStatus: StatusHandler | null = null
  /**
   * 用户在某个会话上手动停掉的持久隧道。
   * 用 sessionId 索引：重连会换 connectionId 但 sessionId 不变，
   * 而「我刚才手动关了这条隧道」这件事必须跨重连保持 —— 否则用户
   * 手动停掉的隧道会在下一次重连成功时自己爬起来。
   */
  private manuallyStopped = new Map<string, Set<string>>()

  setStatusHandler(cb: StatusHandler): void {
    this.onStatus = cb
  }

  /** 全部隧道的实时状态（渲染层初始化时同步一次） */
  states(): TunnelRuntimeInfo[] {
    return [...this.runtimes.values()].map((r) => this.snapshot(r))
  }

  async start(tunnelId: string, sessionId: string): Promise<TunnelRuntimeInfo> {
    const existing = this.runtimes.get(tunnelId)
    if (existing) {
      if (
        (existing.status === 'active' || existing.status === 'starting') &&
        existing.sessionId === sessionId
      ) {
        return this.snapshot(existing)
      }
      // 换会话 / 从 stopped、error、reconnecting 重来：先摘干净旧资源再重建
      this.releaseResources(existing)
    }
    /*
     * 用户点了「启动」——这是明确表达「我要它跑」，与之前那次手动停止无关了。
     * 不擦掉这条记忆的话，手动停过一次的 autoStart 隧道之后连手动都拉不动：
     * 每次 start 都能成功，但下一次重连时它又会被当成「用户关过」而跳过。
     */
    this.manuallyStopped.get(sessionId)?.delete(tunnelId)

    const runtime: TunnelRuntime = {
      tunnelId,
      sessionId,
      sessionTitle: sessionManager.list().find((s) => s.id === sessionId)?.title,
      status: 'starting',
      connectionCount: 0,
      sockets: new Set(),
      channels: new Set()
    }
    /*
     * 先占位再 await。
     *
     * 并发双调是常态（autoStart 在会话就绪后自动拉起 + 用户同时手点「启动」）。
     * 不占位的话两次调用都读不到 existing，各自 await getTunnel 回来后再各写一次
     * runtimes：后写的那份把先写的顶掉，而先写的那份已经 bind 了 net.Server，
     * 于是端口被一个 Map 里再也找不到的 runtime 占死（没有入口能关），
     * 后来的那次启动还会收到假的 EADDRINUSE。占位后第二次调用在开头的
     * existing 分支就看见 'starting' 直接返回同一份快照。
     */
    this.runtimes.set(tunnelId, runtime)
    this.emit(runtime)

    let config: TunnelConfig | undefined
    try {
      config = await getTunnel(tunnelId)
    } catch {
      config = undefined
    }
    if (!config) {
      // 配置读不出来（被删 / 磁盘错误）：别在列表里留一条点不动的错误行
      if (this.runtimes.get(tunnelId) === runtime) this.runtimes.delete(tunnelId)
      runtime.status = 'error'
      runtime.error = '隧道配置不存在，可能已被删除'
      this.emit(runtime)
      throw new Error('隧道配置不存在，可能已被删除')
    }

    try {
      await sessionManager.waitUntilReady(sessionId)
      // 等会话就绪期间用户可能已经点了停止：认准「本 runtime 还是当前那条」
      if (this.runtimes.get(tunnelId) !== runtime || runtime.stale) return this.snapshot(runtime)
      const client = sessionManager.getClient(sessionId)
      if (!client) throw new Error('会话不存在或已断开，请先打开 SSH 连接')
      runtime.client = client
      runtime.sessionTitle = sessionManager.list().find((s) => s.id === sessionId)?.title

      if (config.type === 'local') await this.startLocal(runtime, config, client, config.bindPort)
      else if (config.type === 'dynamic')
        await this.startDynamic(runtime, config, client)
      else await this.startRemote(runtime, config, client)

      if (this.runtimes.get(tunnelId) !== runtime || runtime.stale) {
        // 监听已经建好了但没人要了：当场释放，别留下关不掉的端口
        this.releaseResources(runtime)
        return this.snapshot(runtime)
      }
      runtime.status = 'active'
      runtime.startedAt = Date.now()
      runtime.error = undefined
      runtime.resumeOnReconnect = false
    } catch (err) {
      /*
       * 失败可能只是「我们自己被取消了」：用户等会话就绪期间点了停止，
       * 或者这条 runtime 已被后一次 start 顶掉。此时把状态改成 error 再 emit，
       * 会把用户刚点的「已停止」翻回错误态，已 dispose 的隧道也会被推回前端。
       */
      if (runtime.stale || this.runtimes.get(tunnelId) !== runtime) return this.snapshot(runtime)
      runtime.status = 'error'
      runtime.error = err instanceof Error ? err.message : String(err)
      this.releaseResources(runtime)
    }

    this.emit(runtime)
    return this.snapshot(runtime)
  }

  /**
   * 停止并**彻底移除**运行时（配置被删除时用这个）。
   *
   * stop() 会保留 runtime 只为让 UI 显示「已停止」状态 —— 配置还在，
   * 用户随时能再启动。但配置被删掉之后，留着 runtime 就是幽灵：
   * TUNNEL_LIST 已经列不出这条配置，用户界面上再也找不到入口去关它，
   * 而 net.Server 还在监听本机端口、forwardIn 还绑在远端，
   * 只能重启应用才能释放。-D 类型尤其危险：一个关不掉的 SOCKS5 监听。
   */
  dispose(tunnelId: string): void {
    const runtime = this.runtimes.get(tunnelId)
    if (!runtime) return
    this.releaseResources(runtime)
    runtime.status = 'stopped'
    this.emit(runtime)
    this.runtimes.delete(tunnelId)
  }

  /**
   * 手动停止。
   *
   * 与 dispose 的差别不只是「留不留 runtime」：这里是用户明确表达
   * 「这条我不想跑」，所以要两件事都做到 ——
   *   1. 清掉 resumeOnReconnect，断线重连后不会自己爬起来；
   *   2. 持久隧道记进 manuallyStopped，重连成功时的 autoStart 也跳过它。
   * 临时转发没有「配置」可留，直接删运行时并推 removed。
   */
  stop(tunnelId: string): void {
    const runtime = this.runtimes.get(tunnelId)
    if (!runtime) return
    runtime.resumeOnReconnect = false
    if (runtime.ephemeral) {
      this.releaseResources(runtime)
      this.emit(runtime)
      this.emitRemoved(tunnelId)
      this.runtimes.delete(tunnelId)
      return
    }
    const stopped = this.manuallyStopped.get(runtime.sessionId) ?? new Set<string>()
    stopped.add(tunnelId)
    this.manuallyStopped.set(runtime.sessionId, stopped)
    this.releaseResources(runtime)
    runtime.status = 'stopped'
    runtime.error = undefined
    runtime.startedAt = undefined
    this.emit(runtime)
  }

  /**
   * 会话断开。
   *
   * 两种截然不同的结局，由 reason 决定：
   * - 意外断线且还会自动重连 → 全部挂起成 reconnecting，端口先释放（避免幽灵监听
   *   占着端口让重连后的自己起不来），等 onSessionConnected 再原地拉起；
   * - 用户关标签 / 断线但不重连 → 临时转发直接消失，持久隧道落 stopped / error。
   *
   * reason 缺省时按老语义务处理（error + 固定文案）：verify-tunnel.cjs 与
   * verify-tunnel-lifecycle.cjs 都在用单参调用，语义不能漂。
   */
  onSessionClosed(sessionId: string, reason?: TunnelSessionClosedReason): void {
    const hang = Boolean(reason && !reason.byUser && reason.willReconnect)

    if (hang) {
      for (const runtime of this.runtimes.values()) {
        if (runtime.sessionId !== sessionId) continue
        if (runtime.status !== 'active' && runtime.status !== 'starting') continue
        this.releaseResources(runtime)
        runtime.status = 'reconnecting'
        runtime.error = '连接已断开，等待重连后自动恢复'
        runtime.resumeOnReconnect = true
        this.emit(runtime)
      }
      return
    }

    const byUser = Boolean(reason?.byUser)
    for (const runtime of [...this.runtimes.values()]) {
      if (runtime.sessionId !== sessionId) continue
      runtime.resumeOnReconnect = false
      this.releaseResources(runtime)
      if (runtime.ephemeral) {
        this.emit(runtime)
        this.emitRemoved(runtime.tunnelId)
        this.runtimes.delete(runtime.tunnelId)
        continue
      }
      runtime.status = byUser ? 'stopped' : 'error'
      runtime.error = byUser ? undefined : '会话已断开，隧道已停止'
      runtime.startedAt = byUser ? undefined : runtime.startedAt
      this.emit(runtime)
    }
    this.manuallyStopped.delete(sessionId)
  }

  /**
   * 会话连上了（首次连接或自动重连成功）。
   *
   * 两件事按顺序做，且都必须在拿到新 client 之后：
   *   1. 恢复挂起的隧道（resumeOnReconnect）—— 它们本来就该活着；
   *   2. 拉起 autoStart 的隧道 —— 用户表达过「连上就跑」。
   * 串口会话一律不进（红线）：串口没有 SSH 通道，隧道在语义上不存在。
   */
  async onSessionConnected(
    sessionId: string,
    connectionId: string,
    isReconnect: boolean
  ): Promise<void> {
    let kind: string | undefined
    try {
      kind = sessionManager.kindOf(sessionId)
    } catch {
      kind = undefined
    }
    if (kind === 'serial') return

    for (const runtime of [...this.runtimes.values()]) {
      if (runtime.sessionId !== sessionId) continue
      if (!runtime.resumeOnReconnect) continue
      await this.restore(runtime)
    }

    let configs: TunnelConfig[] = []
    try {
      configs = await listTunnels()
    } catch {
      configs = []
    }
    const stopped = this.manuallyStopped.get(sessionId)
    for (const config of configs) {
      if (config.autoStart !== true) continue
      if (!config.connectionId || config.connectionId !== connectionId) continue
      if (stopped?.has(config.id)) continue
      const current = this.runtimes.get(config.id)
      /*
       * 正在跑（或正在起）就跳过，不管挂在哪个会话上。
       * 旧实现多加了一条「sessionId 不同就跳过」，而关标签后 runtime 会以
       * 旧 sessionId、status='stopped' 一直留在表里 —— 于是同一连接第二次
       * 打开标签时，这条 autoStart 隧道被永久跳过，只有手动点启动才回来。
       * 未运行的 runtime 直接交给 start() 重建（它会先 releaseResources）。
       */
      if (current && (current.status === 'active' || current.status === 'starting')) continue
      try {
        await this.start(config.id, sessionId)
      } catch {
        /* 单条自启失败不该影响其它隧道；错误已经通过 status 事件下发 */
      }
    }
    void isReconnect
  }

  /** 重连彻底放弃：挂起的临时转发直接消失，持久隧道落 error 等用户处置 */
  onReconnectGaveUp(sessionId: string): void {
    for (const runtime of [...this.runtimes.values()]) {
      if (runtime.sessionId !== sessionId) continue
      if (!runtime.resumeOnReconnect) continue
      runtime.resumeOnReconnect = false
      this.releaseResources(runtime)
      if (runtime.ephemeral) {
        this.emit(runtime)
        this.emitRemoved(runtime.tunnelId)
        this.runtimes.delete(runtime.tunnelId)
        continue
      }
      runtime.status = 'error'
      runtime.error = '重连失败，隧道已停止'
      this.emit(runtime)
    }
  }

  /**
   * 会话级临时转发（远端端口探测后一键转发）。
   *
   * 端口策略：优先用目标端口（用户能从 URL 直接猜到映射关系），但低端口
   * （< 1024）在部分设备与本机上要特权，被占用更是常态 —— 这两种情况都
   * 回退到 0 让系统分配，再把真实端口写进 actualPort / ephemeralConfig，
   * 界面按 actualPort 展示。
   *
   * 绝不写 tunnels.json：这是「现在就看一眼」的东西，不是配置。
   */
  async startQuickForward(
    sessionId: string,
    input: { targetHost: string; targetPort: number; process?: string }
  ): Promise<TunnelRuntimeInfo> {
    if (!Number.isInteger(input.targetPort) || input.targetPort <= 0 || input.targetPort > 65535) {
      throw new Error('目标端口不合法')
    }
    const targetHost = input.targetHost || '127.0.0.1'
    // 双击 / 连点会在两次 IPC 之间各起一个 net.Server：同一个端口只可能抢到一个，
    // 另一个要么 EADDRINUSE（回退到随机端口），要么干脆抢到别的端口 —— 界面上就是
    // 两条一模一样的临时转发。同会话同目标已有可用条目时直接复用，不再新建监听。
    for (const existing of this.runtimes.values()) {
      if (existing.sessionId !== sessionId) continue
      if (existing.ephemeral !== true) continue
      if (existing.ephemeralConfig?.targetHost !== targetHost) continue
      if (existing.ephemeralConfig?.targetPort !== input.targetPort) continue
      if (
        existing.status !== 'active' &&
        existing.status !== 'starting' &&
        existing.status !== 'reconnecting'
      ) {
        continue
      }
      return this.snapshot(existing)
    }

    const client = sessionManager.getClient(sessionId)
    if (!client) throw new Error('会话不存在或已断开，请先打开 SSH 连接')

    const tunnelId = 'ephemeral:' + randomUUID()
    const label = input.process ? input.process + ':' + input.targetPort : '临时转发 ' + input.targetPort
    const session = sessionManager.list().find((s) => s.id === sessionId)
    const config: TunnelConfig = {
      id: tunnelId,
      name: label,
      type: 'local',
      bindHost: '127.0.0.1',
      bindPort: input.targetPort,
      targetHost,
      targetPort: input.targetPort,
      connectionId: session?.connectionId,
      createdAt: Date.now(),
      updatedAt: Date.now()
    }
    const runtime: TunnelRuntime = {
      tunnelId,
      sessionId,
      sessionTitle: session?.title,
      status: 'starting',
      connectionCount: 0,
      sockets: new Set(),
      channels: new Set(),
      ephemeral: true,
      ephemeralConfig: {
        name: label,
        type: 'local',
        bindHost: '127.0.0.1',
        bindPort: input.targetPort,
        targetHost,
        targetPort: input.targetPort,
        process: input.process,
        connectionId: session?.connectionId
      }
    }
    this.runtimes.set(tunnelId, runtime)
    this.emit(runtime)

    try {
      runtime.client = client
      await this.listenEphemeral(runtime, config, client, input.targetPort)
      if (runtime.stale || this.runtimes.get(tunnelId) !== runtime) {
        this.releaseResources(runtime)
        return this.snapshot(runtime)
      }
      runtime.status = 'active'
      runtime.startedAt = Date.now()
      runtime.error = undefined
    } catch (err) {
      runtime.status = 'error'
      runtime.error = err instanceof Error ? err.message : String(err)
      this.releaseResources(runtime)
      // 一个监听都没建起来的临时转发留在 runtimes 里只能变成永远点不动的错误行
      // （临时转发是内存对象，没有「删除」入口）。推一帧失败快照后立刻摘键，
      // 界面表现为「转发失败 → 行消失」，用户再按一次可以干净重试。
      const failed = this.snapshot(runtime)
      this.emit(runtime)
      this.runtimes.delete(tunnelId)
      this.emitRemoved(tunnelId)
      return failed
    }
    this.emit(runtime)
    return this.snapshot(runtime)
  }

  /**
   * 把临时转发「原地过户」成持久隧道。
   *
   * 关键在「原地」：不复用 start() 的重新监听路径，而是把现成的 server /
   * sockets / channels 直接换一个 Map 键。重新监听会留下两段窗口 ——
   * 先是旧端口释放（用户正在用的页面立刻断开），再抢端口（可能已被别人占走，
   * EADDRINUSE）。过户期间已建立的连接也必须活着，否则「存下来」这个动作会
   * 顺带打断用户手上的操作。
   */
  async promoteQuickForward(
    ephemeralId: string,
    customName?: string
  ): Promise<{ config: TunnelConfig; runtime: TunnelRuntimeInfo }> {
    const runtime = this.runtimes.get(ephemeralId)
    if (!runtime || !runtime.ephemeral || !runtime.ephemeralConfig) {
      throw new Error('临时转发不存在或已失效')
    }
    const snapshotCfg = runtime.ephemeralConfig
    const port = runtime.actualPort ?? snapshotCfg.bindPort
    const config = await saveTunnel({
      name: customName?.trim() ? customName.trim() : snapshotCfg.name,
      type: 'local',
      bindHost: snapshotCfg.bindHost,
      bindPort: port,
      targetHost: snapshotCfg.targetHost,
      targetPort: snapshotCfg.targetPort,
      connectionId: snapshotCfg.connectionId
    })

    this.runtimes.delete(ephemeralId)
    runtime.tunnelId = config.id
    runtime.ephemeral = undefined
    runtime.ephemeralConfig = undefined
    runtime.actualPort = port
    this.runtimes.set(config.id, runtime)

    this.emitRemoved(ephemeralId)
    this.emit(runtime)
    return { config, runtime: this.snapshot(runtime) }
  }

  /* ------------------------------------------------------------------ *
   *  local (-L)
   * ------------------------------------------------------------------ */

  private startLocal(
    runtime: TunnelRuntime,
    config: TunnelConfig,
    client: Client,
    bindPort: number
  ): Promise<void> {
    if (!config.targetHost || !config.targetPort) {
      throw new Error('本地转发需要填写目标地址与端口')
    }
    const { targetHost, targetPort } = config

    return new Promise<void>((resolve, reject) => {
      let settled = false

      const server = net.createServer((socket) => {
        runtime.sockets.add(socket)
        socket.on('close', () => runtime.sockets.delete(socket))
        socket.on('error', () => socket.destroy())

        client.forwardOut(
          socket.remoteAddress ?? '127.0.0.1',
          socket.remotePort ?? 0,
          targetHost,
          targetPort,
          (err, channel) => {
            if (err) {
              socket.destroy()
              return
            }
            /*
             * forwardOut 是一次往返，回来时本地这段连接很可能已经没了
             * （客户端连上又立刻断开、curl 超时、隧道刚被停）。
             * 此时再把 channel 接上去就是一条无人读的 SSH 通道：数据堆在
             * ssh2 的缓冲里，远端还占着一条 connection，直到超时。
             */
            if (runtime.stale || socket.destroyed || !socket.writable) {
              try {
                channel.end()
              } catch {
                /* ignore */
              }
              socket.destroy()
              return
            }
            runtime.connectionCount += 1
            runtime.channels.add(channel)
            channel.on('close', () => {
              runtime.channels.delete(channel)
              socket.destroy()
            })
            channel.on('error', () => socket.destroy())
            socket.pipe(channel)
            channel.pipe(socket)
            socket.on('close', () => {
              try {
                channel.end()
              } catch {
                /* ignore */
              }
            })
          }
        )
      })

      server.on('error', (err: NodeJS.ErrnoException) => {
        const message =
          err.code === 'EADDRINUSE'
            ? '本机端口 ' + bindPort + ' 已被占用'
            : err.code === 'EACCES'
              ? '无权限监听 ' + config.bindHost + ':' + bindPort
              : '监听失败：' + err.message
        try {
          server.close()
        } catch {
          /* ignore */
        }
        runtime.server = undefined
        if (!settled) {
          settled = true
          // 保留 errno：临时转发要靠它区分「端口被占，回退到随机端口」与真正的失败
          const wrapped = new Error(message) as NodeJS.ErrnoException
          wrapped.code = err.code
          reject(wrapped)
        } else {
          runtime.status = 'error'
          runtime.error = message
          this.emit(runtime)
        }
      })

      server.listen(bindPort, config.bindHost, () => {
        settled = true
        runtime.server = server
        // bindPort 为 0 时真实端口由系统分配，只能从 address() 读回来
        const addr = server.address()
        if (addr && typeof addr === 'object') runtime.actualPort = addr.port
        resolve()
      })
    })
  }

  /** 临时转发的监听：优先 requested，撞端口或特权不足就退到系统分配 */
  private async listenEphemeral(
    runtime: TunnelRuntime,
    config: TunnelConfig,
    client: Client,
    requested: number
  ): Promise<void> {
    const preferred = Number.isInteger(requested) && requested >= 1024 ? requested : 0
    try {
      await this.startLocal(runtime, config, client, preferred)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      const retriable = preferred !== 0 && (code === 'EADDRINUSE' || code === 'EACCES')
      if (!retriable) throw err
      config.bindPort = 0
      await this.startLocal(runtime, config, client, 0)
    }
    const actual = runtime.actualPort ?? preferred
    runtime.actualPort = actual
    if (runtime.ephemeralConfig) runtime.ephemeralConfig.bindPort = actual
  }

  /* ------------------------------------------------------------------ *
   *  remote (-R)
   * ------------------------------------------------------------------ */

  private startRemote(runtime: TunnelRuntime, config: TunnelConfig, client: Client): Promise<void> {
    if (!config.targetHost || !config.targetPort) {
      throw new Error('远程转发需要填写本机目标地址与端口')
    }
    const { targetHost, targetPort } = config

    return new Promise<void>((resolve, reject) => {
      client.forwardIn(config.bindHost, config.bindPort, (err, port) => {
        if (err) {
          reject(
            new Error(
              '远端绑定 ' +
                config.bindHost +
                ':' +
                config.bindPort +
                ' 失败：' +
                err.message +
                '（部分设备未开启 GatewayPorts 或端口受限）'
            )
          )
          return
        }

        runtime.remoteBind = { host: config.bindHost, port }
        runtime.actualPort = port

        /*
         * 同一客户端上可能挂多个 -R 隧道，交给分派器按 destPort + 绑定地址选人。
         * 分派器只在全部隧道都不匹配时 reject 一次（早退不 reject 会漏通道），
         * 命中后这里只管开本地连接。
         */
        const handler: ReverseHandler = {
          bindHost: normalizeBindHost(config.bindHost),
          port,
          open: (accept, rejectConn) => {
            /*
             * accepted 之后不能再 reject：accept() 已经把通道交给 ssh2，
             * 迟到的 error（本地目标连上后又断）再 reject 一次，服务端会收到
             * 一个已经作废的响应，那条连接在两边的状态从此对不上。
             */
            let accepted = false
            const local = net.connect({ host: targetHost, port: targetPort })
            runtime.sockets.add(local)
            local.on('error', () => {
              runtime.sockets.delete(local)
              // connect 回调里先查 runtime.stale / 已销毁：隧道停止后建出来的连接没人收
              if (accepted || runtime.stale) return
              try {
                rejectConn()
              } catch {
                /* ignore */
              }
            })
            local.on('close', () => runtime.sockets.delete(local))

            local.on('connect', () => {
              if (runtime.stale || local.destroyed) {
                local.destroy()
                if (!accepted) {
                  try {
                    rejectConn()
                  } catch {
                    /* ignore */
                  }
                }
                return
              }
              let channel: ClientChannel
              try {
                channel = accept()
              } catch {
                local.destroy()
                return
              }
              accepted = true
              runtime.connectionCount += 1
              runtime.channels.add(channel)
              channel.on('close', () => {
                runtime.channels.delete(channel)
                local.destroy()
              })
              channel.on('error', () => local.destroy())
              local.pipe(channel)
              channel.pipe(local)
              local.on('close', () => {
                try {
                  channel.end()
                } catch {
                  /* ignore */
                }
              })
            })
          }
        }

        addReverseHandler(client, handler)
        runtime.reverseHandler = handler
        resolve()
      })
    })
  }

  /* ------------------------------------------------------------------ *
   *  dynamic (-D)：本机 SOCKS5 代理（仅 CONNECT，无认证）
   * ------------------------------------------------------------------ */

  private startDynamic(
    runtime: TunnelRuntime,
    config: TunnelConfig,
    client: Client
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false

      const server = net.createServer((socket) => {
        runtime.sockets.add(socket)
        socket.on('close', () => runtime.sockets.delete(socket))

        // handleSocks5 内部自带错误兜底与协议处理
        handleSocks5(socket, {
          open: (host, port) =>
            new Promise<Duplex>((resolve, reject) => {
              client.forwardOut('127.0.0.1', 0, host, port, (err, channel) =>
                err ? reject(err) : resolve(channel)
              )
            }),
          onOpen: (channel) => {
            runtime.connectionCount += 1
            runtime.channels.add(channel)
            channel.on('close', () => runtime.channels.delete(channel))
          }
        })
      })

      server.on('error', (err: NodeJS.ErrnoException) => {
        const message =
          err.code === 'EADDRINUSE'
            ? '本机端口 ' + config.bindPort + ' 已被占用'
            : err.code === 'EACCES'
              ? '无权限监听 ' + config.bindHost + ':' + config.bindPort
              : '监听失败：' + err.message
        try {
          server.close()
        } catch {
          /* ignore */
        }
        runtime.server = undefined
        if (!settled) {
          settled = true
          reject(new Error(message))
        } else {
          runtime.status = 'error'
          runtime.error = message
          this.emit(runtime)
        }
      })

      server.listen(config.bindPort, config.bindHost, () => {
        settled = true
        runtime.server = server
        const addr = server.address()
        if (addr && typeof addr === 'object') runtime.actualPort = addr.port
        resolve()
      })
    })
  }

  /* ------------------------------------------------------------------ *
   *  内部
   * ------------------------------------------------------------------ */

  /** 重连成功后把一条挂起的隧道重新拉起来（临时转发与持久隧道同一条路径） */
  private async restore(runtime: TunnelRuntime): Promise<void> {
    const config = await this.configOf(runtime)
    /*
     * configOf 是 await 的（持久隧道要回读 tunnels.json）。这期间用户完全可能
     * 已经 stop()/dispose() 掉这条隧道，或者它已被一条新的 runtime 顶掉。
     * 不在这里拦一道，下面的 `runtime.stale = false` 会把刚打上的作废标记擦掉，
     * 然后照原样把端口重新监听起来 —— 变成一个界面上已经不存在的幽灵监听。
     */
    if (this.runtimes.get(runtime.tunnelId) !== runtime || !runtime.resumeOnReconnect) return
    if (!config) {
      runtime.resumeOnReconnect = false
      runtime.status = 'error'
      runtime.error = '隧道配置不存在，可能已被删除'
      this.emit(runtime)
      return
    }
    /*
     * 重新武装：上一条生命周期（断线挂起 / 用户停止）在 releaseResources 里
     * 打过 stale 标记，不擦掉的话这次恢复会在 waitUntilReady 之后当作废处理
     * 直接返回，隧道永远停在 starting。
     */
    runtime.stale = false
    runtime.status = 'starting'
    this.emit(runtime)
    try {
      await sessionManager.waitUntilReady(runtime.sessionId)
      // 恢复也是异步的：等就绪期间用户可能 stop/dispose 了这条隧道
      if (runtime.stale || this.runtimes.get(runtime.tunnelId) !== runtime) return
      const client = sessionManager.getClient(runtime.sessionId)
      if (!client) throw new Error('会话不存在或已断开，请先打开 SSH 连接')
      runtime.client = client
      runtime.connectionCount = 0
      runtime.sessionTitle = sessionManager.list().find((s) => s.id === runtime.sessionId)?.title
      if (runtime.ephemeral && runtime.ephemeralConfig) {
        await this.listenEphemeral(runtime, config, client, runtime.ephemeralConfig.bindPort)
      } else if (config.type === 'local') {
        await this.startLocal(runtime, config, client, config.bindPort)
      } else if (config.type === 'dynamic') {
        await this.startDynamic(runtime, config, client)
      } else {
        await this.startRemote(runtime, config, client)
      }
      /*
       * 监听建好之后再确认一次归属。startLocal/startRemote 都是异步的
       * （listen 回调、forwardIn 往返），这期间用户点了停止就是停掉了；
       * 少了这一道，stop() 会看到「还没 bind」而直接返回，我们随后才把端口
       * 监听起来并标成 active —— 一个谁都关不掉的幽灵端口（-D 尤其危险）。
       */
      if (runtime.stale || this.runtimes.get(runtime.tunnelId) !== runtime) {
        this.releaseResources(runtime)
        return
      }
      runtime.status = 'active'
      runtime.startedAt = Date.now()
      runtime.error = undefined
      runtime.resumeOnReconnect = false
    } catch (err) {
      // 同上：取消导致的失败不该覆写成 error
      if (runtime.stale || this.runtimes.get(runtime.tunnelId) !== runtime) return
      runtime.status = 'error'
      runtime.error = err instanceof Error ? err.message : String(err)
      runtime.resumeOnReconnect = false
      this.releaseResources(runtime)
    }
    this.emit(runtime)
  }

  /** 运行时对应的配置：临时转发来自内存快照，持久隧道回读 tunnels.json */
  private async configOf(runtime: TunnelRuntime): Promise<TunnelConfig | null> {
    if (runtime.ephemeral && runtime.ephemeralConfig) {
      const e = runtime.ephemeralConfig
      return {
        id: runtime.tunnelId,
        name: e.name,
        type: 'local',
        bindHost: e.bindHost,
        bindPort: runtime.actualPort ?? e.bindPort,
        targetHost: e.targetHost,
        targetPort: e.targetPort,
        connectionId: e.connectionId,
        createdAt: 0,
        updatedAt: 0
      }
    }
    try {
      return (await getTunnel(runtime.tunnelId)) ?? null
    } catch {
      return null
    }
  }

  private releaseResources(runtime: TunnelRuntime): void {
    // 作废标记：让还在 await 里的 start/restore 返回后不要再 bind
    runtime.stale = true
    if (runtime.server) {
      try {
        runtime.server.close()
      } catch {
        /* ignore */
      }
      runtime.server = undefined
    }
    if (runtime.client && runtime.reverseHandler) {
      removeReverseHandler(runtime.client, runtime.reverseHandler)
      runtime.reverseHandler = undefined
    }
    if (runtime.client && runtime.remoteBind) {
      const { host, port } = runtime.remoteBind
      try {
        runtime.client.unforwardIn(host, port, () => {})
      } catch {
        /* ignore */
      }
      runtime.remoteBind = undefined
    }
    for (const socket of runtime.sockets) {
      try {
        socket.destroy()
      } catch {
        /* ignore */
      }
    }
    for (const channel of runtime.channels) {
      try {
        channel.end()
      } catch {
        /* ignore */
      }
    }
    runtime.sockets.clear()
    runtime.channels.clear()
  }

  private snapshot(runtime: TunnelRuntime): TunnelRuntimeInfo {
    return {
      tunnelId: runtime.tunnelId,
      status: runtime.status,
      sessionId: runtime.sessionId,
      sessionTitle: runtime.sessionTitle,
      error: runtime.error,
      startedAt: runtime.startedAt,
      connectionCount: runtime.connectionCount,
      actualPort: runtime.actualPort,
      ephemeral: runtime.ephemeral,
      ephemeralConfig: runtime.ephemeralConfig
    }
  }

  private emit(runtime: TunnelRuntime): void {
    this.onStatus?.(this.snapshot(runtime))
  }

  /** 「这个键消失了」的信号：渲染层据此从 Map 里删条目而不是标成 stopped */
  private emitRemoved(tunnelId: string): void {
    this.onStatus?.({ tunnelId, status: 'stopped', removed: true, connectionCount: 0 })
  }
}

/**
 * 拼本地转发地址给「打开浏览器」用。
 *
 * 严格白名单：只认 http / https 与小写协议名，端口必须是 1..65535 的整数，
 * 主机名写死 127.0.0.1。隧道目标来自远端探测结果，把它拼进 URL 再交给
 * shell.openExternal 等于让远端设备决定本机打开什么 —— 协议位置一旦能注入
 * （javascript:、file:、data:），点一下「打开」就是本机执行。
 */
export function buildSafeLocalTunnelUrl(protocol: 'http' | 'https', port: number): string {
  if (protocol !== 'http' && protocol !== 'https') {
    throw new Error('不支持的协议：' + String(protocol))
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('端口不合法：' + String(port))
  }
  return protocol + '://127.0.0.1:' + port
}

export const tunnelManager = new TunnelManager()
