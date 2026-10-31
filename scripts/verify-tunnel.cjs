/**
 * 隧道运行时自检：本地起 ssh2 测试服务器（支持 tcpip/forwardOut）+ 真实 origin TCP，
 * 直接驱动主进程真实的 sessionManager / tunnelManager / repository 代码。
 *
 * 覆盖（行为语义由 Volt 复核 portForward.ts 后确认）：
 *   1. -L 数据穿透（本机端口 → SSH → origin 回显）
 *   2. 幂等 start（:62-66）：同 tunnelId+sessionId 不重置 connectionCount、不重新 listen
 *   3. stop 清零（:368-410）：状态 stopped、本机端口不再可连
 *   4. 会话断开自动停（:136-145）：状态是 error 不是 stopped，文案固定
 *   5. 删除前 dispose（P0-2 幽灵隧道回归锁，ipc/backupTunnel.ts:41-44）：
 *      dispose+deleteTunnel 后 states() 不再含该 id、端口释放、再 start 报「配置不存在」
 *   6. start 失败态（:97-101）：runtime 留在 Map 里 status=error，stop 可清干净
 *
 * 用法：node scripts/verify-tunnel.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const net = require('net')
const esbuild = require('esbuild')
const { Server, utils } = require('ssh2')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.tsc-verify')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-tunnel-'))
process.env.SW_TEST_USERDATA = userData

/* ---------- 打包被测代码（electron 用桩替换） ---------- */
fs.mkdirSync(OUT_DIR, { recursive: true })
const stub = path.join(OUT_DIR, 'electron-stub.cjs')
fs.writeFileSync(
  stub,
  `module.exports = {
  app: {
    getPath: () => process.env.SW_TEST_USERDATA,
    // settingsService 连带引入 updater，后者模块顶层读这些
    getVersion: () => '0.0.0-test',
    getName: () => 'ssh-workbench-test',
    isPackaged: false
  },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() }
}`
)
const bundle = path.join(OUT_DIR, 'tunnel-bundle.cjs')
esbuild.buildSync({
  stdin: {
    contents: `
      export { sessionManager } from './src/main/ssh/sessionManager'
      export { tunnelManager } from './src/main/ssh/portForward'
      export * from './src/main/store/repository'
      // setSettings 已从 repository 出口摘除（强制走 service 层副作用），脚本预置数据要走这里
      export { updateSettings } from './src/main/app/settingsService'
    `,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle,
  external: ['ssh2'],
  logLevel: 'error',
  alias: {
    electron: stub,
    '@shared': path.join(ROOT, 'src/shared')
  }
})
const M = require(bundle)
const sm = M.sessionManager
const tm = M.tunnelManager

/* ---------- 测试框架 ---------- */
let pass = 0
let fail = 0
const fails = []
function check(name, ok, detail = '') {
  if (ok) pass++
  else {
    fail++
    fails.push(`${name} ${detail}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 5000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await sleep(15)
  }
  return fn()
}
const uid = () => Math.random().toString(36).slice(2)

/** 拿一个当前空闲的端口（listen 0 取到后立即释放；本机测试竞态可忽略） */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
    s.on('error', reject)
  })
}

/** 尝试连接端口：成功返回 socket，失败返回 null */
function tryConnect(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1')
    const timer = setTimeout(() => {
      sock.destroy()
      resolve(null)
    }, timeoutMs)
    sock.on('connect', () => {
      clearTimeout(timer)
      resolve(sock)
    })
    sock.on('error', () => {
      clearTimeout(timer)
      resolve(null)
    })
  })
}

const stateOf = (id) => tm.states().find((s) => s.tunnelId === id)

async function main() {
  /* ---------- origin：真实 TCP 回显服务 ---------- */
  const origin = net.createServer((s) => {
    s.on('error', () => {})
    s.on('data', (d) => s.write('ECHO:' + d))
  })
  await new Promise((r) => origin.listen(0, '127.0.0.1', r))
  const originPort = origin.address().port

  /* ---------- ssh2 测试服务器：shell + tcpip（forwardOut 出口） ---------- */
  const hostKey = utils.generateKeyPairSync('ed25519').private
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {})
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === 'u' && ctx.password === 'p') ctx.accept()
      else ctx.reject(['password'])
    })
    client.on('session', (accept) => {
      const session = accept()
      session.on('pty', (a) => a && a())
      session.on('window-change', (a) => a && a())
      session.on('shell', (a) => {
        const s = a()
        s.write('READY\r\n')
        s.on('data', () => {})
      })
    })
    /* -L 隧道的远端出口：把通道桥到 origin */
    client.on('tcpip', (accept, reject, info) => {
      const ch = accept()
      const up = net.connect(originPort, '127.0.0.1')
      ch.on('close', () => up.destroy())
      up.on('connect', () => {
        ch.pipe(up)
        up.pipe(ch)
      })
      up.on('error', () => {
        try { ch.close() } catch { /* ignore */ }
      })
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const sshPort = server.address().port

  await M.updateSettings({ latencyProbe: false, autoLog: false, strictHostKey: true, autoReconnect: false })
  const conn = await M.saveConnection({
    name: 'tunnel-test', host: '127.0.0.1', port: sshPort, username: 'u', authType: 'password',
    password: 'p', group: '默认', tags: []
  })

  const status = new Map()
  sm.setHandlers({
    onData: () => {},
    onStatus: (id, s) => status.set(id, s),
    onLatency: () => {}
  })

  const A = uid()
  await sm.open(A, conn.id, 80, 24)
  check('会话已连接', status.get(A) === 'connected', String(status.get(A)))

  /* ================= 1. -L 数据穿透 ================= */
  const bindPort = await freePort()
  const t1 = await M.saveTunnel({
    name: 'L-穿透', type: 'local', bindHost: '127.0.0.1', bindPort,
    targetHost: '127.0.0.1', targetPort: originPort, connectionId: conn.id
  })
  const info1 = await tm.start(t1.id, A)
  check('start 返回 active', info1.status === 'active', info1.status + ' ' + (info1.error ?? ''))

  const probe1 = await tryConnect(bindPort)
  check('本机端口可连', probe1 !== null)
  if (probe1) {
    const got = new Promise((r) => probe1.once('data', (d) => r(d.toString())))
    probe1.write('ping')
    const echo = await Promise.race([got, sleep(3000).then(() => null)])
    check('数据经隧道穿透到 origin 并回来', echo === 'ECHO:ping', String(echo))
    probe1.destroy()
  }
  check('connectionCount 记到 1', await waitFor(() => (stateOf(t1.id)?.connectionCount ?? 0) >= 1),
    String(stateOf(t1.id)?.connectionCount))

  /* ================= 2. 幂等 start ================= */
  const before = stateOf(t1.id).connectionCount
  const info2 = await tm.start(t1.id, A)
  check('重复 start 直接返回快照（仍 active）', info2.status === 'active')
  check('connectionCount 未被重置', stateOf(t1.id).connectionCount === before,
    `${before} -> ${stateOf(t1.id).connectionCount}`)
  const probe2 = await tryConnect(bindPort)
  check('重复 start 后端口仍在监听', probe2 !== null)
  if (probe2) probe2.destroy()

  /* ================= 3. stop 清零 ================= */
  tm.stop(t1.id)
  check('stop 后状态为 stopped', stateOf(t1.id)?.status === 'stopped', stateOf(t1.id)?.status)
  const probe3 = await tryConnect(bindPort)
  check('stop 后本机端口不再可连', probe3 === null)
  if (probe3) probe3.destroy()

  /* ================= 4. 会话断开 → error（不是 stopped） ================= */
  await tm.start(t1.id, A)
  check('重新 start 成功', stateOf(t1.id)?.status === 'active')
  sm.close(A)
  await waitFor(() => !status.get(A) || status.get(A) === 'disconnected')
  tm.onSessionClosed(A) // 应用内由 main/index.ts:1385 接线，这里直接驱动单元
  check('会话断开后隧道状态为 error', stateOf(t1.id)?.status === 'error', stateOf(t1.id)?.status)
  check('错误文案固定', stateOf(t1.id)?.error === '会话已断开，隧道已停止', stateOf(t1.id)?.error)
  const probe4 = await tryConnect(bindPort)
  check('会话断开后端口已释放', probe4 === null)
  if (probe4) probe4.destroy()

  /* ================= 5. 删除前 dispose（P0-2 幽灵隧道回归锁） ================= */
  /*
   * 旧实现 TUNNEL_DELETE 只删 JSON 记录，runtime 留在 Map：
   * net.Server 继续监听、用户失去关闭入口。修复后删除路径先 dispose。
   * 这里模拟修复后的 ipc/backupTunnel.ts:41-44 顺序。
   */
  const A2 = uid()
  await sm.open(A2, conn.id, 80, 24)
  check('新会话已连接', status.get(A2) === 'connected')

  const bindPort2 = await freePort()
  const t2 = await M.saveTunnel({
    name: 'L-删除回归', type: 'local', bindHost: '127.0.0.1', bindPort: bindPort2,
    targetHost: '127.0.0.1', targetPort: originPort, connectionId: conn.id
  })
  await tm.start(t2.id, A2)
  check('删除前隧道 active', stateOf(t2.id)?.status === 'active')

  tm.dispose(t2.id)          // TUNNEL_DELETE 第一步
  await M.deleteTunnel(t2.id) // 第二步

  check('dispose 后 states() 不再含该 id', !stateOf(t2.id))
  const probe5 = await tryConnect(bindPort2)
  check('dispose 后端口已释放（无幽灵监听）', probe5 === null)
  if (probe5) probe5.destroy()
  check('配置已从 tunnels.json 删除', !(await M.listTunnels()).some((t) => t.id === t2.id))
  let startAfterDeleteRejected = false
  try {
    await tm.start(t2.id, A2)
  } catch {
    startAfterDeleteRejected = true
  }
  check('删除后再 start 被拒绝', startAfterDeleteRejected)

  /* ================= 6. start 失败态：留在 Map，stop 可清 ================= */
  /*
   * 注意（Volt 提醒）：失败路径 :97-101 会把 runtime 留在 Map 且 status=error，
   * 所以「stop 清零」类断言不能拿失败态当前置，这里单独验证失败态本身。
   */
  const blocker = net.createServer()
  await new Promise((r) => blocker.listen(0, '127.0.0.1', r))
  const occupiedPort = blocker.address().port
  const t3 = await M.saveTunnel({
    name: 'L-端口冲突', type: 'local', bindHost: '127.0.0.1', bindPort: occupiedPort,
    targetHost: '127.0.0.1', targetPort: originPort, connectionId: conn.id
  })
  const info3 = await tm.start(t3.id, A2)
  check('端口被占用时 start 返回 error', info3.status === 'error', info3.status)
  check('错误信息说明端口占用', /已被占用/.test(info3.error ?? ''), info3.error)
  check('失败态 runtime 仍留在 Map（供 UI 显示）', !!stateOf(t3.id))
  tm.stop(t3.id)
  check('失败态可被 stop 清为 stopped', stateOf(t3.id)?.status === 'stopped', stateOf(t3.id)?.status)
  blocker.close()

  /* ---------- 清理 ---------- */
  sm.close(A2)
  await sleep(200)
  server.close()
  origin.close()

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fails.length) {
    console.log('失败项：')
    for (const f of fails) console.log('  - ' + f)
  }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('自检异常:', e)
  process.exit(2)
})
