/**
 * probe-font7: 用真实 settings.json 启动，原样回显用户截图里的 banner 文本，原生 dpr 截图。
 * 用法: node scripts/probe-font7.cjs --tag=x --settings=<path> [--scale=1]
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
const argv = process.argv.slice(2)
const arg = (k, d) => { const hit = argv.find((a) => a.startsWith('--' + k + '=')); return hit ? hit.slice(k.length + 3) : d }
const TAG = arg('tag', 'p7')
const SETTINGS_SRC = arg('settings', '')
const SCALE = Number(arg('scale', '1'))
const DPR = arg('dpr', '')
const EXE = arg('exe', '')
const OUT = path.join(ROOT, 'tmp-probe')
const pickPort = (a, b) => a + Math.floor(Math.random() * (b - a))
const APP_PORT = pickPort(21000, 29000)
const LAB_PORT = pickPort(29000, 34000)
const USERDATA = path.join(os.tmpdir(), 'sw-p7-' + TAG)
const LAB_ROOT = path.join(os.tmpdir(), 'sw-p7-lab-' + TAG)

const children = []
const killTree = (c) => { if (!c || c.killed) return; try { spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
const cleanup = () => { for (const c of children) killTree(c) }
process.on('exit', cleanup)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + APP_PORT + '/json/list')).json()
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (p) return p
    } catch {}
    await sleep(400)
  }
  throw new Error('no target')
}
function connect(url) {
  const ws = new WebSocket(url)
  const pending = new Map(); let seq = 0
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result) }
  })
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)) } }, 60000)
  })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description)
    return r.result.value
  }
  return { ready, send, evaluate, ws }
}

const LINES = [
  'lab-shell ready',
  'IPv4 address for br-7c8d1004c709:  192.168.1.1',
  'IPv4 address for br-911122b47c87:  172.18.0.1',
  'IPv4 address for enp6s0f1:         10.4.23.13'
]


const PATCH = `(() => {
  window.__fontLog = [];
  const orig = CanvasRenderingContext2D.prototype.fillText;
  CanvasRenderingContext2D.prototype.fillText = function (t, x, y, ...rest) {
    try { if (window.__fontLog.length < 4000) window.__fontLog.push({ f: this.font, t: String(t).slice(0,2), cw: this.canvas.width, ch: this.canvas.height, dpr: window.devicePixelRatio }); } catch (e) {}
    return orig.call(this, t, x, y, ...rest);
  };
})()`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true })
  fs.rmSync(USERDATA, { recursive: true, force: true })
  fs.mkdirSync(path.join(USERDATA, 'data'), { recursive: true })
  if (SETTINGS_SRC) fs.copyFileSync(SETTINGS_SRC, path.join(USERDATA, 'data', 'settings.json'))
  fs.rmSync(LAB_ROOT, { recursive: true, force: true }); fs.mkdirSync(LAB_ROOT, { recursive: true })

  const lab = spawn(process.execPath, [path.join(ROOT, 'scripts', 'lab-sftp-server.cjs')], {
    env: Object.assign({}, process.env, { SFTP_ROOT: LAB_ROOT, SFTP_PORT: String(LAB_PORT), SFTP_USER: 'lab', SFTP_PASS: 'labpass', LAB_SHELL_ECHO: '1' }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(lab)
  await sleep(1500)
  const env = Object.assign({}, process.env); delete env.ELECTRON_RUN_AS_NODE
  const exePath = EXE || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  const exeArgs = EXE ? ['--user-data-dir=' + USERDATA, '--remote-debugging-port=' + APP_PORT].concat(DPR ? ['--force-device-scale-factor=' + DPR] : []) : ['.', '--user-data-dir=' + USERDATA, '--remote-debugging-port=' + APP_PORT, '--no-sandbox'].concat(DPR ? ['--force-device-scale-factor=' + DPR] : [])
  const app = spawn(exePath, exeArgs, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(app)
  await sleep(9000)
  let p = connect((await getTarget()).webSocketDebuggerUrl)
  await p.ready; await p.send('Runtime.enable'); await sleep(2500)
  await p.evaluate("(async () => { await window.api.conn.save({ name: 'p7-lab', host: '127.0.0.1', port: " + LAB_PORT + ", username: 'lab', authType: 'password', password: 'labpass', group: 'x', tags: [] }); return 1 })()")
  try { await p.send('Page.enable') } catch (e) {}
  try { await p.send('Page.addScriptToEvaluateOnNewDocument', { source: PATCH }) } catch (e) { console.log('patch install failed: ' + e.message) }
  await p.evaluate('location.reload()'); await sleep(4500)
  p = connect((await getTarget()).webSocketDebuggerUrl)
  await p.ready; await p.send('Runtime.enable'); await sleep(1500)
  await p.evaluate("(() => { const r = document.querySelector('[data-conn-id]'); if(r) r.dispatchEvent(new MouseEvent('dblclick', { bubbles:true, cancelable:true })); return 1 })()")
  await sleep(3500)
  const echoed = await p.evaluate("(async () => { const r = await window.api.session.list(); const list = r && r.data ? r.data : []; if (!list.length) return 'no-session'; for (const L of " + JSON.stringify(LINES) + ") { await window.api.session.write(list[0].id, L); await new Promise(r2 => setTimeout(r2, 400)) } await new Promise(r2 => setTimeout(r2, 800)); return 'ok:' + list[0].status })()")
  console.log('echo: ' + echoed)
  await sleep(1500)

  const info = await p.evaluate("(() => { const st = window.api && window.api.settings ? 'has' : 'no'; const row = document.querySelector('.xterm-rows > div'); const cs = row ? getComputedStyle(row) : null; const m = document.querySelector('.xterm-char-measure-element'); const mr = m ? m.getBoundingClientRect() : null; return { dpr: window.devicePixelRatio, canvases: document.querySelectorAll('.xterm canvas').length, rowsEl: document.querySelectorAll('.xterm-rows > div').length, cellW: mr ? +(mr.width / m.textContent.length).toFixed(3) : null, rowFont: cs ? cs.fontFamily + ' / ' + cs.fontSize + ' / ls=' + cs.letterSpacing : null, screen: (() => { const s = document.querySelector('.xterm-screen'); const r = s ? s.getBoundingClientRect() : null; return r ? { w: +r.width.toFixed(1), h: +r.height.toFixed(1) } : null })() } })()")
  console.log('INFO ' + TAG + ': ' + JSON.stringify(info))

  const fonts = await p.evaluate("(() => { const l = window.__fontLog || []; const uniq = {}; for (const e of l) uniq[e.f + ' | canvas ' + e.cw + 'x' + e.ch + ' | dpr ' + e.dpr] = (uniq[e.f + ' | canvas ' + e.cw + 'x' + e.ch + ' | dpr ' + e.dpr] || 0) + 1; return { total: l.length, uniq: Object.entries(uniq).slice(0, 12) } })()")
  console.log('FONTS ' + TAG + ': ' + JSON.stringify(fonts))

  const geo = await p.evaluate("(() => { const s = document.querySelector('.xterm-screen').getBoundingClientRect(); return {x: Math.round(s.x), y: Math.round(s.y), w: Math.round(s.width), h: Math.round(s.height)} })()")
  const shot = await p.send('Page.captureScreenshot', { format: 'png', clip: { x: geo.x, y: geo.y, width: Math.min(geo.w, 420), height: 120, scale: SCALE } })
  const file = path.join(OUT, 'p7-' + TAG + '.png')
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
  console.log('saved: ' + file + ' ' + fs.statSync(file).size + 'B geo=' + JSON.stringify(geo))
  try { p.ws.close() } catch {}
  cleanup(); process.exit(0)
}
main().catch((e) => { console.error('FATAL ' + e.message); cleanup(); process.exit(2) })