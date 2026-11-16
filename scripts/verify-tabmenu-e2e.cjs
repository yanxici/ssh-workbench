/**
 * 标签栏右键菜单的「真机点击」回归（v2.1.8）。
 *
 * 为什么必须用 CDP Input.dispatchMouseEvent，而不是 el.dispatchEvent(new MouseEvent('click'))：
 * 前者走浏览器的真实输入管线，要经过命中测试与 -webkit-app-region 判定；
 * 后者由 JS 直接投递到元素，绕开窗口管理器，**bug 还在时也会绿**。
 * 本脚本存在的全部意义就是复现「鼠标点下去没反应」这一层。
 *
 * 根因（2026-11-15 定位）：ContextMenu 用 position:fixed 定位，但 fixed 只改绘制位置、
 * 不改 DOM 归属。菜单被渲染在标题栏 .drag-region 子树里，Chromium 把 drag 区内的鼠标
 * 按下交给窗口管理器做「拖动窗口」，click 一律被吞 —— 表现为 hover 有高亮、点了没反应。
 * 修法：createPortal(..., document.body) + no-drag 兜底。
 *
 * 断言判据（每条都在修复未落地时会红）：
 *   M1 菜单不出现在任何 .drag-region 子树里           —— 不 portal 时直接红；
 *   M2 菜单是 document.body 的直接子元素（portal 证据） —— 同上，判据独立于 M1 的类名；
 *   M3 CDP 真实右键标签能弹出菜单                      —— openMenu 没接到 onContextMenu 时红；
 *   M4 CDP 真实左键点「重命名」→ 标签里出现输入框       —— 事件被 drag 区吞掉时红（核心）；
 *   M5 真实点击「本连接不弹通知」→ 重开菜单文案变「恢复本连接通知」 —— onClick 没执行时红；
 *   M6 真实点击「向右分屏」→ 可见分屏格 2、标签数仍 1   —— 分屏入口链路断时红；
 *   M7 真实点击「关闭此分屏」→ 回到 1 格且标签仍在      —— 误调 close 连锅端时红；
 *   M8 多标签时真实点击「关闭其他标签」→ 只剩 1 个标签   —— 该入口形同虚设时红。
 *
 * 用法：node scripts/verify-tabmenu-e2e.cjs
 *      TM_APP=<打包 exe> node scripts/verify-tabmenu-e2e.cjs   # 验证打包产物
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
function pickPort(min, max) { return min + Math.floor(Math.random() * (max - min)) }
const APP_PORT = Number(process.env.TM_CDP_PORT || pickPort(21000, 28000))
const LAB_PORT = Number(process.env.TM_LAB_PORT || pickPort(28000, 33000))
const USERDATA = path.join(os.tmpdir(), 'sw-tabmenu-e2e')
const LAB_ROOT = path.join(os.tmpdir(), 'sw-tabmenu-labroot')

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
  for (let i = 0; i < 60; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + APP_PORT + '/json/list')).json()
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
    ws.send(JSON.stringify({ id, method, params: params || {} }))
    setTimeout(() => { if (pend.has(id)) { pend.delete(id); reject(new Error('timeout ' + method)) } }, 45000)
  })
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? String(r.exceptionDetails.exception.description) : 'eval error')
    return r.result.value
  }
  return { ready, send, evaluate, errs, ws }
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

/* ---------- 真实鼠标（走 Chromium 输入管线，受 app-region 影响） ---------- */
async function mouseClick(p, x, y, button) {
  const btn = button || 'left'
  await p.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await sleep(40)
  await p.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: btn, buttons: btn === 'right' ? 2 : 1, clickCount: 1 })
  await sleep(60)
  await p.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: btn, buttons: 0, clickCount: 1 })
  await sleep(120)
}

/* 标签中心坐标 */
const TAB_RECT = (i) => '(() => {' +
  ' const t = [...document.querySelectorAll("[data-tab-id]")][' + i + '];' +
  ' if (!t) return null;' +
  ' const r = t.getBoundingClientRect();' +
  ' return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height }' +
'})()'

/* 菜单里某个按钮的中心坐标（只找 .menu，避免撞到侧栏同名文案） */
const ITEM_RECT = (label) => '(() => {' +
  ' const m = document.querySelector(".menu");' +
  ' if (!m) return null;' +
  ' const b = [...m.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === ' + JSON.stringify(label) + ');' +
  ' if (!b) return { missing: true };' +
  ' if (b.disabled) return { disabled: true };' +
  ' const r = b.getBoundingClientRect();' +
  ' return { x: r.left + r.width / 2, y: r.top + r.height / 2 }' +
'})()'

/* 菜单文本 */
const MENU_TEXT = '(() => { const m = document.querySelector(".menu"); return m ? m.innerText : null })()'

/* 菜单的 DOM 归属：是否落在 .drag-region 子树里 / 是否是 body 直接子元素 */
const MENU_OWNER = '(() => {' +
  ' const m = document.querySelector(".menu");' +
  ' if (!m) return { menu: false };' +
  ' const inDrag = !!m.closest(".drag-region");' +
  ' return {' +
  '   menu: true,' +
  '   inDragRegion: inDrag,' +
  '   isBodyChild: m.parentElement === document.body,' +
  '   appRegion: getComputedStyle(m).getPropertyValue("-webkit-app-region") || getComputedStyle(m).webkitAppRegion || ""' +
  ' }' +
'})()'

const PANE_PROBE = '(() => {' +
  ' const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 10 && r.height > 10 };' +
  ' const panes = [...document.querySelectorAll("[data-pane-id]")].filter(vis);' +
  ' return { count: panes.length, ids: panes.map((el) => el.getAttribute("data-pane-id")) }' +
'})()'

const TAB_COUNT = '(() => document.querySelectorAll("[data-tab-id]").length)()'

/* 打开标签右键菜单：真实右键 */
async function openTabMenu(p, tabIndex) {
  const r = await p.evaluate(TAB_RECT(tabIndex || 0))
  if (!r) return { ok: false, why: 'no-tab' }
  await mouseClick(p, r.x, r.y, 'right')
  await sleep(350)
  const menu = await p.evaluate(MENU_OWNER)
  return { ok: !!menu.menu, rect: r, owner: menu }
}

/* 点菜单项：真实左键 */
async function clickItem(p, label) {
  const r = await p.evaluate(ITEM_RECT(label))
  if (!r) return 'no-menu'
  if (r.missing) return 'no-item'
  if (r.disabled) return 'disabled'
  await mouseClick(p, r.x, r.y, 'left')
  await sleep(300)
  return 'ok'
}

async function main() {
  fs.rmSync(USERDATA, { recursive: true, force: true })
  fs.mkdirSync(USERDATA, { recursive: true })
  fs.rmSync(LAB_ROOT, { recursive: true, force: true })
  fs.mkdirSync(LAB_ROOT, { recursive: true })

  const lab = spawn(process.execPath, [path.join(ROOT, 'scripts', 'lab-sftp-server.cjs')], {
    env: Object.assign({}, process.env, {
      SFTP_ROOT: LAB_ROOT, SFTP_PORT: String(LAB_PORT), SFTP_USER: 'lab', SFTP_PASS: 'labpass', LAB_SHELL_ECHO: '1'
    }),
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(lab)
  await sleep(1500)

  const env = Object.assign({}, process.env)
  delete env.ELECTRON_RUN_AS_NODE
  const packaged = process.env.TM_APP
  const exe = packaged || (process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    : process.platform === 'darwin'
      ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
      : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron'))
  if (!fs.existsSync(exe)) throw new Error('找不到可执行文件：' + exe)
  const args = packaged
    ? ['--user-data-dir=' + USERDATA, '--remote-debugging-port=' + APP_PORT, '--disable-gpu']
    : ['.', '--user-data-dir=' + USERDATA, '--remote-debugging-port=' + APP_PORT, '--disable-gpu', '--no-sandbox']
  const app = spawn(exe, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(app)
  await sleep(9000)

  const p = connect((await getTarget()).webSocketDebuggerUrl)
  await p.ready
  await p.send('Runtime.enable')
  if (!(await waitReady(p))) throw new Error('应用 30s 内未就绪')

  /* ------------- 建连接 ------------- */
  const saved = await p.evaluate('(async () => {' +
    ' const r = await window.api.conn.save({ name: "tm-lab", host: "127.0.0.1", port: ' + LAB_PORT + ', username: "lab", authType: "password", password: "labpass", group: "x", tags: [] });' +
    ' return r.ok ? (r.data && r.data.id) : false' +
  '})()')
  check('建立测试连接', typeof saved === 'string' && saved.length > 0, saved)
  await p.evaluate('(() => { location.reload(); return "reloading" })()')
  await sleep(2500)
  if (!(await waitReady(p))) throw new Error('reload 后应用未就绪')

  await p.evaluate('(() => {' +
    ' const r = document.querySelector("[data-conn-id]");' +
    ' if (!r) return "no-row";' +
    ' r.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true }));' +
    ' return "ok"' +
  '})()')
  let sessionId = null
  for (let i = 0; i < 60; i++) {
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

  /* ---------------- M1/M2/M3 菜单 DOM 归属 ---------------- */
  const opened = await openTabMenu(p, 0)
  check('M3 真实右键标签弹出菜单', opened.ok === true, opened)
  const owner = opened.owner || {}
  check('M1 菜单不在任何 .drag-region 子树里（否则点击会被窗口管理器吞）', owner.inDragRegion === false, owner)
  check('M2 菜单是 document.body 的直接子元素（createPortal 生效）', owner.isBodyChild === true, owner)

  /* ---------------- M4 真实点击「重命名」 ---------------- */
  const rn = await clickItem(p, '重命名')
  await sleep(500)
  const editing = await p.evaluate('(() => {' +
    ' const t = document.querySelector("[data-tab-id]");' +
    ' const i = t && t.querySelector("input");' +
    ' return { hasInput: !!i, focused: !!(i && document.activeElement === i), value: i ? i.value : null }' +
  '})()')
  check('M4 真实左键点「重命名」→ 标签内出现输入框（这是被 drag 区吞掉时最先红的一条）',
    rn === 'ok' && editing && editing.hasInput === true, { click: rn, editing })
  await p.evaluate('(() => { const t = document.querySelector("[data-tab-id] input"); if (t) { t.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); } return "ok" })()')
  await sleep(400)

  /* ---------------- M5 通知开关 ---------------- */
  await openTabMenu(p, 0)
  const t1 = String(await p.evaluate(MENU_TEXT))
  check('M5a 菜单初始文案是「本连接不弹通知」', t1.includes('本连接不弹通知'), t1.slice(0, 120))
  const tog = await clickItem(p, '本连接不弹通知')
  await sleep(500)
  await openTabMenu(p, 0)
  const t2 = String(await p.evaluate(MENU_TEXT))
  check('M5b 真实点击后重开菜单文案变「恢复本连接通知」', tog === 'ok' && t2.includes('恢复本连接通知'), { click: tog, menu: t2.slice(0, 160) })
  /* 恢复回去，避免影响后续 */
  await clickItem(p, '恢复本连接通知')
  await sleep(400)

  /* ---------------- M6 向右分屏 ---------------- */
  await openTabMenu(p, 0)
  const split = await clickItem(p, '向右分屏')
  await sleep(2500)
  const afterSplit = await p.evaluate(PANE_PROBE)
  check('M6 真实点击「向右分屏」→ 可见分屏格变 2', split === 'ok' && afterSplit && afterSplit.count === 2, { click: split, panes: afterSplit })
  const tabCount2 = await p.evaluate(TAB_COUNT)
  check('M6b 分屏不新增标签', tabCount2 === 1, tabCount2)

  /* ---------------- M7 关闭此分屏 ---------------- */
  await openTabMenu(p, 0)
  const mt = String(await p.evaluate(MENU_TEXT))
  check('M7a 分屏后菜单出现「关闭此分屏」', mt.includes('关闭此分屏'), mt.slice(0, 160))
  const closePane = await clickItem(p, '关闭此分屏')
  await sleep(2000)
  const afterClose = await p.evaluate(PANE_PROBE)
  check('M7b 真实点击「关闭此分屏」→ 回到 1 格', closePane === 'ok' && afterClose && afterClose.count === 1, { click: closePane, panes: afterClose })
  const tabCount3 = await p.evaluate(TAB_COUNT)
  check('M7c 标签仍在（关的是分屏不是整个终端）', tabCount3 === 1, tabCount3)

  /* ---------------- M8 关闭其他标签 ---------------- */
  /* 先开第二个标签：菜单「新建终端（复用此连接）」 */
  await openTabMenu(p, 0)
  const newTab = await clickItem(p, '新建终端（复用此连接）')
  await sleep(2500)
  const tabCount4 = await p.evaluate(TAB_COUNT)
  check('M8a 真实点击「新建终端（复用此连接）」→ 多出一个标签', newTab === 'ok' && tabCount4 === 2, { click: newTab, tabs: tabCount4 })

  await openTabMenu(p, 0)
  const closeOthers = await clickItem(p, '关闭其他标签')
  await sleep(2500)
  const tabCount5 = await p.evaluate(TAB_COUNT)
  check('M8b 真实点击「关闭其他标签」→ 只剩 1 个标签', closeOthers === 'ok' && tabCount5 === 1, { click: closeOthers, tabs: tabCount5 })

  /* ---------------- 收尾 ---------------- */
  const errs = (p.errs || []).filter((e) => !/ResizeObserver|DevTools|Autofill/.test(e))
  if (errs.length) {
    console.log('  渲染层异常：')
    for (const e of errs.slice(0, 6)) console.log('    ! ' + e)
  }
  check('无渲染层未捕获异常', errs.length === 0, errs.slice(0, 3))

  console.log('')
  console.log('=== 标签栏右键菜单真机点击验证：' + pass + ' 通过 / ' + fail + ' 失败 ===')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL ' + (e && e.stack ? e.stack : e))
  cleanup()
  process.exit(1)
})
