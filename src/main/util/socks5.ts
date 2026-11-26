import type { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

/**
 * 最小可用的 SOCKS5 服务端（CONNECT 命令、无认证）—— 动态转发（-D）的协议实现。
 *
 * 与隧道解耦：协议握手、按 ATYP 解析目标地址、应答码全部在此完成；
 * 实际"打通到目标"的动作交给 open 回调（生产环境 = ssh2 forwardOut，测试环境 = 内存通道），
 * 因此本模块可以脱离 SSH/Electron 单独验证。
 */

export interface Socks5Options {
  /** 建立到目标 host:port 的全双工通道 */
  open: (host: string, port: number) => Promise<Duplex>
  /** 通道建立成功回调（用于统计、登记清理） */
  onOpen?: (channel: Duplex) => void
}

/** VER=5, REP=code, RSV=0, ATYP=IPv4, BND.ADDR=0.0.0.0, BND.PORT=0 */
function reply(code: number): Buffer {
  return Buffer.from([0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
}

export function handleSocks5(socket: Socket, options: Socks5Options): void {
  let stage: 'greeting' | 'request' | 'done' = 'greeting'
  let buf = Buffer.alloc(0)

  // 协议层自护：客户端异常断开（RST）等场景不能让 'error' 事件冒泡成未捕获异常
  socket.on('error', () => socket.destroy())

  /*
   * 失败回复必须先写出去再关连接。
   *
   * 原来 write() 之后紧跟 destroy()：destroy 会在写缓冲出队之前掐断连接，
   * 客户端收到的是 RST 而不是 0x05 0xNN，于是报「代理无响应」而不是
   * 「目标端口不通」—— 排查方向被带偏。end() 会先把数据刷完再发 FIN。
   */
  const fail = (code: number): void => {
    /*
     * 一票否决：失败后立刻摘掉握手监听并封死阶段。
     *
     * 原来只 end() 不摘监听，客户端在收到失败应答前又发来一段数据时，
     * onData 会拿旧的 buf/stage 再走一遍解析，对已经半关的 socket 再 write
     * 一次应答（ERR_STREAM_WRITE_AFTER_END），或者走到 request 阶段
     * 带着一个畸形的 buf 去 open() —— 失败被报成「连接成功」。
     */
    stage = 'done'
    socket.removeListener('data', onData)
    try {
      socket.end(reply(code))
    } catch {
      socket.destroy()
    }
  }

  const onData = (chunk: Buffer): void => {
    buf = Buffer.concat([buf, chunk])

    /* ---- 阶段一：方法协商（仅支持无认证 0x00） ---- */
    if (stage === 'greeting') {
      if (buf.length < 2) return
      if (buf[0] !== 0x05) return fail(0x01)
      const n = buf[1]
      if (buf.length < 2 + n) return
      const methods = buf.subarray(2, 2 + n)
      if (!methods.includes(0x00)) {
        // 与方法协商失败同款收尾：不封阶段、不摘监听的话，客户端在收到
        // 0x05 0xff 前再发一段数据，onData 会拿旧 buf 再走一遍解析
        stage = 'done'
        socket.removeListener('data', onData)
        try {
          socket.end(Buffer.from([0x05, 0xff]))
        } catch {
          socket.destroy()
        }
        return
      }
      socket.write(Buffer.from([0x05, 0x00]))
      buf = buf.subarray(2 + n)
      stage = 'request'
    }

    /* ---- 阶段二：请求解析 ---- */
    if (stage !== 'request') return
    if (buf.length < 4) return

    const cmd = buf[1]
    const atyp = buf[3]
    let hostLen: number
    if (atyp === 0x01) hostLen = 4
    else if (atyp === 0x04) hostLen = 16
    else if (atyp === 0x03) {
      if (buf.length < 5) return
      hostLen = buf[4]
    } else return fail(0x08) // address type not supported

    const total = 4 + (atyp === 0x03 ? 1 : 0) + hostLen + 2
    if (buf.length < total) return

    if (cmd !== 0x01) return fail(0x07) // command not supported（仅 CONNECT）

    let host: string
    let offset = 4
    if (atyp === 0x01) {
      host = `${buf[offset]}.${buf[offset + 1]}.${buf[offset + 2]}.${buf[offset + 3]}`
      offset += 4
    } else if (atyp === 0x04) {
      const parts: string[] = []
      for (let i = 0; i < 16; i += 2) parts.push(buf.readUInt16BE(offset + i).toString(16))
      host = parts.join(':')
      offset += 16
    } else {
      const len = buf[4]
      host = buf.subarray(5, 5 + len).toString('utf8')
      offset = 5 + len
    }
    const port = buf.readUInt16BE(offset)
    const rest = buf.subarray(total)

    // 移交数据通道：先摘掉握手监听，等待隧道建立期间暂停读取
    stage = 'done'
    socket.removeListener('data', onData)
    socket.pause()

    options
      .open(host, port)
      .then((channel) => {
        /*
         * open 是异步的（SSH 里是一次 forwardOut 往返），回来时客户端可能
         * 早就断了。往已销毁的 socket 写应答会抛 ERR_STREAM_DESTROYED，
         * 而且那条 channel 再没人消费，只能等远端超时。
         */
        if (socket.destroyed || !socket.writable) {
          try {
            channel.end()
          } catch {
            /* ignore */
          }
          socket.destroy()
          return
        }
        socket.write(reply(0x00)) // succeeded
        if (rest.length > 0) channel.write(rest)
        socket.pipe(channel)
        channel.pipe(socket)
        socket.resume()
        socket.on('close', () => {
          try {
            channel.end()
          } catch {
            /* ignore */
          }
        })
        channel.on('close', () => socket.destroy())
        channel.on('error', () => socket.destroy())
        options.onOpen?.(channel)
      })
      .catch(() => fail(0x05)) // connection refused
  }

  socket.on('data', onData)
}
