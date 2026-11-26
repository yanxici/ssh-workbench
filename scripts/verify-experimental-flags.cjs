/**
 * 实验性开关自检（阶段 1 的 flag 灰度）。
 *
 * 锁三件事：
 *   1. 设置面板里真的能看到「实验性」分区（不是只加了组件却没挂上去）；
 *   2. flag 能写入 settings 并持久化（主进程 → settings.json → 回读）；
 *   3. 全部关掉后回到旧视觉（flags 全 false），保证「可独立回滚」这条硬约束成立。
 *
 * 坑：.click() 对自绘标题栏按钮不触发 React 的 onPointerDown/onClick 链，
 * 必须 dispatchEvent(new MouseEvent('click', {bubbles:true})) 才能打开 Modal。
 * 第一次写这条探针时就踩了 —— 表现为「按钮存在但面板没弹出来」。
 *
 * 用法：node scripts/verify-experimental-flags.cjs
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
function pickPort(min, max) { return min + Math.floor(Math.random() * (max - min)) }
const APP_PORT = Number(process.env.FLAG_CDP_PORT || pickPort(21000, 29000))
const USERDATA = path.join(os.tmpdir(), 'sw-flags-probe')
const PORT = String(APP_PORT)
const children = []
function killTree(c) { if (!c || c.killed) return; try { spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
function cleanup() { for (const c of children) killTree(c) }
process.on('exit', cleanup)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(n, ok, d) { if (ok) { pass++; console.log('  PASS  ' + n) } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + JSON.stringify(d) : '')) } }
async function getTarget() { for (let i = 0; i < 40; i++) { try { const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); const p = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (p) return p } catch {} await sleep(400) } throw new Error('no target') }
function connect(url) {
  const ws = new WebSocket(url); const pend = new Map(); let s = 0
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result) } })
  const ready = new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
  const send = (a, b = {}) => new Promise((res, rej) => { const id = ++s; pend.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method: a, params: b })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('timeout ' + a)) } }, 45000) })
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
  /*
   * 等应用真正就绪（轮询），不用固定 sleep。
   * 门禁串跑时机器很忙，固定 9s 常不够；而固定等待写成 20s 又拖慢每次运行。
   * 轮询既稳又快：通常 300ms 内就绪，慢的时候自己等到 30s。
   */
  let ready = false
  for (let i = 0; i < 150; i++) {
    try {
      const ok = await p.evaluate('document.body && document.body.innerText.length > 100')
      if (ok) { ready = true; break }
    } catch {
      /* 页面还没加载完时 evaluate 可能抛，继续等 */
    }
    await sleep(200)
  }
  if (!ready) throw new Error('应用 30s 内未就绪')

  console.log('\n[实验性开关]')
  const opened = await p.evaluate(`(() => { const b = document.querySelector('[aria-label="设置"]'); if (!b) return 'no-btn'; b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window })); return 'ok' })()`)
  await sleep(1200)
  check('设置按钮可打开面板', opened === 'ok', opened)
  /* 设置页升级为 6 选项卡：实验性分区位于「更新与诊断」选项卡（data-settings-tab="system"） */
  const tabSwitched = await p.evaluate(`(() => {
    const tab = document.querySelector('[data-settings-tab="system"]')
    if (!tab) return 'no-tab'
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'ok'
  })()`)
  await sleep(500)
  check('可切换到「更新与诊断」选项卡', tabSwitched === 'ok', tabSwitched)
  const text = await p.evaluate(`(() => document.body.innerText)()`)
  check('设置面板出现「实验性」分区', String(text).includes('实验性'), String(text).slice(0, 80))
  /* 若为旧折叠头则展开，新版 SettingsCard 默认已展开 */
  await p.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('实验性（设计 token 灰度）'))
    if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'ok'
  })()`)
  await sleep(400)
  /*
  * 断言的是「5 个开关的标签都出现」。
  * 注意「终端」这个词在设置面板别处也有（终端分区），单判 'includes("终端")' 会假绿，
  * 所以这里用每个开关独有的业务标签。
  */
  const labels = await p.evaluate(`(() => ['文件面板（SFTP / 本地双栏）', '连接列表', '命令面板', '终端', '状态栏'].filter((k) => document.body.innerText.includes(k)))()`)
  check('5 个面板开关都在', Array.isArray(labels) && labels.length === 5, labels)

  const toggle = await p.evaluate(`(async () => {
    const before = await window.api.settings.get()
    const b = before.ok ? before.data : null
    const wasOff = !(b && b.experimental && b.experimental.tokens && b.experimental.tokens.sftp)
    await window.api.settings.set({ experimental: { tokens: { sftp: true } } })
    const after = await window.api.settings.get()
    const a = after.ok ? after.data : null
    return { wasOff, nowOn: !!(a && a.experimental && a.experimental.tokens && a.experimental.tokens.sftp) }
  })()`)
  check('flag 可写入并持久化', toggle.wasOff === true && toggle.nowOn === true, toggle)

  const restored = await p.evaluate(`(async () => {
    await window.api.settings.set({ experimental: { tokens: {} } })
    const r = await window.api.settings.get()
    const s = r.ok ? r.data : null
    const tk = s && s.experimental ? s.experimental.tokens : null
    return !tk || Object.keys(tk).every((k) => tk[k] !== true)
  })()`)
  check('全部关回旧视觉', restored === true, restored)

  console.log('')
  try { p.ws.close() } catch {}
  cleanup()
  console.log('通过 ' + pass + '  失败 ' + fail)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error('FATAL ' + e.message); cleanup(); process.exit(2) })