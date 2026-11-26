/**
 * 代理隧道客户端自检：真实 loopback 上启动迷你 SOCKS5 / HTTP 代理，
 * 验证客户端握手与隧道打通（无需构建环境）。
 * 用法：node node_modules/typescript/bin/tsc -p tsconfig.verify.json && node scripts/verify-proxy.cjs
 */
const net = require('node:net')
const { connectViaSocks5, connectViaHttpConnect } = require('../.tsc-verify/main/util/proxySockets.js')
const { handleSocks5 } = require('../.tsc-verify/main/util/socks5.js')
const crypto = require('node:crypto')
const { Client, Server } = require('ssh2')

let pass = 0
let fail = 0

function check(name, condition, detail) {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}${detail !== undefined ? `  -> ${detail}` : ''}`)
  }
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))

/** 建立一条已就绪的到 target 的连接 */
function connectReady(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1')
    s.once('connect', () => resolve(s))
    s.once('error', reject)
  })
}

/** 目标服务：接受隧道出口，回显"OK" */
async function startTarget() {
  const server = net.createServer((socket) => {
    socket.on('data', () => socket.write('OK'))
  })
  const port = await listen(server)
  return { server, port }
}

async function main() {
  console.log('== SOCKS5 客户端（无认证）==')
  {
    const target = await startTarget()
    const proxy = net.createServer((socket) => {
      handleSocks5(socket, { open: () => connectReady(target.port) })
    })
    const proxyPort = await listen(proxy)

    const socket = await connectViaSocks5({
      proxyHost: '127.0.0.1',
      proxyPort,
      targetHost: '127.0.0.1',
      targetPort: target.port
    })
    check('SOCKS5 隧道建立成功', true)
    const echo = await new Promise((resolve) => {
      socket.on('data', (d) => resolve(d.toString()))
      socket.write('ping')
    })
    check('经隧道与目标通信正常', echo === 'OK', echo)
    socket.destroy()
    proxy.close()
    target.server.close()
  }

  console.log('== SOCKS5 客户端（目标不可达报错）==')
  {
    const proxy = net.createServer((socket) => {
      handleSocks5(socket, { open: () => Promise.reject(new Error('refused')) })
    })
    const proxyPort = await listen(proxy)
    const failed = await connectViaSocks5({
      proxyHost: '127.0.0.1',
      proxyPort,
      targetHost: 'nope.internal',
      targetPort: 22
    }).then(() => null, (e) => e.message)
    check('目标拒绝 → 抛出含「拒绝」的错误', failed && failed.includes('拒绝'), failed)
    proxy.close()
  }

  console.log('== SOCKS5 客户端（认证失败）==')
  {
    const proxy = net.createServer((socket) => {
      socket.on('data', () => {
        socket.write(Buffer.from([0x05, 0x02]))
        socket.once('data', () => socket.write(Buffer.from([0x01, 0x01])))
      })
    })
    const proxyPort = await listen(proxy)
    const failed = await connectViaSocks5({
      proxyHost: '127.0.0.1',
      proxyPort,
      username: 'u',
      password: 'wrong',
      targetHost: '127.0.0.1',
      targetPort: 22
    }).then(() => null, (e) => e.message)
    check('认证失败 → 报用户名密码错误', failed && failed.includes('认证失败'), failed)
    proxy.close()
  }

  console.log('== HTTP CONNECT 客户端 ==')
  {
    const target = await startTarget()
    // 正确的 HTTP CONNECT 代理：握手监听器用 removeListener 分离，隧道阶段 pipe 双向转发
    const proxy = net.createServer((socket) => {
      let buf = Buffer.alloc(0)
      const onHandshake = (chunk) => {
        buf = Buffer.concat([buf, chunk])
        const end = buf.indexOf('\r\n\r\n')
        if (end < 0) return
        socket.removeListener('data', onHandshake)
        const rest = buf.subarray(end + 4)
        const up = net.connect(target.port, '127.0.0.1')
        up.once('connect', () => {
          socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (rest.length > 0) up.write(rest)
          socket.pipe(up)
          up.pipe(socket)
        })
        up.on('error', () => socket.destroy())
      }
      socket.on('data', onHandshake)
    })
    const proxyPort = await listen(proxy)

    const socket = await connectViaHttpConnect({
      proxyHost: '127.0.0.1',
      proxyPort,
      targetHost: '127.0.0.1',
      targetPort: target.port
    })
    check('HTTP CONNECT 隧道建立成功', true)
    // 握手成功后 socket 应可写且确实把数据写到底层（bytesWritten 增加）
    const before = socket.bytesWritten
    socket.write('ping')
    await new Promise((r) => setTimeout(r, 100))
    check('握手后写入数据确实发出', socket.bytesWritten >= before + 4, `${before} -> ${socket.bytesWritten}`)
    socket.destroy()
    proxy.close()
    target.server.close()
  }

  console.log('== HTTP CONNECT（407 拒绝）==')
  {
    const proxy = net.createServer((socket) => {
      socket.on('data', () => {
        socket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n')
      })
    })
    const proxyPort = await listen(proxy)
    const failed = await connectViaHttpConnect({
      proxyHost: '127.0.0.1',
      proxyPort,
      targetHost: '127.0.0.1',
      targetPort: 22
    }).then(() => null, (e) => e.message)
    check('407 → 报 CONNECT 被拒', failed && failed.includes('407'), failed)
    proxy.close()
  }

  /*
   * 粘包回归：代理握手回包与 SSH banner 在同一个 TCP 段里。
   *
   * 这是 P0-13 的实际触发形态（本地/低延迟代理几乎必然粘包），也是两种错误
   * 实现最容易被"看起来能通"骗过去的地方 —— 不粘包的用例两种写法都过。
   * 判据是「resolve 之后才挂的 data 监听能不能收到 banner」：
   * 拿到 socket 才挂监听正是 ssh2 的做法，也是 resume() 版本丢字节的原因。
   */
  console.log('== SOCKS5 粘包：CONNECT 回包 + SSH banner 同段 ==')
  {
    const BANNER = 'SSH-2.0-FakeTest_1.0\r\n'
    // 极简 SOCKS5 服务端：第一次读 → 方法协商；第二次读 → CONNECT 回包与 banner 一次写出
    const proxy = net.createServer((socket) => {
      let step = 0
      socket.on('data', () => {
        step += 1
        if (step === 1) {
          socket.write(Buffer.from([0x05, 0x00]))
          return
        }
        // 0x05 0x00 | RSV | ATYP=IPv4 | 127.0.0.1 | port 22 —— 与 banner 合并成一个 write
        const reply = Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, 0x00, 0x16])
        socket.write(Buffer.concat([reply, Buffer.from(BANNER, 'ascii')]))
      })
    })
    const proxyPort = await listen(proxy)

    const socket = await connectViaSocks5({
      proxyHost: '127.0.0.1',
      proxyPort,
      targetHost: '127.0.0.1',
      targetPort: 22
    })
    const got = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('<超时：banner 被丢弃>'), 1000)
      socket.on('data', (d) => {
        clearTimeout(timer)
        resolve(d.toString('ascii'))
      })
    })
    check('粘包 banner 在 resolve 后仍能被读到', got === BANNER, JSON.stringify(got))
    socket.destroy()
    proxy.close()
  }

  console.log('== HTTP CONNECT 粘包：200 回包 + SSH banner 同段 ==')
  {
    const BANNER = 'SSH-2.0-FakeTest_1.0\r\n'
    const proxy = net.createServer((socket) => {
      socket.on('data', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n' + BANNER)
      })
    })
    const proxyPort = await listen(proxy)

    const socket = await connectViaHttpConnect({
      proxyHost: '127.0.0.1',
      proxyPort,
      targetHost: '127.0.0.1',
      targetPort: 22
    })
    const got = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('<超时：banner 被丢弃>'), 1000)
      socket.on('data', (d) => {
        clearTimeout(timer)
        resolve(d.toString('ascii'))
      })
    })
    check('粘包 banner 在 resolve 后仍能被读到', got === BANNER, JSON.stringify(got))
    socket.destroy()
    proxy.close()
  }

  /*
   * 上面两段用的是裸 socket 挂 'data' 读 banner，只证明字节没丢。
   * 真正要保证的是「把这条 socket 原样交给 ssh2」能握手成功 ——
   * ssh2 会自己接管 readable 状态与缓冲，任何 pause/resume 时序错乱都在这步暴露。
   */
  console.log('== 真实 ssh2.Client 经 SOCKS5 完成握手 ==')
  {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
    const hostKey = privateKey.export({ type: 'pkcs1', format: 'pem' })
    const sshServer = new Server({ hostKeys: [hostKey] }, (client) => {
      client.on('authentication', (ctx) => ctx.accept())
    })
    const sshPort = await new Promise((r) => sshServer.listen(0, '127.0.0.1', () => r(sshServer.address().port)))

    // 迷你 SOCKS5：方法协商 → CONNECT 回包后把连接桥到真实 sshd 上
    const proxy = net.createServer((socket) => {
      let step = 0
      socket.on('data', () => {
        step += 1
        if (step === 1) {
          socket.write(Buffer.from([0x05, 0x00]))
          return
        }
        if (step === 2) {
          socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 127, 0, 0, 1, (sshPort >> 8) & 0xff, sshPort & 0xff]))
          const up = net.connect(sshPort, '127.0.0.1')
          up.on('error', () => socket.destroy())
          up.pipe(socket)
          socket.pipe(up)
        }
      })
      socket.on('error', () => undefined)
    })
    const proxyPort = await listen(proxy)

    const sock = await connectViaSocks5({
      proxyHost: '127.0.0.1',
      proxyPort,
      targetHost: '127.0.0.1',
      targetPort: sshPort
    })
    const client = new Client()
    const events = []
    client.on('handshake', () => events.push('handshake'))
    client.on('ready', () => events.push('ready'))
    client.on('error', (e) => events.push('error:' + e.message))
    client.connect({ sock, username: 'u', password: 'p', readyTimeout: 4000 })
    const ok = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000)
      const done = () => {
        if (events.includes('ready')) {
          clearTimeout(timer)
          resolve(true)
        }
      }
      client.on('ready', done)
      client.on('error', () => {
        clearTimeout(timer)
        resolve(false)
      })
    })
    check('ssh2.Client 经代理 socket 握手成功', ok, events.join(','))
    check('握手事件按 handshake → ready 顺序发生', events.join(',') === 'handshake,ready', events.join(','))
    client.end()
    sock.destroy()
    proxy.close()
    sshServer.close()
  }

  console.log('== 代理不可达 ==')
  {
    const failed = await connectViaSocks5({
      proxyHost: '127.0.0.1',
      proxyPort: 1,
      targetHost: '127.0.0.1',
      targetPort: 22,
      timeoutMs: 1500
    }).then(() => null, (e) => e.message)
    check('代理不可达 → 清晰报错', failed && failed.includes('无法连接'), failed)
  }
}

main().then(() => {
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}).catch((err) => {
  console.error('验证脚本异常：', err)
  process.exit(1)
})
