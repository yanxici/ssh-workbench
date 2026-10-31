/**
 * 批量执行自检：本地起多个 ssh2 测试服务器，直接驱动主进程真实的
 * sessionManager / batchRunner / repository 代码。
 *
 * 覆盖（行为语义由 Volt 复核 batchExec.ts 后确认）：
 *   1. 保序：第一个会话故意最慢，结果下标仍严格等于传入下标（闸门版用 slots 占位）
 *   2. 并发闸门：12 个会话同跑，服务端实测同时在飞的 exec 通道 <= BATCH_CONCURRENCY(8)
 *   3. 单点失败不阻塞：不存在的会话返回 error 项，其余照常 done
 *   4. 取消路径一（执行中）：cancel 后 status=cancelled 且保留部分输出
 *   5. 取消路径二（未就绪）：cancel 先于 waitUntilReady 失败 → cancelled、stdout 空
 *   6. 截断：300KB 输出被截到 256KB + 提示尾巴（不是 exec.ts 的 512KB 默认值）
 *   7. timeoutMs=0 → status=timeout 而不是崩溃
 *   8. 进度事件：running → 终态 两段都有
 *
 * 注意（Volt 提醒）：runs 以 runId 为键且 run() 无条件覆盖，每轮必须换新 runId。
 *
 * 用法：node scripts/verify-batch-exec.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')
const { Server, utils } = require('ssh2')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.tsc-verify')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-batch-'))
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
const bundle = path.join(OUT_DIR, 'batch-bundle.cjs')
esbuild.buildSync({
  stdin: {
    contents: `
      export { sessionManager } from './src/main/ssh/sessionManager'
      export { batchRunner } from './src/main/ssh/batchExec'
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
const br = M.batchRunner

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
async function waitFor(fn, ms = 8000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await sleep(15)
  }
  return fn()
}
const uid = () => Math.random().toString(36).slice(2)

/**
 * 造一个 ssh2 测试服务器。
 * exec 行为按命令分发：
 *   'slow'   → 1200ms 后输出 slow-done
 *   'stream' → 先吐 partial-output 然后挂住不退出（供取消用）
 *   'big'    → 输出 300KB
 *   其他     → delayMs 后输出 ok
 * conc 非空时统计全局在飞 exec 通道数。
 */
function makeServer({ delayMs = 0, conc = null }) {
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
      /*
       * ssh2 的 exec 回调签名是 (accept, reject, info)——命令在第三个参数。
       * 写成 a.command 永远是 undefined，所有命令都会落到默认分支，
       * stream/big 这些用例根本测不到。
       */
      session.on('exec', (a, _reject, info) => {
        const s = a()
        if (conc) {
          conc.now += 1
          conc.max = Math.max(conc.max, conc.now)
          /*
           * 不能用 s.on('close') 减计数：ssh2 服务端通道在 s.exit()/s.end() 之后
           * 往往不触发 'close'（实测 probe：客户端 12 个通道全部结束后，
           * 服务端 close 一次都没来），consecutive 计数只增不减，
           * 峰值必然等于会话总数 12 —— 会误报成「闸门失效」。
           * 改成在「服务端处理完毕」这一刻释放，用标志位防重复。
           */
          let released = false
          conc.release = () => {}
          s.__release = () => {
            if (released) return
            released = true
            conc.now -= 1
          }
        }
        const cmd = (info?.command ?? '').trim()
        if (cmd === 'stream') {
          s.write('partial-output')
          // 挂住不退出，等客户端取消/超时关通道；释放交给 close 兜底
          s.on('close', () => s.__release?.())
          return
        }
        if (cmd === 'big') {
          const chunk = 'A'.repeat(1024)
          for (let i = 0; i < 300; i++) s.write(chunk)
          s.exit(0)
          s.end()
          s.__release?.()
          return
        }
        const wait = cmd === 'slow' ? 1200 : delayMs
        setTimeout(() => {
          try {
            s.write(cmd === 'slow' ? 'slow-done' : 'ok')
            s.exit(0)
            s.end()
          } catch { /* 通道可能已被客户端关闭 */ }
          s.__release?.()
        }, wait)
      })
    })
  })
  return server
}

const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)))

async function main() {
  const slowServer = makeServer({})
  const fastServer = makeServer({})
  const conc = { now: 0, max: 0 }
  const gateServer = makeServer({ delayMs: 150, conc })
  const [slowPort, fastPort, gatePort] = await Promise.all([
    listen(slowServer), listen(fastServer), listen(gateServer)
  ])

  await M.updateSettings({ latencyProbe: false, autoLog: false, strictHostKey: true, autoReconnect: false })

  const mkConn = (name, port) =>
    M.saveConnection({
      name, host: '127.0.0.1', port, username: 'u', authType: 'password',
      password: 'p', group: '默认', tags: []
    })
  const connSlow = await mkConn('batch-slow', slowPort)
  const connFast = await mkConn('batch-fast', fastPort)
  const connGate = await mkConn('batch-gate', gatePort)

  const status = new Map()
  sm.setHandlers({
    onData: () => {},
    onStatus: (id, s) => status.set(id, s),
    onLatency: () => {}
  })

  const openSession = async (connId) => {
    const id = uid()
    await sm.open(id, connId, 80, 24)
    if (status.get(id) !== 'connected') throw new Error('会话连接失败: ' + status.get(id))
    return id
  }

  const progressEvents = []
  br.setProgressHandler((e) => progressEvents.push(e))

  /* ================= 1. 保序：第一个最慢 ================= */
  const sSlow = await openSession(connSlow.id)
  const sFast1 = await openSession(connFast.id)
  const sFast2 = await openSession(connFast.id)
  const orderIds = [sSlow, sFast1, sFast2]
  const r1 = await br.run(uid(), orderIds, 'slow', 10000)
  check('结果数量等于会话数', r1.length === 3, String(r1.length))
  check('下标严格保序（最慢的仍在第 0 位）',
    r1.every((r, i) => r.sessionId === orderIds[i]),
    r1.map((r) => r.sessionId).join(','))
  check('全部 done', r1.every((r) => r.status === 'done'), r1.map((r) => r.status).join(','))

  /* ================= 2. 并发闸门：12 会话，峰值 <= 8 ================= */
  const gateIds = []
  for (let i = 0; i < 12; i++) gateIds.push(await openSession(connGate.id))
  const r2 = await br.run(uid(), gateIds, 'x', 15000)
  check('12 个会话全部完成', r2.length === 12 && r2.every((r) => r.status === 'done'),
    `${r2.length} 个，状态 ${[...new Set(r2.map((r) => r.status))].join('/')}`)
  check('在飞 exec 峰值 <= 8（闸门生效）', conc.max <= 8, `峰值 ${conc.max}`)
  check('确实并发了（峰值 > 1）', conc.max > 1, `峰值 ${conc.max}`)

  /* ================= 3. 单点失败不阻塞 ================= */
  const r3 = await br.run(uid(), [sFast1, 'no-such-session', sFast2], 'x', 10000)
  check('失败项存在且标记 error', r3[1].status === 'error', r3[1].status)
  check('其余项不受影响照常 done', r3[0].status === 'done' && r3[2].status === 'done')
  check('失败项带错误说明', typeof r3[1].error === 'string' && r3[1].error.length > 0, r3[1].error)

  /* ================= 4. 取消路径一：执行中取消，保留部分输出 ================= */
  const runId4 = uid()
  const p4 = br.run(runId4, [sFast1], 'stream', 10000)
  await waitFor(() => progressEvents.some((e) => e.runId === runId4 && e.status === 'running'))
  await sleep(400) // 等 partial-output 到达
  br.cancel(runId4)
  const r4 = await p4
  check('执行中取消 → cancelled', r4[0].status === 'cancelled', r4[0].status)
  check('部分输出被保留', r4[0].stdout.includes('partial-output'), JSON.stringify(r4[0].stdout.slice(0, 40)))

  /* ================= 5. 取消路径二：未就绪即取消 → cancelled 且 stdout 空 ================= */
  /*
   * run() 同步登记 runs 后才进第一个 await，所以同一 tick 里 cancel 必然生效；
   * waitUntilReady 对不存在的会话立刻抛错，catch 判 token.cancelled → 'cancelled'。
   */
  const runId5 = uid()
  const p5 = br.run(runId5, ['no-such-session'], 'x', 10000)
  br.cancel(runId5)
  const r5 = await p5
  check('未就绪 + 已取消 → cancelled（不是 error）', r5[0].status === 'cancelled', r5[0].status)
  check('该路径 stdout 为空', r5[0].stdout === '', JSON.stringify(r5[0].stdout))

  /* ================= 6. 截断：256KB 上限 + 提示尾巴 ================= */
  const r6 = await br.run(uid(), [sFast1], 'big', 15000)
  const NOTE = '...（输出超过上限，已截断）'
  check('300KB 输出被截断', r6[0].stdout.length < 300 * 1024, String(r6[0].stdout.length))
  check('截断上限是 256KB（不是 512KB 默认值）',
    r6[0].stdout.length >= 256 * 1024 && r6[0].stdout.length < 256 * 1024 + 128,
    String(r6[0].stdout.length))
  check('带截断提示尾巴', r6[0].stdout.endsWith(NOTE))

  /* ================= 7. timeoutMs=0 / 负数 → timeout 而不是崩溃 ================= */
  const r7 = await br.run(uid(), [sFast2], 'x', 0)
  check('timeoutMs=0 返回 timeout', r7[0].status === 'timeout', r7[0].status)
  /*
   * 负数同 0：Node setTimeout 对负值按 1ms 处理，语义是「立即超时」。
   * 本断言锁定修复前行为（Volt 要求按实际行为写）；exec.ts 夹紧落地后
   * 改断言为 status=done 且耗时 >= 默认超时窗口。
   */
  const r7b = await br.run(uid(), [sFast2], 'x', -1)
  check('timeoutMs=-1 返回 timeout（不崩溃）', r7b[0].status === 'timeout', r7b[0].status)

  /* ================= 8. 进度事件两段齐全 ================= */
  const runId8 = uid()
  await br.run(runId8, [sFast1], 'x', 10000)
  const evts = progressEvents.filter((e) => e.runId === runId8)
  check('有 running 事件', evts.some((e) => e.status === 'running'))
  check('有终态事件', evts.some((e) => e.status === 'done'))

  /* ---------- 清理 ---------- */
  for (const id of [sSlow, sFast1, sFast2, ...gateIds]) sm.close(id)
  await sleep(200)
  slowServer.close()
  fastServer.close()
  gateServer.close()

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
