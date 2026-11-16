/**
 * trzsz 桥接（v2.1.6）压测。
 *
 * 为什么需要压测：把 TrzszFilter 插进 sessionManager.flush() 意味着
 * **这个会话之后每一个字节都要过一遍它的状态机**。过滤器写错了会立刻表现出来，
 * 但「写得对但很慢」不会 —— 终端只是变卡，没人报错。所以必须有量。
 *
 * 三段：
 *   P1 纯逻辑吞吐   —— 不为会话建过滤器时，flush 只多一次 includes() 与一次正则；
 *                      这里直接量它，单次耗时不达标说明连「未挂载」都在拖慢所有人。
 *   P2 真应用开销   —— 同一段输出，在「过滤器未挂载」与「已挂载」两种状态下各跑三轮，
 *                      交替进行避免负载漂移。判据是中位耗时比 <= 3.0，
 *                      并且必须证明过滤器真的挂上了（否则量的是同一条路径，比值恒为 1，
 *                      压测就成了摆设 —— 这是 AGENTS.md 2.6 记的假绿形态）。
 *   P3 数据零影响   —— connections.json 的 sha256 前后一致；会话录制里没有握手串。
 *
 * 用法：node scripts/perf-trzsz.cjs
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const crypto = require('node:crypto')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
function pickPort(min, max) { return min + Math.floor(Math.random() * (max - min)) }
const APP_PORT = Number(process.env.PT_CDP_PORT || pickPort(21000, 29000))
const LAB_PORT = Number(process.env.PT_LAB_PORT || pickPort(29000, 34000))
const USERDATA = path.join(os.tmpdir(), 'sw-perf-trzsz')
const LAB_ROOT = path.join(os.tmpdir(), 'sw-perf-trzsz-root')
const PORT = String(APP_PORT)

const children = []
function killTree(c) { if (!c || c.killed) return; try { spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
function cleanup() { for (const c of children) killTree(c) }
process.on('exit', cleanup)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')) }
}
/**
 * 连接库的内容指纹。
 *
 * 不能直接哈希整个文件：openSession 会写 lastUsedAt，那是**设计上**该变的，
 * 把它算进去这条断言只会永远红。所以归一化后再哈希 —— 只保留身份类字段，
 * 顺带把数组按 id 排序，避免并发写入顺序造成假红。
 */
function connFingerprint(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const list = Array.isArray(raw) ? raw : raw.connections || []
    const norm = list
      .map((c) => ({ id: c.id, name: c.name, host: c.host, port: c.port, username: c.username, kind: c.kind, group: c.group }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    return crypto.createHash('sha256').update(JSON.stringify(norm)).digest('hex') + ':' + norm.length
  } catch { return 'missing' }
}
function median(list) {
  const a = list.slice().sort((x, y) => x - y)
  return a[Math.floor(a.length / 2)]
}

/* ================= 一、纯逻辑：未挂载路径的额外开销 ================= */
function loadBridge() {
  const out = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'main', 'ssh', 'trzszBridge.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['trzsz', 'electron'],
    write: false,
    logLevel: 'silent'
  })
  const code = out.outputFiles[0].text
  const fn = new Function('module', 'exports', 'require', code)
  const mod = { exports: {} }
  fn(mod, mod.exports, require)
  return mod.exports
}

function pureLogic() {
  const bridge = loadBridge()
  const chunk = 'drwxr-xr-x 2 root root 4096 Nov 15 03:00 firmware\r\n'
  const N = 30000
  const t0 = process.hrtime.bigint()
  let hits = 0
  for (let i = 0; i < N; i++) {
    if (bridge.looksLikeTrzsz(chunk)) hits++
    if (bridge.looksLikeTrzszMissing(chunk)) hits++
    const s = bridge.stripTrzszHandshake(chunk)
    if (s.length === 0) hits++
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  const perChunk = (ms * 1000) / N
  console.log('  P1 ' + N + ' 段文本三次判定合计 ' + ms.toFixed(1) + 'ms（' + perChunk.toFixed(2) + 'us/段），误命中 ' + hits)
  check('P1 未挂载过滤器的额外开销可忽略（< 20us/段）', perChunk < 20, perChunk)
  check('P1b 普通输出不会被误判成握手或「没装」', hits === 0, hits)

  /*
   * 真正要量的东西在这里：一旦为会话挂上过滤器，**之后每个字节都要过它的状态机**。
   * 上面那三条只量了「未挂载」的代价，管不到这条路径 —— 只量未挂载就是假绿：
   * 过滤器写得再慢，未挂载的会话也不受影响，比值为 1，压测全绿。
   */
  const sent = []
  const session = new bridge.TrzszSession(
    {
      sendToServer: () => {},
      emitText: () => {},
      emitState: () => {},
      pickSaveDirectory: async () => undefined,
      pickSendFiles: async () => undefined
    },
    120,
    () => {}
  )
  const line = 'drwxr-xr-x 2 root root 4096 Nov 15 03:00 firmware\r\n'
  const ROUNDS = 20000
  const t1 = process.hrtime.bigint()
  for (let i = 0; i < ROUNDS; i++) sent.push(session.processServerOutput(line))
  const ms1 = Number(process.hrtime.bigint() - t1) / 1e6
  const perLine = (ms1 * 1000) / ROUNDS
  const bytes = sent.join('').length
  console.log('  P1c 过滤器挂载后 ' + ROUNDS + ' 行 ' + ms1.toFixed(1) + 'ms（' + perLine.toFixed(2) +
    'us/行），透传字节 ' + bytes)
  check('P1c 挂载后每行处理开销 < 50us（1200 行屏 < 60ms）', perLine < 50, perLine)
  check('P1d 非传输态一个字节都不吞（透传长度等于输入长度）',
    bytes === line.length * ROUNDS, { got: bytes, want: line.length * ROUNDS })
  session.dispose()
}

/* ================= 二、真应用 ================= */
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

async function waitReady(p) {
  for (let i = 0; i < 150; i++) {
    try { if (await p.evaluate('document.body && document.body.innerText.length > 100')) return true } catch {}
    await sleep(200)
  }
  return false
}

const SENTINEL_IN_DOM = (tag) => '(() => {' +
  ' const r = document.querySelector(".xterm-rows");' +
  ' return r ? r.innerText.includes(' + JSON.stringify('PERF-TZ-' + tag) + ') : false' +
'})()'

/**
 * 往会话灌 payload 并等哨兵行到 DOM。
 * 计时用 setTimeout 轮询而不是 requestAnimationFrame —— 窗口不可见时 rAF 被节流，
 * 会量出几十秒的假数据（AGENTS.md 2.3 记过这个坑）。
 */
async function roundTrip(p, sessionId, tag, lines) {
  /* 由 lab 服务器生成 N 行输出（见 lab-sftp-server.cjs 的 @@PERF@@ 分支） */
  const payload = JSON.stringify('@@PERF:' + lines + ':' + tag + '@@\r')
  const t0 = Date.now()
  await p.evaluate('(async () => { await window.api.session.write(' + JSON.stringify(sessionId) + ', ' + payload + ') })()')
  const deadline = t0 + 60000
  while (Date.now() < deadline) {
    if (await p.evaluate(SENTINEL_IN_DOM(tag))) return Date.now() - t0
    await sleep(20)
  }
  return -1
}

async function realApp() {
  fs.rmSync(USERDATA, { recursive: true, force: true })
  fs.mkdirSync(USERDATA, { recursive: true })
  fs.rmSync(LAB_ROOT, { recursive: true, force: true })
  fs.mkdirSync(LAB_ROOT, { recursive: true })

  const lab = spawn(process.execPath, [path.join(ROOT, 'scripts', 'lab-sftp-server.cjs')], {
    env: Object.assign({}, process.env, {
      SFTP_ROOT: LAB_ROOT,
      SFTP_PORT: String(LAB_PORT),
      SFTP_USER: 'lab',
      SFTP_PASS: 'labpass',
      LAB_SHELL_ECHO: '1',
      LAB_SHELL_TRZSZ: '1'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(lab)
  await sleep(1500)

  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  env.SSHWB_TRZSZ_AUTODECLINE = '1'
  const exe = process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    : process.platform === 'darwin'
      ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
      : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron')
  const app = spawn(exe, ['.', '--user-data-dir=' + USERDATA, '--remote-debugging-port=' + APP_PORT, '--disable-gpu', '--no-sandbox'], {
    cwd: ROOT, env: env, stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(app)
  await sleep(9000)

  const p = connect((await getTarget()).webSocketDebuggerUrl)
  await p.ready
  await p.send('Runtime.enable')
  if (!(await waitReady(p))) throw new Error('应用 30s 内未就绪')

  const saved = await p.evaluate('(async () => {' +
    ' const r = await window.api.conn.save({ name: "pt-lab", host: "127.0.0.1", port: ' + LAB_PORT + ', username: "lab", authType: "password", password: "labpass", group: "x", tags: [] });' +
    ' return r.ok ? (r.data && r.data.id) : false' +
  '})()')
  check('建立测试连接', typeof saved === 'string' && saved.length > 0, saved)
  await p.evaluate('(() => { location.reload(); return "reloading" })()')
  await sleep(2500)
  if (!(await waitReady(p))) throw new Error('reload 后应用未就绪')

  const connFile = path.join(USERDATA, 'data', 'connections.json')
  const connBefore = connFingerprint(connFile)

  await p.evaluate('(() => { const r = document.querySelector("[data-conn-id]"); if (!r) return "no-row"; r.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); return "ok" })()')
  let sessionId = null
  for (let i = 0; i < 50; i++) {
    sessionId = await p.evaluate('(async () => {' +
      ' const l = await window.api.session.list();' +
      ' const list = l && l.data ? l.data : [];' +
      ' const c = list.find((s) => s.status === "connected");' +
      ' return c ? c.id : null;' +
    '})()')
    if (sessionId) break
    await sleep(400)
  }
  check('打开真实 SSH 会话', typeof sessionId === 'string' && sessionId.length > 0, sessionId)
  if (!sessionId) throw new Error('会话没开起来')

  /* --- 预热：第一轮含 JIT 与终端首次布局，丢弃 --- */
  await roundTrip(p, sessionId, 'warm', 200)

  /*
   * 交替跑：OFF（过滤器未挂载）/ ON（已挂载）/ OFF / ON / OFF / ON。
   * 两种状态穿插进行，避免后跑的几轮赶上机器发热或 GC 造成系统性偏差。
   */
  const off = []
  const on = []
  for (let i = 0; i < 3; i++) {
    const a = await roundTrip(p, sessionId, 'off' + i, 1200)
    if (a < 0) throw new Error('第 ' + i + ' 轮（未挂载）哨兵行没到 DOM')
    off.push(a)

    /*
     * 挂上过滤器：让对端进入 trzsz 模式并下发一次握手。
     * 过滤器一旦为这个会话创建就不会再拆（drop 只在会话关闭时发生），
     * 所以之后每一轮都是「已挂载」状态。
     */
    if (i === 0) {
      await p.evaluate('(async () => { await window.api.session.write(' + JSON.stringify(sessionId) + ', "@@TRZSZ:ON@@") })()')
      await sleep(300)
      await p.evaluate('(async () => { await window.api.session.write(' + JSON.stringify(sessionId) + ', "tsz\\r") })()')
      const attached = await (async () => {
        const deadline = Date.now() + 12000
        while (Date.now() < deadline) {
          const txt = String(await p.evaluate('(() => { const r = document.querySelector(".xterm-rows"); return r ? r.innerText : "" })()'))
          if (txt.includes('::TRZSZ:TRANSFER:S:') && txt.includes('lab-saw-act')) return true
          await sleep(250)
        }
        return false
      })()
      check('过滤器真的挂上了（对端握手 + 取消帧回执都看到了）', attached, attached)
    }

    const b = await roundTrip(p, sessionId, 'on' + i, 1200)
    if (b < 0) throw new Error('第 ' + i + ' 轮（已挂载）哨兵行没到 DOM')
    on.push(b)
  }

  const offMed = median(off)
  const onMed = median(on)
  const ratio = onMed / offMed
  console.log('  P2 未挂载 ' + off.join('/') + 'ms，已挂载 ' + on.join('/') + 'ms，中位 ' +
    offMed + ' vs ' + onMed + ' = ' + ratio.toFixed(2) + 'x')
  check('P2 挂了过滤器之后输出耗时不超过 3 倍', ratio <= 3, { off: off, on: on, ratio: ratio })

  /* --- P3 数据零影响 --- */
  const connAfter = connFingerprint(connFile)
  check('P3 connections.json 身份字段前后一致（条数与内容都没被压测改坏）', connBefore === connAfter,
    { before: connBefore, after: connAfter })

  const logDir = path.join(USERDATA, 'sessions')
  let castText = ''
  if (fs.existsSync(logDir)) {
    const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.cast'))
    if (files.length) castText = fs.readFileSync(path.join(logDir, files[files.length - 1]), 'utf8')
  }
  check('P3b 压测期间产出的录制里没有握手串', castText.length > 0 && !castText.includes('::TRZSZ:TRANSFER:'),
    { bytes: castText.length })

  /*
   * settings.json 只在「改过设置」之后才存在（默认值不落盘），
   * 所以先触发一次真实写入再读 —— 直接读文件会在干净环境里必然失败。
   */
  await p.evaluate('(async () => { await window.api.settings.set({}) })()')
  await sleep(600)
  const settingsFile = path.join(USERDATA, 'data', 'settings.json')
  let parsed = null
  try { parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8')) } catch {}
  check('P3c settings.json 仍是合法 JSON 且保留 taskNotify 键',
    !!parsed && typeof parsed.taskNotify === 'object', parsed ? Object.keys(parsed).length : 'parse-fail')

  console.log('')
  console.log('=== trzsz 压测：' + pass + ' 通过 / ' + fail + ' 失败 ===')
  process.exit(fail === 0 ? 0 : 1)
}

async function main() {
  console.log('--- P1 纯逻辑 ---')
  pureLogic()
  console.log('--- P2/P3 真应用 ---')
  await realApp()
}

main().catch((e) => {
  console.error('FATAL ' + (e && e.stack ? e.stack : e))
  cleanup()
  process.exit(1)
})
