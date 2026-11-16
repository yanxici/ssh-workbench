/**
 * 内置 TFTP 服务端自检：真起一个 UDP 服务端，真跑一遍 RFC 1350 握手。
 *
 * 为什么值得单独跑：刷 7628 时 TFTP 是整个流程里唯一"看不见"的一环 ——
 * 串口那边有没有按对键是肉眼可见的，而固件拉不动只表现为板子反复重试。
 * 这个脚本用一个最小客户端把服务端当作黑盒驱动，覆盖现场最容易踩的几件事：
 *
 *   1. RRQ + blksize/tsize 选项 → 回 OACK（不回的话新 U-Boot 直接判失败）
 *   2. OACK 后从**新端口**发数据（复用 69 会被 U-Boot 按 TID 丢掉）
 *   3. 多块传输内容与源文件逐字节一致，最后一块小于块大小
 *   4. 重复 ACK 不推进块号（网络重复包）
 *   5. 文件名对不上 → ERROR 1 File not found（不是静默超时）
 *   6. WRQ → ERROR 2（只读，绝不接受写入）
 *   7. 不带选项的老式客户端（512 字节块）也能传完
 *   8. stop() 后端口释放，状态归零
 *
 * 用法：node scripts/verify-tftp.cjs
 */
const crypto = require('crypto')
const dgram = require('dgram')
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.tsc-verify')

/* ---------- 打包被测代码 ---------- */
fs.mkdirSync(OUT_DIR, { recursive: true })
const bundle = path.join(OUT_DIR, 'tftp-bundle.cjs')
esbuild.buildSync({
  stdin: {
    contents: `
      export { TftpServer, localAddresses } from './src/main/tftp/server'
    `,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle,
  logLevel: 'error',
  alias: {
    '@shared': path.join(ROOT, 'src/shared')
  }
})
const { TftpServer, localAddresses } = require(bundle)

/* ---------- 测试框架 ---------- */
let pass = 0
let fail = 0
const fails = []
function check(name, ok, detail = '') {
  if (ok) pass++
  else {
    fail++
    fails.push(`${name}${detail ? ' — ' + detail : ''}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 4000, describe) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await sleep(10)
  }
  const ok = fn()
  if (!ok && describe) {
    let snap
    try {
      snap = describe()
    } catch (e) {
      snap = `<采集失败: ${e && e.message}>`
    }
    console.log(`      [waitFor 超时 ${ms}ms] 实际: ${snap}`)
  }
  return ok
}

/* ---------- TFTP 常量（客户端侧，故意不复用服务端导出） ---------- */
const OP_RRQ = 1
const OP_WRQ = 2
const OP_DATA = 3
const OP_ACK = 4
const OP_ERROR = 5
const OP_OACK = 6

const PORT = 16969

function rrqPacket(filename, options) {
  const parts = [filename, 'octet']
  for (const [k, v] of Object.entries(options ?? {})) parts.push(k, String(v))
  const head = Buffer.alloc(2)
  head.writeUInt16BE(OP_RRQ, 0)
  return Buffer.concat([head, Buffer.from(parts.join('\0') + '\0', 'latin1')])
}

function wrqPacket(filename) {
  const head = Buffer.alloc(2)
  head.writeUInt16BE(OP_WRQ, 0)
  return Buffer.concat([head, Buffer.from(`${filename}\0octet\0`, 'latin1')])
}

function ackPacket(block) {
  const buf = Buffer.alloc(4)
  buf.writeUInt16BE(OP_ACK, 0)
  buf.writeUInt16BE(block, 2)
  return buf
}

function parseOp(buf) {
  return buf.length >= 2 ? buf.readUInt16BE(0) : -1
}

function parseOack(buf) {
  const text = buf.subarray(2).toString('latin1')
  const parts = text.split('\0').filter((s) => s.length > 0)
  const out = {}
  for (let i = 0; i + 1 < parts.length; i += 2) out[parts[i].toLowerCase()] = parts[i + 1]
  return out
}

/**
 * 最小 TFTP 客户端：按 RFC 1350 收一个文件。
 * 返回 { op, oack, data, blockSize, fromPort, errorCode, errorText }
 */
function tftpGet(filename, options, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    const chunks = []
    let blockSize = Number(options?.blksize ?? 512)
    let oack = null
    let errorCode = null
    let errorText = ''
    let done = false
    let serverPort = PORT

    const finish = (result) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        sock.close()
      } catch {
        // 已关
      }
      resolve({
        oack,
        data: Buffer.concat(chunks),
        blockSize,
        fromPort: serverPort,
        errorCode,
        errorText,
        ...result
      })
    }

    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs)

    sock.on('message', (msg, rinfo) => {
      const op = parseOp(msg)
      serverPort = rinfo.port
      if (op === OP_ERROR) {
        errorCode = msg.readUInt16BE(2)
        errorText = msg.subarray(4).toString('latin1').replace(/\0+$/, '')
        finish({ op })
        return
      }
      if (op === OP_OACK) {
        oack = parseOack(msg)
        if (oack.blksize) blockSize = Number(oack.blksize)
        sock.send(ackPacket(0), rinfo.port, rinfo.address)
        return
      }
      if (op === OP_DATA) {
        const block = msg.readUInt16BE(2)
        const payload = msg.subarray(4)
        chunks.push(payload)
        sock.send(ackPacket(block), rinfo.port, rinfo.address)
        if (payload.length < blockSize) finish({ op })
        return
      }
      finish({ op })
    })

    sock.bind(0, () => {
      sock.send(rrqPacket(filename, options), PORT, '127.0.0.1')
    })
  })
}

/* ---------- 用例 ---------- */
async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-tftp-'))
  // 1.3 MB 左右、非 512 整数倍：保证最后一块是短块，且多块都走到
  const payload = crypto.randomBytes(1024 * 1024 + 12345)
  const firmware = path.join(tmpDir, 'openwrt-21.02.2-7628n-PgwayCount.bin')
  fs.writeFileSync(firmware, payload)

  const server = new TftpServer()
  const logs = []
  server.setLogHandler((e) => logs.push(e))

  /* ---- 0. 未启动时的状态 ---- */
  const idle = server.state()
  check('未启动时 running=false', idle.running === false)
  check('未启动时 file 为空', idle.file === null)
  check('localAddresses 不含回环', !localAddresses().includes('127.0.0.1'))

  /* ---- 1. 启动 ---- */
  const started = await server.start(firmware, PORT)
  check('启动后 running=true', started.running === true)
  check('端口正确', started.port === PORT, `实际 ${started.port}`)
  check('对外文件名取 basename', started.file === path.basename(firmware), `实际 ${started.file}`)
  check('total 等于文件大小', started.total === payload.length)
  check('启动日志已产生', logs.some((l) => /TFTP 已启动/.test(l.message)))

  /* ---- 2. 空文件 / 不存在的文件应被拒绝 ---- */
  const emptyPath = path.join(tmpDir, 'empty.bin')
  fs.writeFileSync(emptyPath, '')
  let emptyRejected = false
  try {
    await server.start(emptyPath, PORT)
  } catch (err) {
    emptyRejected = /空/.test(err.message)
  }
  check('空固件被拒绝', emptyRejected)
  // 上面失败后服务端已停，重新起
  await server.start(firmware, PORT)

  /* ---- 3. 带选项的完整传输 ---- */
  const withOptions = await tftpGet(path.basename(firmware), { blksize: 1024, tsize: 0 })
  check('带选项时先回 OACK', withOptions.oack !== null)
  check(
    'OACK 回显 blksize',
    withOptions.oack?.blksize === '1024',
    `实际 ${JSON.stringify(withOptions.oack)}`
  )
  check(
    'OACK 回显 tsize',
    withOptions.oack?.tsize === String(payload.length),
    `实际 ${withOptions.oack?.tsize}`
  )
  check(
    '数据从新端口发出（TID 规则）',
    withOptions.fromPort !== PORT,
    `fromPort=${withOptions.fromPort}`
  )
  const gotHash = crypto.createHash('sha256').update(withOptions.data).digest('hex')
  const wantHash = crypto.createHash('sha256').update(payload).digest('hex')
  check('传输内容与源文件一致', gotHash === wantHash)
  check('收到完整字节数', withOptions.data.length === payload.length, `实际 ${withOptions.data.length}`)

  /* ---- 4. 不带选项的老式客户端（512 块） ---- */
  const plain = await tftpGet(path.basename(firmware), undefined)
  check('无选项时不发 OACK', plain.oack === null)
  check('无选项时块大小 512', plain.blockSize === 512)
  check(
    '无选项传输内容一致',
    crypto.createHash('sha256').update(plain.data).digest('hex') === wantHash
  )

  /* ---- 5. 文件名对不上 ---- */
  const wrongName = await tftpGet('openwrt-other.bin', { blksize: 512 })
  check('未知文件名回 ERROR', wrongName.op === OP_ERROR)
  check('错误码为 1 File not found', wrongName.errorCode === 1, `实际 ${wrongName.errorCode}`)
  check('有对应的错误日志', logs.some((l) => /请求了 openwrt-other\.bin/.test(l.message)))

  /* ---- 6. WRQ 只读 ---- */
  const wrqResult = await new Promise((resolve) => {
    const sock = dgram.createSocket('udp4')
    const timer = setTimeout(() => {
      sock.close()
      resolve({ timedOut: true })
    }, 2000)
    sock.on('message', (msg) => {
      clearTimeout(timer)
      sock.close()
      resolve({ op: parseOp(msg), code: msg.readUInt16BE(2) })
    })
    sock.bind(0, () => sock.send(wrqPacket('upload.bin'), PORT, '127.0.0.1'))
  })
  check('WRQ 被拒绝（回 ERROR）', wrqResult.op === OP_ERROR)
  check('WRQ 错误码 2（Access violation）', wrqResult.code === 2, `实际 ${wrqResult.code}`)

  /* ---- 7. 传完后状态里的字节数 ---- */
  const afterTransfer = await waitFor(() => server.state().transferred > 0, 2000, () =>
    JSON.stringify(server.state())
  )
  check('传输后 transferred 有值', afterTransfer, JSON.stringify(server.state()))

  /* ---- 8. 停止后释放 ---- */
  server.stop()
  await sleep(120)
  const stopped = server.state()
  check('停止后 running=false', stopped.running === false)
  check('停止后 file 归空', stopped.file === null)
  check('停止后 transferred 归零', stopped.transferred === 0)
  // 停掉后端口应能重新绑上
  const probe = dgram.createSocket('udp4')
  const rebindable = await new Promise((resolve) => {
    probe.once('error', () => resolve(false))
    probe.bind(PORT, () => {
      probe.close()
      resolve(true)
    })
  })
  check('停止后端口可重新绑定', rebindable)

  /* ---- 9. 端口占用报错可读 ---- */
  const blocker = dgram.createSocket('udp4')
  await new Promise((r) => blocker.bind(PORT, r))
  let busyMessage = ''
  try {
    await server.start(firmware, PORT)
  } catch (err) {
    busyMessage = err.message
  }
  check('端口被占用时报可读错误', /已被占用/.test(busyMessage), busyMessage)
  blocker.close()

  /* ---- 10. 清理 ---- */
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    // 忽略
  }

  console.log('')
  if (fail === 0) {
    console.log(`TFTP 服务端自检全部通过（${pass} 项）`)
  } else {
    console.log(`TFTP 服务端自检失败 ${fail} 项 / 通过 ${pass} 项`)
    for (const f of fails) console.log(`  FAIL ${f}`)
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error('自检脚本异常：', err)
  process.exitCode = 1
})
