/**
 * 代理隧道客户端自检：真实 loopback 上启动迷你 SOCKS5 / HTTP 代理，
 * 验证客户端握手与隧道打通（无需构建环境）。
 * 用法：node node_modules/typescript/bin/tsc -p tsconfig.verify.json && node scripts/verify-proxy.cjs
 */
const net = require('node:net')
const { connectViaSocks5, connectViaHttpConnect } = require('../.tsc-verify/main/util/proxySockets.js')
const { handleSocks5 } = require('../.tsc-verify/main/util/socks5.js')

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
