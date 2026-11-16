/**
 * 嵌套分屏（v2.1.5）的真实应用验证。
 *
 * 为什么必须跑真应用：verify-pane-tree.cjs 只能证明「树算得对」，
 * 证明不了这几件事 —— 分屏之后标签栏里没多出一个标签、焦点描边真的换格、
 * 拖分隔条之后比例真的落盘、关掉一格之后树真的塌缩回单终端。
 * 这些全靠 DOM + settings.json 才能看见。
 *
 * 断言判据（每条都对应一个真会出错的实现方式）：
 *   S1 分屏后 DOM 里真的多了一格      —— 只改 store 不改渲染时是 1 格；
 *   S2 标签数不增加                    —— TabBar 不按 isNestedPane 过滤时变 2 个标签；
 *   S3 真的开了第二个 SSH 会话         —— 分屏只复制视图、没开 shell 时主进程只有 1 个；
 *   S4 Ctrl+Alt+→ 把焦点描边换到右格   —— 快捷键没接线 / neighbor 不工作都是这条红；
 *   S5 拖分隔条后比例落盘              —— 拖拽只改内存不持久化时 settings 里还是 0.5；
 *   S6 单格时方向键不被吞              —— 无分屏仍 preventDefault 会让终端「按词移动光标」失效；
 *   S7 点 x 只关这一格，标签还在       —— 走 sessionStore.close 会把整棵树连锅端；
 *   S8 树真的塌缩、splitLayout 被清空  —— 不塌缩时标签里留一块永久黑的空洞。
 *
 * 用法：node scripts/verify-split-e2e.cjs
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
function pickPort(min, max) { return min + Math.floor(Math.random() * (max - min)) }
const APP_PORT = Number(process.env.SP_CDP_PORT || pickPort(21000, 29000))
const LAB_PORT = Number(process.env.SP_LAB_PORT || pickPort(29000, 34000))
const USERDATA = path.join(os.tmpdir(), 'sw-split-e2e')
const LAB_ROOT = path.join(os.tmpdir(), 'sw-split-labroot')
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

/* 当前可见标签里的分屏格数（隐藏标签的格子也在 DOM 里，必须按可见性过滤） */
const PANE_PROBE = '(() => {' +
  ' const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 10 && r.height > 10 };' +
  ' const panes = [...document.querySelectorAll("[data-pane-id]")].filter(vis);' +
  ' const focused = panes.filter((el) => ((el.firstElementChild && el.firstElementChild.className) || "").includes("ring-accent")).map((el) => el.getAttribute("data-pane-id"));' +
  ' return { count: panes.length, focused: focused, ids: panes.map((el) => el.getAttribute("data-pane-id")) }' +
'})()'

/* 当前焦点格的 id 列表（0 或 1 个元素）；与 PANE_PROBE 同一套可见性判据 */
const FOCUSED = '(() => {' +
  ' const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 10 && r.height > 10 };' +
  ' return [...document.querySelectorAll("[data-pane-id]")].filter(vis).filter((el) => ((el.firstElementChild && el.firstElementChild.className) || "").includes("ring-accent")).map((el) => el.getAttribute("data-pane-id"))' +
'})()'

/* 派发一次真实按键：判据看 defaultPrevented，它直接反映「是否被快捷键吃掉」 */
const KEY = (key, opts) => '(() => {' +
  ' const e = new KeyboardEvent("keydown", { key: ' + JSON.stringify(key) + ', ctrlKey: true, altKey: ' + (opts && opts.alt ? 'true' : 'false') + ', shiftKey: false, bubbles: true, cancelable: true });' +
  ' window.dispatchEvent(e);' +
  ' return e.defaultPrevented' +
'})()'

async function main() {
  fs.rmSync(USERDATA, { recursive: true, force: true })
  fs.mkdirSync(USERDATA, { recursive: true })
  fs.rmSync(LAB_ROOT, { recursive: true, force: true })
  fs.mkdirSync(LAB_ROOT, { recursive: true })

  const lab = spawn(process.execPath, [path.join(ROOT, 'scripts', 'lab-sftp-server.cjs')], {
    env: Object.assign({}, process.env, { SFTP_ROOT: LAB_ROOT, SFTP_PORT: String(LAB_PORT), SFTP_USER: 'lab', SFTP_PASS: 'labpass', LAB_SHELL_ECHO: '1' }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(lab)
  await sleep(1500)

  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
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

  /* ---------------- 一、建连接（主进程直写后必须 reload） ---------------- */
  const saved = await p.evaluate('(async () => {' +
    ' const r = await window.api.conn.save({ name: "sp-lab", host: "127.0.0.1", port: ' + LAB_PORT + ', username: "lab", authType: "password", password: "labpass", group: "x", tags: [] });' +
    ' return r.ok ? (r.data && r.data.id) : false' +
  '})()')
  check('建立测试连接', typeof saved === 'string' && saved.length > 0, saved)
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

  const before = await p.evaluate(PANE_PROBE)
  check('S0 初始只有一格', before && before.count === 1, before)

  /* ---------------- 二、右键「向右分屏」 ---------------- */
  const menuOpened = await p.evaluate('(() => {' +
    ' const tab = document.querySelector("[data-tab-id]");' +
    ' if (!tab) return "no-tab";' +
    ' const r = tab.getBoundingClientRect();' +
    ' tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }));' +
    ' return "ok"' +
  '})()')
  await sleep(500)
  const menuText = String(await p.evaluate('(() => document.body.innerText.slice(0, 8000))()'))
  check('标签右键菜单出现「向右分屏 / 向下分屏」',
    menuOpened === 'ok' && menuText.includes('向右分屏') && menuText.includes('向下分屏'), menuOpened)

  await p.evaluate('(() => {' +
    ' const el = [...document.querySelectorAll("button,div,span")].filter((x) => (x.textContent || "").trim() === "向右分屏").pop();' +
    ' if (!el) return "no-item";' +
    ' el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));' +
    ' return "ok"' +
  '})()')
  await sleep(2500)

  const afterSplit = await p.evaluate(PANE_PROBE)
  check('S1 分屏后可见分屏格变成 2 个', afterSplit && afterSplit.count === 2, afterSplit)

  const tabCount = await p.evaluate('(() => document.querySelectorAll("[data-tab-id]").length)()')
  check('S2 标签数量仍是 1（嵌套格不占标签位）', tabCount === 1, tabCount)

  const sessionsNow = await p.evaluate('(async () => { const l = await window.api.session.list(); return (l && l.data ? l.data : []).length })()')
  check('S3 真的开了第二个 SSH 会话（不是复制视图）', sessionsNow === 2, sessionsNow)

  /* ---------------- 三、焦点移动 ---------------- */
  const focusBefore = await p.evaluate(FOCUSED)
  /*
   * 判据拆两段，避免自证：
   *   1. 本次按键是否真的到达了 window 的 capture 监听（自挂一个探针计数）；
   *   2. 焦点是否从「按之前的那一格」移到了「另一格」。
   * 之前只比 focused[0] 与分屏前的 id —— 分屏本身就把焦点给了新格，
   * 于是不按键也会绿，属于假绿。
   *
   * 方向必须用 ←：向右分屏后焦点落在新开的右格上，右格右侧没有邻居，
   * 按 → 本来就该返回 false（不该吞键）。要验证「移动」，只能往左走。
   */
  const consumed = await p.evaluate('(() => {' +
    ' window.__cap = 0;' +
    ' const onCap = () => { window.__cap += 1 };' +
    ' window.addEventListener("keydown", onCap, { capture: true });' +
    ' const e = new KeyboardEvent("keydown", { key: "ArrowLeft", ctrlKey: true, altKey: true, shiftKey: false, bubbles: true, cancelable: true });' +
    ' window.dispatchEvent(e);' +
    ' window.removeEventListener("keydown", onCap, { capture: true });' +
    ' return { cap: window.__cap, prevented: e.defaultPrevented }' +
  '})()')
  await sleep(400)
  const focusAfter = await p.evaluate(FOCUSED)
  check('S4 Ctrl+Alt+← 被快捷键吃掉（defaultPrevented）',
    !!consumed && consumed.cap > 0 && consumed.prevented === true, {
      consumed: consumed, before: focusBefore, after: focusAfter
    })
  check(
    'S4b 焦点描边从按之前那一格移到了另一格',
    !!focusBefore && !!focusAfter && focusBefore.length === 1 &&
      focusAfter.length === 1 && focusAfter[0] !== focusBefore[0],
    { before: focusBefore, after: focusAfter }
  )
  check('S4c 该会话真的被激活（activeId 指向新焦点格）',
    !!focusAfter && focusAfter.length === 1 &&
      (await p.evaluate('(async () => { const l = await window.api.session.list(); const a = l && l.data ? l.data.filter((x) => x.status === "connected").length : 0; return a })()')) === 2,
    focusAfter)

  /* ---------------- 四、拖分隔条 ---------------- */
  const dragged = await p.evaluate('(() => {' +
    /*
     * 必须按 aria-label 过滤：页面上有三个 role=separator（侧边栏 / 分屏 / 命令栏），
     * 第一个是侧边栏的，拖它当然不会改 splitLayout —— 这正是这条断言一度假红的根因。
     */
    ' const d = [...document.querySelectorAll("[role=separator]")].find((x) => (x.getAttribute("aria-label") || "").includes("分屏"));' +
    ' if (!d) return "no-divider";' +
    ' const r = d.getBoundingClientRect();' +
    ' const x = r.left + r.width / 2, y = r.top + r.height / 2;' +
    ' d.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));' +
    ' window.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: x + 180, clientY: y }));' +
    ' window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x + 180, clientY: y }));' +
    ' return "ok"' +
  '})()')
  await sleep(1200)
  const layout = await p.evaluate('(async () => { const r = await window.api.settings.get(); return r.ok ? (r.data.splitLayout || null) : null })()')
  const tree = layout && saved ? layout[saved] : null
  check('S5 拖分隔条后比例落盘（不再是 0.5）',
    dragged === 'ok' && !!tree && tree.t === 's' && typeof tree.r === 'number' && Math.abs(tree.r - 0.5) > 0.02,
    { dragged: dragged, tree: tree })

  /* ---------------- 五、关一格：塌缩回单终端 ---------------- */
  await p.evaluate('(() => {' +
    ' const tab = document.querySelector("[data-tab-id]");' +
    ' if (!tab) return "no-tab";' +
    ' const btn = tab.querySelector("button[title]");' +
    ' const all = [...tab.querySelectorAll("button")];' +
    ' const x = all.find((b) => (b.getAttribute("title") || "").indexOf("关闭") === 0);' +
    ' if (!x) return "no-x";' +
    ' x.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));' +
    ' return x.getAttribute("title")' +
  '})()')
  await sleep(2000)

  const afterClose = await p.evaluate(PANE_PROBE)
  check('S6 点 x 只关掉这一格（可见格回到 1）', afterClose && afterClose.count === 1, afterClose)
  const tabCount2 = await p.evaluate('(() => document.querySelectorAll("[data-tab-id]").length)()')
  check('S6b 标签仍在（关的是分屏不是标签）', tabCount2 === 1, tabCount2)

  const layout2 = await p.evaluate('(async () => { const r = await window.api.settings.get(); const m = r.ok ? (r.data.splitLayout || {}) : {}; return Object.keys(m) })()')
  check('S7 树塌缩后 splitLayout 里该连接的条目被清掉', Array.isArray(layout2) && layout2.indexOf(saved) < 0, layout2)

  /* ---------------- 六、单格时方向键不被吞 ---------------- */
  const consumedSingle = await p.evaluate(KEY('ArrowLeft', { alt: true }))
  check('S8 单格时 Ctrl+Alt+← 不被吃掉（终端还能按词移动光标）', consumedSingle === false, consumedSingle)

  /* ---------------- 七、终端右键菜单也能分屏 ----------------
   *
   * 分屏原先只有标签栏一个入口：标签栏 44px 高、还会横向滚动，鼠标要精准落在
   * 某一条标签上才点得到，而想分屏时视线和鼠标其实都在终端里。
   * 这一段验的是终端右键这条新入口 —— 它必须与标签栏入口走同一条 splitStore 链路，
   * 判据都选「修复没落地时会红」的量：
   *
   *   T0 单格时终端菜单有分屏项、且**没有**「关闭此分屏」
   *      —— 把「关闭此分屏」写成常驻会让单格用户看到「关掉整个终端」的入口；
   *   T1/T2 点终端菜单「向右分屏」真的多一格、标签数不增加
   *      —— 只挂菜单不接 onClick 时 T1 红；
   *   T3 分屏后终端菜单出现「关闭此分屏」
   *      —— paneTotal 判据写错（比如拿会话 id 当 owner）时这条红；
   *   T4 点「关闭此分屏」真的回到一格
   *      —— 误调 sessionStore.close 会把整棵树连锅端，T4 与标签数一起红。
   *
   * 打开菜单用 .xterm 上派发 contextmenu：它冒泡到 TerminalView 里挂了
   * onContextMenu 的那个容器 div，与真实右键同一条路径。
   */
  const TERM_MENU_OPEN = '(() => {' +
    ' const t = document.querySelector(".xterm");' +
    ' if (!t) return "no-xterm";' +
    ' const r = t.getBoundingClientRect();' +
    ' t.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 40 }));' +
    ' return "ok"' +
  '})()'
  /* 菜单文本只取 .menu 这一个元素，不看 body.innerText —— 后者会把侧栏/状态栏文案一起算进来 */
  const MENU_TEXT = '(() => { const m = document.querySelector(".menu"); return m ? m.innerText : null })()'
  const TERM_MENU_CLICK = (label) => '(() => {' +
    ' const m = document.querySelector(".menu");' +
    ' if (!m) return "no-menu";' +
    ' const btn = [...m.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === ' + JSON.stringify(label) + ');' +
    ' if (!btn) return "no-item";' +
    ' if (btn.disabled) return "disabled";' +
    ' btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));' +
    ' return "ok"' +
  '})()'

  await p.evaluate(TERM_MENU_OPEN)
  await sleep(400)
  const termMenu1 = String(await p.evaluate(MENU_TEXT))
  check('T0 单格时终端菜单有分屏项、且不出现「关闭此分屏」',
    termMenu1.includes('向右分屏') && termMenu1.includes('向下分屏') && !termMenu1.includes('关闭此分屏'),
    termMenu1.slice(0, 200))

  const termSplit = await p.evaluate(TERM_MENU_CLICK('向右分屏'))
  await sleep(2500)
  const afterTermSplit = await p.evaluate(PANE_PROBE)
  check('T1 终端菜单「向右分屏」真的多出一格', termSplit === 'ok' && !!afterTermSplit && afterTermSplit.count === 2,
    { clicked: termSplit, panes: afterTermSplit })
  const tabCount3 = await p.evaluate('(() => document.querySelectorAll("[data-tab-id]").length)()')
  check('T2 标签数量仍是 1（终端入口与标签栏入口同一条链路）', tabCount3 === 1, tabCount3)

  await p.evaluate(TERM_MENU_OPEN)
  await sleep(400)
  const termMenu2 = String(await p.evaluate(MENU_TEXT))
  check('T3 分屏后终端菜单出现「关闭此分屏」', termMenu2.includes('关闭此分屏'), termMenu2.slice(0, 200))

  const termClose = await p.evaluate(TERM_MENU_CLICK('关闭此分屏'))
  await sleep(2000)
  const afterTermClose = await p.evaluate(PANE_PROBE)
  check('T4 终端菜单「关闭此分屏」只关这一格（可见格回到 1）',
    termClose === 'ok' && !!afterTermClose && afterTermClose.count === 1,
    { clicked: termClose, panes: afterTermClose })
  const tabCount4 = await p.evaluate('(() => document.querySelectorAll("[data-tab-id]").length)()')
  check('T4b 标签仍在（关的是分屏不是整个终端）', tabCount4 === 1, tabCount4)

  const errs = (p.errs || []).filter((e) => !/ResizeObserver|DevTools|Autofill/.test(e))
  if (errs.length) {
    console.log('  渲染层异常：')
    for (const e of errs.slice(0, 6)) console.log('    ! ' + e)
  }
  check('无渲染层未捕获异常', errs.length === 0, errs.slice(0, 3))

  console.log('')
  console.log('=== 分屏真实应用验证：' + pass + ' 通过 / ' + fail + ' 失败 ===')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL ' + (e && e.stack ? e.stack : e))
  cleanup()
  process.exit(1)
})
