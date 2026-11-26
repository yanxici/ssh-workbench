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

/** HTTP CONNECT 的 authority 形式：IPv6 字面量必须带方括号，否则解析成 host:port 会错位 */
function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/**
 * 把手握剩余的字节交还给调用方，并把 socket 恢复成「未流动」状态。
 *
 * 这里是整份文件最容易改错的地方，两种写法都试过并各自炸过一次：
 *
 * **写法 A（错）**：`socket.on('data')` 收数据 → 收齐后 `pause()` + `unshift(rest)` + `resume()`。
 * `resume()` 会在 `process.nextTick` 队列里挂 `resume_()`，而 `resolve()` 之后
 * 的 `await` 续体排在**微任务**队列 —— Node 里 nextTick **严格先于**微任务执行。
 * 于是 `resume_()` 先跑，把 `rest`（粘在同一 TCP 段里的 `SSH-2.0-...` banner）
 * 以 `'data'` 事件派发出去，而此时 ssh2 还没挂监听（它自己还要多过一轮
 * `cryptoInit.then(...)`），字节**当场被丢光**，连接卡到 15 秒超时。
 *
 * **写法 B（对，本实现）**：全程 `'readable'` + `socket.read()` 拉数据，
 * 从不进流模式、从不 `pause()`、从不 `resume()`。收齐后摘掉 `'readable'`，
 * `unshift(rest)` 留在内部缓冲里，`readableFlowing` 保持 `null`：
 * - 交给 ssh2：它先 `pause()` 再挂 `data` 再 `resume()`，完整读到 rest；
 * - 交给直接挂 `sock.on('data')` 的调用方（如 verify-proxy.cjs）：
 *   `readableFlowing === null` 时挂 data 监听会自动切入流模式，rest 照常交付。
 *
 * 所以：**不要为了「让数据流动起来」加 resume() 或 setImmediate()**，
 * 那是把 P0-13 原样改回去。
 */
function finishHandshake(socket: net.Socket, rest: Buffer, onReadable: () => void): void {
  socket.removeListener('readable', onReadable)
  if (rest.length > 0) socket.unshift(rest)
}

/** 通过 SOCKS5 代理建立到目标的 TCP 隧道 */
export function connectViaSocks5(opts: ProxyTarget): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ host: opts.proxyHost, port: opts.proxyPort })
    let settled = false
    let stage: 'greeting' | 'auth' | 'reply' = 'greeting'
    let buf = Buffer.alloc(0)

    const timer = setTimeout(
      () => fail(new Error('SOCKS5 代理握手超时')),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    )

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('readable', onReadable)
      socket.removeListener('end', onAbort)
      socket.removeListener('close', onAbort)
      socket.destroy()
      reject(err)
    }

    const done = (rest: Buffer): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('end', onAbort)
      socket.removeListener('close', onAbort)
      finishHandshake(socket, rest, onReadable)
      resolve(socket)
    }

    /*
     * 代理在握手完成前断连时必须立刻失败。
     * 不监听的话，`'readable'` 在 EOF 时仍会被触发一次但 read() 返回 null，
     * 于是傻等到 12 秒超时才报「握手超时」—— 真实原因是连接被对端关了。
     */
    const onAbort = (): void => fail(new Error('SOCKS5 代理在握手完成前断开了连接'))

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

    socket.once('error', (err) =>
      fail(new Error(`无法连接 SOCKS5 代理 ${opts.proxyHost}:${opts.proxyPort}：${err.message}`))
    )
    socket.once('connect', () => {
      const methods = opts.username ? [0x00, 0x02] : [0x00]
      socket.write(Buffer.concat([Buffer.from([0x05, methods.length]), Buffer.from(methods)]))
    })

    /** 消费缓冲里已到齐的字节；返回 'wait' 表示还缺数据，继续 read() */
    function consume(): 'wait' | 'done' {
      if (stage === 'greeting') {
        if (buf.length < 2) return 'wait'
        if (buf[0] !== 0x05) {
          fail(new Error('代理未按 SOCKS5 协议响应'))
          return 'done'
        }
        const method = buf[1]
        buf = buf.subarray(2)
        if (method === 0x00) {
          sendConnect()
          return 'wait'
        }
        if (method === 0x02) {
          if (!opts.username) {
            fail(new Error('代理要求用户名密码认证，但连接未配置'))
            return 'done'
          }
          stage = 'auth'
          const u = Buffer.from(opts.username, 'utf8')
          const p = Buffer.from(opts.password ?? '', 'utf8')
          socket.write(
            Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p])
          )
          return 'wait'
        }
        fail(new Error('代理不支持无认证/用户名密码之外的方式'))
        return 'done'
      }

      if (stage === 'auth') {
        if (buf.length < 2) return 'wait'
        const [, status] = buf
        buf = buf.subarray(2)
        if (status !== 0) {
          fail(new Error('SOCKS5 认证失败：用户名或密码错误'))
          return 'done'
        }
        sendConnect()
        return 'wait'
      }

      // stage === 'reply'
      if (buf.length < 4) return 'wait'
      const rep = buf[1]
      const atyp = buf[3]
      let addrLen = 0
      if (atyp === 0x01) addrLen = 4
      else if (atyp === 0x04) addrLen = 16
      else if (atyp === 0x03) {
        if (buf.length < 5) return 'wait'
        addrLen = 1 + buf[4]
      } else {
        fail(new Error('代理返回了无法识别的地址类型'))
        return 'done'
      }

      const total = 4 + addrLen + 2
      if (buf.length < total) return 'wait'
      if (rep !== 0x00) {
        fail(new Error(`代理拒绝连接：${SOCKS5_ERRORS[rep] ?? `错误码 0x${rep.toString(16)}`}`))
        return 'done'
      }

      const rest = buf.subarray(total)
      buf = Buffer.alloc(0)
      done(rest)
      return 'done'
    }

    function onReadable(): void {
      if (settled) return
      let chunk: Buffer | null
      while (!settled && (chunk = socket.read() as Buffer | null) !== null) {
        buf = Buffer.concat([buf, chunk])
        if (consume() !== 'wait') return
      }
    }

    socket.on('readable', onReadable)
    socket.once('end', onAbort)
    socket.once('close', onAbort)
  })
}

/** 通过 HTTP CONNECT 代理建立到目标的 TCP 隧道 */
export function connectViaHttpConnect(opts: ProxyTarget): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const socket = net.connect({ host: opts.proxyHost, port: opts.proxyPort })
    let settled = false
    let buf = Buffer.alloc(0)

    const timer = setTimeout(
      () => fail(new Error('HTTP 代理握手超时')),
      opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    )

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.removeListener('readable', onReadable)
      socket.removeListener('end', onAbort)
      socket.removeListener('close', onAbort)
      socket.destroy()
      reject(err)
    }

    const onAbort = (): void => fail(new Error('HTTP 代理在握手完成前断开了连接'))

    socket.once('error', (err) =>
      fail(new Error(`无法连接 HTTP 代理 ${opts.proxyHost}:${opts.proxyPort}：${err.message}`))
    )
    socket.once('connect', () => {
      // IPv6 字面量在 CONNECT 请求行与 Host 头里必须带方括号
      const hostPort = `${formatHost(opts.targetHost)}:${opts.targetPort}`
      const auth = opts.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${opts.username}:${opts.password ?? ''}`).toString('base64')}\r\n`
        : ''
      socket.write(
        `CONNECT ${hostPort} HTTP/1.1\r\n` +
          `Host: ${hostPort}\r\n` +
          auth +
          'Proxy-Connection: Keep-Alive\r\n\r\n'
      )
    })

    /** 与 SOCKS5 同一套拉模式，理由见 finishHandshake 的注释 */
    function onReadable(): void {
      if (settled) return
      let chunk: Buffer | null
      while (!settled && (chunk = socket.read() as Buffer | null) !== null) {
        buf = Buffer.concat([buf, chunk])
        if (buf.length > 64 * 1024) {
          fail(new Error('代理响应头异常（过大）'))
          return
        }
        const end = buf.indexOf('\r\n\r\n')
        if (end < 0) continue
        const head = buf.subarray(0, end).toString('latin1')
        const statusLine = head.split('\r\n')[0] ?? ''
        const match = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/)
        const code = match ? Number(match[1]) : 0
        if (code !== 200) {
          fail(new Error(`HTTP 代理拒绝 CONNECT：${statusLine.trim() || '无状态行'}`))
          return
        }
        const rest = buf.subarray(end + 4)
        settled = true
        clearTimeout(timer)
        socket.removeListener('end', onAbort)
        socket.removeListener('close', onAbort)
        finishHandshake(socket, rest, onReadable)
        resolve(socket)
        return
      }
    }

    socket.on('readable', onReadable)
    socket.once('end', onAbort)
    socket.once('close', onAbort)
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
