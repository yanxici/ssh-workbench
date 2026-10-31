import net from 'node:net'
import type { Duplex } from 'node:stream'
import type { Client, ClientChannel, TcpConnectionDetails } from 'ssh2'
import type { TunnelConfig, TunnelRuntimeInfo, TunnelStatus } from '@shared/types'
import { getTunnel } from '../store/repository'
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
 * - 隧道始终挂在一个在线会话上；会话断开时所属隧道自动停止（状态置为 error 并提示）；
 * - 一份配置同一时刻只运行一个实例；重复 start 幂等。
 */

type StatusHandler = (info: TunnelRuntimeInfo) => void

interface TunnelRuntime {
  tunnelId: string
  sessionId: string
  sessionTitle?: string
  status: TunnelStatus
  error?: string
  startedAt?: number
  connectionCount: number
  actualPort?: number
  /** local / dynamic：本机监听 server */
  server?: net.Server
  /** remote：forwardIn 的绑定信息（停止时 unforwardIn） */
  remoteBind?: { host: string; port: number }
  /** remote：'tcp connection' 监听器（停止时移除；同一客户端可能挂多个隧道，按端口过滤） */
  tcpListener?: (
    details: TcpConnectionDetails,
    accept: () => ClientChannel,
    reject: () => void
  ) => void
  client?: Client
  sockets: Set<net.Socket>
  channels: Set<Duplex>
}

class TunnelManager {
  private runtimes = new Map<string, TunnelRuntime>()
  private onStatus: StatusHandler | null = null

  setStatusHandler(cb: StatusHandler): void {
    this.onStatus = cb
  }

  /** 全部隧道的实时状态（渲染层初始化时同步一次） */
  states(): TunnelRuntimeInfo[] {
    return [...this.runtimes.values()].map((r) => this.snapshot(r))
  }

  async start(tunnelId: string, sessionId: string): Promise<TunnelRuntimeInfo> {
    const existing = this.runtimes.get(tunnelId)
    if (existing && (existing.status === 'active' || existing.status === 'starting')) {
      if (existing.sessionId === sessionId) return this.snapshot(existing)
      this.stop(tunnelId) // 换会话：先停旧实例
    }

    const config = await getTunnel(tunnelId)
    if (!config) throw new Error('隧道配置不存在，可能已被删除')

    const runtime: TunnelRuntime = {
      tunnelId,
      sessionId,
      sessionTitle: sessionManager.list().find((s) => s.id === sessionId)?.title,
      status: 'starting',
      connectionCount: 0,
      sockets: new Set(),
      channels: new Set()
    }
    this.runtimes.set(tunnelId, runtime)
    this.emit(runtime)

    try {
      await sessionManager.waitUntilReady(sessionId)
      const client = sessionManager.getClient(sessionId)
      if (!client) throw new Error('会话不存在或已断开，请先打开 SSH 连接')
      runtime.client = client
      runtime.sessionTitle = sessionManager.list().find((s) => s.id === sessionId)?.title

      if (config.type === 'local') await this.startLocal(runtime, config, client)
      else if (config.type === 'dynamic') await this.startDynamic(runtime, config, client)
      else await this.startRemote(runtime, config, client)

      runtime.status = 'active'
      runtime.startedAt = Date.now()
      runtime.error = undefined
    } catch (err) {
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

  stop(tunnelId: string): void {
    const runtime = this.runtimes.get(tunnelId)
    if (!runtime) return
    this.releaseResources(runtime)
    runtime.status = 'stopped'
    runtime.error = undefined
    runtime.startedAt = undefined
    this.emit(runtime)
  }

  /** 会话来开时，停掉挂在它上面的全部隧道 */
  onSessionClosed(sessionId: string): void {
    for (const runtime of this.runtimes.values()) {
      if (runtime.sessionId !== sessionId) continue
      if (runtime.status !== 'active' && runtime.status !== 'starting') continue
      this.releaseResources(runtime)
      runtime.status = 'error'
      runtime.error = '会话已断开，隧道已停止'
      this.emit(runtime)
    }
  }

  /* ------------------------------------------------------------------ *
   *  local (-L)
   * ------------------------------------------------------------------ */

  private startLocal(runtime: TunnelRuntime, config: TunnelConfig, client: Client): Promise<void> {
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
            ? `本机端口 ${config.bindPort} 已被占用`
            : err.code === 'EACCES'
              ? `无权限监听 ${config.bindHost}:${config.bindPort}`
              : `监听失败：${err.message}`
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
        resolve()
      })
    })
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
              `远端绑定 ${config.bindHost}:${config.bindPort} 失败：${err.message}` +
                '（部分设备未开启 GatewayPorts 或端口受限）'
            )
          )
          return
        }

        runtime.remoteBind = { host: config.bindHost, port }
        runtime.actualPort = port

        // 同一客户端上可能挂多个 -R 隧道，按绑定端口过滤到自己
        const listener = (
          details: TcpConnectionDetails,
          accept: () => ClientChannel,
          rejectConn: () => void
        ): void => {
          if (details.destPort !== port) return

          const local = net.connect({ host: targetHost, port: targetPort })
          runtime.sockets.add(local)
          local.on('error', () => {
            runtime.sockets.delete(local)
            try {
              rejectConn()
            } catch {
              /* ignore */
            }
          })
          local.on('close', () => runtime.sockets.delete(local))

          local.on('connect', () => {
            let channel: ClientChannel
            try {
              channel = accept()
            } catch {
              local.destroy()
              return
            }
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

        client.on('tcp connection', listener)
        runtime.tcpListener = listener
        resolve()
      })
    })
  }

  /* ------------------------------------------------------------------ *
   *  dynamic (-D)：本机 SOCKS5 代理（仅 CONNECT，无认证）
   * ------------------------------------------------------------------ */

  private startDynamic(runtime: TunnelRuntime, config: TunnelConfig, client: Client): Promise<void> {
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
            ? `本机端口 ${config.bindPort} 已被占用`
            : err.code === 'EACCES'
              ? `无权限监听 ${config.bindHost}:${config.bindPort}`
              : `监听失败：${err.message}`
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
        resolve()
      })
    })
  }

  /* ------------------------------------------------------------------ *
   *  内部
   * ------------------------------------------------------------------ */

  private releaseResources(runtime: TunnelRuntime): void {
    if (runtime.server) {
      try {
        runtime.server.close()
      } catch {
        /* ignore */
      }
      runtime.server = undefined
    }
    if (runtime.client && runtime.tcpListener) {
      try {
        runtime.client.removeListener('tcp connection', runtime.tcpListener)
      } catch {
        /* ignore */
      }
      runtime.tcpListener = undefined
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
      actualPort: runtime.actualPort
    }
  }

  private emit(runtime: TunnelRuntime): void {
    this.onStatus?.(this.snapshot(runtime))
  }
}

export const tunnelManager = new TunnelManager()
