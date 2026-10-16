/**
 * SOCKS5 协议实现自检（真实 loopback TCP，无需 SSH/构建环境）。
 *
 * 拓扑：测试客户端 --TCP--> SOCKS5 服务端(handleSocks5) --net.connect--> 本地"出口服务"
 * open 回调模拟 ssh2 forwardOut：连到出口服务的真实 TCP 连接（收发独立，忠实还原双工通道）。
 *
 * 用法：node node_modules/typescript/bin/tsc -p tsconfig.verify.json && node scripts/verify-socks5.cjs
 */
const net = require('node:net')
const { handleSocks5 } = require('../.tsc-verify/main/util/socks5.js')

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** 字节流读取器：按需等待 n 个字节（跨 TCP 分段安全） */
function makeReader(socket) {
  let buf = Buffer.alloc(0)
  const waiters = []
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk])
    for (const w of [...waiters]) {
      if (buf.length >= w.n) {
        const out = buf.subarray(0, w.n)
        buf = buf.subarray(w.n)
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve(out)
      }
    }
  })
  return (n) =>
    new Promise((resolve, reject) => {
      if (buf.length >= n) {
        const out = buf.subarray(0, n)
        buf = buf.subarray(n)
        resolve(out)
        return
      }
      const w = { n, resolve }
      waiters.push(w)
      setTimeout(() => {
        const i = waiters.indexOf(w)
        if (i >= 0) {
          waiters.splice(i, 1)
          reject(new Error(`等待 ${n} 字节超时`))
        }
      }, 2500)
    })
}

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))
}

/** 模拟"目标服务"：接受隧道出口连接，记录每个连接及其字节读取器 */
async function startOrigin() {
  const conns = []
  const server = net.createServer((socket) => {
    socket.on('error', () => {})
    conns.push({ socket, read: makeReader(socket) })
  })
  const port = await listen(server)
  return { server, port, conns }
}

/** SOCKS5 服务端：open 回调连到出口服务 */
async function startSocksServer(originPort) {
  const targets = []
  const server = net.createServer((socket) => {
    handleSocks5(socket, {
      open: (host, port) => {
        targets.push({ host, port })
        return new Promise((resolve, reject) => {
          const up = net.connect(originPort, '127.0.0.1')
          up.on('connect', () => resolve(up))
          up.on('error', reject)
        })
      }
    })
  })
  const port = await listen(server)
  return { server, port, targets }
}

function connect(port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => resolve(socket))
  })
}

/** 轮询等待条件成立 */
async function waitFor(fn, timeoutMs = 2000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const v = fn()
    if (v) return v
    await delay(20)
  }
  throw new Error('waitFor 超时')
}

let pass = 0
let fail = 0

function check(name, condition, detail) {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}${detail ? `  -> ${detail}` : ''}`)
  }
}

async function main() {
  console.log('== 用例 1：IPv4 CONNECT 全流程（含双向数据） ==')
  {
    const origin = await startOrigin()
    const { server, port, targets } = await startSocksServer(origin.port)
    const sock = await connect(port)
    const read = makeReader(sock)

    sock.write(Buffer.from([0x05, 0x01, 0x00]))
    const greet = await read(2)
    check('问候应答 05 00', greet[0] === 0x05 && greet[1] === 0x00, greet.toString('hex'))

    sock.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0x7f, 0x00, 0x00, 0x01, 0x1f, 0x90]))
    const rep = await read(10)
    check('CONNECT 应答成功（REP=0）', rep[0] === 0x05 && rep[1] === 0x00, rep.toString('hex'))
    check(
      '目标解析为 127.0.0.1:8080',
      targets.length === 1 && targets[0].host === '127.0.0.1' && targets[0].port === 8080,
      JSON.stringify(targets)
    )

    const up = await waitFor(() => origin.conns[0])
    sock.write(Buffer.from('ping-from-client'))
    const got = await up.read(16)
    check('客户端数据完整进入隧道出口', got.toString() === 'ping-from-client', got.toString())

    up.socket.write(Buffer.from('pong-from-tunnel'))
    const back = await read(16)
    check('出口数据完整回传客户端', back.toString() === 'pong-from-tunnel', back.toString())

    sock.destroy()
    up.socket.destroy()
    server.close()
    origin.server.close()
  }

  console.log('== 用例 2：域名 ATYP（0x03）==')
  {
    const origin = await startOrigin()
    const { server, port, targets } = await startSocksServer(origin.port)
    const sock = await connect(port)
    const read = makeReader(sock)
    sock.write(Buffer.from([0x05, 0x01, 0x00]))
    await read(2)
    const domain = Buffer.from('example.com', 'utf8')
    sock.write(
      Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x03, domain.length]),
        domain,
        Buffer.from([0x01, 0xbb])
      ])
    )
    const rep = await read(10)
    check('域名 CONNECT 成功', rep[1] === 0x00, rep.toString('hex'))
    check(
      '目标解析为 example.com:443',
      targets.length === 1 && targets[0].host === 'example.com' && targets[0].port === 443,
      JSON.stringify(targets)
    )
    sock.destroy()
    server.close()
    origin.server.close()
  }

  console.log('== 用例 3：握手与首包负载同帧到达（前导数据不丢失）==')
  {
    const origin = await startOrigin()
    const { server, port } = await startSocksServer(origin.port)
    const sock = await connect(port)
    const read = makeReader(sock)

    const domain = Buffer.from('db.internal', 'utf8')
    sock.write(
      Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00, 0x05, 0x01, 0x00, 0x03, domain.length]),
        domain,
        Buffer.from([0x1a, 0x0b]), // 6667
        Buffer.from('early-payload')
      ])
    )
    const greet = await read(2)
    check('问候应答正常', greet[1] === 0x00, greet.toString('hex'))
    const rep = await read(10)
    check('CONNECT 应答正常', rep[1] === 0x00, rep.toString('hex'))

    const up = await waitFor(() => origin.conns[0])
    const got = await up.read(13)
    check('同帧前导负载未丢失', got.toString() === 'early-payload', got.toString())

    sock.destroy()
    server.close()
    origin.server.close()
  }

  console.log('== 用例 4：不支持的命令（BIND=0x02）==')
  {
    const origin = await startOrigin()
    const { server, port, targets } = await startSocksServer(origin.port)
    const sock = await connect(port)
    const read = makeReader(sock)
    sock.write(Buffer.from([0x05, 0x01, 0x00]))
    await read(2)
    sock.write(Buffer.from([0x05, 0x02, 0x00, 0x01, 0x7f, 0x00, 0x00, 0x01, 0x00, 0x50]))
    const rep = await read(10)
    check('应答 REP=0x07（命令不支持）', rep[1] === 0x07, rep.toString('hex'))
    check('未发起隧道建立', targets.length === 0)
    sock.destroy()
    server.close()
    origin.server.close()
  }

  console.log('== 用例 5：无可用认证方式 ==')
  {
    const origin = await startOrigin()
    const { server, port } = await startSocksServer(origin.port)
    const sock = await connect(port)
    const read = makeReader(sock)
    sock.write(Buffer.from([0x05, 0x01, 0x02])) // 仅提供用户名密码认证
    const res = await read(2)
    check('应答 05 FF（无可用方法）', res[0] === 0x05 && res[1] === 0xff, res.toString('hex'))
    sock.destroy()
    server.close()
    origin.server.close()
  }

  console.log('== 用例 6：隧道建立失败（目标不可达）==')
  {
    const server = net.createServer((socket) => {
      handleSocks5(socket, { open: () => Promise.reject(new Error('unreachable')) })
    })
    const port = await listen(server)
    const sock = await connect(port)
    const read = makeReader(sock)
    sock.write(Buffer.from([0x05, 0x01, 0x00]))
    await read(2)
    sock.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0x0a, 0x00, 0x00, 0x01, 0x00, 0x16]))
    const rep = await read(10)
    check('应答 REP=0x05（连接被拒）', rep[1] === 0x05, rep.toString('hex'))
    sock.destroy()
    server.close()
  }

  console.log('== 用例 7：客户端 RST 断开不产生未捕获异常 ==')
  {
    const origin = await startOrigin()
    const { server, port } = await startSocksServer(origin.port)
    const sock = await connect(port)
    const read = makeReader(sock)
    sock.write(Buffer.from([0x05, 0x01, 0x00]))
    await read(2)
    sock.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0x7f, 0x00, 0x00, 0x01, 0x1f, 0x90]))
    await read(10)
    await waitFor(() => origin.conns[0])
    sock.destroy() // 立即 RST，模拟客户端强退
    await delay(150)
    check('进程存活（无 unhandled error 崩溃）', true)
    server.close()
    origin.server.close()
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('验证脚本异常：', err)
  process.exit(1)
})
