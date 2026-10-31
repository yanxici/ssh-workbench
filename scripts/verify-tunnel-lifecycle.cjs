/**
 * 验证隧道运行时生命周期：dispose() 必须真正移除运行时。
 *
 * 用法：node scripts/verify-tunnel-lifecycle.cjs
 *
 * 背景（Volt 报的 P0-2）：
 *   删除隧道配置原先只从 JSON 里 filter 掉，runtime 原样留在 Map 里 ——
 *   状态还是 active、net.Server 继续监听、forwardIn 还绑在远端，
 *   但 TUNNEL_LIST 已经列不出它，用户失去关闭入口，只能重启应用。
 *
 * 本脚本验证状态机语义（不起真实端口，只驱动 runtimes Map）：
 *   - dispose 之后 states() 里不再有该 id；
 *   - stop 之后 states() 里仍有该 id 且 status='stopped'（配置还在，可重启）；
 *   - 对不存在的 id 调 dispose/stop 不抛错。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, '.tsc-verify')
const stubDir = path.join(OUT, 'stub-tunnel')
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-tunnel-'))
  fs.writeFileSync(
    path.join(stubDir, 'electron.cjs'),
    [
      `const userData = ${JSON.stringify(tmp)}`,
      'module.exports = {',
      '  app: { getPath: () => userData },',
      '  BrowserWindow: { getAllWindows: () => [] }',
      '}'
    ].join('\n') + '\n'
  )

  const bundle = path.join(stubDir, 'tunnel.cjs')
  await esbuild.build({
    stdin: {
      contents: `export { tunnelManager } from './src/main/ssh/portForward'`,
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

  const { tunnelManager } = require(bundle)

  // ---- dispose / stop 都是公开方法 ----
  check('tunnelManager.dispose 存在', typeof tunnelManager.dispose === 'function')
  check('tunnelManager.stop 存在', typeof tunnelManager.stop === 'function')
  check('tunnelManager.states 存在', typeof tunnelManager.states === 'function')

  // ---- 初始为空 ----
  check('初始 states() 为空', tunnelManager.states().length === 0, tunnelManager.states().length)

  /*
   * 直接操作私有 runtimes Map 注入假 runtime。
   * 这里刻意不走 start()：start 需要真实 ssh2 Client，本脚本要保证零网络依赖。
   * 目的是锁住「配置删除 → 运行时消失」这个契约，而不是测 ssh2 接线
   * （那部分归 verify-tunnel.cjs，需要 lab ssh server）。
   */
  // 字段要与 TunnelRuntime 对齐：releaseResources 会遍历 sockets/channels 集合并 clear()
  const fake = {
    tunnelId: 'T1',
    sessionId: 'S1',
    status: 'active',
    bindPort: 18080,
    bindHost: '127.0.0.1',
    type: 'local',
    targetHost: '10.0.0.1',
    targetPort: 80,
    startedAt: Date.now(),
    sockets: new Set(),
    channels: new Set()
  }
  tunnelManager.runtimes.set('T1', fake)
  check('注入后 states() 有 1 条', tunnelManager.states().length === 1, tunnelManager.states().length)
  check('注入的状态是 active', tunnelManager.states()[0].status === 'active')

  // ---- stop：保留 runtime，只改状态（配置还在，用户能重启）----
  tunnelManager.stop('T1')
  check('stop 后 states() 仍有该 id', tunnelManager.states().length === 1, tunnelManager.states().length)
  check('stop 后 status = stopped', tunnelManager.states()[0].status === 'stopped',
    tunnelManager.states()[0].status)

  // ---- dispose：彻底移除（配置已删，界面不再需要它）----
  tunnelManager.runtimes.set('T2', { ...fake, tunnelId: 'T2', status: 'active' })
  check('注入 T2 后共 2 条', tunnelManager.states().length === 2, tunnelManager.states().length)
  tunnelManager.dispose('T2')
  check('dispose 后 states() 只剩 1 条', tunnelManager.states().length === 1, tunnelManager.states().length)
  // snapshot 暴露的字段名是 tunnelId（不是 id）
  check('dispose 后该 id 彻底消失',
    !tunnelManager.states().some((s) => s.tunnelId === 'T2'),
    tunnelManager.states().map((s) => s.tunnelId))

  // ---- 幂等：对不存在的 id 调 dispose/stop 不抛 ----
  let threw = null
  try {
    tunnelManager.dispose('NOT_EXIST')
    tunnelManager.stop('NOT_EXIST')
  } catch (e) {
    threw = e
  }
  check('对不存在的 id 调用不抛错', threw === null, threw && threw.message)

  // ---- 会话断开：置 error 而不是 stopped（Volt 确认的行为）----
  tunnelManager.runtimes.set('T3', { ...fake, tunnelId: 'T3', sessionId: 'S9', status: 'active' })
  tunnelManager.onSessionClosed('S9')
  const t3 = tunnelManager.states().find((s) => s.tunnelId === 'T3')
  check('会话断开后该隧道仍在 states 里（便于用户看到原因）', Boolean(t3))
  check('会话断开后 status = error', t3 && t3.status === 'error', t3 && t3.status)

  // 清理
  tunnelManager.dispose('T1')
  tunnelManager.dispose('T3')
  fs.rmSync(tmp, { recursive: true, force: true })

  console.log(`\n${failed === 0 ? '隧道生命周期回归全部通过' : `${failed} 项失败`}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('校验异常:', e)
  process.exit(2)
})
