import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { StringDecoder } from 'node:string_decoder'
import type {
  AppSettings,
  ConnStatus,
  Connection,
  ReconnectEvent,
  SessionInfo
} from '@shared/types'
import { getConnection, getSettings, touchConnection } from '../store/repository'
import { recorder } from '../store/recorder'
import { getSecret } from '../store/vault'
import {
  buildConnectConfig,
  connectClient,
  connectWithOptionalProxy,
  forwardThrough,
  humanizeConnectError,
  takeHostKeyMismatch
} from './connectConfig'

/**
 * SSH 会话管理 —— 全部 SSH 行为都发生在主进程（Node 侧），渲染进程零直连。
 *
 * 关键设计：
 * - 多跳 ProxyJump：逐跳 forwardOut + sock 串联；
 * - 主机指纹校验：首次连接记录，后续不一致时拒绝（可在设置中放开）；
 * - 输出合帧：8ms 窗口内的数据合并为一条 IPC 消息，减少高频输出时的 IPC 次数；
 *   StringDecoder 保证跨帧的多字节 UTF-8 字符不被切断；
 * - 延迟探测：每 5s 执行一次 `echo` 轻命令测往返（可在设置中关闭）。
 */

export interface SessionEvents {
  onData: (sessionId: string, data: string, raw: Buffer) => void
  onStatus: (sessionId: string, status: ConnStatus, error?: string) => void
  onLatency: (sessionId: string, ms: number) => void
}

interface SessionRecord {
  id: string
  connectionId: string
  connectionName: string
  host: string
  username: string
  status: ConnStatus
  error?: string
  createdAt: number
  cols: number
  rows: number
  latencyMs?: number
  client: Client
  shell?: ClientChannel
  /** 跳板链上所有中间连接，关闭时一并清理 */
  jumpClients: Client[]
  decoder: StringDecoder
  pending: Buffer[]
  flushTimer?: NodeJS.Timeout
  /** 最近一次探测的时刻 / 是否正在进行，供全局轮转探针调度 */
  probedAt?: number
  probing?: boolean
  closedByUser: boolean
  /** 同一 SSH 连接上的终端（shell）共享的引用计数：归零才真正断开连接 */
  shared: { refs: number }
  /** 已拆除：client 的 close/error 可能在 shell close 之后再触发，防止重复 teardown */
  closed: boolean
  /** cleanup 已执行（失败路径与 teardown 都会调用，需幂等） */
  cleaned: boolean
  /** 解绑本记录挂在共享 client 上的监听 */
  offClient?: () => void
}

/**
 * 延迟探测：全局一个节拍器，每 1 秒探一个会话并轮转。
 * 旧实现是每个会话各挂一个 5s 定时器，N 个会话就是每 5 秒 N 次 exec，
 * 连接一多直接把链路和主进程压满。
 */
const PROBE_TICK_MS = 1000
/** 同一会话的最小探测间隔：会话少时给出 5s 级别的新鲜度，会话多时自然被拉长 */
const PROBE_MIN_GAP_MS = 5000
const FLUSH_INTERVAL_MS = 8
/** 等待会话就绪的默认上限（连接握手未完成的挂起请求） */
const READY_TIMEOUT_MS = 30_000

/** 就绪等待者：会话进入 connected 时 resolve，失败/断开/超时时 reject */
interface ReadyWaiter {
  resolve: () => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

class SessionManager {
  private sessions = new Map<string, SessionRecord>()
  /**
   * SFTP 预挂载回调。
   *
   * 不能在这里直接 import sftpManager —— sftpManager 已经 import 了本模块，
   * 互相 import 会让其中一方在初始化阶段拿到 undefined。
   * 改由 main 入口注入，回调未注入时静默跳过（预热只是优化）。
   */
  private sftpPrewarm: ((sessionId: string) => Promise<void>) | null = null
  /** 自动重连进度回调，由 main 转发到渲染层 */
  private onReconnect:
    | ((e: ReconnectEvent) => void)
    | null = null

  setReconnectHandler(fn: (e: ReconnectEvent) => void): void {
    this.onReconnect = fn
  }
  /**
   * 每个会话的自动重连进度。
   * 用 sessionId 索引而不是挂在 SessionRecord 上：teardown 会把 record 从
   * sessions 里删掉，重连期间我们需要独立于旧 record 保存"重试到第几次了"。
   */
  private reconnectState = new Map<
    string,
    {
      attempt: number
      timer?: NodeJS.Timeout
      /** 重连时复用的会话信息（record 已被 teardown 删除，只能靠快照） */
      connectionId: string
      title: string
      cols: number
      rows: number
    }
  >()
  private handlers: SessionEvents | null = null
  /** 会话关闭钩子（供 SFTP 等模块清理挂在会话上的资源） */
  private onClosed: ((sessionId: string) => void) | null = null
  /** 「等待就绪」挂起队列（SFTP/隧道等子系统在握手完成后才能挂载） */
  private readyWaiters = new Map<string, Set<ReadyWaiter>>()
  /** open() 尚未登记会话（还在读连接/凭据）的 id */
  private opening = new Set<string>()
  /** 登记前就被关闭的 id：open() 读完配置后直接放弃 */
  private cancelled = new Set<string>()

  setHandlers(handlers: SessionEvents): void {
    this.handlers = handlers
  }

  setOnClosed(cb: (sessionId: string) => void): void {
    this.onClosed = cb
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      connectionId: s.connectionId,
      connectionName: s.connectionName,
      host: s.host,
      username: s.username,
      title: s.connectionName,
      status: s.status,
      error: s.error,
      createdAt: s.createdAt,
      latencyMs: s.latencyMs,
      cols: s.cols,
      rows: s.rows
    }))
  }

  /** 供 SFTP 模块在已建立的连接上挂载 SFTP 子系统 */
  getClient(sessionId: string): Client | undefined {
    return this.sessions.get(sessionId)?.client
  }

  /* ------------------------------------------------------------------ *
   *  会话就绪等待
   * ------------------------------------------------------------------ */

  /**
   * 等待会话完成握手进入 connected 状态（SFTP/隧道等子系统只能在其后挂载）。
   *
   * 修复背景：会话记录在创建瞬间就进入 Map 并广播 connecting，此时其中的
   * client 还是未连接的占位对象。若此刻直接在它上面挂载 SFTP 会立即失败，
   * 且调用方（文件树）不会再重试 —— 表现为「无法获取远端目录」。
   */
  waitUntilReady(sessionId: string, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
    const record = this.sessions.get(sessionId)
    if (!record) return Promise.reject(new Error('会话不存在或已断开，请先打开 SSH 连接'))
    if (record.status === 'connected') return Promise.resolve()
    if (record.status === 'error') return Promise.reject(new Error(record.error ?? '会话连接失败'))
    if (record.status === 'disconnected') return Promise.reject(new Error('会话已断开'))

    return new Promise<void>((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.removeReadyWaiter(sessionId, waiter)
          reject(new Error('等待会话就绪超时，设备响应较慢，请稍后重试'))
        }, timeoutMs)
      }
      const set = this.readyWaiters.get(sessionId) ?? new Set<ReadyWaiter>()
      set.add(waiter)
      this.readyWaiters.set(sessionId, set)
    })
  }

  /** 状态变化时结算挂起的等待者（connected 放行；error/disconnected 拒绝） */
  private settleReadyWaiters(sessionId: string, status: ConnStatus, error?: string): void {
    const set = this.readyWaiters.get(sessionId)
    if (!set || set.size === 0) return
    if (status !== 'connected' && status !== 'error' && status !== 'disconnected') return
    this.readyWaiters.delete(sessionId)
    for (const waiter of set) {
      clearTimeout(waiter.timer)
      if (status === 'connected') {
        waiter.resolve()
      } else {
        waiter.reject(new Error(error ?? (status === 'error' ? '会话连接失败' : '会话已断开')))
      }
    }
  }

  private removeReadyWaiter(sessionId: string, waiter: ReadyWaiter): void {
    const set = this.readyWaiters.get(sessionId)
    if (!set) return
    set.delete(waiter)
    if (set.size === 0) this.readyWaiters.delete(sessionId)
  }

  /* ------------------------------------------------------------------ *
   *  打开会话
   * ------------------------------------------------------------------ */

  async open(sessionId: string, connectionId: string, cols: number, rows: number): Promise<void> {
    if (this.sessions.has(sessionId) || this.opening.has(sessionId)) return

    // 读连接/凭据期间会话还没登记，这时到达的 close 记到 cancelled 里，登记前检查
    this.opening.add(sessionId)
    let conn: Connection | undefined
    let secret: Awaited<ReturnType<typeof getSecret>>
    let settings: AppSettings
    try {
      conn = await getConnection(connectionId)
      if (!conn) throw new Error('连接不存在，可能已被删除')
      secret = await getSecret(connectionId)
      settings = await getSettings()
    } finally {
      this.opening.delete(sessionId)
    }
    if (this.cancelled.delete(sessionId)) return

    const record: SessionRecord = {
      id: sessionId,
      connectionId,
      connectionName: conn.name,
      host: conn.host,
      username: conn.username,
      status: 'connecting',
      createdAt: Date.now(),
      cols,
      rows,
      client: new Client(),
      jumpClients: [],
      decoder: new StringDecoder('utf-8'),
      pending: [],
      closedByUser: false,
      shared: { refs: 1 },
      closed: false,
      cleaned: false
    }
    this.sessions.set(sessionId, record)
    this.emitStatus(record, 'connecting')

    try {
      const cfg = await buildConnectConfig(conn, secret, settings)

      // ---- 建立连接（含跳板链；SOCKS5/HTTP 代理作用于第一条 socket）----
      const client =
        conn.proxyJump && conn.proxyJump.length > 0
          ? await this.connectThroughJumps(record, conn, cfg, settings, secret.proxyPassword)
          : await connectWithOptionalProxy(cfg, {
              host: conn.host,
              port: conn.port,
              proxy: conn.proxy,
              proxyPassword: secret.proxyPassword
            })

      // 连接建立期间用户已关闭标签：释放刚建好的连接，避免泄漏
      if (record.closed) {
        this.endQuietly(client, record.jumpClients)
        record.jumpClients = []
        return
      }

      // 多个终端共用此连接，每个终端各挂一组监听
      client.setMaxListeners(0)
      record.client = client
      this.wireClientEvents(record)
      this.emitStatus(record, 'connected')
      // 后台预热 SFTP：把首次打开文件面板的握手延迟提前吃掉
      void this.prewarmSftp(record.id)

      // ---- 打开交互式 shell ----
      await this.attachShell(record)

      await touchConnection(connectionId)
      // 延迟探测：起全局节拍器即可，单会话不再各自挂定时器
      if (settings.latencyProbe) this.ensureProbeTicker()

      // 会话日志录制（asciinema cast 格式，可在「会话日志」面板回放）
      if (settings.autoLog) {
        void recorder.start(sessionId, conn.name, record.cols, record.rows).catch(() => {})
      }
    } catch (err) {
      const message = this.describeError(err, conn)
      // 已被关闭 / 拆除（如连接中途关掉标签）：状态已广播过，不再覆盖成 error
      if (record.closed) throw new Error(message)
      this.failRecord(record, message)
      throw new Error(message)
    }
  }

  /**
   * 会话内新建终端：在 hostSessionId 已建立的 SSH 连接上再开一个 shell，免重新登录。
   * 新终端拥有独立的 sessionId（输入输出、录制、关闭互不影响），共享底层连接。
   */
  async openShell(
    sessionId: string,
    connectionId: string,
    hostSessionId: string,
    cols: number,
    rows: number
  ): Promise<void> {
    if (this.sessions.has(sessionId)) return
    const host = this.sessions.get(hostSessionId)
    if (!host || host.status !== 'connected' || host.closed) {
      throw new Error('所属会话未连接，无法在其上新建终端')
    }
    if (host.connectionId !== connectionId) throw new Error('终端与所属会话的连接不一致')

    const record: SessionRecord = {
      id: sessionId,
      connectionId: host.connectionId,
      connectionName: host.connectionName,
      host: host.host,
      username: host.username,
      status: 'connecting',
      createdAt: Date.now(),
      cols,
      rows,
      latencyMs: host.latencyMs,
      client: host.client,
      // 与宿主共享同一跳板链数组，最后一个终端关闭时统一断开
      jumpClients: host.jumpClients,
      decoder: new StringDecoder('utf-8'),
      pending: [],
      closedByUser: false,
      shared: host.shared,
      closed: false,
      cleaned: false
    }
    record.shared.refs++
    // 先登记再 await：期间到达的 resize 能记到 record 上，shell 以真实尺寸打开
    this.sessions.set(sessionId, record)
    this.emitStatus(record, 'connecting')

    try {
      this.wireClientEvents(record)
      await this.attachShell(record)
      this.emitStatus(record, 'connected')
      void this.prewarmSftp(record.id)

      const settings = await getSettings()
      if (settings.autoLog && !record.closed) {
        void recorder.start(sessionId, record.connectionName, record.cols, record.rows).catch(() => {})
      }
    } catch (err) {
      const message = humanizeConnectError(err instanceof Error ? err.message : String(err))
      if (record.closed) throw new Error(message)
      this.failRecord(record, message)
      throw new Error(message)
    }
  }

  /** 在 record.client 上打开交互式 shell 并接好数据流 */
  private async attachShell(record: SessionRecord): Promise<void> {
    const shell = await new Promise<ClientChannel>((resolve, reject) => {
      record.client.shell(
        { term: 'xterm-256color', cols: record.cols, rows: record.rows },
        (err, channel) => (err ? reject(err) : resolve(channel))
      )
    })
    // shell 打开期间被关闭：直接收掉，不再挂到已拆除的记录上
    if (record.closed) {
      try {
        shell.end()
      } catch {
        /* ignore */
      }
      throw new Error('会话已关闭')
    }
    record.shell = shell

    shell.on('data', (chunk: Buffer) => this.feed(record, chunk))
    shell.stderr.on('data', (chunk: Buffer) => this.feed(record, chunk))
    shell.on('close', () => {
      if (!record.closedByUser) this.teardown(record, 'disconnected')
    })
  }

  /** 打开失败：广播 error 并释放资源（只处理仍属于本记录的 Map 项） */
  private failRecord(record: SessionRecord, message: string): void {
    record.closed = true
    record.status = 'error'
    record.error = message
    this.emitStatus(record, 'error', message)
    this.cleanup(record)
    if (this.sessions.get(record.id) === record) this.sessions.delete(record.id)
  }

  private endQuietly(client: Client, jumps: Client[]): void {
    for (const c of [client, ...jumps]) {
      try {
        c.end()
      } catch {
        /* ignore */
      }
    }
  }

  /** 逐跳建立 ProxyJump 链，返回最终到目标主机的连接 */
  private async connectThroughJumps(
    record: SessionRecord,
    target: Connection,
    targetCfg: ConnectConfig,
    settings: AppSettings,
    targetProxyPassword?: string
  ): Promise<Client> {
    let prev: Client | null = null

    for (const jumpId of target.proxyJump ?? []) {
      const jumpConn = await getConnection(jumpId)
      if (!jumpConn) throw new Error(`跳板机连接不存在（id: ${jumpId}）`)
      const jumpSecret = await getSecret(jumpId)
      const jumpCfg = await buildConnectConfig(jumpConn, jumpSecret, settings)

      let client: Client
      if (!prev) {
        // 第一跳：目标连接配置的代理作用于它（后续跳走 SSH 隧道）
        client = await connectWithOptionalProxy(jumpCfg, {
          host: jumpConn.host,
          port: jumpConn.port,
          proxy: target.proxy,
          proxyPassword: targetProxyPassword
        })
      } else {
        const tunnel = await forwardThrough(prev, jumpConn.host, jumpConn.port)
        client = await connectClient(jumpCfg, tunnel)
      }
      record.jumpClients.push(client)
      prev = client
    }

    if (!prev) {
      return connectWithOptionalProxy(targetCfg, {
        host: target.host,
        port: target.port,
        proxy: target.proxy,
        proxyPassword: targetProxyPassword
      })
    }
    const tunnel = await forwardThrough(prev, target.host, target.port)
    return connectClient(targetCfg, tunnel)
  }

  /** 连接建立后的掉线处理 */
  private wireClientEvents(record: SessionRecord): void {
    const client = record.client
    const onClose = (): void => {
      if (!record.closedByUser) this.teardown(record, 'disconnected')
    }
    const onError = (err: Error): void => {
      if (!record.closedByUser) this.teardown(record, 'error', err.message)
    }
    client.on('close', onClose)
    client.on('error', onError)
    record.offClient = () => {
      client.off('close', onClose)
      client.off('error', onError)
    }
  }

  private describeError(err: unknown, conn: Connection): string {
    const raw = err instanceof Error ? err.message : String(err)
    if (/host key|verif|Host denied/i.test(raw)) {
      const mismatch = takeHostKeyMismatch(conn.host, conn.port)
      if (mismatch) {
        return (
          `主机指纹已变化（${conn.host}:${conn.port}）\n` +
          `记录中：${mismatch.known ?? '（无）'}\n` +
          `设备当前：${mismatch.actual}\n` +
          '若设备确实重装系统或升级过固件，请到 设置 → 已知主机指纹 点该记录上的指纹按钮确认更新。'
        )
      }
      return `主机指纹校验未通过（${conn.host}:${conn.port}）。若设备已重装或固件升级导致密钥变化，请在 设置 → 已知主机 中更新该记录后重试。`
    }
    return humanizeConnectError(raw)
  }

  /* ------------------------------------------------------------------ *
   *  数据写入 / 窗口
   * ------------------------------------------------------------------ */

  write(sessionId: string, data: string): void {
    const rec = this.sessions.get(sessionId)
    if (rec?.shell) {
      rec.shell.write(data)
      recorder.appendInput(sessionId, data)
    }
  }

  /**
   * 写入原始字节（ZMODEM 等二进制协议用）。
   * 不能走 write()：那里的 string 会被 ssh2 按 UTF-8 编码，>127 的字节会变成多字节序列而失真。
   * 二进制内容也不写进会话录制，避免污染日志。
   */
  writeBytes(sessionId: string, data: Buffer): void {
    const rec = this.sessions.get(sessionId)
    if (rec?.shell) rec.shell.write(data)
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const rec = this.sessions.get(sessionId)
    if (!rec) return
    rec.cols = cols
    rec.rows = rows
    try {
      rec.shell?.setWindow(rows, cols, 0, 0)
    } catch {
      // 连接已断开时忽略
    }
  }

  /** 广播输入：多个会话同时写入 */
  broadcast(sessionIds: string[], data: string): void {
    for (const id of sessionIds) this.write(id, data)
  }

  /* ------------------------------------------------------------------ *
   *  关闭 / 清理
   * ------------------------------------------------------------------ */

  close(sessionId: string, silent = false): void {
    const rec = this.sessions.get(sessionId)
    if (!rec) {
      if (this.opening.has(sessionId)) this.cancelled.add(sessionId)
      return
    }
    rec.closedByUser = true
    this.teardown(rec, 'disconnected', undefined, silent)
  }

  private teardown(
    record: SessionRecord,
    status: ConnStatus,
    error?: string,
    silent = false
  ): void {
    // shell close 与 client close 会先后触发，只处理第一次；
    // 否则重连复用同一 sessionId 后，旧记录的迟到事件会误删新会话
    if (record.closed) return
    record.closed = true
    this.flush(record)
    recorder.stop(record.id)
    this.cleanup(record)
    if (this.sessions.get(record.id) === record) this.sessions.delete(record.id)
    // 静默关闭（如用户主动关闭）不会 emitStatus，也要拒绝挂起的等待者
    this.settleReadyWaiters(record.id, status, error)
    this.onClosed?.(record.id)
    if (!silent) this.emitStatus(record, status, error)

    /*
     * 自动重连：只在「非用户主动关闭」且状态是 disconnected/error 时启动。
     * 用户点了关闭标签（closedByUser）或程序退出时不重连 —— 那是主动行为，
     * 重连会让用户觉得"关不掉"。
     */
    if (!record.closedByUser && (status === 'disconnected' || status === 'error')) {
      void this.scheduleReconnect(record)
    }
  }

  /**
   * 安排一次自动重连（指数退避）。
   *
   * 退避序列（秒）：1, 2, 4, 8, 16 —— 上限 30s，默认最多 5 次。
   * 为什么退避：服务器重启或网络中断时，立刻重试只会连续撞墙，
   * 既刷日志又给对方增加无谓负担。退避能让短抖动（1~2 秒）快速恢复，
   * 长中断则慢慢重试直到放弃。
   *
   * 放弃条件：次数用尽，或用户主动关闭该标签。
   */
  private async scheduleReconnect(record: SessionRecord): Promise<void> {
    const existing = this.reconnectState.get(record.id)
    const attempt = (existing?.attempt ?? 0) + 1

    let settings: AppSettings
    try {
      settings = await getSettings()
    } catch {
      return
    }
    if (settings.autoReconnect === false) return

    const max = Math.max(1, Math.min(settings.autoReconnectMax ?? 5, 20))
    if (attempt > max) {
      this.reconnectState.delete(record.id)
      this.onReconnect?.({
        sessionId: record.id,
        phase: 'gave-up',
        message: `已自动重试 ${max} 次仍未成功，请检查网络或手动重连`,
        attempt: attempt - 1
      })
      return
    }

    /*
     * 记录重连所需的全部信息。
     * teardown 后 record 已从 sessions 移除，重连必须靠这份快照，
     * 尤其是 connectionId（open 要它去查连接配置和凭据）。
     */
    const connectionId = record.connectionId
    const title = record.connectionName
    const { cols, rows } = record

    const delaySec = Math.min(2 ** (attempt - 1), 30)
    this.reconnectState.set(record.id, {
      attempt,
      connectionId,
      title,
      cols,
      rows
    })

    this.onReconnect?.({
      sessionId: record.id,
      phase: 'scheduled',
      message: `连接已断开，${delaySec} 秒后自动重连（第 ${attempt}/${max} 次）`,
      attempt
    })

    const timer = setTimeout(() => {
      void this.runReconnect(record.id)
    }, delaySec * 1000)
    timer.unref?.()
    const st = this.reconnectState.get(record.id)
    if (st) st.timer = timer
  }

  /** 真正执行一次重连；成功后清空状态，失败则排下一次 */
  private async runReconnect(sessionId: string): Promise<void> {
    const st = this.reconnectState.get(sessionId)
    if (!st) return

    this.onReconnect?.({
      sessionId,
      phase: 'connecting',
      message: `正在重连（第 ${st.attempt} 次）…`,
      attempt: st.attempt
    })

    try {
      // open 内部会在 sessions 里重新登记 record，走完整流程（跳板/代理/shell）
      await this.open(sessionId, st.connectionId, st.cols, st.rows)
      this.reconnectState.delete(sessionId)
      this.onReconnect?.({
        sessionId,
        phase: 'restored',
        message: '已自动重连',
        attempt: st.attempt
      })
      return
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.onReconnect?.({
        sessionId,
        phase: 'failed',
        message: `重连失败：${message}`,
        attempt: st.attempt
      })
      // 失败后继续按退避排下一次（次数 +1，用快照而不是 record）
      await this.scheduleReconnectFromState(sessionId)
    }
  }

  /**
   * record 已销毁时用快照继续排重试。
   * 与 scheduleReconnect 的差别：后者从 record 读快照，这里从 reconnectState 读。
   */
  private async scheduleReconnectFromState(sessionId: string): Promise<void> {
    const st = this.reconnectState.get(sessionId)
    if (!st) return

    let settings: AppSettings
    try {
      settings = await getSettings()
    } catch {
      return
    }
    if (settings.autoReconnect === false) {
      this.reconnectState.delete(sessionId)
      return
    }

    const max = Math.max(1, Math.min(settings.autoReconnectMax ?? 5, 20))
    const attempt = st.attempt + 1
    if (attempt > max) {
      this.reconnectState.delete(sessionId)
      this.onReconnect?.({
        sessionId,
        phase: 'gave-up',
        message: `已自动重试 ${max} 次仍未成功，请检查网络或手动重连`,
        attempt: st.attempt
      })
      return
    }

    const delaySec = Math.min(2 ** (attempt - 1), 30)
    this.reconnectState.set(sessionId, { ...st, attempt, timer: undefined })
    this.onReconnect?.({
      sessionId,
      phase: 'scheduled',
      message: `${delaySec} 秒后重试（第 ${attempt}/${max} 次）`,
      attempt
    })

    const timer = setTimeout(() => void this.runReconnect(sessionId), delaySec * 1000)
    timer.unref?.()
    const cur = this.reconnectState.get(sessionId)
    if (cur) cur.timer = timer
  }

  /** 取消自动重连（用户主动关闭标签、手动点重连、或连接成功时调用） */
  cancelReconnect(sessionId: string): void {
    const st = this.reconnectState.get(sessionId)
    if (!st) return
    if (st.timer) clearTimeout(st.timer)
    this.reconnectState.delete(sessionId)
  }

  /** 是否有会话正在自动重连（供测试/诊断） */
  isReconnecting(sessionId: string): boolean {
    return this.reconnectState.has(sessionId)
  }

  private cleanup(record: SessionRecord): void {
    if (record.cleaned) return
    record.cleaned = true
    if (record.flushTimer) clearTimeout(record.flushTimer)
    record.flushTimer = undefined
    record.probedAt = undefined
    record.probing = false
    // 没有可探测的会话时把节拍器停掉，避免空转
    // （cleanup 早于 sessions.delete 执行，所以要按「未关闭」计数）
    let live = 0
    for (const r of this.sessions.values()) if (!r.closed) live++
    if (live === 0) this.stopProbeTicker()

    try {
      record.shell?.end()
    } catch {
      /* ignore */
    }

    record.shared.refs--
    if (record.shared.refs > 0) {
      // 连接上还有别的终端：只摘掉本终端的监听，连接保留
      record.offClient?.()
    } else {
      // 最后一个终端：断开连接。监听保留（teardown 已幂等），
      // 避免 end 之后迟到的 error 事件因无监听而变成未捕获异常
      this.endQuietly(record.client, record.jumpClients)
      record.jumpClients.length = 0
    }
    record.jumpClients = []
  }

  /* ------------------------------------------------------------------ *
   *  输出合帧
   * ------------------------------------------------------------------ */

  private feed(record: SessionRecord, chunk: Buffer): void {
    if (record.closed) return
    record.pending.push(chunk)
    if (record.flushTimer) return
    record.flushTimer = setTimeout(() => {
      record.flushTimer = undefined
      this.flush(record)
    }, FLUSH_INTERVAL_MS)
  }

  private flush(record: SessionRecord): void {
    if (record.pending.length === 0) return
    // 原始字节：ZMODEM 等二进制协议必须基于未解码的字节流解析，
    // 因此除文本外再把合并后的原始缓冲一并交给上层。
    const raw = Buffer.concat(record.pending)
    const text = record.decoder.write(raw)
    record.pending = []
    if (text || raw.length) {
      this.handlers?.onData(record.id, text, raw)
      if (text) recorder.appendOutput(record.id, text)
    }
  }

  /* ------------------------------------------------------------------ *
   *  延迟探测
   * ------------------------------------------------------------------ */

  /**
   * 全局轮转探针。
   *
   * 旧实现是「每个会话一个 setInterval」，连接一多就变成每 5 秒 × N 条
   * `exec('echo')` 同时压到各条链路上，CPU 与网络往返都翻倍，是卡顿主因之一。
   * 现在改成单一节拍器：每秒只探一个会话，按会话列表轮转。
   * 会话越多，单个会话的刷新间隔越长，但总负载恒定。
   */
  private probeTimer: NodeJS.Timeout | null = null
  private probeCursor = 0

  private ensureProbeTicker(): void {
    if (this.probeTimer) return
    this.probeTimer = setInterval(() => this.probeTick(), PROBE_TICK_MS)
  }

  private stopProbeTicker(): void {
    if (!this.probeTimer) return
    clearInterval(this.probeTimer)
    this.probeTimer = null
    this.probeCursor = 0
  }

  private probeTick(): void {
    // 只剩需要探测的会话才走节拍，避免空转
    const live = [...this.sessions.values()]
    if (live.length === 0) {
      this.stopProbeTicker()
      return
    }
    this.probeCursor = (this.probeCursor + 1) % live.length
    const record = live[this.probeCursor]
    if (!record || record.closed || record.status !== 'connected') return
    if (Date.now() - (record.probedAt ?? 0) < PROBE_MIN_GAP_MS) return
    this.probeOne(record)
  }

  private probeOne(record: SessionRecord): void {
    // busy 标记避免一次没回来又发下一次（慢设备上会出现请求堆积）
    if (record.probing) return
    record.probing = true
    record.probedAt = Date.now()
    const t0 = record.probedAt
    const finish = (): void => {
      record.probing = false
    }
    try {
      record.client.exec('echo', (err, stream) => {
        if (err || !stream) {
          finish()
          return
        }
        let done = false
        const complete = (): void => {
          if (done) return
          done = true
          clearTimeout(guard)
          const ms = Date.now() - t0
          record.latencyMs = ms
          this.handlers?.onLatency(record.id, ms)
          finish()
        }
        // 部分设备 exec 不返回 close：3s 后主动收尾，只丢弃本次结果
        const guard = setTimeout(() => {
          done = true
          try {
            stream.close()
          } catch {
            /* ignore */
          }
          finish()
        }, 3000)

        stream.on('data', () => {})
        stream.stderr.on('data', () => {})
        stream.on('close', complete)
      })
    } catch {
      // 连接瞬断时忽略本次探测
      finish()
    }
  }

  /** 注入 SFTP 预挂载实现（见 sftpPrewarm 字段说明） */
  setSftpPrewarm(fn: (sessionId: string) => Promise<void>): void {
    this.sftpPrewarm = fn
  }

  /**
   * 后台预热 SFTP。失败不抛：预热只是把延迟提前吃掉，
   * 预热不了（服务器禁 SFTP、连接已断）时后续按需挂载照常工作。
   */
  private async prewarmSftp(sessionId: string): Promise<void> {
    const fn = this.sftpPrewarm
    if (!fn) return
    try {
      await fn(sessionId)
    } catch {
      /* 静默：见方法注释 */
    }
  }

  private emitStatus(record: SessionRecord, status: ConnStatus, error?: string): void {
    record.status = status
    record.error = error
    // 同一 sessionId 已被新记录（重连）占用：旧记录的状态不再外发
    const current = this.sessions.get(record.id)
    if (current && current !== record) return
    this.settleReadyWaiters(record.id, status, error)
    this.handlers?.onStatus(record.id, status, error)
  }
}

export const sessionManager = new SessionManager()
