/**
 * trzsz 文件传输（v2.1.6）的真实应用验证。
 *
 * 为什么必须跑真应用：verify-trzsz.cjs 用假 hooks 证明了「桥接层这套逻辑对」，
 * 但证明不了这几件只有真链路才有的事 —— 主进程的 TrzszFilter 真的挂上了会话、
 * 「远端没装 trz」的提示真的过了 IPC 到渲染层变成 toast、取消帧真的发到了对端、
 * 握手串真的没进会话录制。
 *
 * 判据（每条都对应一个真会出错的实现方式）：
 *   Z1 手敲 trz 未装 → 出提示        —— flush() 里不做无过滤器兜底时永远不出；
 *   Z2 渲染层通道存在                —— preload 漏挂 api.trzsz 时这条红；
 *   Z3 取消选文件不算失败            —— 把「用户取消」当错误抛时 ok 变 false；
 *   Z4 上传到没装 trz 的远端 → 报错  —— 捕获 Upload does not start 的路径没写时
 *                                      会等满 3 秒后抛原始英文；
 *   Z5 对端真的收到取消帧            —— sendAction 没接到 transport 时收不到回执；
 *   Z6 录制里没有握手串              —— stripTrzszHandshake 没接进 flush 时回放是乱码；
 *   Z7 无未捕获异常。
 *
 * 用法：node scripts/verify-trzsz-e2e.cjs
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
function pickPort(min, max) { return min + Math.floor(Math.random() * (max - min)) }
const APP_PORT = Number(process.env.TZ_CDP_PORT || pickPort(21000, 29000))
const LAB_PORT = Number(process.env.TZ_LAB_PORT || pickPort(29000, 34000))
const USERDATA = path.join(os.tmpdir(), 'sw-trzsz-e2e')
const LAB_ROOT = path.join(os.tmpdir(), 'sw-trzsz-labroot')
const PORT = String(APP_PORT)
const UPLOAD_FILE = path.join(LAB_ROOT, 'up.bin')

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
  const errs = []
  let seq = 0
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) {
      const pair = pend.get(m.id)
      pend.delete(m.id)
      if (m.error) pair.reject(new Error(JSON.stringify(m.error)))
      else pair.resolve(m.result)
      return
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errs.push(m.params && m.params.exceptionDetails ? String(m.params.exceptionDetails.text) : 'exc')
    }
  })
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = ++seq
    pend.set(id, { resolve: resolve, reject: reject })
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }))
    setTimeout(() => { if (pend.has(id)) { pend.delete(id); reject(new Error('timeout ' + method)) } }, 45000)
  })
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? String(r.exceptionDetails.exception.description) : 'eval error')
    return r.result.value
  }
  return { ready: ready, send: send, evaluate: evaluate, errs: errs, ws: ws }
}

async function waitReady(p) {
  for (let i = 0; i < 150; i++) {
    try {
      const ok = await p.evaluate('document.body && document.body.innerText.length > 100')
      if (ok === true) return true
    } catch {}
    await sleep(200)
  }
  return false
}

/**
 * 终端里当前**可见**的行文本（DOM 渲染器）；生产构建没有测试桥，只能读 DOM。
 *
 * 为什么不能直接取 document.querySelector('.xterm-rows')：
 *   querySelector 取的是文档里第一个终端，而分屏/多标签时前面可能压着一个
 *   被 display:none 隐藏的终端 —— 那一个的缓冲区可能是空的，于是断言读到 ""
 *   但「远端回执没到」这种真 bug 看起来一模一样。实测这条脚本就是这样时红时绿。
 *   判据因此改成：按可见性（getBoundingClientRect 宽高 > 10）挑终端，
 *   并把所有可见终端拼起来 —— 只要有一个真的收到了回执就算收到。
 */
const TERM_ROWS_VISIBLE = '(() => {' +
  ' const all = Array.prototype.slice.call(document.querySelectorAll(".xterm-rows"));' +
  ' return all.filter((r) => { const b = r.getBoundingClientRect(); return b.width > 10 && b.height > 10 })' +
'})()'
const TERM_TEXT = '(() => {' +
  ' const all = Array.prototype.slice.call(document.querySelectorAll(".xterm-rows"));' +
  ' const vis = all.filter((r) => { const b = r.getBoundingClientRect(); return b.width > 10 && b.height > 10 });' +
  ' if (!vis.length) return "";' +
  ' return vis.map((r) => r.innerText).join("\\n")' +
'})()'

async function waitFor(p, expr, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try { if (await p.evaluate(expr)) return true } catch {}
    await sleep(250)
  }
  return false
}

async function main() {
  fs.rmSync(USERDATA, { recursive: true, force: true })
  fs.mkdirSync(USERDATA, { recursive: true })
  fs.rmSync(LAB_ROOT, { recursive: true, force: true })
  fs.mkdirSync(LAB_ROOT, { recursive: true })
  fs.writeFileSync(UPLOAD_FILE, Buffer.alloc(4096, 7))

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
  /* 原生模态对话框会挂住进程，脚本点不到 —— 让它立即返回「取消」 */
  env.SSHWB_TRZSZ_AUTODECLINE = '1'
  const exe = process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    : process.platform === 'darwin'
      ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
      : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron')
  if (!fs.existsSync(exe)) throw new Error('找不到 Electron 二进制：' + exe)
  const app = spawn(exe, ['.', '--user-data-dir=' + USERDATA, '--remote-debugging-port=' + APP_PORT, '--disable-gpu', '--no-sandbox'], {
    cwd: ROOT, env: env, stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(app)
  await sleep(9000)

  const p = connect((await getTarget()).webSocketDebuggerUrl)
  await p.ready
  await p.send('Runtime.enable')
  if (!(await waitReady(p))) throw new Error('应用 30s 内未就绪')

  /* ---------------- 一、建连接并开会话 ---------------- */
  const saved = await p.evaluate('(async () => {' +
    ' const r = await window.api.conn.save({ name: "tz-lab", host: "127.0.0.1", port: ' + LAB_PORT + ', username: "lab", authType: "password", password: "labpass", group: "x", tags: [] });' +
    ' return r.ok ? (r.data && r.data.id) : false' +
  '})()')
  check('建立测试连接', typeof saved === 'string' && saved.length > 0, saved)
  /* conn.save 走主进程直写，渲染层的连接列表不会自己刷新 —— 必须 reload 才能双击开会话 */
  await p.evaluate('(() => { location.reload(); return "reloading" })()')
  await sleep(2500)
  if (!(await waitReady(p))) throw new Error('reload 后应用未就绪')

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
  if (!sessionId) throw new Error('会话没开起来，后面的断言无意义')
  await sleep(1200)

  /* ---------------- 二、Z2 渲染层通道 ---------------- */
  const apiShape = await p.evaluate('(() => ({' +
    ' up: typeof (window.api.trzsz && window.api.trzsz.upload),' +
    ' cancel: typeof (window.api.trzsz && window.api.trzsz.cancel),' +
    ' onState: typeof (window.api.on && window.api.on.trzszState),' +
    ' filePathOf: typeof window.api.filePathOf' +
  '}))()')
  check('Z2 渲染层 trzsz 通道齐全（upload / cancel / onState / filePathOf）',
    apiShape && apiShape.up === 'function' && apiShape.cancel === 'function' &&
      apiShape.onState === 'function' && apiShape.filePathOf === 'function', apiShape)

  /* ---------------- 三、Z1 手敲 trz（远端没装） ---------------- */
  /*
   * 这条刻意走「没有过滤器」的路径：手敲 trz 时我们还没看到握手，
   * 不会为会话创建 TrzszFilter，于是没有任何人解析这段输出。
   * 提示能出来，只可能是 sessionManager.flush() 里那次兜底匹配起了作用。
   */
  await p.evaluate('(async () => { await window.api.session.write(' + JSON.stringify(sessionId) + ', "trz\\r") })()')
  const toastShown = await waitFor(p, '(() => document.body.innerText.includes("远端没有 trz / tsz"))()', 8000)
  check('Z1 手敲 trz 且远端没装 → 渲染层出现提示', toastShown,
    (await p.evaluate('(() => document.body.innerText.slice(0, 600))()')))

  /* ---------------- 四、Z4 上传到没装 trz 的远端 ---------------- */
  /*
   * trzsz 的 uploadFiles 会先发 Ctrl-C、等 200ms、再发 trz，
   * 若 3 秒内没等到握手就抛 'Upload does not start'。
   * 我们把它换成中文提示，同时发 no-remote-trz 状态事件。
   * 判据里带耗时下界：立刻返回说明根本没等，那这条就没测到真链路。
   */
  const upStart = Date.now()
  const upFail = await p.evaluate('(async () => {' +
    ' const r = await window.api.trzsz.upload(' + JSON.stringify(sessionId) + ', [' + JSON.stringify(UPLOAD_FILE) + ']);' +
    ' return { ok: r.ok, error: r.ok ? "" : String(r.error || "") }' +
  '})()')
  const upMs = Date.now() - upStart
  check('Z4 上传到没装 trz 的远端 → 中文报错且真的等过握手超时',
    !!upFail && upFail.ok === false && /没装 trzsz/.test(upFail.error) && upMs > 2500,
    { result: upFail, ms: upMs })

  /* ---------------- 五、Z5 对端下发握手 → 取消帧真的发到对端 ---------------- */
  /*
   * 先让 lab 进入 trzsz 模式（'@@TRZSZ:ON@@' 不含小写 trz/tsz，不会被当成命令），
   * 再发一次 tsz 让对端下发 '::TRZSZ:TRANSFER:S:...' 握手。
   * 主进程的过滤器收到后走下载分支 → 弹目录对话框（此处被 AUTODECLINE 立即取消）
   * → sendAction(false) 编码成 '#ACT:' 帧发给对端 → lab 回 'lab-saw-act'。
   * 终端里出现这一行，才能证明「取消帧真的出了本机」。
   */
  await p.evaluate('(async () => { await window.api.session.write(' + JSON.stringify(sessionId) + ', "@@TRZSZ:ON@@") })()')
  await sleep(300)
  await p.evaluate('(async () => { await window.api.session.write(' + JSON.stringify(sessionId) + ', "tsz\\r") })()')
  const sawAct = await waitFor(p, TERM_ROWS_VISIBLE + '.some((r) => r.innerText.includes("lab-saw-act"))', 20000)
  const termText = await p.evaluate(TERM_TEXT)
  /*
   * 失败时只打 termText（常常是 ""）没法定性：得知道是「终端压根不在 DOM」，
   * 还是「终端在但没收到字节」。三个现场量各对应一种病因 ——
   *   hasXterm=false  → 标签/面板被卸载（渲染层结构问题）
   *   rowsLen=0       → 终端在但缓冲区空（真没收到数据）
   *   rowsLen>0 无握手 → 收到数据但过滤器吞了（trzsz 过滤链问题）
   */
  const z5Diag = sawAct ? null : await p.evaluate('(() => {' +
    ' const list = Array.prototype.slice.call(document.querySelectorAll(".xterm")).map((x) => {' +
    '  const r = x.getBoundingClientRect();' +
    '  const rows = x.querySelector(".xterm-rows");' +
    '  let hidden = null;' +
    '  for (let n = x; n && n !== document.body; n = n.parentElement) {' +
    '   const cs = getComputedStyle(n);' +
    '   if (cs.display === "none" || cs.visibility === "hidden") { hidden = n.className || n.tagName; break }' +
    '  }' +
    '  return {' +
    '   w: Math.round(r.width), h: Math.round(r.height),' +
    '   classes: String(x.className).slice(0, 80),' +
    '   hiddenBy: hidden,' +
    '   rowsLen: rows ? rows.innerText.length : -1,' +
    '   rowsTail: rows ? rows.innerText.slice(-120) : null,' +
    '   colRow: rows ? (rows.getAttribute("style") || "").slice(0, 60) : null' +
    '  }' +
    ' });' +
    ' return { count: list.length, list: list, tabs: document.querySelectorAll("[data-conn-id]").length }' +
  '})()').catch((e) => ({ diagError: String(e && e.message) }))
  check('Z5 对端下发 tsz 握手后，取消帧真的到对端（终端出现 lab-saw-act）', sawAct,
    { term: String(termText).slice(-400), diag: z5Diag })
  check('Z5b 握手串本身照常显示在终端里（不吞字节）',
    String(termText).includes('::TRZSZ:TRANSFER:S:'), String(termText).slice(-400))

  /* ---------------- 六、Z3 取消选文件不算失败 ---------------- */
  const cancelled = await p.evaluate('(async () => {' +
    ' const r = await window.api.trzsz.upload(' + JSON.stringify(sessionId) + ');' +
    ' return { ok: r.ok, error: r.ok ? "" : String(r.error || "") }' +
  '})()')
  check('Z3 用户取消选文件 → 返回成功而不是报错', !!cancelled && cancelled.ok === true, cancelled)

  /* ---------------- 七、Z6 录制里不该出现握手 ---------------- */
  await sleep(1200)
  const logDir = path.join(USERDATA, 'sessions')
  let castText = ''
  let castName = ''
  if (fs.existsSync(logDir)) {
    const files = fs.readdirSync(logDir).filter((f) => f.endsWith('.cast'))
    if (files.length) {
      castName = files[files.length - 1]
      castText = fs.readFileSync(path.join(logDir, castName), 'utf8')
    }
  }
  check('Z6 会话录制里剔掉了握手串（回放不会是一屏乱码）',
    castName !== '' && castText.length > 0 && !castText.includes('::TRZSZ:TRANSFER:'),
    { file: castName, bytes: castText.length })

  const errs = (p.errs || []).filter((e) => !/ResizeObserver|DevTools|Autofill/.test(e))
  if (errs.length) {
    console.log('  渲染层异常：')
    for (const e of errs.slice(0, 6)) console.log('    ! ' + e)
  }
  check('Z7 无渲染层未捕获异常', errs.length === 0, errs.slice(0, 3))

  console.log('')
  console.log('=== trzsz 真实应用验证：' + pass + ' 通过 / ' + fail + ' 失败 ===')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL ' + (e && e.stack ? e.stack : e))
  cleanup()
  process.exit(1)
})
