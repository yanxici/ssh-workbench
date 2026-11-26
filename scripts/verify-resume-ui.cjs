#!/usr/bin/env node
/**
 * 「断线续传」在真实 UI 上的验证 —— 断言的是**用户能看到的那一行字**。
 *
 * 为什么单独要这一份：
 * - scripts/verify-sftp-resume.cjs 只证明主进程逻辑分支对（假通道）；
 * - scripts/verify-sftp-resume-e2e.cjs 只证明真 TCP 断链后字节仍然正确；
 * - 但用户抱怨的恰恰是「进度条不动、界面没有任何提示」—— 原来的实现只把
 *   状态写进 title 提示框，用户根本不会 hover。所以「这一行提示可见」本身
 *   就是产品行为，必须有断言盯着它真的渲染出来。
 *
 * 做法：真 lab SSH 服务器（LAB_DROP_AFTER_BYTES 中途 client.end()）→ 真 Electron 应用
 * → 主进程打补丁接管文件对话框 → 点真实「上传文件」按钮 → 轮询 DOM 抓那一行提示
 * → 截图留证据 → 校验远端 sha256 → 校验结束后提示消失。
 *
 * 用法：node scripts/verify-resume-ui.cjs
 *   RESUME_SIZE_MB=16  大文件大小（必须 >= 8MB，否则进度浮层本身不弹）
 *   RESUME_DROP_MB=4   累计写多少 MB 后断链
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const net = require('node:net')

const ROOT = path.resolve(__dirname, '..')
const TMP = path.join(os.tmpdir(), 'resume-ui')
const LAB_ROOT = path.join(TMP, 'lab')
const SRC = path.join(TMP, 'src')
const USERDATA = path.join(TMP, 'ud')
const SHOT_DIR = path.join(ROOT, '.tmp')
const APP_PORT = Number(process.env.RESUME_APP_PORT || 9471)
const MAIN_PORT = Number(process.env.RESUME_MAIN_PORT || 9472)
const LAB_PORT = Number(process.env.RESUME_LAB_PORT || 2412)
const SIZE_MB = Number(process.env.RESUME_SIZE_MB || 16)
const DROP_MB = Number(process.env.RESUME_DROP_MB || 4)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
function check(name, ok, extra) {
  if (ok) console.log('  ok   ' + name)
  else {
    failed += 1
    console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''))
  }
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
async function waitFor(fn, ms, step = 200) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      if (await fn()) return true
    } catch {}
    await sleep(step)
  }
  return false
}

/* ------------------------------ CDP ------------------------------ */
const WS_IMPL = (() => {
  if (typeof WebSocket === 'function') return WebSocket
  try {
    return require('ws')
  } catch {
    throw new Error('当前 Node 既没有全局 WebSocket 也没装 ws')
  }
})()
async function attach(port, want) {
  const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
  const t = list.find((x) => x.webSocketDebuggerUrl && (want === 'main' ? true : x.type === 'page'))
  if (!t) throw new Error(want + ': ' + port + ' 无可用 target')
  const ws = new WS_IMPL(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id
      pending.set(i, { resolve, reject })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const evalJs = async (expression, api = false) => {
    if (process.env.RESUME_TRACE) console.log('  > ' + expression.slice(0, 70))
    // 页面刚 reload 时旧执行上下文会被销毁，Runtime.evaluate 会回 -32000；
    // 这不是产品缺陷，等新上下文就绪后重试即可。
    for (let attempt = 0; ; attempt++) {
      let r
      try {
        r = await send('Runtime.evaluate', {
          expression,
          awaitPromise: true,
          returnByValue: true,
          userGesture: true,
          includeCommandLineAPI: api
        })
      } catch (err) {
        const msg = String(err && err.message)
        const transient =
          msg.includes('Execution context was destroyed') || msg.includes('Cannot find context')
        if (!transient || attempt >= 40) throw err
        await new Promise((res) => setTimeout(res, 250))
        continue
      }
      if (r.exceptionDetails)
        throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails))
      return r.result.value
    }
  }
  return { send, evalJs, close: () => ws.close() }
}

/* ------------------------------ 页面侧探针 ------------------------------ */
const PAGE_SDK = [
  'window.__r = {',
  '  props(n){ if(!n) return null; const k = Object.keys(n).find(x => x.startsWith("__reactProps$")); return k ? n[k] : null },',
  '  ev(){ return { preventDefault(){}, stopPropagation(){}, nativeEvent:{}, clientX:240, clientY:320, button:0, buttons:0, target:null } },',
  '  find(node, names){',
  '    let c = node, d = 0',
  '    while (c && d < 8) { const p = this.props(c); if (p) { for (const n of names) if (typeof p[n] === "function") return p[n] } c = c.parentElement; d++ }',
  '    return null',
  '  },',
  '  menu(re){ const rx = new RegExp(re); const els = Array.from(document.querySelectorAll("body *")).filter(e => e.children.length <= 1 && (e.textContent||"").trim().length < 26 && rx.test((e.textContent||"").trim())); for (const el of els) { const f = this.find(el, ["onClick"]); if (f) { f(this.ev()); return el.textContent.trim() } } return null },',
  '  btn(re){ const rx = new RegExp(re); const b = Array.from(document.querySelectorAll("button")).find(x => rx.test(x.getAttribute("title") || "")); if(!b) return false; b.click(); return true },',
  '  titles(){ return Array.from(document.querySelectorAll("button")).map(b => (b.getAttribute("title") || "") + "|" + (b.textContent||"").trim().slice(0,18)).filter(Boolean) },',
  '  clickText(re){ const rx = new RegExp(re); const b = Array.from(document.querySelectorAll("button")).find(x => rx.test((x.textContent || "").trim())); if(!b) return false; b.click(); return true },',
  '  openSession(){ const r = document.querySelector("[data-conn-id]"); if(!r) return "no-conn"; const f = this.find(r, ["onDoubleClick","onDblClick"]); if(!f) return "no-handler"; f(this.ev()); return "ok" },',
  '  sessionReady(){ return document.querySelectorAll(".xterm").length > 0 },',
  '  sidebarOpen(){ return Array.from(document.querySelectorAll("button")).some(b => /^上传文件到 /.test(b.getAttribute("title") || "")) },',
  '  openSidebar(){ if (this.sidebarOpen()) return "already"; const b = Array.from(document.querySelectorAll("button")).find(x => x.getAttribute("title") === "文件"); if(!b) return "no-btn"; b.click(); return "clicked" },',
  '  /* 进度浮层里那行提示：断线续传时应当出现，且必须占实际像素（不是 display:none 的残留） */',
  '  note(){',
  '    const els = Array.from(document.querySelectorAll("body *")).filter(e => (e.textContent||"").includes("重连后续传") && e.children.length <= 1)',
  '    for (const el of els) {',
  '      const r = el.getBoundingClientRect()',
  '      if (r.width > 0 && r.height > 0) return { text: (el.textContent||"").trim(), w: Math.round(r.width), h: Math.round(r.height) }',
  '    }',
  '    return null',
  '  },',
  '  dockPresent(){ return !!Array.from(document.querySelectorAll("button")).find(b => /传输进度/.test(b.getAttribute("title") || "")) },',
  '  dockTexts(){ return Array.from(document.querySelectorAll("button")).filter(b => /传输进度/.test(b.getAttribute("title") || "")).map(b => (b.textContent||"").trim()).slice(0, 3) }',
  '}',
  '"sdk-ready"'
].join('\n')

function makeBig() {
  const buf = Buffer.alloc(SIZE_MB * 1024 * 1024)
  let x = 987654321
  for (let i = 0; i < buf.length; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    buf[i] = x >> 16
  }
  fs.writeFileSync(path.join(SRC, 'big.bin'), buf)
  return { path: path.join(SRC, 'big.bin'), sha: sha(buf), size: buf.length }
}

async function main() {
  const started = Date.now()
  const children = []
  const kill = (c) => {
    if (!c || c.killed) return
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
      else c.kill('SIGKILL')
    } catch {}
  }
  const cleanup = () => children.forEach(kill)
  process.on('exit', cleanup)

  for (const d of [LAB_ROOT, SRC, USERDATA]) fs.rmSync(d, { recursive: true, force: true })
  for (const d of [LAB_ROOT, SRC, USERDATA, SHOT_DIR]) fs.mkdirSync(d, { recursive: true })
  fs.mkdirSync(path.join(LAB_ROOT, 'up'), { recursive: true })
  const big = makeBig()

  const lab = spawn(process.execPath, [path.join(ROOT, 'scripts', 'lab-sftp-server.cjs')], {
    env: {
      ...process.env,
      SFTP_ROOT: LAB_ROOT,
      SFTP_PORT: String(LAB_PORT),
      SFTP_USER: 'lab',
      SFTP_PASS: 'labpass',
      LAB_DROP_AFTER_BYTES: String(DROP_MB * 1024 * 1024),
      LAB_DROP_TIMES: '1',
      LAB_DROP_DIR: 'upload'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(lab)
  lab.stderr.on('data', (d) => process.stdout.write('[lab:err] ' + d))
  lab.stdout.on('data', (d) => process.env.VERBOSE && process.stdout.write('[lab] ' + d))
  const labUp = await waitFor(
    () =>
      new Promise((res) => {
        const s = net.connect(LAB_PORT, '127.0.0.1')
        s.on('connect', () => (s.end(), res(true)))
        s.on('error', () => res(false))
      }),
    15000,
    200
  )
  check('lab SSH 服务器就绪', labUp, String(LAB_PORT))
  if (!labUp) throw new Error('lab 没起来')

  const electronPath = process.env.E2E_APP || require('electron')
  const baseArgs = [
    '--user-data-dir=' + USERDATA,
    '--remote-debugging-port=' + APP_PORT,
    '--inspect=' + MAIN_PORT,
    '--disable-gpu',
    '--no-sandbox'
  ]
  const appArgs = process.env.E2E_APP ? baseArgs : ['.', ...baseArgs]
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const app = spawn(electronPath, appArgs, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(app)
  const log = []
  app.stdout.on('data', (d) => {
    log.push(String(d))
    if (process.env.VERBOSE) process.stdout.write('[app] ' + d)
  })
  app.stderr.on('data', (d) => log.push(String(d)))

  const pageUp = await waitFor(async () => {
    try {
      const l = await (await fetch('http://127.0.0.1:' + APP_PORT + '/json/list')).json()
      return l.some((x) => x.type === 'page' && x.webSocketDebuggerUrl)
    } catch {
      return false
    }
  }, 60000, 400)
  check('应用起来了（CDP page target）', pageUp, '')
  if (!pageUp) throw new Error('应用 CDP 没起来\n' + log.join('').slice(-3000))

  const mainCdp = await attach(MAIN_PORT, 'main')
  let page = await attach(APP_PORT, 'page')

  await mainCdp.evalJs(
    '(() => { const electron = (typeof require === "function" ? require : process.mainModule.require)("electron");' +
      ' globalThis.__files = []; globalThis.__calls = [];' +
      ' electron.dialog.showOpenDialog = async (a, b) => { const o = (b && b.properties) ? b : (a || {});' +
      ' globalThis.__calls.push({ isDir: Array.isArray(o.properties) && o.properties.includes("openDirectory") });' +
      ' if (!globalThis.__files.length) return { canceled: true, filePaths: [] };' +
      ' return { canceled: false, filePaths: globalThis.__files.slice() } }; return true })()',
    true
  )
  await mainCdp.evalJs('(globalThis.__files = ' + JSON.stringify([big.path]) + ', true)', true)

  const conn = await page.evalJs(
    'window.api.conn.save({ name: "resume-ui", host: "127.0.0.1", port: ' +
      LAB_PORT +
      ', username: "lab", authType: "password", password: "labpass", group: "e2e", tags: [] }).then(r => JSON.stringify(r))'
  )
  check('建连接', /"ok":true/.test(String(conn)), String(conn).slice(0, 120))
  /*
   * reload 会销毁执行上下文，Runtime.evaluate 的 promise 往往回不来，
   * 直接 await 会把整个脚本带崩（"Execution context was destroyed"）。
   * 这里只求"发出刷新"，回来与否都不关心。
   */
  await page.evalJs('setTimeout(() => location.reload(), 0), 1').catch(() => {})
  await sleep(1800)
  page.close()
  page = await attach(APP_PORT, 'page')
  await page.evalJs(PAGE_SDK)
  await sleep(600)

  const opened = await page.evalJs('window.__r.openSession()')
  const ready = await waitFor(() => page.evalJs('window.__r.sessionReady()'), 25000)
  check('双击连接开会话', opened === 'ok' && ready, opened)

  const side = await page.evalJs('window.__r.openSidebar()')
  const sideUp = await waitFor(() => page.evalJs('window.__r.sidebarOpen()'), 15000)
  check('打开文件侧栏', sideUp, side)

  /* 触发上传：真实按钮 → 真实对话框（已打补丁）→ 真实确认 */
  if (process.env.RESUME_DBG) {
    console.log('  侧栏状态: ' + (await page.evalJs('window.__r.sidebarOpen()')))
    console.log('  按钮快照: ' + (await page.evalJs('JSON.stringify(window.__r.titles().filter(t => /上传|文件夹|新建文件夹/.test(t)))')))
  }
  /* 侧栏是异步 bootstrap 的：按钮存在不代表 FileExplorer 已经挂好 onClick，
     所以点击也要轮询重试，而不是"查到一次就点一次"。 */
  let clicked = false
  await waitFor(async () => {
    clicked = await page.evalJs('window.__r.btn("上传文件到")')
    return clicked === true
  }, 15000, 250)
  await sleep(900)
  const confirm = await page.evalJs('window.__r.menu("^选择文件并上传$") || "no-confirm"')
  if (process.env.RESUME_DBG) {
    console.log('  对话框调用: ' + (await mainCdp.evalJs('JSON.stringify(globalThis.__calls || [])', true)))
  }
  check(
    '点「上传文件」并确认',
    clicked === true && confirm === '选择文件并上传',
    JSON.stringify({ clicked, confirm })
  )

  /* 抓提示：断链→重连的窗口期只有 1~3 秒，轮询要密 */
  let seen = null
  const seenOk = await waitFor(async () => {
    const n = await page.evalJs('window.__r.note()')
    if (n && n.text) {
      seen = n
      return true
    }
    return false
  }, 40000, 120)
  check('UI 上真的出现「重连后续传」提示行（可见、非 title）', seenOk, seen)
  const dockOk = await page.evalJs('window.__r.dockPresent()')
  check('提示出现在传输进度浮层里', dockOk, await page.evalJs('JSON.stringify(window.__r.dockTexts())'))

  if (seenOk) {
    const shot = await page.send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(SHOT_DIR, 'resume-note.png')
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
    console.log('  截图: ' + file)
  }

  /* 最终状态：字节正确 + 提示消失 */
  /* 上传落到「文件侧栏当前目录」，首次打开是家目录/根目录，随 bootstrap 结果而变，
     所以不写死 up/ —— 递归找吧，反正 lab 根目录是我们自己造的空目录。 */
  const findRemote = () => {
    const stack = [LAB_ROOT]
    while (stack.length) {
      const d = stack.pop()
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const f = path.join(d, e.name)
        if (e.isDirectory()) stack.push(f)
        else if (e.name === 'big.bin') return f
      }
    }
    return null
  }
  const doneOk = await waitFor(() => {
    const f = findRemote()
    return !!f && fs.statSync(f).size === big.size
  }, 90000, 400)
  const remote = findRemote()
  const remoteSha = doneOk && remote ? sha(fs.readFileSync(remote)) : ''
  check('远端文件大小正确', doneOk, doneOk ? big.size + ' @ ' + remote : remote ? fs.statSync(remote).size : 'missing')
  check('远端内容与本地一致（sha256）', remoteSha === big.sha)
  const noteGone = await waitFor(async () => (await page.evalJs('window.__r.note()')) === null, 20000, 300)
  check('传输结束后提示行消失', noteGone, '')

  console.log('')
  console.log(
    failed === 0
      ? '==== UI 断线续传提示验证全部通过（' + (Date.now() - started) / 1000 + 's）===='
      : '==== ' + failed + ' 条失败 ===='
  )
  cleanup()
  setTimeout(() => process.exit(failed ? 1 : 0), 300)
}

main().catch((e) => {
  console.error('[resume-ui] 失败:', e && e.stack)
  process.exit(1)
})
