import dgram from 'node:dgram'
import { promises as fs } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { basename, dirname, resolve } from 'node:path'
import type { TftpLogEvent, TftpServerState } from '@shared/types'

/**
 * 内置 TFTP 服务端（RFC 1350，只读，单文件）。
 *
 * 为什么要有这个文件：
 *   7628 刷机流程第一步是「PC 打开 tftp 工具，选固件路径，板子在 U-Boot 里
 *   tftpboot 拉固件」。也就是说刷一块板子要先装一个第三方 TFTP 软件、
 *   记住固件目录、还要保证它监听在 69 端口。现场装机的人不关心 TFTP，
 *   他关心的是串口里那条 tftpboot 能不能跑起来。
 *
 * 范围（刻意收窄，与 v2.0.0 串口「Console 救急」的口径一致）：
 *   - 只做**读**（RRQ）。WRQ 一律回 ERROR —— 板子往本机写文件是绝不能开的口子。
 *   - 只服务**一个**文件：启动时指定，RRQ 名字对不上就回 File not found。
 *     不做目录浏览、不做通配。
 *   - 支持 U-Boot 会发的三个选项：blksize / tsize / timeout。不回 OACK 的话，
 *     新版本 U-Boot 会认为协商失败并直接报错，现场表现是「固件在服务器上、
 *     板子就是拉不动」。
 *
 * 端口：U-Boot 的 tftpboot 默认只发到 69，所以默认 69。Windows 上非管理员
 * 也能绑 69（Linux 需要 CAP_NET_BIND_SERVICE）。
 */

const OP_RRQ = 1
const OP_WRQ = 2
const OP_DATA = 3
const OP_ACK = 4
const OP_ERROR = 5
const OP_OACK = 6

const ERR_NOT_FOUND = 1
const ERR_ACCESS = 2
const ERR_ILLEGAL = 4
const ERR_UNKNOWN_TID = 5

/** 默认块大小（RFC 1350 固定 512，选项协商后可变） */
const DEFAULT_BLOCK_SIZE = 512
/** blksize 上限：以太网 MTU 1500 - IP/UDP 头 28 - TFTP 头 4 */
const MAX_BLOCK_SIZE = 1468
const MIN_BLOCK_SIZE = 8
/** 重传间隔与次数：现场网线直连，2 秒足够；超过 5 次基本就是网线/网口不对 */
const RETRY_TIMEOUT_MS = 2000
const MAX_RETRIES = 5

export type TftpLogHandler = (event: TftpLogEvent) => void

interface RrqRequest {
  filename: string
  mode: string
  options: Map<string, string>
}

interface Transfer {
  socket: dgram.Socket
  address: string
  port: number
  handle: fs.FileHandle
  size: number
  blockSize: number
  /** 最近发出的块号；OACK 阶段为 0 */
  block: number
  /** 最近一次发出的包，重传时原样再发 */
  lastPacket: Buffer
  retries: number
  timer?: NodeJS.Timeout
  /** OACK 已发、还没收到 ACK 0 */
  negotiating: boolean
  /** 正在读盘/发包：重复 ACK 与超时重传都会触发 sendBlock，串行化避免乱序 */
  sending: boolean
  closed: boolean
}

/** 解析 RRQ：filename\0mode\0(key\0value\0)* */
function parseRrq(payload: Buffer): RrqRequest | null {
  const parts = payload.toString('latin1').split('\0')
  // 末尾一定有一个空串（结尾的 \0），所以至少 3 段
  if (parts.length < 3) return null
  const filename = parts[0]
  const mode = parts[1].toLowerCase()
  if (!filename) return null
  const options = new Map<string, string>()
  for (let i = 2; i + 1 < parts.length; i += 2) {
    const key = parts[i].toLowerCase()
    if (!key) continue
    options.set(key, parts[i + 1])
  }
  return { filename, mode, options }
}

function errorPacket(code: number, message: string): Buffer {
  const msg = Buffer.from(message, 'latin1')
  const buf = Buffer.alloc(4 + msg.length + 1)
  buf.writeUInt16BE(OP_ERROR, 0)
  buf.writeUInt16BE(code, 2)
  msg.copy(buf, 4)
  return buf
}

function dataPacket(block: number, payload: Buffer): Buffer {
  const buf = Buffer.alloc(4 + payload.length)
  buf.writeUInt16BE(OP_DATA, 0)
  buf.writeUInt16BE(block & 0xffff, 2)
  payload.copy(buf, 4)
  return buf
}

function oackPacket(options: Array<[string, string]>): Buffer {
  const body = options.map(([k, v]) => `${k}\0${v}\0`).join('')
  const head = Buffer.alloc(2)
  head.writeUInt16BE(OP_OACK, 0)
  return Buffer.concat([head, Buffer.from(body, 'latin1')])
}

/**
 * 本机可用于 serverip 的 IPv4。
 *
 * 排除回环与 APIPA（169.254.x.x）：刷机时 PC 与板子是网线直连，用户常手动
 * 设一个 192.168.x.x 的地址，那一块才是板子能到达的。把 127.0.0.1 列出来
 * 只会让人抄错。
 */
export function localAddresses(): string[] {
  const out: string[] = []
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue
      if (info.address.startsWith('169.254.')) continue
      out.push(info.address)
    }
  }
  return out
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function clampBlockSize(raw: string | undefined): number {
  if (!raw) return DEFAULT_BLOCK_SIZE
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n)) return DEFAULT_BLOCK_SIZE
  if (n < MIN_BLOCK_SIZE) return MIN_BLOCK_SIZE
  if (n > MAX_BLOCK_SIZE) return MAX_BLOCK_SIZE
  return n
}

export class TftpServer {
  private socket: dgram.Socket | null = null
  private onLog: TftpLogHandler | null = null
  private transfer: Transfer | null = null
  /**
   * 传输代次。beginTransfer 里有两个 await（开文件、绑端口），
   * 期间可能又来一个 RRQ 或者用户点了停止 —— 那时代次已经变了，
   * 这次启动必须自己收尾退出，否则会覆盖 this.transfer 把上一份 FD/UDP/定时器漏掉。
   */
  private transferGen = 0
  private dir: string | null = null
  private file: string | null = null
  private filePath: string | null = null
  private fileSize = 0
  private port = 69
  private transferred = 0
  private client: string | null = null

  setLogHandler(cb: TftpLogHandler | null): void {
    this.onLog = cb
  }

  state(): TftpServerState {
    return {
      running: this.socket !== null,
      port: this.port,
      dir: this.dir,
      file: this.file,
      addresses: localAddresses(),
      client: this.client,
      transferred: this.transferred,
      total: this.fileSize
    }
  }

  /**
   * 起服务。filePath 是固件绝对路径，对外提供的文件名取 basename。
   *
   * 重复调用（已启动、参数不同）会先停旧的再起新的：串口引导条上用户换一次
   * 固件就该生效，不该要求他先点停止。
   */
  async start(filePath: string, port = 69): Promise<TftpServerState> {
    const abs = resolve(filePath)
    const stat = await fs.stat(abs)
    if (!stat.isFile()) throw new Error(`不是一个文件：${abs}`)
    if (stat.size === 0) throw new Error('固件文件是空的')

    if (this.socket) this.stop()

    this.dir = dirname(abs)
    this.file = basename(abs)
    this.filePath = abs
    this.fileSize = stat.size
    this.transferred = 0
    this.client = null
    this.port = port

    const socket = dgram.createSocket({ type: 'udp4' })
    await new Promise<void>((resolveBind, rejectBind) => {
      const onError = (err: NodeJS.ErrnoException): void => {
        socket.removeListener('listening', onListening)
        rejectBind(
          new Error(
            err.code === 'EADDRINUSE'
              ? `端口 ${port} 已被占用（可能有别的 TFTP 工具正在运行），关掉它再试`
              : `TFTP 服务端启动失败：${err.message}`
          )
        )
      }
      const onListening = (): void => {
        socket.removeListener('error', onError)
        resolveBind()
      }
      socket.once('error', onError)
      socket.once('listening', onListening)
      socket.bind(port)
    }).catch((err: unknown) => {
      try {
        socket.close()
      } catch {
        // 没绑成功，忽略
      }
      this.dir = null
      this.file = null
      this.filePath = null
      this.fileSize = 0
      throw err
    })

    this.socket = socket
    socket.on('message', (msg, rinfo) => this.handleRequest(msg, rinfo))
    socket.on('error', (err) => {
      this.log('error', `TFTP 服务端错误：${err.message}`)
      this.stop()
    })

    const ips = localAddresses()
    this.log(
      'info',
      `TFTP 已启动：${ips.length ? ips.join(' / ') : '未检测到可用网卡'}:${port} 提供 ${this.file}（${formatSize(this.fileSize)}）`
    )
    return this.state()
  }

  stop(): void {
    this.closeTransfer(null)
    const socket = this.socket
    this.socket = null
    if (socket) {
      try {
        socket.close()
      } catch {
        // 已关
      }
      this.log('info', 'TFTP 已停止')
    }
    this.dir = null
    this.file = null
    this.filePath = null
    this.fileSize = 0
    this.transferred = 0
    this.client = null
  }

  /* ---------------------------------------------------------------- *
   *  请求处理
   * ---------------------------------------------------------------- */

  private handleRequest(msg: Buffer, rinfo: dgram.RemoteInfo): void {
    const socket = this.socket
    if (!socket || msg.length < 4) return
    const opcode = msg.readUInt16BE(0)

    if (opcode === OP_WRQ) {
      socket.send(errorPacket(ERR_ACCESS, 'Server is read-only'), rinfo.port, rinfo.address)
      this.log('error', `拒绝了来自 ${rinfo.address} 的写请求（只读）`)
      return
    }
    if (opcode !== OP_RRQ) {
      socket.send(errorPacket(ERR_ILLEGAL, 'Illegal TFTP operation'), rinfo.port, rinfo.address)
      return
    }

    const req = parseRrq(msg.subarray(2))
    if (!req) {
      socket.send(errorPacket(ERR_ILLEGAL, 'Malformed request'), rinfo.port, rinfo.address)
      return
    }

    const asked = basename(req.filename.replace(/\\/g, '/'))
    if (!this.filePath || !this.file || asked.toLowerCase() !== this.file.toLowerCase()) {
      socket.send(errorPacket(ERR_NOT_FOUND, 'File not found'), rinfo.port, rinfo.address)
      this.log('error', `${rinfo.address} 请求了 ${asked}，当前提供的是 ${this.file ?? '（无）'}`)
      return
    }

    // 同一时刻只跑一个传输：U-Boot 重试会再发 RRQ，旧的直接丢掉
    this.closeTransfer('新的请求到达，放弃旧传输')

    const blockSize = clampBlockSize(req.options.get('blksize'))
    const accepted: Array<[string, string]> = []
    if (req.options.has('blksize')) accepted.push(['blksize', String(blockSize)])
    if (req.options.has('tsize')) accepted.push(['tsize', String(this.fileSize)])
    if (req.options.has('timeout')) accepted.push(['timeout', String(RETRY_TIMEOUT_MS / 1000)])

    this.client = `${rinfo.address}:${rinfo.port}`
    this.transferred = 0
    void this.beginTransfer(rinfo, blockSize, accepted.length > 0 ? accepted : null)
  }

  private async beginTransfer(
    rinfo: dgram.RemoteInfo,
    blockSize: number,
    accepted: Array<[string, string]> | null
  ): Promise<void> {
    const filePath = this.filePath
    if (!filePath) return
    const gen = ++this.transferGen
    const size = this.fileSize

    let handle: fs.FileHandle
    try {
      handle = await fs.open(filePath, 'r')
    } catch (err) {
      this.log('error', `打开固件失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    // 开文件期间又来了新的 RRQ / 用户停止：这份句柄没人接手，自己关掉
    if (gen !== this.transferGen) {
      void handle.close().catch(() => {})
      return
    }

    /*
     * 每个传输用新的 UDP socket（RFC 1350 的 TID 规则）。
     * 复用 69 那个 socket 也能发出去，但 U-Boot 会校验回包来源端口 ——
     * 从 69 发回去的数据包它当作「不是我等的那个 TID」直接丢掉，表现是
     * 「服务器日志显示已发送、板子一直在重试」。
     */
    const socket = dgram.createSocket({ type: 'udp4' })
    const bound = await new Promise<boolean>((resolveBind) => {
      const onError = (err: Error): void => {
        socket.removeListener('listening', onListening)
        this.log('error', `无法建立传输通道：${err.message}`)
        resolveBind(false)
      }
      const onListening = (): void => {
        socket.removeListener('error', onError)
        resolveBind(true)
      }
      socket.once('error', onError)
      socket.once('listening', onListening)
      socket.bind(0)
    })
    if (!bound) {
      void handle.close().catch(() => {})
      return
    }
    if (gen !== this.transferGen) {
      void handle.close().catch(() => {})
      try {
        socket.close()
      } catch {
        // 已关
      }
      return
    }

    const transfer: Transfer = {
      socket,
      address: rinfo.address,
      port: rinfo.port,
      handle,
      size,
      blockSize,
      block: 0,
      lastPacket: Buffer.alloc(0),
      retries: 0,
      negotiating: accepted !== null,
      sending: false,
      closed: false
    }
    this.transfer = transfer
    this.transferred = 0

    socket.on('message', (msg, from) => this.handleTransferMessage(transfer, msg, from))
    socket.on('error', (err) => {
      // 已被新一轮传输替换掉的旧 socket 迟到的 error 不能把新传输关掉
      if (transfer.closed || this.transfer !== transfer) return
      this.log('error', `TFTP 传输错误：${err.message}`)
      this.closeTransfer('传输出错')
    })

    this.log(
      'info',
      `U-Boot 开始拉取固件：${this.file} → ${rinfo.address}:${rinfo.port}（块大小 ${blockSize}）`
    )

    if (accepted) this.sendPacket(transfer, oackPacket(accepted))
    else void this.sendBlock(transfer, 1)
  }

  private handleTransferMessage(transfer: Transfer, msg: Buffer, from: dgram.RemoteInfo): void {
    if (transfer.closed || msg.length < 4) return
    /*
     * TID 校验（RFC 1350）：一个传输只认同一个对端地址+端口。
     *
     * 原来完全不看 rinfo，于是这里收到的任何杂包都会让服务器往
     * transfer.port（正在刷机的板子）回一个 ERR_UNKNOWN_TID ——
     * 板子收到自己传输上的错误包会立刻中止，刷机就断在半路。
     * 错误包只能发给真正的发送方。
     */
    if (from.address !== transfer.address || from.port !== transfer.port) {
      transfer.socket.send(errorPacket(ERR_UNKNOWN_TID, 'Unknown transfer ID'), from.port, from.address)
      return
    }
    const opcode = msg.readUInt16BE(0)

    if (opcode === OP_ERROR) {
      const code = msg.readUInt16BE(2)
      const text = msg.subarray(4).toString('latin1').replace(/\0+$/, '')
      this.log('error', `板子报错（code ${code}）：${text || '无描述'}`)
      this.closeTransfer('对端中止')
      return
    }

    if (opcode !== OP_ACK) {
      // 同一个 TID 上的非 ACK 包：协议外的东西，忽略即可，不能回错误把它踢掉
      return
    }

    const acked = msg.readUInt16BE(2)
    if (transfer.negotiating) {
      if (acked !== 0) return
      transfer.negotiating = false
      transfer.retries = 0
      void this.sendBlock(transfer, 1)
      return
    }

    // 重复 ACK（网络重复包）不推进
    if (acked !== (transfer.block & 0xffff)) return

    const payloadLen = transfer.lastPacket.length - 4
    if (payloadLen < transfer.blockSize) {
      // 最后一块（含刚好整除时补的 0 字节块）已被确认
      this.log(
        'info',
        `固件传输完成：${this.file} → ${transfer.address}（${formatSize(this.fileSize)}）`
      )
      this.transferred = this.fileSize
      this.closeTransfer(null)
      return
    }

    transfer.retries = 0
    void this.sendBlock(transfer, transfer.block + 1)
  }

  private async sendBlock(transfer: Transfer, block: number): Promise<void> {
    if (transfer.closed) return
    /*
     * 串行化：重复 ACK 与超时重传都会再进来一次，两次 read 并发会读到
     * 同一段偏移并把包发出两遍，板子那边看着像丢包重传，实际是乱序覆盖。
     */
    if (transfer.sending) return
    transfer.sending = true
    try {
      const offset = (block - 1) * transfer.blockSize
      let payload: Buffer = Buffer.alloc(0)
      if (offset < transfer.size) {
        const want = Math.min(transfer.blockSize, transfer.size - offset)
        const buf = Buffer.alloc(want)
        const { bytesRead } = await transfer.handle.read(buf, 0, want, offset)
        payload = buf.subarray(0, bytesRead)
      }
      if (transfer.closed) return
      transfer.block = block
      this.transferred = Math.min(offset + payload.length, transfer.size)
      this.sendPacket(transfer, dataPacket(block, payload))
    } catch (err) {
      // read 失败以前是裸 rejection（void 掉的 Promise），进程会直接崩。
      // 但旧传输的 read 失败不能把已经开始的下一轮传输关掉。
      if (transfer.closed || this.transfer !== transfer) return
      this.log('error', `读取固件失败：${err instanceof Error ? err.message : String(err)}`)
      this.closeTransfer('读取失败')
    } finally {
      transfer.sending = false
    }
  }

  /** 发包并排一次超时重传；收到 ACK 后由 handleTransferMessage 重排 */
  private sendPacket(transfer: Transfer, packet: Buffer): void {
    if (transfer.closed) return
    transfer.lastPacket = packet
    transfer.socket.send(packet, transfer.port, transfer.address)
    this.armTimer(transfer)
  }

  private armTimer(transfer: Transfer): void {
    if (transfer.timer) clearTimeout(transfer.timer)
    transfer.timer = setTimeout(() => {
      if (transfer.closed) return
      transfer.retries += 1
      if (transfer.retries > MAX_RETRIES) {
        this.log(
          'error',
          `重传 ${MAX_RETRIES} 次仍未收到确认，放弃。检查网线是否直连、PC 与板子是否同网段`
        )
        this.closeTransfer('超时')
        return
      }
      this.log('info', `等待确认超时，重传第 ${transfer.retries} 次（块 ${transfer.block}）`)
      transfer.socket.send(transfer.lastPacket, transfer.port, transfer.address)
      this.armTimer(transfer)
    }, RETRY_TIMEOUT_MS)
  }

  private closeTransfer(reason: string | null): void {
    // 在途的 beginTransfer 一律作废（它会在每个 await 之后自查代次）
    this.transferGen += 1
    const t = this.transfer
    if (!t) return
    this.transfer = null
    t.closed = true
    if (t.timer) clearTimeout(t.timer)
    try {
      t.socket.close()
    } catch {
      // 已关
    }
    void t.handle.close().catch(() => {})
    if (reason) this.log('info', `传输结束：${reason}`)
  }

  private log(level: TftpLogEvent['level'], message: string): void {
    this.onLog?.({ level, message, at: Date.now() })
  }
}

/** 单例：主进程同时只会刷一块板子，不需要多个实例 */
export const tftpServer = new TftpServer()
