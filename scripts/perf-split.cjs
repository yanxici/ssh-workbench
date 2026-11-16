/**
 * 嵌套分屏（v2.1.5）压测。
 *
 * 量三件事，都是分屏最容易出事的地方：
 *   P1 布局计算：layoutPaneTree 在 4 格树上反复算矩形/分隔条，纯 CPU；
 *   P2 落盘链路：settings.set({splitLayout}) 往返一次要多久（拖拽松手就会触发）；
 *   P3 数据零影响：压测前后 connections.json 的条数与 id 集合必须完全一致。
 *
 * 为什么 P2 要跑真应用：splitLayout 走的是「渲染层 → IPC → JsonStore.update →
 * 磁盘 → 回读」整条链路，v2.1.5 期间正是在这条链路上发现 JsonStore 写-读竞态
 * （写成功、读回空）。只测纯函数会漏掉它。
 *
 * 用法：node scripts/perf-split.cjs
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const crypto = require('node:crypto')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
function pickPort(min, max) { return min + Math.floor(Math.random() * (max - min)) }
const APP_PORT = Number(process.env.PS_CDP_PORT || pickPort(21000, 29000))
const PORT = String(APP_PORT)
const USERDATA = path.join(os.tmpdir(), 'sw-perf-split')
const DATA_DIR = path.join(USERDATA, 'data')

const children = []
function killTree(c) { if (!c || c.killed) return; try { spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
process.on('exit', () => { for (const c of children) killTree(c) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')) }
}

function sig(file) {
  try {
    const raw = fs.readFileSync(file, 'utf-8')
    const list = JSON.parse(raw)
    const ids = Array.isArray(list) ? list.map((x) => x && x.id).sort() : []
    return { n: Array.isArray(list) ? list.length : -1, ids: ids, sha: crypto.createHash('sha256').update(raw).digest('hex') }
  } catch { return { n: -1, ids: [], sha: 'missing' } }
}

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
      const p = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (p) return p
    } catch {}
    await sleep(400)
  }
  throw new Error('CDP 无可用页面目标')
}

function connect(url) {
  const ws = new WebSocket(url)
  const pend = new Map()
  let seq = 0
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) {
      const pair = pend.get(m.id)
      pend.delete(m.id)
      if (m.error) pair.reject(new Error(JSON.stringify(m.error)))
      else pair.resolve(m.result)
    }
  })
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq
    pend.set(id, { resolve: resolve, reject: reject })
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }))
    setTimeout(() => { if (pend.has(id)) { pend.delete(id); reject(new Error('timeout ' + method)) } }, 60000)
  })
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? String(r.exceptionDetails.exception.description) : 'eval error')
    return r.result.value
  }
  return { ready: ready, send: send, evaluate: evaluate, ws: ws }
}

async function main() {
  /* ---------------- P1 纯逻辑：布局计算吞吐 ---------------- */
  const OUT = path.join(ROOT, '.tsc-verify')
  fs.mkdirSync(OUT, { recursive: true })
  const bundle = path.join(OUT, 'panetree-perf.cjs')
  await esbuild.build({
    stdin: { contents: "export { layoutPaneTree, countLeaves } from './src/renderer/src/lib/paneTree'", resolveDir: ROOT, loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle, logLevel: 'error'
  })
  const PT = require(bundle)
  const tree = {
    type: 'split', dir: 'row', ratio: 0.5,
    children: [
      { type: 'split', dir: 'col', ratio: 0.6, children: [{ type: 'leaf', sessionId: 'a' }, { type: 'leaf', sessionId: 'b' }] },
      { type: 'split', dir: 'col', ratio: 0.4, children: [{ type: 'leaf', sessionId: 'c' }, { type: 'leaf', sessionId: 'd' }] }
    ]
  }
  check('P1a 4 格树叶子数正确', PT.countLeaves(tree) === 4, PT.countLeaves(tree))
  const t0 = process.hrtime.bigint()
  const ITER = 20000
  let cells = 0
  for (let i = 0; i < ITER; i++) {
    const out = PT.layoutPaneTree(tree, i % 2 === 0 ? 'row' : 'col')
    cells += out.rects.size + out.dividers.length
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  const perIter = ms / ITER
  check('P1b 布局计算单次 < 50us（拖拽 60fps 的预算内）', perIter < 0.05, { perIter: perIter, ms: ms, cells: cells })
  console.log('        ' + ITER + ' 次 = ' + ms.toFixed(1) + 'ms，单次 ' + (perIter * 1000).toFixed(2) + 'us')

  /* ---------------- P2 真应用：splitLayout 落盘往返 ---------------- */
  fs.rmSync(USERDATA, { recursive: true, force: true })
  fs.mkdirSync(USERDATA, { recursive: true })

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const app = spawn(path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe'),
    ['.', '--user-data-dir=' + USERDATA, '--remote-debugging-port=' + PORT, '--disable-gpu', '--no-sandbox'],
    { cwd: ROOT, env: env, stdio: 'ignore' })
  children.push(app)

  const target = await getTarget()
  const p = connect(target.webSocketDebuggerUrl)
  await p.ready
  await p.send('Runtime.enable', {})
  for (let i = 0; i < 150; i++) {
    const ok = await p.evaluate('document.body && document.body.innerText.length > 100').catch(() => false)
    if (ok === true) break
    await sleep(200)
  }

  const connSigBefore = sig(path.join(DATA_DIR, 'connections.json'))

  /* 直接走 IPC 落盘：绕开 UI，量的是「渲染层 → 主进程 → 磁盘 → 回读」这条链。
     每轮只写一个键，读完立刻校验：v2.1.5 的 JsonStore 竞态正是「写成功、读回空」，
     所以判据必须读回值，不能只看 set 是否返回 ok。 */
  const written = await p.evaluate('(async () => {' +
    ' const N = 40; const times = []; const mismatches = [];' +
    ' for (let i = 0; i < N; i++) {' +
    '   const layout = {};' +
    '   layout["perfconn-" + i] = { t: "s", d: i % 2 === 0 ? "row" : "col", r: 0.3 + (i % 5) * 0.1, k: [{ t: "l", c: "perfconn-" + i }, { t: "l", c: "perfconn-" + i + "-b" }] };' +
    '   const t0 = performance.now();' +
    '   const w = await window.api.settings.set({ splitLayout: layout });' +
    '   const g = await window.api.settings.get();' +
    '   times.push(performance.now() - t0);' +
    '   if (!g || !g.ok || !g.data || !g.data.splitLayout || !g.data.splitLayout["perfconn-" + i]) mismatches.push(i);' +
    ' }' +
    ' times.sort((a, b) => a - b);' +
    ' return { median: times[Math.floor(N / 2)], max: times[N - 1], mismatches: mismatches }' +
  '})()')

  check('P2a 40 次「写 splitLayout 再读回」全部读到刚写的键', written && written.mismatches.length === 0,
    written && written.mismatches)
  check('P2b 单次往返中位 < 120ms（拖拽松手不能卡手）', written && written.median < 120,
    written && { median: written.median, max: written.max })
  console.log('        中位 ' + (written ? written.median.toFixed(1) : '?') + 'ms，最慢 ' + (written ? written.max.toFixed(1) : '?') + 'ms')

  /* 恢复成空表，收尾不留脏数据（压测在临时 userData 里，这里只是让断言更严格） */
  const cleared = await p.evaluate('(async () => { const r = await window.api.settings.set({ splitLayout: {} }); return r && r.ok })()')
  check('P2c 清空 splitLayout 后回读为空表', cleared === true, cleared)

  const connSigAfter = sig(path.join(DATA_DIR, 'connections.json'))
  check('P3a 压测前后 connections.json 条数一致', connSigBefore.n === connSigAfter.n, { before: connSigBefore.n, after: connSigAfter.n })
  check('P3b 压测前后 connections.json id 集合一致',
    JSON.stringify(connSigBefore.ids) === JSON.stringify(connSigAfter.ids), { before: connSigBefore.ids.length, after: connSigAfter.ids.length })
  check('P3c 压测前后 connections.json 字节完全一致',
    connSigBefore.sha === connSigAfter.sha, { before: connSigBefore.sha.slice(0, 12), after: connSigAfter.sha.slice(0, 12) })

  /* ---------------- P4 数据零影响：settings.json 结构健全 ---------------- */
  const settingsFile = path.join(DATA_DIR, 'settings.json')
  let settingsOk = false
  let keys = []
  try {
    const parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))
    keys = Object.keys(parsed)
    settingsOk = Array.isArray(parsed.dangerPatterns) && typeof parsed.terminal === 'object'
  } catch {}
  check('P4a settings.json 仍可解析且关键字段在', settingsOk, keys.slice(0, 8))
  check('P4b 压测没把 splitLayout 以外的东西写坏', settingsOk && keys.indexOf('taskNotify') >= 0, keys.length)

  try { p.ws.close() } catch {}
  console.log('\n=== 分屏压测：' + pass + ' 通过 / ' + fail + ' 失败 ===')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('压测异常:', e)
  process.exit(2)
})
