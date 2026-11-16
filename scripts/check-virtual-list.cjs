/**
 * 虚拟列表自检（阶段 3，补做）。文件名为 check-* 见文末说明。
 *
 * 只验**渲染层**：给 SFTP 面板塞 10000 条目录项，断言 DOM 行数被窗口化、
 * 且滚动高度覆盖全量。不去连真实 SFTP —— 之前两版脚本分别死在
 * 「reload 销毁 CDP target」和「脚本自己建会话状态为空」，
 * 而这里要证明的是虚拟化本身，与数据来自哪条链路无关。
 *
 * 数据源：注入到 sftpStore 的 remoteFiles（面板只消费这个字段渲染，
 * 不看它从哪来），因此构造等价形状的假数据即可，不触碰任何 IO。
 *
 * 三条断言：
 *   1. 渲染的行数远小于总项数（窗口化生效）；
 *   2. 滚动高度 ≈ 总项数 × 行高（滚动条覆盖全量，用户能滚到底）；
 *   3. 滚到中部后仍是少量行、且行内容随滚动变化（不是一次性全渲染）。
 *
 * 区分度：把 RemotePane 的 useVirtualizer 换回 files.map，
 * 第 1 条会红（10000 行全在 DOM 里）。
 *
 * 前置：需要 ZM_TEST=1 的构建（挂 window.__lazy_test 测试桥）。
 *   用法：npm run test:vlist（自动构建测试版、跑断言、再恢复普通构建）
 *
 * 文件名用 check- 而不是 verify- 是刻意的：主门禁 run-all-verify 只 glob `verify-*.cjs`，
 * 而本脚本必须配 ZM_TEST 构建才能跑 —— 挂在主门禁里会稳定红（没有测试桥），
 * 那种红会训练所有人忽略门禁结果。
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
function pickPort(min, max) { return min + Math.floor(Math.random() * (max - min)) }
const APP_PORT = Number(process.env.VL_CDP_PORT || pickPort(21000, 29000))
const USERDATA = path.join(os.tmpdir(), 'sw-vlist-probe')
const PORT = String(APP_PORT)
const N = Number(process.env.VL_COUNT || 10000)
const children = []
function killTree(c) { if (!c || c.killed) return; try { spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
function cleanup() { for (const c of children) killTree(c) }
process.on('exit', cleanup)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(n, ok, d) { if (ok) { pass++; console.log('  PASS  ' + n) } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + JSON.stringify(d) : '')) } }
async function getTarget() { for (let i = 0; i < 60; i++) { try { const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); const p = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (p) return p } catch {} await sleep(400) } throw new Error('no target') }
function connect(url) {
  const ws = new WebSocket(url); const pend = new Map(); let s = 0
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result) } })
  const ready = new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
  const send = (a, b = {}) => new Promise((res, rej) => { const id = ++s; pend.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method: a, params: b })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('timeout ' + a)) } }, 60000) })
  const evaluate = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value }
  return { ready, evaluate, ws }
}

async function main() {
  fs.rmSync(USERDATA, { recursive: true, force: true })
  fs.mkdirSync(USERDATA, { recursive: true })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const exe = process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron')
  const app = spawn(exe, ['.', '--user-data-dir=' + USERDATA, '--remote-debugging-port=' + APP_PORT, '--disable-gpu', '--no-sandbox'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(app)
  await sleep(9000)

  const t = await getTarget()
  const p = connect(t.webSocketDebuggerUrl)
  await p.ready
  await sleep(2000)

  console.log('\n[虚拟列表 · 渲染层]')
  const bridge = await p.evaluate(`!!(window.__lazy_test && window.__lazy_test.stores && window.__lazy_test.stores.sftp)`)
  check('测试桥可用（需 ZM_TEST=1 构建）', bridge === true, String(bridge))
  if (!bridge) { console.log('  跳过：请用 ZM_TEST=1 npm run build 重新构建'); cleanup(); process.exit(1) }

  const injected = await p.evaluate(`(() => {
    const N = ${N}
    const files = Array.from({ length: N }, (_, i) => ({
      name: 'f-' + String(i).padStart(5, '0') + '.txt',
      path: '/big/f-' + String(i).padStart(5, '0') + '.txt',
      size: i * 7,
      type: 'file',
      isLink: false,
      modeStr: '-rw-r--r--',
      mtime: 1700000000000 + i * 1000
    }))
    window.__lazy_test.stores.sftp.setState({ open: true, sessionId: 'vlist', sessionTitle: 'vlist', remoteDir: '/big', remoteFiles: files, remoteLoading: false })
    return files.length
  })()`)
  check('已注入 ' + N + ' 条目录项', injected === N, injected)
  await sleep(2000)

  const geo = await p.evaluate(`(() => {
    const sc = [...document.querySelectorAll('.scroll-thin')].find((el) => el.scrollHeight > el.clientHeight + 200)
    if (!sc) return { found: false }
    const rows = sc.querySelectorAll('[style*="translateY"]').length
    return { found: true, rows, scrollH: Math.round(sc.scrollHeight), clientH: Math.round(sc.clientHeight) }
  })()`)
  console.log('  几何: ' + JSON.stringify(geo))
  check('存在可滚动的列表容器', geo.found === true, geo)
  check('渲染行数远小于总项数（窗口化生效）', geo.found && geo.rows > 0 && geo.rows < 200, geo.rows)
  check('滚动高度覆盖全量（>= N × 20px）', geo.found && geo.scrollH >= N * 20, { scrollH: geo.scrollH, expect: N * 20 })
  check('滚动高度 <= N × 40px（未虚增）', geo.found && geo.scrollH <= N * 40, geo.scrollH)

  const scrolled = await p.evaluate(`(async () => {
    const sc = [...document.querySelectorAll('.scroll-thin')].find((el) => el.scrollHeight > el.clientHeight + 200)
    if (!sc) return { err: 'no scroller' }
    const first = () => { const r = sc.querySelector('[style*="translateY"]'); return r ? r.textContent.slice(0, 24) : '' }
    const before = first()
    sc.scrollTop = sc.scrollHeight / 2
    await new Promise((r) => setTimeout(r, 400))
    const after = first()
    const rows = sc.querySelectorAll('[style*="translateY"]').length
    return { before, after, rows }
  })()`)
  console.log('  滚动: ' + JSON.stringify(scrolled))
  check('滚到中部后仍只渲染少量行', scrolled.rows > 0 && scrolled.rows < 200, scrolled.rows)
  check('滚动后首行内容变化（说明是窗口化而非全量渲染）', scrolled.before !== scrolled.after, scrolled)

  console.log('')
  try { p.ws.close() } catch {}
  cleanup()
  console.log('通过 ' + pass + '  失败 ' + fail)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error('FATAL ' + e.message); cleanup(); process.exit(2) })