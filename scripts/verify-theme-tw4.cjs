/**
 * 主题变量回归自检（真实 Electron + CDP，走真实 UI 设置面板；上游 Tailwind 4 迁移时写的，本仓 Tailwind 3 同样适用）。
 *
 * 为什么必须有这一条：
 *   本仓的语义色是两层结构 —— tailwind.config.js 把 `color-x` 映射成
 *   `rgb(var(--c-x) / <alpha-value>)`，再由 index.css 的 `:root` / `.light` / `.dark` 改 `--c-x`
 *   （上游 Tailwind 4 把这层映射搬进 CSS 的 `@theme {}` 块，形态变了，验的是同一件事）。
 *
 *   这层结构最隐蔽的失败是：颜色被固化成编译期常量（`@theme` 固化就是这种退化），切 .dark 时颜色不跟着变。
 *   构建成功、类型检查通过、18 项 SFTP e2e 也全绿（e2e 不测主题），只有人眼能发现。
 *
 * 6 条断言：浅色初始态 → 切暗色（类名/--c-app/body 背景/body 文字）→ 切回亮色完全恢复。
 * 其中「--c-app 真的变了」是「变量没被固化」的直接证据。
 *
 * 坑：必须用全新 user-data-dir。上一次运行残留的 theme 会让首帧不是浅色，第 1 条误判。
 *
 * 用法：node scripts/verify-theme-tw4.cjs
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
/* 同 verify-xterm6：端口随机，避免与前一条自起应用的脚本撞车。详见那边的注释。 */
function pickPort(min, max) { return min + Math.floor(Math.random() * (max - min)) }
const APP_PORT = Number(process.env.TW4_CDP_PORT || pickPort(21000, 29000))
const USERDATA = path.join(os.tmpdir(), 'sw-tw4-probe')

const children = []
function killTree(c) { if (!c || c.killed) return; try { spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
function cleanup() { for (const c of children) killTree(c) }
process.on('exit', cleanup)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PORT = String(APP_PORT)
async function getTarget() { for (let i = 0; i < 40; i++) { try { const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (p) return p } catch {} await sleep(400) } throw new Error('no target') }
function connect(url) {
  const ws = new WebSocket(url); const pending = new Map(); let seq = 0
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result) } })
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')) } }, 40000) })
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value }
  return { ready, send, evaluate, ws }
}
let pass = 0, fail = 0
function check(n, ok, d) { if (ok) { pass++; console.log('  PASS  ' + n) } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : '')) } }

async function main() {
  fs.rmSync(USERDATA, { recursive: true, force: true })
  fs.mkdirSync(USERDATA, { recursive: true })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const exe = process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron')
  if (!fs.existsSync(exe)) throw new Error('找不到 Electron 二进制：' + exe)
  const app = spawn(exe, ['.', '--user-data-dir=' + USERDATA, '--remote-debugging-port=' + APP_PORT, '--disable-gpu', '--no-sandbox'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(app)
  await new Promise((r) => setTimeout(r, 9000))
  await runProbe()
  cleanup()
  process.exit(fail === 0 ? 0 : 1)
}

async function runProbe() {
  const t = await getTarget()
  const p = connect(t.webSocketDebuggerUrl)
  await p.ready; await p.send('Runtime.enable')
  /* 等应用真正就绪（轮询），理由同 verify-panel-switch */
  let ready = false
  for (let i = 0; i < 150; i++) {
    try {
      const ok = await p.evaluate('document.body && document.body.innerText.length > 100')
      if (ok) { ready = true; break }
    } catch {
      /* 未加载完 */
    }
    await sleep(200)
  }
  if (!ready) throw new Error('应用 30s 内未就绪')
  const snap = async () => p.evaluate(`(() => { const cs = getComputedStyle(document.documentElement); return { cls: document.documentElement.className, cApp: cs.getPropertyValue('--c-app').trim(), cInk: cs.getPropertyValue('--c-ink').trim(), bodyBg: getComputedStyle(document.body).backgroundColor, bodyColor: getComputedStyle(document.body).color } })()`)
  // 通过 UI 的设置面板切主题（走真实链路：store -> settingsStore -> applyTheme）
  const clickSettings = await p.evaluate(`(() => { const b=[...document.querySelectorAll('button')].find(x=>/设置|Settings/.test(x.getAttribute('aria-label')||x.title||'')); if(!b) return 'no-btn'; b.click(); return 'ok' })()`)
  await sleep(1200)
  const light = await snap()
  console.log('light: ' + JSON.stringify(light))
  check('浅色下 html 带 .light 且 --c-app 有值', /light/.test(light.cls) && !!light.cApp, JSON.stringify(light))
  const darkBtn = await p.evaluate(`(() => { const bs=[...document.querySelectorAll('button')]; const b=bs.find(x=>/^深色$|^暗色$/.test(x.textContent.trim())); if(!b) return 'none'; b.click(); return 'ok' })()`)
  await sleep(1200)
  const dark = await snap()
  console.log('dark: ' + JSON.stringify(dark) + ' knob=' + darkBtn)
  check('切暗色：html 变 .dark', /dark/.test(dark.cls), dark.cls)
  check('切暗色：--c-app 变化（变量未被固化）', dark.cApp !== light.cApp, light.cApp + ' -> ' + dark.cApp)
  check('切暗色：body 背景跟随', dark.bodyBg !== light.bodyBg, light.bodyBg + ' -> ' + dark.bodyBg)
  check('切暗色：body 文字色跟随', dark.bodyColor !== light.bodyColor, light.bodyColor + ' -> ' + dark.bodyColor)
  const back = await p.evaluate(`(() => { const bs=[...document.querySelectorAll('button')]; const b=bs.find(x=>/^亮色$/.test(x.textContent.trim())); if(!b) return 'none'; b.click(); return 'ok' })()`)
  await sleep(1000)
  const restored = await snap()
  check('切回浅色恢复原值', restored.cApp === light.cApp && restored.bodyBg === light.bodyBg, JSON.stringify(restored))
  console.log('\n通过 ' + pass + '  失败 ' + fail)
  try { p.ws.close() } catch {}

}
main().catch((e) => { console.error('FATAL ' + e.message); cleanup(); process.exit(2) })