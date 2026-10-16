/**
 * 会话层压测：本地起一个 ssh2 测试服务器，直接驱动主进程真实的 sessionManager / repository 代码。
 * 覆盖：会话内新建终端（共享连接引用计数）、断线检测、原地重连、连接中途关闭、
 *       JSON 存储并发读改写、命令分组重命名/删除、设置并发写。
 * 用法：node scripts/verify-session.cjs [压测轮数，默认 40]
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')
const { Server, utils } = require('ssh2')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.tsc-verify')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-session-'))
process.env.SW_TEST_USERDATA = userData

/* ---------- 打包被测代码（electron 用桩替换） ---------- */
fs.mkdirSync(OUT_DIR, { recursive: true })
const stub = path.join(OUT_DIR, 'electron-stub.cjs')
fs.writeFileSync(
  stub,
  `module.exports = {
  app: { getPath: () => process.env.SW_TEST_USERDATA },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() }
}`
)
const bundle = path.join(OUT_DIR, 'session-bundle.cjs')
esbuild.buildSync({
  stdin: {
    contents: `
      export { sessionManager } from './src/main/ssh/sessionManager'
      export * from './src/main/store/repository'
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
  // buildSync 不支持插件，用 alias 替换 electron 与 @shared 路径
  alias: {
    electron: stub,
    '@shared': path.join(ROOT, 'src/shared')
  }
})
const M = require(bundle)
const sm = M.sessionManager

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

/* ---------- 事件采集 ---------- */
const status = new Map()
const output = new Map()
const statusLog = []
sm.setHandlers({
  onData: (id, d) => output.set(id, (output.get(id) ?? '') + d),
  onStatus: (id, s, e) => {
    status.set(id, s)
    statusLog.push([id, s, e])
  },
  onLatency: () => {}
})

/* ---------- 测试 SSH 服务器 ---------- */
const liveConns = new Set()
let shellCount = 0
const hostKey = utils.generateKeyPairSync('ed25519').private
const server = new Server({ hostKeys: [hostKey] }, (client) => {
  liveConns.add(client)
  client.on('close', () => liveConns.delete(client))
  client.on('error', () => {})
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'u' && ctx.password === 'p') ctx.accept()
    else ctx.reject(['password'])
  })
  client.on('session', (accept) => {
    const session = accept()
    session.on('pty', (a) => a && a())
    session.on('window-change', (a) => a && a())
    session.on('exec', (a) => {
      const s = a()
      s.exit(0)
      s.end()
    })
    session.on('shell', (a) => {
      const s = a()
      const n = ++shellCount
      s.write(`READY#${n}\r\n`)
      s.on('data', (d) => {
        const text = d.toString()
        if (text.includes('exit')) {
          s.exit(0)
          s.end()
        } else s.write(`OUT#${n}:${text}`)
      })
    })
  })
})

const uid = () => Math.random().toString(36).slice(2)

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  await M.setSettings({ latencyProbe: false, autoLog: true, strictHostKey: true })
  const conn = await M.saveConnection({
    name: 'test', host: '127.0.0.1', port, username: 'u', authType: 'password',
    password: 'p', group: '默认', tags: []
  })

  /* 1. 基础连接 */
  const A = uid()
  await sm.open(A, conn.id, 80, 24)
  check('A 已连接', status.get(A) === 'connected')
  check('A 收到 shell 输出', await waitFor(() => /READY#/.test(output.get(A) ?? '')))
  check('服务器连接数=1', liveConns.size === 1, `实际 ${liveConns.size}`)

  /* 2. 会话内新建终端（复用连接） */
  const B = uid()
  const C = uid()
  await Promise.all([sm.openShell(B, conn.id, A, 100, 30), sm.openShell(C, conn.id, A, 80, 24)])
  check('B/C 已连接', status.get(B) === 'connected' && status.get(C) === 'connected')
  check('新建终端不新增 SSH 连接', liveConns.size === 1, `实际 ${liveConns.size}`)
  sm.write(B, 'hello-B')
  check('B 输入只回到 B', await waitFor(() => /hello-B/.test(output.get(B) ?? '')))
  await sleep(100)
  check('A/C 没串到 B 的输出', !/hello-B/.test((output.get(A) ?? '') + (output.get(C) ?? '')))
  let rejected = false
  try {
    await sm.openShell(uid(), conn.id, 'no-such', 80, 24)
  } catch {
    rejected = true
  }
  check('宿主不存在时拒绝新建终端', rejected)

  /* 3. 关掉一个终端，其他终端和连接不受影响 */
  sm.close(B)
  await sleep(150)
  sm.write(A, 'still-A')
  sm.write(C, 'still-C')
  check('关 B 后 A 正常', await waitFor(() => /still-A/.test(output.get(A) ?? '')))
  check('关 B 后 C 正常', await waitFor(() => /still-C/.test(output.get(C) ?? '')))
  check('关 B 后连接仍在', liveConns.size === 1)

  /* 4. 关掉宿主 A，C 仍可用；最后一个关掉才断连接 */
  sm.close(A)
  await sleep(150)
  sm.write(C, 'after-A-closed')
  check('关宿主后 C 仍可用', await waitFor(() => /after-A-closed/.test(output.get(C) ?? '')))
  check('关宿主后连接仍在', liveConns.size === 1)
  sm.close(C)
  check('最后一个终端关闭后断开连接', await waitFor(() => liveConns.size === 0), `实际 ${liveConns.size}`)
  check('会话表清空', sm.list().length === 0, `残留 ${sm.list().length}`)

  /* 5. 单个 shell 退出（exit）只影响自己 */
  const D = uid()
  const E = uid()
  await sm.open(D, conn.id, 80, 24)
  await sm.openShell(E, conn.id, D, 80, 24)
  sm.write(E, 'exit')
  check('E exit 后标记断开', await waitFor(() => status.get(E) === 'disconnected'))
  sm.write(D, 'D-alive')
  check('E exit 后 D 正常', await waitFor(() => /D-alive/.test(output.get(D) ?? '')))

  /* 6. 网络中断：服务器掐断连接，连接上所有终端都变断开 */
  const F = uid()
  await sm.openShell(F, conn.id, D, 80, 24)
  for (const c of liveConns) c.end()
  check('掐线后 D 断开', await waitFor(() => status.get(D) === 'disconnected'))
  check('掐线后 F 断开', await waitFor(() => status.get(F) === 'disconnected'))
  check('掐线后会话表清空', await waitFor(() => sm.list().length === 0))

  /* 7. 原地重连（同一 sessionId） */
  output.set(D, '')
  await sm.open(D, conn.id, 80, 24)
  check('D 重连成功', status.get(D) === 'connected')
  sm.write(D, 'after-reconnect')
  check('重连后可输入', await waitFor(() => /after-reconnect/.test(output.get(D) ?? '')))
  await sleep(300)
  check('重连后状态未被旧事件覆盖', status.get(D) === 'connected', `实际 ${status.get(D)}`)
  sm.close(D)
  await waitFor(() => liveConns.size === 0)

  /* 8. 连接中途关闭：不泄漏连接 */
  const G = uid()
  const p = sm.open(G, conn.id, 80, 24).catch(() => {})
  sm.close(G)
  await p
  check('连接中途关闭不泄漏', await waitFor(() => liveConns.size === 0 && sm.list().length === 0, 3000),
    `连接 ${liveConns.size} 会话 ${sm.list().length}`)

  /* 9. 错误密码 → error，重连仍报错，不残留 */
  const bad = await M.saveConnection({
    name: 'bad', host: '127.0.0.1', port, username: 'u', authType: 'password',
    password: 'wrong', group: '默认', tags: []
  })
  const H = uid()
  await sm.open(H, bad.id, 80, 24).catch(() => {})
  check('错误密码 → error', status.get(H) === 'error')
  await sm.open(H, bad.id, 80, 24).catch(() => {})
  check('错误密码重连仍 error 且无残留', status.get(H) === 'error' && sm.list().length === 0)

  /* 10. 随机压测：反复开会话 / 新建终端 / 随机关闭 / 掐线 / 重连 */
  const ROUNDS = Number(process.argv[2]) || 40
  const t0 = Date.now()
  for (let r = 0; r < ROUNDS; r++) {
    const host = uid()
    await sm.open(host, conn.id, 80, 24)
    const kids = []
    const n = 1 + Math.floor(Math.random() * 6)
    await Promise.all(
      Array.from({ length: n }, () => {
        const k = uid()
        kids.push(k)
        return sm.openShell(k, conn.id, host, 80, 24).catch(() => {})
      })
    )
    const all = [host, ...kids]
    // 每个终端各写一次，确认隔离
    all.forEach((id) => sm.write(id, `ping-${id}`))
    const okIso = await waitFor(() => all.every((id) => (output.get(id) ?? '').includes(`ping-${id}`)), 3000)
    check(`第${r}轮 ${all.length} 个终端输出隔离`, okIso)
    const mode = r % 3
    if (mode === 0) {
      // 乱序逐个关闭
      all.sort(() => Math.random() - 0.5).forEach((id) => sm.close(id))
    } else if (mode === 1) {
      // 掐线后原地重连宿主再关
      for (const c of liveConns) c.end()
      await waitFor(() => all.every((id) => status.get(id) === 'disconnected'), 3000)
      await sm.open(host, conn.id, 80, 24)
      check(`第${r}轮掐线后重连`, status.get(host) === 'connected')
      sm.close(host)
    } else {
      // 连发关闭 + 重复关闭
      all.forEach((id) => {
        sm.close(id)
        sm.close(id)
      })
    }
    const clean = await waitFor(() => liveConns.size === 0 && sm.list().length === 0, 3000)
    check(`第${r}轮无连接/会话泄漏`, clean, `连接 ${liveConns.size} 会话 ${sm.list().length}`)
  }
  console.log(`随机压测 ${ROUNDS} 轮耗时 ${Date.now() - t0}ms`)

  /* 11. 存储并发：200 条命令并发保存不丢 */
  const before = (await M.listCommands()).length
  await Promise.all(
    Array.from({ length: 200 }, (_, i) =>
      M.saveCommand({ name: `c${i}`, command: `echo ${i}`, group: i % 2 ? 'G1' : 'G2', confirmRequired: false, variables: [] })
    )
  )
  const afterList = await M.listCommands()
  check('并发保存 200 条不丢', afterList.length === before + 200, `${afterList.length - before}/200`)
  const disk = JSON.parse(fs.readFileSync(path.join(userData, 'data', 'commands.json'), 'utf8'))
  check('落盘与内存一致', disk.length === afterList.length, `磁盘 ${disk.length} 内存 ${afterList.length}`)

  /* 12. 分组重命名 / 删除（与并发保存交错） */
  const [moved] = await Promise.all([
    M.renameCommandGroup('G1', 'G1-新'),
    M.saveCommand({ name: 'x', command: 'x', group: 'G2', confirmRequired: false, variables: [] })
  ])
  const l2 = await M.listCommands()
  check('重命名移动 100 条', moved === 100, `实际 ${moved}`)
  check('旧分组已无命令', !l2.some((c) => c.group === 'G1'))
  check('交错保存未丢', l2.filter((c) => c.group === 'G2').length === 101)
  const removed = await M.deleteCommandGroup('G2')
  const l3 = await M.listCommands()
  check('删除分组 101 条', removed === 101 && !l3.some((c) => c.group === 'G2'), `删除 ${removed}`)
  check('其他分组不受影响', l3.filter((c) => c.group === 'G1-新').length === 100)
  let threw = false
  try {
    await M.renameCommandGroup('G1-新', '   ')
  } catch {
    threw = true
  }
  check('空分组名被拒绝', threw)

  /* 13. 设置并发写不互相覆盖 */
  await Promise.all([
    M.setSettings({ commandGroups: ['空分组A', '空分组B'] }),
    M.setSettings({ theme: 'light' }),
    M.setSettings({ autoLog: false })
  ])
  const st = await M.getSettings()
  check('并发设置全部生效',
    st.theme === 'light' && st.autoLog === false && (st.commandGroups ?? []).length === 2,
    JSON.stringify({ theme: st.theme, autoLog: st.autoLog, groups: st.commandGroups }))

  server.close()
  fs.rmSync(userData, { recursive: true, force: true })
  fs.rmSync(bundle, { force: true })
  fs.rmSync(stub, { force: true })

  console.log(`通过 ${pass}  失败 ${fail}`)
  fails.slice(0, 20).forEach((f) => console.log('  ✗ ' + f))
  process.exit(fail ? 1 : 0)
}

process.on('uncaughtException', (e) => {
  console.log('未捕获异常: ' + (e && e.stack))
  process.exit(2)
})
main().catch((e) => {
  console.log('测试中断: ' + (e && e.stack))
  process.exit(2)
})
