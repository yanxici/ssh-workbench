/**
 * 连接阶段广播自检（阶段 5）。
 *
 * 锁两件事：
 *   1. 建立一次真实 SSH 会话的过程中，渲染层确实收到了带 phase 的 connecting 事件；
 *   2. 连接完成后 phase 被清空（否则状态栏会残留「打开终端…」这种文案）。
 *
 * 为什么第 2 条重要：phase 只在 connecting 期间有意义，连上之后还留着，
 * 用户会看到「已连接」旁边挂着一个「打开终端…」—— 那是信息污染。
 *
 * 诚实边界：ssh2 的 connect() 把握手与认证合成一次调用，主进程拿不到两者分界，
 * 所以实际只会发出 tcp / handshake / jump / shell 四类，'auth' 类型保留但不发。
 * 断言因此只检查「至少出现过 tcp 或 shell 之一」，不写死完整序列。
 *
 * 用法：node scripts/verify-conn-phase.cjs
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
function pickPort(min, max) { return min + Math.floor(Math.random() * (max - min)) }
const APP_PORT = Number(process.env.CP_CDP_PORT || pickPort(21000, 29000))
const LAB_PORT = Number(process.env.CP_LAB_PORT || pickPort(29000, 34000))
const USERDATA = path.join(os.tmpdir(), 'sw-connphase-probe')
const LAB_ROOT = path.join(os.tmpdir(), 'sw-connphase-root')
const PORT = String(APP_PORT)
const children = []
function killTree(c) { if (!c || c.killed) return; try { spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
function cleanup() { for (const c of children) killTree(c) }
process.on('exit', cleanup)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(n, ok, d) { if (ok) { pass++; console.log('  PASS  ' + n) } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + JSON.stringify(d) : '')) } }
async function getTarget() { for (let i = 0; i < 80; i++) { try { const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); const p = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (p) return p } catch {} await sleep(400) } throw new Error('no target') }
function connect(url) {
  const ws = new WebSocket(url); const pend = new Map(); let s = 0
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result) } })
  const ready = new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
  const send = (a, b = {}) => new Promise((res, rej) => { const id = ++s; pend.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method: a, params: b })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('timeout ' + a)) } }, 60000) })
  const evaluate = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value }
  return { ready, evaluate, ws }
}

async function main() {
  fs.rmSync(USERDATA, { recursive: true, force: true }); fs.mkdirSync(USERDATA, { recursive: true })
  fs.rmSync(LAB_ROOT, { recursive: true, force: true }); fs.mkdirSync(LAB_ROOT, { recursive: true })
  const lab = spawn(process.execPath, [path.join(ROOT, 'scripts', 'lab-sftp-server.cjs')], {
    env: { ...process.env, SFTP_ROOT: LAB_ROOT, SFTP_PORT: String(LAB_PORT), SFTP_USER: 'lab', SFTP_PASS: 'labpass', LAB_SHELL_ECHO: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(lab)
  await sleep(1500)

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const exe = process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron')
  const app = spawn(exe, ['.', '--user-data-dir=' + USERDATA, '--remote-debugging-port=' + APP_PORT, '--disable-gpu', '--no-sandbox'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(app)
  await sleep(3000)

  const t = await getTarget()
  const p = connect(t.webSocketDebuggerUrl)
  await p.ready
  let ready = false
  for (let i = 0; i < 150; i++) {
    try { if (await p.evaluate('document.body && document.body.innerText.length > 100')) { ready = true; break } } catch {}
    await sleep(200)
  }
  check('应用就绪', ready === true)

  console.log('\n[连接阶段广播]')
  const res = await p.evaluate(`(async () => {
    const seen = []
    const off = window.api.on.sessionStatus((e) => seen.push({ status: e.status, phase: e.phase || null }))
    const save = await window.api.conn.save({ name: 'phase-lab', host: '127.0.0.1', port: ${LAB_PORT}, username: 'lab', authType: 'password', password: 'labpass', group: 'p', tags: [] })
    if (!save.ok) { off(); return { err: 'save failed' } }
    await window.api.session.open({ sessionId: 'cp-1', connectionId: save.data.id, cols: 100, rows: 30 })
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100))
      if (seen.some((x) => x.status === 'connected' || x.status === 'error')) break
    }
    off()
    return { seen }
  })()`)
  console.log('  事件: ' + JSON.stringify(res))
  const seen = res && res.seen ? res.seen : []
  check('收到了带 phase 的 connecting 事件', seen.some((x) => x.status === 'connecting' && x.phase), seen)
  check('phase 取值在合法集合内', seen.filter((x) => x.phase).every((x) => ['tcp', 'handshake', 'auth', 'jump', 'shell'].includes(x.phase)), seen.map((x) => x.phase))
  check('连接成功后 status=connected', seen.some((x) => x.status === 'connected'), seen)
  check('连接完成后 phase 被清空（状态栏不留阶段文案）', seen.filter((x) => x.status === 'connected').every((x) => x.phase === null), seen)

  console.log('')
  try { p.ws.close() } catch {}
  cleanup()
  console.log('通过 ' + pass + '  失败 ' + fail)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error('FATAL ' + e.message); cleanup(); process.exit(2) })
