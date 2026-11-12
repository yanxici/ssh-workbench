/**
 * SSH 传输实现。
 *
 * 这里**不负责建连** —— 跳板链、SOCKS/HTTP 代理、主机指纹校验、密码/私钥认证
 * 仍然留在 sessionManager 里（那是 ssh2 专有的、几百行的领域逻辑，搬进通用
 * 传输层只会让抽象变成「SSH 换个壳」）。本实现接一个已经能连上的 `Client`，
 * 负责在其上开 shell、收发数据、调整窗口、关闭。
 *
 * 解码固定 UTF-8：远端 locale 由 SSH 服务端决定，客户端没有可选项。
 */
import { StringDecoder } from 'node:string_decoder'
import type { Client, ClientChannel } from 'ssh2'
import type { Transport, TransportEvents, TransportOpenOptions } from './types'

/** 取一个已建立连接的 ssh2 Client；由调用方（sessionManager）提供 */
export type SshClientProvider = () => Promise<Client>

export interface SshTransportOptions {
  /** 懒取连接：open() 时才真正建连，构造阶段不产生副作用 */
  getClient: SshClientProvider
  /** 终端类型，默认 xterm-256color */
  term?: string
}

export class SshTransport implements Transport {
  readonly kind = 'ssh' as const

  private readonly getClient: SshClientProvider
  private readonly term: string
  private readonly events: TransportEvents

  private client?: Client
  private shell?: ClientChannel
  private decoder = new StringDecoder('utf-8')
  private opened = false
  /** 本实现主动调用了 close()：之后 shell/client 的迟到事件不再上报 */
  private closing = false

  constructor(options: SshTransportOptions, events: TransportEvents) {
    this.getClient = options.getClient
    this.term = options.term ?? 'xterm-256color'
    this.events = events
  }

  /** 暴露底层连接：SFTP 挂载、延迟探测等 SSH 专有功能仍要用它 */
  getClientRef(): Client | undefined {
    return this.client
  }

  async open(opts: TransportOpenOptions): Promise<void> {
    if (this.opened) throw new Error('传输层已打开')
    const client = await this.getClient()
    this.client = client

    if (this.closing) {
      // 建连期间用户已关闭标签：把刚建好的连接收掉，不留泄漏
      try {
        client.end()
      } catch {
        /* ignore */
      }
      throw new Error('会话已关闭')
    }

    const shell = await new Promise<ClientChannel>((resolve, reject) => {
      client.shell({ term: this.term, cols: opts.cols, rows: opts.rows }, (err, channel) =>
        err ? reject(err) : resolve(channel)
      )
    })

    if (this.closing) {
      try {
        shell.end()
      } catch {
        /* ignore */
      }
      throw new Error('会话已关闭')
    }

    this.shell = shell
    this.opened = true

    shell.on('data', (chunk: Buffer) => this.emit(chunk))
    // stderr 与 stdout 混在同一条终端里：运维场景下用户要看到报错，
    // 分开显示反而割裂（也是 V1.x 一直的行为）
    shell.stderr.on('data', (chunk: Buffer) => this.emit(chunk))
    shell.on('close', () => this.handleClosed())
  }

  write(data: string): void {
    if (!this.shell || this.closing) return
    this.shell.write(data)
  }

  writeBytes(data: Buffer): void {
    if (!this.shell || this.closing) return
    this.shell.write(data)
  }

  resize(cols: number, rows: number): void {
    try {
      this.shell?.setWindow(rows, cols, 0, 0)
    } catch {
      // 连接已断开时忽略：窗口变化不是关键路径
    }
  }

  close(): void {
    if (this.closing) return
    this.closing = true
    try {
      this.shell?.end()
    } catch {
      /* ignore */
    }
    this.shell = undefined
  }

  /** 底层连接被外部关掉（重连、进程退出）：走正常断开路径 */
  private handleClosed(): void {
    if (this.closing) return
    this.closing = true
    this.shell = undefined
    this.events.onClose()
  }

  private emit(chunk: Buffer): void {
    if (this.closing) return
    // StringDecoder 保证跨帧的多字节 UTF-8 字符不被切断
    this.events.onData(chunk, this.decoder.write(chunk))
  }
}
