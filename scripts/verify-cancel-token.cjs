/**
 * 验证取消令牌的订阅广播与 execCollect 的取消路径。
 *
 * 用法：node scripts/verify-cancel-token.cjs
 *
 * 背景（Volt 报的 P1-5）：
 *   exec.ts 原来给每个任务挂一个 120ms 的 setInterval 去轮询 token.cancelled。
 *   批量 50 会话 + 巡检 4 并发 + 监控 N 台时，几十上百个定时器每秒空转几百次。
 *   改成订阅制后必须保证两件事，否则取消会失效（比空转严重得多）：
 *     1. 一次 cancel() 能广播到所有在跑的订阅者；
 *     2. finish 之后的订阅必须被摘掉，不能泄漏。
 */
const fs = require('node:fs')
const path = require('node:path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, '.tsc-verify')
const stubDir = path.join(OUT, 'stub-cancel')
fs.mkdirSync(stubDir, { recursive: true })

let failed = 0
function check(name, ok, extra) {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failed++
    console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`)
  }
}

async function main() {
  fs.writeFileSync(
    path.join(stubDir, 'electron.cjs'),
    'module.exports = { app: { getPath: () => require("node:os").tmpdir() } }\n'
  )

  const bundle = path.join(stubDir, 'exec.cjs')
  await esbuild.build({
    stdin: {
      contents: `export { createCancelToken, execCollect } from './src/main/ssh/exec'`,
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['electron', 'ssh2'],
    logLevel: 'error',
    alias: { '@shared': path.join(ROOT, 'src/shared'), electron: path.join(stubDir, 'electron.cjs') }
  })

  const { createCancelToken, execCollect } = require(bundle)

  // ---- 基础语义 ----
  const t = createCancelToken()
  check('初始 cancelled = false', t.cancelled === false)
  check('onCancel 是函数', typeof t.onCancel === 'function')
  check('cancel 是函数', typeof t.cancel === 'function')

  // ---- 广播：一次 cancel 命中所有订阅者 ----
  let hits = 0
  const unsubs = []
  for (let i = 0; i < 10; i++) unsubs.push(t.onCancel(() => (hits += 1)))
  t.cancel()
  check('10 个订阅者全部收到取消', hits === 10, hits)
  check('cancel 后 cancelled = true', t.cancelled === true)

  // ---- 幂等：重复 cancel 不重复广播 ----
  hits = 0
  const t2 = createCancelToken()
  t2.onCancel(() => (hits += 1))
  t2.cancel()
  t2.cancel()
  t2.cancel()
  check('重复 cancel 只广播一次', hits === 1, hits)

  // ---- 退订：finish 后必须能摘掉 ----
  const t3 = createCancelToken()
  let called = 0
  const off = t3.onCancel(() => (called += 1))
  off()
  t3.cancel()
  check('退订后不再收到广播', called === 0, called)

  // ---- 订阅者抛错不影响其他订阅者 ----
  const t4 = createCancelToken()
  let okCount = 0
  t4.onCancel(() => {
    throw new Error('订阅者故意抛错')
  })
  t4.onCancel(() => (okCount += 1))
  let threw = null
  try {
    t4.cancel()
  } catch (e) {
    threw = e
  }
  check('单个订阅者抛错不冒出来', threw === null, threw && threw.message)
  check('其他订阅者仍收到取消', okCount === 1, okCount)

  // ---- execCollect：已取消的令牌直接结算，不白开通道 ----
  const fakeClient = {
    exec() {
      throw new Error('不该走到这里：已取消的令牌必须先结算')
    }
  }
  const preCancelled = createCancelToken()
  preCancelled.cancel()
  const r1 = await execCollect(fakeClient, 'true', 5000, preCancelled)
  check('已取消令牌 → status=cancelled', r1.status === 'cancelled', r1.status)

  // ---- execCollect：运行中被取消 ----
  const tokens = createCancelToken()
  let closed = false
  const stream = {
    on() {},
    close() {
      closed = true
    },
    stderr: { on() {} }
  }
  const client2 = {
    exec(_cmd, cb) {
      cb(null, stream)
    }
  }
  const p = execCollect(client2, 'sleep 100', 60000, tokens)
  await new Promise((r) => setTimeout(r, 30))
  tokens.cancel()
  const r2 = await p
  check('运行中取消 → status=cancelled', r2.status === 'cancelled', r2.status)
  check('运行中取消 → 通道被关闭', closed === true, closed)

  console.log(`\n${failed === 0 ? '取消令牌回归全部通过' : `${failed} 项失败`}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('校验异常:', e)
  process.exit(2)
})
