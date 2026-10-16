import net from 'node:net'
import type { ProxyConfig } from '@shared/types'

/**
 * 代理隧道客户端（纯 Node，可独立测试）。
 *
 * - SOCKS5：完整握手（方法协商 → 可选用户名密码认证 → CONNECT → 解析应答）；
 * - HTTP  ：CONNECT 方法 + 可选 Basic 认证；
 * 成功后返回**裸 socket**，交给 ssh2 作为 `sock` 承载 SSH 协议。
 */

export interface ProxyTarget {
  proxyHost: string
  proxyPort: number
  username?: string
  password?: string
  targetHost: string
  targetPort: number
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 12000

const SOCKS5_ERRORS: Record<number, string> = {
  1: '代理内部错误',
  2: '代理规则拒绝连接',
  3: '目标网络不可达',
  4: '目标主机不可达',
  5: '目标拒绝连接（端口未开放）',
  6: 'TTL 超时',
  7: '代理不支持该命令',
  8: '代理不支持该地址类型'
}

function ipv4ToBuffer(ip: string): Buffer {
  return Buffer.from(ip.split('.').map((n) => Number(n) & 0xff))
}

/** 通过 SOCKS5 代理建立到目标的 TCP 隧道 */
export function connectViaSocks5(opts: ProxyTarget): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ host: opts.proxyHost, port: opts.proxyPort })
    let settled = false
    let stage: 'greeting' | 'auth' | 'reply' = 'greeting'
    let buf = Buffer.alloc(0)

    const timer = setTimeout(() => fail(new Error('SOCKS5 代理握手超时')), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(err)
    }

    const sendConnect = (): void => {
      const hostBuf = net.isIPv4(opts.targetHost)
        ? Buffer.concat([Buffer.from([0x01]), ipv4ToBuffer(opts.targetHost)])
        : Buffer.concat([
            Buffer.from([0x03, Buffer.byteLength(opts.targetHost)]),
            Buffer.from(opts.targetHost, 'utf8')
          ])
      const portBuf = Buffer.alloc(2)
      portBuf.writeUInt16BE(opts.targetPort)
      stage = 'reply'
      socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00]), hostBuf, portBuf]))
    }

    socket.once('error', (err) => fail(new Error(`无法连接 SOCKS5 代理 ${opts.proxyHost}:${opts.proxyPort}：${err.message}`)))
    socket.once('connect', () => {
      const methods = opts.username ? [0x00, 0x02] : [0x00]
      socket.write(Buffer.concat([Buffer.from([0x05, methods.length]), Buffer.from(methods)]))
    })

    socket.on('data', (chunk) => {
      if (settled) return
      buf = Buffer.concat([buf, chunk])

      if (stage === 'greeting') {
        if (buf.length < 2) return
        if (buf[0] !== 0x05) return fail(new Error('代理未按 SOCKS5 协议响应'))
        const method = buf[1]
        buf = buf.subarray(2)
        if (method === 0x00) return sendConnect()
        if (method === 0x02) {
          if (!opts.username) return fail(new Error('代理要求用户名密码认证，但连接未配置'))
          stage = 'auth'
          const u = Buffer.from(opts.username, 'utf8')
          const p = Buffer.from(opts.password ?? '', 'utf8')
          socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]))
          return
        }
        return fail(new Error('代理不支持无认证/用户名密码之外的方式'))
      }

      if (stage === 'auth') {
        if (buf.length < 2) return
        const [, status] = buf
        buf = buf.subarray(2)
        if (status !== 0) return fail(new Error('SOCKS5 认证失败：用户名或密码错误'))
        return sendConnect()
      }

      // stage === 'reply'
      if (buf.length < 4) return
      const rep = buf[1]
      const atyp = buf[3]
      let addrLen = 0
      if (atyp === 0x01) addrLen = 4
      else if (atyp === 0x04) addrLen = 16
      else if (atyp === 0x03) {
        if (buf.length < 5) return
        addrLen = 1 + buf[4]
      } else return fail(new Error('代理返回了无法识别的地址类型'))

      const total = 4 + addrLen + 2
      if (buf.length < total) return
      if (rep !== 0x00) {
        return fail(new Error(`代理拒绝连接：${SOCKS5_ERRORS[rep] ?? `错误码 0x${rep.toString(16)}`}`))
      }

      const rest = buf.subarray(total)
      socket.removeAllListeners('data')
      if (rest.length > 0) socket.unshift(rest)
      settled = true
      clearTimeout(timer)
      resolve(socket)
    })
  })
}

/** 通过 HTTP CONNECT 代理建立到目标的 TCP 隧道 */
export function connectViaHttpConnect(opts: ProxyTarget): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ host: opts.proxyHost, port: opts.proxyPort })
    let settled = false
    let buf = Buffer.alloc(0)

    const timer = setTimeout(() => fail(new Error('HTTP 代理握手超时')), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      reject(err)
    }

    socket.once('error', (err) => fail(new Error(`无法连接 HTTP 代理 ${opts.proxyHost}:${opts.proxyPort}：${err.message}`)))
    socket.once('connect', () => {
      const auth = opts.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${opts.username}:${opts.password ?? ''}`).toString('base64')}\r\n`
        : ''
      socket.write(
        `CONNECT ${opts.targetHost}:${opts.targetPort} HTTP/1.1\r\n` +
          `Host: ${opts.targetHost}:${opts.targetPort}\r\n` +
          auth +
          'Proxy-Connection: Keep-Alive\r\n\r\n'
      )
    })

    socket.on('data', (chunk) => {
      if (settled) return
      buf = Buffer.concat([buf, chunk])
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) {
        if (buf.length > 16 * 1024) fail(new Error('代理响应头异常（过大）'))
        return
      }
      const head = buf.subarray(0, end).toString('latin1')
      const statusLine = head.split('\r\n')[0] ?? ''
      const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/)
      const code = match ? Number(match[1]) : 0
      if (code !== 200) {
        return fail(new Error(`HTTP 代理拒绝 CONNECT：${statusLine.trim() || '无状态行'}`))
      }
      const rest = buf.subarray(end + 4)
      socket.removeAllListeners('data')
      if (rest.length > 0) socket.unshift(rest)
      settled = true
      clearTimeout(timer)
      // 握手完成，socket 交给调用方承载 SSH；确保流状态干净（可读可写）
      socket.resume()
      setImmediate(() => resolve(socket))
    })
  })
}

/** 统一入口：按代理类型分发（password 来自凭据保险箱） */
export function openProxySocket(
  proxy: ProxyConfig,
  password: string | undefined,
  targetHost: string,
  targetPort: number,
  timeoutMs?: number
): Promise<net.Socket> {
  const opts: ProxyTarget = {
    proxyHost: proxy.host,
    proxyPort: proxy.port,
    username: proxy.username,
    password: proxy.password ?? password,
    targetHost,
    targetPort,
    timeoutMs
  }
  return proxy.type === 'http' ? connectViaHttpConnect(opts) : connectViaSocks5(opts)
}
