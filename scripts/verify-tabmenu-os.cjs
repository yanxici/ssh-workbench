/**
 * 标签栏右键菜单的 **操作系统级** 真机点击回归（v2.1.8）。
 *
 * 为什么不能只用 CDP Input.dispatchMouseEvent：
 * 实测过 —— 把修复 stash 掉重跑，CDP 注入的鼠标事件仍然点得动菜单（M4 依然绿）。
 * 原因是 -webkit-app-region: drag 的判定发生在 **浏览器进程 / OS 窗口层**（OLE 拖窗），
 * 而 CDP 注入绕过浏览器进程，直接落进渲染进程的输入管线。所以「鼠标点下去没反应」
 * 这个 bug 本身，只有真正的 OS 鼠标消息能复现。
 *
 * 本脚本因此分成两层：
 *   - 测量与断言：CDP（拿元素矩形、读 DOM/状态）
 *   - 点击：user32 SetCursorPos + mouse_event（真·系统鼠标消息，和用户手动点同一条路径）
 *
 * 断言判据（每条都在修复未落地时会红 —— 已用 git stash 实测确认）：
 *   O1 真实右键标签能弹出菜单
 *   O2 菜单不在 .drag-region 子树里 / 是 body 直接子元素
 *   O3 真实左键点「重命名」→ 标签内出现输入框          ← stash 掉修复时红（核心）
 *   O4 真实左键点「本连接不弹通知」→ 文案切到「恢复」   ← stash 掉修复时红
 *   O5 真实左键点「向右分屏」→ 可见分屏格 2            ← stash 掉修复时红
 *   O6 真实左键点「关闭此分屏」→ 回到 1 格、标签仍在
 *   O7 真实左键点「新建终端」→ 多一个标签
 *   O8 真实左键点「关闭其他标签」→ 只剩 1 个标签        ← stash 掉修复时红
 *
 * 用法：node scripts/verify-tabmenu-os.cjs
 *      TM_APP=<打包 exe> node scripts/verify-tabmenu-os.cjs
 */
const { spawn, execFileSync } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
const PWSH = process.env.PWSH || 'C:\\Users\\Administrator\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'
const HELPER = path.join(ROOT, 'scripts', '_osclick.ps1')
function pickPort(min, max) { return min + Math.floor(Math.random() * (max - min)) }
const APP_PORT = Number(process.env.TM_CDP_PORT || pickPort(21000, 28000))
const LAB_PORT = Number(process.env.TM_LAB_PORT || pickPort(28000, 33000))
const USERDATA = path.join(os.tmpdir(), 'sw-tabmenu-os')
const LAB_ROOT = path.join(os.tmpdir(), 'sw-tabmenu-oslab')

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

/* ---------- OS 鼠标助手 ---------- */
function osci(args) {
  const out = execFileSync(PWSH, ['-NoProfile', '-File', HELPER].concat(args), { encoding: 'utf8' })
  return String(out).trim()
}
/*
 * 每次真实点击前都让被测窗口重新置顶（-Hwnd）。只 pin 一次是不够的：
 * 桌面上任何后来的窗口都会把这批 user32 点击吃掉，而 CDP 侧看起来一切正常 ——
 * 表现为「菜单弹不出来 / 点了没反应」，和产品 bug 一模一样。
 */
let APP_HWND = 0
function osClick(x, y, button) {
  const a = ['-Action', 'click', '-X', String(Math.round(x)), '-Y', String(Math.round(y)), '-Button', button || 'left']
  if (APP_HWND) a.push('-Hwnd', String(APP_HWND))
  return osci(a)
}

/** 轮询等待条件成立（比固定 sleep 稳，也不会掩盖真正的慢） */
async function waitFor(fn, ms, step) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - t0 > (ms || 6000)) return v
    await sleep(step || 200)
  }
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
    pend.set(id, { resolve, reject })
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

/* ---------- 坐标换算：CSS px -> 屏幕物理 px ---------- */
/*
 * 这里**不能**用 devicePixelRatio 当换算系数。
 * 实测（2560x1600 @175% 缩放，DPR=1.75）：本应用的窗口客户区物理宽 1278px，
 * 而 window.innerWidth=1279 CSS px —— 也就是 1 CSS px == 1 物理 px，
 * 有效缩放是 1.0 而不是 1.75。按 1.75 换算会把点击投到目标元素的 1.75 倍远处，
 * 导致右键点空白、菜单根本弹不出来（曾因此产出 11 条假红）。
 * 正确做法：用 user32 的客户区物理尺寸 / innerWidth|innerHeight **实测**出缩放。
 */
let ORIGIN = { x: 0, y: 0 }
let SCALE_X = 1
let SCALE_Y = 1
function toScreen(pt) { return { x: ORIGIN.x + pt.x * SCALE_X, y: ORIGIN.y + pt.y * SCALE_Y } }

const TAB_RECT = (i) => '(() => {' +
  ' const t = [...document.querySelectorAll("[data-tab-id]")][' + i + '];' +
  ' if (!t) return null;' +
  ' const r = t.getBoundingClientRect();' +
  ' return { x: r.left + r.width / 2, y: r.top + r.height / 2 }' +
'})()'

const ITEM_RECT = (label) => '(() => {' +
  ' const m = document.querySelector(".menu");' +
  ' if (!m) return null;' +
  ' const b = [...m.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === ' + JSON.stringify(label) + ');' +
  ' if (!b) return { missing: true };' +
  ' if (b.disabled) return { disabled: true };' +
  ' const r = b.getBoundingClientRect();' +
  ' return { x: r.left + r.width / 2, y: r.top + r.height / 2 }' +
'})()'

const MENU_TEXT = '(() => { const m = document.querySelector(".menu"); return m ? m.innerText : null })()'
const MENU_OWNER = '(() => {' +
  ' const m = document.querySelector(".menu");' +
  ' if (!m) return { menu: false };' +
  ' return { menu: true, inDragRegion: !!m.closest(".drag-region"), isBodyChild: m.parentElement === document.body,' +
  '   appRegion: (getComputedStyle(m).getPropertyValue("-webkit-app-region") || "").trim() }' +
'})()'
const PANE_PROBE = '(() => {' +
  ' const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 10 && r.height > 10 };' +
  ' return { count: [...document.querySelectorAll("[data-pane-id]")].filter(vis).length }' +
'})()'
const TAB_COUNT = '(() => document.querySelectorAll("[data-tab-id]").length)()'

async function osMenuClick(p, label) {
  const r = await p.evaluate(ITEM_RECT(label))
  if (!r) return 'no-menu'
  if (r.missing) return 'no-item'
  if (r.disabled) return 'disabled'
  /*
   * 点击投递探针：区分「点击没落到按钮上」和「落上了但业务没生效」。
   * 这两类失败的处理方式完全不同 —— 前者是测试/环境问题（窗口被挡、焦点丢了），
   * 后者才是产品 bug。没有这个探针时，两者都只表现为「点了没反应」。
   */
  if (process.env.TM_DBG) {
    await p.evaluate('(() => { window.__clickLog = [];' +
      ' if (!window.__clickInstalled) { window.__clickInstalled = 1;' +
        ' document.addEventListener("mousedown", (e) => {' +
          ' const t = e.target;' +
          ' window.__clickLog.push({ k: "down", cx: e.clientX, cy: e.clientY,' +
            ' tag: t && t.tagName, txt: t && (t.innerText || "").slice(0, 12),' +
            ' menu: !!(t && t.closest && t.closest(".menu")) }) }, true);' +
        ' document.addEventListener("click", (e) => {' +
          ' const t = e.target;' +
          ' window.__clickLog.push({ k: "click", tag: t && t.tagName,' +
            ' txt: t && (t.innerText || "").slice(0, 12),' +
            ' menu: !!(t && t.closest && t.closest(".menu")) }) }, true) }' +
      ' return 1 })()')
  }
  const s = toScreen(r)
  osClick(s.x, s.y, 'left')
  await sleep(400)
  if (process.env.TM_DBG) {
    const log = await p.evaluate('(() => ({ log: window.__clickLog || [],' +
      ' menuOpen: !!document.querySelector(".menu") }))()')
    console.log('  [click:' + label + '] ' + JSON.stringify(log))
  }
  return 'ok'
}

/*
 * 右键开菜单：失败重试 3 次。
 * 单次右键偶发落空（窗口刚动过 / 上一帧焦点还在切换）时，若直接判红，
 * 后续依赖菜单的用例会连环红 —— 一整轮 11 条失败里有 6 条是这么来的。
 * 重试是安全的：菜单是幂等的，重复右键只会重开同一个菜单。
 */
async function osOpenTabMenu(p, idx) {
  let owner = { menu: false }
  let s = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await p.evaluate(TAB_RECT(idx || 0))
    if (!r) return { ok: false, why: 'no-tab' }
    s = toScreen(r)
    osClick(s.x, s.y, 'right')
    owner = await waitFor(async () => {
      const o = await p.evaluate(MENU_OWNER)
      return o && o.menu ? o : 0
    }, 1500, 150) || await p.evaluate(MENU_OWNER)
    if (owner && owner.menu) break
    if (attempt < 2) console.log('  菜单未弹出，重试右键（第 ' + (attempt + 2) + ' 次）')
  }
  return { ok: !!(owner && owner.menu), owner, screen: s, attempts: 0 }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('本脚本只在 Windows 上跑')
  fs.rmSync(USERDATA, { recursive: true, force: true })
  fs.mkdirSync(USERDATA, { recursive: true })
  fs.rmSync(LAB_ROOT, { recursive: true, force: true })
  fs.mkdirSync(LAB_ROOT, { recursive: true })

  const savedCursor = osci(['-Action', 'save'])

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
  const exe = packaged || path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
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

  /* ---------- 窗口几何 ---------- */
  /*
 * 主窗口句柄所属进程：默认就是自己 spawn 的那个进程。
 * TM_PID 只在特殊场景（已有实例在跑、脚本只连 CDP 不 spawn）才需要显式指定；
 * 之前写成 packaged ? TM_PID : app.pid，打包模式下忘传 TM_PID 就拿到 pid=0 →
 * hwnd=0 → 几何全 0 → 所有点击投到 (0,0)，12 条断言整片假红，报的却是"菜单弹不出来"。
 */
const mainPid = Number(process.env.TM_PID || 0) || app.pid
  const hwndOut = execFileSync(PWSH, ['-NoProfile', '-Command',
    '$p = Get-Process -Id ' + mainPid + ' -ErrorAction SilentlyContinue; if ($p) { $p.MainWindowHandle } else { 0 }'
  ], { encoding: 'utf8' }).trim()
  const hwnd = String(hwndOut).split(/\r?\n/).pop()
  check('取到应用主窗口句柄', hwnd && hwnd !== '0', { pid: mainPid, hwnd })
  /*
   * 必须钉 TOPMOST。桌面上任何别的 TOPMOST 窗口（上一轮手动测试留下的 dev 实例、
   * 之前脚本 pin 过却没 unpin 的窗口）都会把这些**真实**鼠标点击全部吃掉 ——
   * CDP 注入点得动，user32 点击却点到别人身上，于是一整轮 11 条假红，
   * 报的还都是"菜单弹不出来"，看起来像修复失效。这是本项目第二次踩这个坑。
   */
  osci(['-Action', 'pin', '-X', hwnd])
  APP_HWND = Number(hwnd)
  await sleep(700)
  /*
   * 客户区原点用 user32 的 ClientToScreen 取（物理像素），不用 window.screenX ——
   * 后者是窗口外框位置，还带着标题栏与边框偏移，换算容易差十几像素。
   */
  const geoRaw = osci(['-Action', 'geometry', '-X', hwnd])
  const mGeo = /clientOrigin=(-?\d+),(-?\d+) clientSize=(\d+)x(\d+)/.exec(geoRaw)
  if (!mGeo) throw new Error('取窗口客户区几何失败：' + geoRaw)
  ORIGIN = { x: Number(mGeo[1]), y: Number(mGeo[2]) }
  const clientSize = { w: Number(mGeo[3]), h: Number(mGeo[4]) }
  const geom = await p.evaluate('(() => ({ dpr: window.devicePixelRatio, innerW: window.innerWidth, innerH: window.innerHeight }))()')
  /* 有效缩放 = 客户区物理尺寸 / CSS 尺寸（不用 devicePixelRatio，理由见 toScreen 上方注释） */
  SCALE_X = clientSize.w / geom.innerW
  SCALE_Y = clientSize.h / geom.innerH
  console.log('  几何: 有效缩放=' + SCALE_X.toFixed(4) + 'x' + SCALE_Y.toFixed(4) +
    ' (devicePixelRatio=' + geom.dpr + ') clientOrigin=' + JSON.stringify(ORIGIN) +
    ' clientSize=' + clientSize.w + 'x' + clientSize.h + ' cssInner=' + geom.innerW + 'x' + geom.innerH)

  /*
   * 换算闭环自检：CSS -> 屏幕点击 -> 页内 clientX 往返一致。
   * 先用「客户区物理尺寸 / innerWidth」估出缩放，再用一次真实点击**实测残差**去修正 ORIGIN，
   * 迭代到 <=2px。只做单次静态比较是不稳的：窗口在 pin 之后还可能被系统微移 1~3px，
   * 那一轮就会红，而换算本身完全正确（曾因此报「几何换算自检」假红）。
   */
  await p.evaluate('(() => { window.__probeClick = null;' +
    ' if (!window.__probeInstalled) { window.__probeInstalled = 1;' +
    '   document.addEventListener("mousedown", (e) => { window.__probeClick = { cx: e.clientX, cy: e.clientY } }, true) }' +
    ' return 1 })()')
  const probeCss = { x: Math.round(geom.innerW * 0.5), y: Math.round(geom.innerH * 0.6) }
  let back = null
  let probeScreen = null
  for (let iter = 0; iter < 4; iter++) {
    probeScreen = toScreen(probeCss)
    osClick(probeScreen.x, probeScreen.y, 'left')
    await sleep(300)
    back = await p.evaluate('window.__probeClick')
    if (!back) continue
    const dx = probeCss.x - back.cx
    const dy = probeCss.y - back.cy
    if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1) break
    /* 用实测残差修正原点（缩放已在同一坐标系内，残差直接加在 ORIGIN 上） */
    ORIGIN = { x: ORIGIN.x + dx * SCALE_X, y: ORIGIN.y + dy * SCALE_Y }
    if (iter === 0) console.log('  几何: 首测残差=' + dx + ',' + dy + ' → 原点修正为 ' + JSON.stringify(ORIGIN))
  }
  const roundOk = !!back && Math.abs(back.cx - probeCss.x) <= 2 && Math.abs(back.cy - probeCss.y) <= 2
  check('窗口几何换算自检（CSS 坐标 -> 屏幕点击 -> 页内 clientX 往返一致，闭环迭代收敛）', roundOk,
    { css: probeCss, screen: probeScreen && { x: Math.round(probeScreen.x), y: Math.round(probeScreen.y) }, back, origin: ORIGIN, scale: [SCALE_X, SCALE_Y] })

  /* ------------- 建连接 ------------- */
  const saved = await p.evaluate('(async () => {' +
    ' const r = await window.api.conn.save({ name: "tm-os", host: "127.0.0.1", port: ' + LAB_PORT + ', username: "lab", authType: "password", password: "labpass", group: "x", tags: [] });' +
    ' return r.ok ? (r.data && r.data.id) : false' +
  '})()')
  check('建立测试连接', typeof saved === 'string' && saved.length > 0, saved)
  await p.evaluate('(() => { location.reload(); return "reloading" })()')
  await sleep(2500)
  if (!(await waitReady(p))) throw new Error('reload 后应用未就绪')

  await p.evaluate('(() => {' +
    ' const r = document.querySelector("[data-conn-id]");' +
    ' if (!r) return "no-row";' +
    ' r.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); return "ok"' +
  '})()')
  let sessionId = null
  for (let i = 0; i < 60; i++) {
    sessionId = await p.evaluate('(async () => {' +
      ' const l = await window.api.session.list();' +
      ' const list = l && l.data ? l.data : [];' +
      ' const c = list.find((s) => s.status === "connected");' +
      ' return c ? c.id : null' +
    '})()')
    if (sessionId) break
    await sleep(400)
  }
  check('打开真实 SSH 会话', typeof sessionId === 'string' && sessionId.length > 0, sessionId)
  await sleep(800)

  /* ---------------- O1/O2 ---------------- */
  const opened = await osOpenTabMenu(p, 0)
  check('O1 OS 真实右键标签弹出菜单', opened.ok === true, opened)
  const owner = opened.owner || {}
  check('O2 菜单脱离 .drag-region 且是 body 直接子元素', owner.inDragRegion === false && owner.isBodyChild === true, owner)

  /* ---------------- O3 重命名 ---------------- */
  const rn = await osMenuClick(p, '重命名')
  await sleep(600)
  const editing = await p.evaluate('(() => {' +
    ' const t = document.querySelector("[data-tab-id]");' +
    ' const i = t && t.querySelector("input");' +
    ' return { hasInput: !!i, focused: !!(i && document.activeElement === i) }' +
  '})()')
  check('O3 OS 真实左键点「重命名」→ 标签内出现输入框', rn === 'ok' && editing && editing.hasInput === true, { click: rn, editing })
  await p.evaluate('(() => { const i = document.querySelector("[data-tab-id] input"); if (i) i.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return "ok" })()')
  await sleep(500)

  /* ---------------- O4 通知开关 ---------------- */
  await osOpenTabMenu(p, 0)
  const t1 = String(await p.evaluate(MENU_TEXT))
  check('O4a 菜单初始文案是「本连接不弹通知」', t1.includes('本连接不弹通知'), t1.slice(0, 120))
  const tog = await osMenuClick(p, '本连接不弹通知')
  await sleep(700)
  await osOpenTabMenu(p, 0)
  const t2 = String(await p.evaluate(MENU_TEXT))
  check('O4b OS 真实点击后文案切到「恢复本连接通知」', tog === 'ok' && t2.includes('恢复本连接通知'), { click: tog, menu: t2.slice(0, 160) })
  await osMenuClick(p, '恢复本连接通知')
  await sleep(600)

  /* ---------------- O5 向右分屏 ---------------- */
  await osOpenTabMenu(p, 0)
  const split = await osMenuClick(p, '向右分屏')
  const afterSplit = await waitFor(async () => {
    const v = await p.evaluate(PANE_PROBE)
    return v && v.count === 2 ? v : 0
  }, 9000, 250)
  check('O5 OS 真实点击「向右分屏」→ 可见分屏格变 2', split === 'ok' && afterSplit && afterSplit.count === 2, { click: split, panes: afterSplit })
  const tabCount2 = await p.evaluate(TAB_COUNT)
  check('O5b 分屏不新增标签', tabCount2 === 1, tabCount2)

  /* ---------------- O6 关闭此分屏 ---------------- */
  await osOpenTabMenu(p, 0)
  const mt = String(await p.evaluate(MENU_TEXT))
  check('O6a 分屏后菜单出现「关闭此分屏」', mt.includes('关闭此分屏'), mt.slice(0, 160))
  const closePane = await osMenuClick(p, '关闭此分屏')
  const afterClose = await waitFor(async () => {
    const v = await p.evaluate(PANE_PROBE)
    return v && v.count === 1 ? v : 0
  }, 9000, 250)
  check('O6b OS 真实点击「关闭此分屏」→ 回到 1 格', closePane === 'ok' && afterClose && afterClose.count === 1, { click: closePane, panes: afterClose })
  const tabCount3 = await p.evaluate(TAB_COUNT)
  check('O6c 标签仍在', tabCount3 === 1, tabCount3)

  /* ---------------- O7/O8 多标签 ---------------- */
  if (process.env.TM_DBG) {
    /* 探针：记录 openShell 的调用，用来区分「点击没到」和「到了但 UI 没加标签」 */
    await p.evaluate('(() => { window.__openShellCalls = [];' +
      ' if (!window.__openShellPatched) { window.__openShellPatched = 1;' +
        ' const orig = window.api.session.openShell;' +
        ' window.api.session.openShell = (a) => { window.__openShellCalls.push(a); return orig(a) } }' +
      ' return 1 })()')
  }
  await osOpenTabMenu(p, 0)
  const newTab = await osMenuClick(p, '新建终端（复用此连接）')
  const tabCount4 = await waitFor(async () => {
    const n = await p.evaluate(TAB_COUNT)
    return n === 2 ? n : 0
  }, 9000, 250)
  if (process.env.TM_DBG) {
    const dbg = await p.evaluate('(() => ({ calls: window.__openShellCalls || [],' +
      ' tabIds: [...document.querySelectorAll("[data-tab-id]")].map(e => e.dataset.tabId),' +
      ' panes: [...document.querySelectorAll("[data-pane-id]")].map(e => e.dataset.paneId) }))()')
    console.log('  [dbg] ' + JSON.stringify(dbg))
  }
  check('O7 OS 真实点击「新建终端（复用此连接）」→ 多出一个标签', newTab === 'ok' && tabCount4 === 2, { click: newTab, tabs: tabCount4 })

  await osOpenTabMenu(p, 0)
  const closeOthers = await osMenuClick(p, '关闭其他标签')
  const tabCount5 = await waitFor(async () => {
    const n = await p.evaluate(TAB_COUNT)
    return n === 1 ? n : 0
  }, 9000, 250)
  check('O8 OS 真实点击「关闭其他标签」→ 只剩 1 个标签', closeOthers === 'ok' && tabCount5 === 1, { click: closeOthers, tabs: tabCount5 })

  /* ---------------- 收尾 ---------------- */
  const errs = (p.errs || []).filter((e) => !/ResizeObserver|DevTools|Autofill/.test(e))
  if (errs.length) {
    console.log('  渲染层异常：')
    for (const e of errs.slice(0, 6)) console.log('    ! ' + e)
  }
  check('无渲染层未捕获异常', errs.length === 0, errs.slice(0, 3))

  /* 还原用户鼠标位置 */
  const m = /cursor=(-?\d+),(-?\d+)/.exec(savedCursor)
  if (m) osci(['-Action', 'restore', '-X', m[1], '-Y', m[2]])

  console.log('')
  console.log('=== 标签栏右键菜单 OS 级真机点击验证：' + pass + ' 通过 / ' + fail + ' 失败 ===')
  osci(['-Action', 'unpin', '-X', hwnd])
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL ' + (e && e.stack ? e.stack : e))
  cleanup()
  process.exit(1)
})
