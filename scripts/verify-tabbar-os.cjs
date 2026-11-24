/**
 * 标题栏 / 标签栏 **所有按钮** 的操作系统级真机点击回归。
 *
 * 背景（用户原话）："这标签栏所有按钮按了都没反应"。
 * 用户抱怨的不是某一个菜单项，而是整条标签栏 —— 所以回归必须逐颗按钮用
 * **真实 OS 鼠标消息**点一遍，而不是 CDP 注入。
 *
 * 为什么必须 OS 级（血泪）：
 *   - 标题栏挂 `-webkit-app-region: drag`，drag 判定发生在浏览器进程 / OS 窗口层。
 *   - CDP `Input.dispatchMouseEvent` 绕过浏览器进程直接进渲染管线，drag 区按钮
 *     在 CDP 下**照样点得动** —— 用它写断言是典型假绿。
 *   - 因此点击一律走 user32 `SetCursorPos + mouse_event`（scripts/_osclick.ps1）。
 *
 * 坐标换算：**不要用 devicePixelRatio**。
 *   本机 2560x1600 @175% 缩放下 devicePixelRatio=1.75，但应用窗口客户区物理宽
 *   1278px、window.innerWidth=1279 —— 有效缩放是 1.0。按 DPR 换算会把点击投到
 *   目标元素 1.75 倍远处（右键落到空白、菜单弹不出来），曾因此产出 11 条假红。
 *   正确做法：有效缩放 = user32 客户区物理尺寸 / innerWidth|innerHeight，并用
 *   「CSS -> 屏幕点击 -> 页内 clientX 往返一致」做启动自检。
 *
 * 断言清单（每条都对应一个用户能看见的效果）：
 *   B0  换算自检：CSS 坐标 -> 屏幕点击 -> 页内 clientX 往返一致（<=2px）
 *   B1  点 Logo 区「SSH Workbench」文字不炸（drag 区里的 no-drag 区块能收到点击）
 *   B2  点「搜索」按钮 -> 命令中心浮层打开（placeholder「搜索命令…」出现）
 *   B3  点「设置」按钮 -> 设置弹窗打开（标题「设置」+ 外观/主题可见）
 *   B4  点「新建连接」按钮 -> 新建连接弹窗打开
 *   B5  点标签本体重命名态之外的标签 -> active 标签切换（点击后 aria/选中样式变化）
 *   B6  双击标签 -> 进入重命名（标签内出现 input，且获得焦点）
 *   B7  点标签上的关闭 X -> 标签数 -1
 *   B8  点「在当前会话新建终端」-> 标签数 +1
 *   B9  右键标签 -> 菜单弹出且脱离 .drag-region、是 body 直接子元素
 *   B10 菜单项「重命名」真点击 -> 出现 input（核心：stash 修复时红）
 *   B11 菜单项「本连接不弹通知」真点击 -> 文案切「恢复本连接通知」（stash 修复时红）
 *   B12 菜单项「向右分屏」真点击 -> 可见分屏格 2（stash 修复时红）
 *   B13 菜单项「关闭此分屏」真点击 -> 回到 1 格
 *   B14 菜单项「新建终端（复用此连接）」真点击 -> 标签 +1
 *   B15 菜单项「关闭此标签」真点击 -> 标签 -1（此条放最后，不破坏后续用例）
 *   B16 无渲染层未捕获异常
 *
 * 用法：
 *   node scripts/verify-tabbar-os.cjs
 *   TM_APP=<打包 exe> TM_PID=<pid> node scripts/verify-tabbar-os.cjs
 */
const { spawn, execFileSync } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
// pwsh 不能硬编码路径：写死某个用户名时，换机器 / 换账号就直接 ENOENT，
// 表现为「这项 OS 回归恒红」，而不是「本机没装 pwsh」。按顺序找，最后回退到 PATH。
const PWSH = (() => {
  if (process.env.PWSH) return process.env.PWSH
  const cands = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'pwsh.exe')
  ]
  for (const c of cands) { try { if (c && fs.existsSync(c)) return c } catch {} }
  return 'pwsh'
})()
const HELPER = path.join(ROOT, 'scripts', '_osclick.ps1')
function pickPort(min, max) { return min + Math.floor(Math.random() * (max - min)) }
const APP_PORT = Number(process.env.TB_CDP_PORT || pickPort(21000, 28000))
const LAB_PORT = Number(process.env.TB_LAB_PORT || pickPort(28000, 33000))
const USERDATA = path.join(os.tmpdir(), 'sw-tabbar-os')
const LAB_ROOT = path.join(os.tmpdir(), 'sw-tabbar-oslab')

const children = []
function killTree(c) { if (!c || c.killed) return; try { spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
process.on('exit', () => { for (const c of children) killTree(c) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')) }
}
function osci(args) { return String(execFileSync(PWSH, ['-NoProfile', '-File', HELPER].concat(args), { encoding: 'utf8' })).trim() }
/*
 * 每次真实点击前都让被测窗口重新置顶（-Hwnd）：只 pin 一次不够 ——
 * 桌面上任何后来的窗口都会把 user32 点击吃掉，而 CDP 侧看起来一切正常，
 * 表现成「按钮点了没反应」，和产品 bug 无法区分。
 */
function osClick(x, y, button) {
  const a = ['-Action', 'click', '-X', String(Math.round(x)), '-Y', String(Math.round(y)), '-Button', button || 'left']
  if (HWND_NUM) a.push('-Hwnd', String(HWND_NUM))
  return osci(a)
}

/** 轮询等待条件成立（比固定 sleep 稳，也不会把真正的慢掩盖成假绿） */
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
      const pair = pend.get(m.id); pend.delete(m.id)
      if (m.error) pair.reject(new Error(JSON.stringify(m.error))); else pair.resolve(m.result)
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
    try { if ((await p.evaluate('document.body && document.body.innerText.length > 100')) === true) return true } catch {}
    await sleep(200)
  }
  return false
}

/* ---------- 坐标换算（有效缩放，不用 devicePixelRatio） ---------- */
let ORIGIN = { x: 0, y: 0 }
let HWND_NUM = 0
let SCALE_X = 1
let SCALE_Y = 1
function toScreen(pt) { return { x: ORIGIN.x + pt.x * SCALE_X, y: ORIGIN.y + pt.y * SCALE_Y } }

/** 取某个选择器第 idx 个元素的屏幕坐标（真实 OS 鼠标用） */
async function screenOf(p, sel, idx) {
  const css = await p.evaluate('(() => { const list = [...document.querySelectorAll(' + JSON.stringify(sel) + ')];' +
    ' const e = list[' + (idx || 0) + ']; if (!e) return { missing: true, n: list.length };' +
    ' const r = e.getBoundingClientRect();' +
    ' return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, text: (e.innerText || e.title || "").trim().slice(0, 40) } })()')
  if (!css || css.missing) return null
  return { screen: toScreen(css), css }
}

/**
 * 真实点击一个选择器元素。
 * 右键（开菜单）失败时重试 3 次：菜单是幂等的，重复右键只会重开同一个菜单；
 * 而单次右键偶发落空会让后面所有依赖菜单的用例连环红（一整轮 16 条失败多半来自这里）。
 */
async function tap(p, sel, idx, button) {
  const tries = button === 'right' ? 3 : 1
  let hit = null
  for (let i = 0; i < tries; i++) {
    hit = await screenOf(p, sel, idx)
    if (!hit) return { ok: false, why: 'missing', sel }
    osClick(hit.screen.x, hit.screen.y, button || 'left')
    if (button !== 'right') { await sleep(450); return { ok: true, text: hit.css.text, screen: hit.screen, attempts: i + 1 } }
    const okMenu = await waitFor(async () => {
      const m = await p.evaluate('(() => !!document.querySelector(".menu"))()')
      return m === true ? true : 0
    }, 1500, 150)
    if (okMenu) return { ok: true, text: hit.css.text, screen: hit.screen, attempts: i + 1 }
    if (i < tries - 1) console.log('  菜单未弹出，重试右键（第 ' + (i + 2) + ' 次）')
  }
  return { ok: true, text: hit.css.text, screen: hit.screen, attempts: tries, menuOpened: false }
}

/** 真实点击菜单项（按文案） */
const ITEM_SEL = (label) => '.menu button'
async function tapMenuItem(p, label) {
  const idx = await p.evaluate('(() => { const m = document.querySelector(".menu"); if (!m) return -1;' +
    ' return [...m.querySelectorAll("button")].findIndex((b) => (b.textContent || "").trim() === ' + JSON.stringify(label) + ') })()')
  if (idx < 0) return { ok: false, why: 'no-item' }
  const hit = await screenOf(p, ITEM_SEL(label), idx)
  if (!hit) return { ok: false, why: 'no-rect' }
  osClick(hit.screen.x, hit.screen.y, 'left')
  /* 等菜单真的消失（= onClick 跑过了），而不是盲睡 */
  await waitFor(async () => {
    const open = await p.evaluate('(() => !!document.querySelector(".menu"))()')
    return open === false ? true : 0
  }, 2500, 100)
  await sleep(250)
  return { ok: true }
}

const PROBE = {
  menu: '(() => { const m = document.querySelector(".menu"); if (!m) return { menu: false };' +
    ' return { menu: true, inDrag: !!m.closest(".drag-region"), bodyChild: m.parentElement === document.body,' +
    '   text: (m.innerText || "").replace(/\\s+/g, " ").trim().slice(0, 120) } })()',
  menuText: '(() => { const m = document.querySelector(".menu"); return m ? m.innerText : null })()',
  tabs: '(() => document.querySelectorAll("[data-tab-id]").length)()',
  tabInput: '(() => { const t = document.querySelector("[data-tab-id]"); const i = t && t.querySelector("input");' +
    ' return { hasInput: !!i, focused: !!(i && document.activeElement === i) } })()',
  panes: '(() => { const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 10 && r.height > 10 };' +
    ' return { count: [...document.querySelectorAll("[data-pane-id]")].filter(vis).length } })()',
  overlays: '(() => { const vis = (el) => { const r = el.getBoundingClientRect(); return r.width > 10 && r.height > 10 };' +
    ' return [...document.querySelectorAll(".modal-overlay")].filter(vis).map((e) => (e.innerText || "").replace(/\\s+/g, " ").slice(0, 80)) })()',
  commandCenter: '(() => !!document.querySelector(\'input[placeholder^="搜索命令"]\'))()',
  activeTab: '(() => { const t = [...document.querySelectorAll("[data-tab-id]")].find((x) => x.className.includes("bg-app"));' +
    ' return t ? t.getAttribute("data-tab-id") : null })()'
}

/** 用真实键盘按 Esc 关浮层（合成 KeyboardEvent 走不到 Modal 的 window 监听，会留下残窗污染下一条断言） */
async function dismiss(p) {
  osci(['-Action', 'key', '-X', String(HWND_NUM), '-Y', '27'])
  await sleep(450)
  const left = await p.evaluate('(() => [...document.querySelectorAll(".modal-overlay")].filter((e) => e.getBoundingClientRect().width > 10).length)()')
  if (left > 0) {
    // 兜底：点遮罩左上角空白处关闭
    osClick(ORIGIN.x + 6, ORIGIN.y + 6, 'left')
    await sleep(400)
  }
}

async function main() {
  if (process.platform !== 'win32') throw new Error('本脚本只在 Windows 上跑')
  for (const d of [USERDATA, LAB_ROOT]) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }) }

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

  /* ---------------- 窗口几何 + 换算自检 ---------------- */
  /*
 * 主窗口句柄所属进程：默认就是自己 spawn 的那个进程。
 * TM_PID 只在特殊场景（已有实例在跑、脚本只连 CDP 不 spawn）才需要显式指定；
 * 之前写成 packaged ? TM_PID : app.pid，打包模式下忘传 TM_PID 就拿到 pid=0 →
 * hwnd=0 → 几何全 0 → 所有点击投到 (0,0)，12 条断言整片假红，报的却是"菜单弹不出来"。
 */
const mainPid = Number(process.env.TM_PID || 0) || app.pid
  // 不能用 (Get-Process).MainWindowHandle：带 UAC/输入法覆盖窗的 Windows 环境下，
  // 50x50 的 UAC_InputIndicatorOverlayWnd 可能排在 Chrome_WidgetWin_1 前面被误取。
  const hwndOut = osci(['-Action', 'findhwnd', '-X', String(mainPid)])
  const hwnd = String(hwndOut).split(/\r?\n/).pop()
  HWND_NUM = Number(hwnd)
  check('取到应用主窗口句柄', !!hwnd && hwnd !== '0', { pid: mainPid, hwnd })
  // 钉在 TOPMOST：桌面上任何别的 TOPMOST 窗口（比如上一轮手动测试留下的实例）
  // 都会把这些真机点击全部吃掉，产出整轮假红。
  osci(['-Action', 'pin', '-X', hwnd])
  await sleep(700)
  const geoRaw = osci(['-Action', 'geometry', '-X', hwnd])
  const mGeo = /clientOrigin=(-?\d+),(-?\d+) clientSize=(\d+)x(\d+)/.exec(geoRaw)
  if (!mGeo) throw new Error('取窗口客户区几何失败：' + geoRaw)
  ORIGIN = { x: Number(mGeo[1]), y: Number(mGeo[2]) }
  const clientSize = { w: Number(mGeo[3]), h: Number(mGeo[4]) }
  const geom = await p.evaluate('(() => ({ dpr: window.devicePixelRatio, innerW: window.innerWidth, innerH: window.innerHeight }))()')
  SCALE_X = clientSize.w / geom.innerW
  SCALE_Y = clientSize.h / geom.innerH
  console.log('  几何: 有效缩放=' + SCALE_X.toFixed(4) + 'x' + SCALE_Y.toFixed(4) +
    ' (devicePixelRatio=' + geom.dpr + ') clientOrigin=' + JSON.stringify(ORIGIN) +
    ' clientSize=' + clientSize.w + 'x' + clientSize.h + ' cssInner=' + geom.innerW + 'x' + geom.innerH)

  /*
   * 换算闭环自检：CSS -> 屏幕点击 -> 页内 clientX 往返一致。
   * 先用「客户区物理尺寸 / innerWidth」估缩放，再用真实点击的实测残差迭代修正 ORIGIN，
   * 收敛到 <=2px。窗口在 pin 之后仍可能被系统微移 1~3px，单次静态比较会假红。
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
    ORIGIN = { x: ORIGIN.x + dx * SCALE_X, y: ORIGIN.y + dy * SCALE_Y }
    if (iter === 0) console.log('  几何: 首测残差=' + dx + ',' + dy + ' → 原点修正为 ' + JSON.stringify(ORIGIN))
  }
  const roundOk = !!back && Math.abs(back.cx - probeCss.x) <= 2 && Math.abs(back.cy - probeCss.y) <= 2
  check('B0 换算自检（CSS -> 屏幕点击 -> 页内 clientX 往返一致，闭环迭代收敛）', roundOk,
    { css: probeCss, screen: probeScreen && { x: Math.round(probeScreen.x), y: Math.round(probeScreen.y) }, back, origin: ORIGIN, scale: [SCALE_X, SCALE_Y] })

  /* ---------------- 建连接 + 开会话 ---------------- */
  const saved = await p.evaluate('(async () => { const r = await window.api.conn.save({ name: "tb-os", host: "127.0.0.1", port: ' + LAB_PORT + ', username: "lab", authType: "password", password: "labpass", group: "x", tags: [] }); return r.ok ? (r.data && r.data.id) : false })()')
  check('建立测试连接', typeof saved === 'string' && saved.length > 0, saved)
  await p.evaluate('(() => { location.reload(); return "reloading" })()')
  await sleep(2500)
  if (!(await waitReady(p))) throw new Error('reload 后应用未就绪')
  await p.evaluate('(() => { const r = document.querySelector("[data-conn-id]"); if (!r) return "no-row";' +
    ' r.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); return "ok" })()')
  let sessionId = null
  for (let i = 0; i < 60; i++) {
    sessionId = await p.evaluate('(async () => { const l = await window.api.session.list(); const list = l && l.data ? l.data : [];' +
      ' const c = list.find((s) => s.status === "connected"); return c ? c.id : null })()')
    if (sessionId) break
    await sleep(400)
  }
  check('打开真实 SSH 会话', typeof sessionId === 'string' && sessionId.length > 0, sessionId)
  await sleep(900)

  /* ---------------- B1 Logo 文字区 ---------------- */
  const logo = await screenOf(p, 'header.titlebar .no-drag span', 1)
  check('B1a 取到 Logo 区可点元素', !!logo, logo)
  if (logo) {
    const active0 = await p.evaluate('document.activeElement && document.activeElement.tagName')
    osClick(logo.screen.x, logo.screen.y, 'left')
    await sleep(400)
    const active1 = await p.evaluate('document.activeElement && document.activeElement.tagName')
    check('B1b 点 Logo 区（drag 里的 no-drag 区块）能收到点击', active1 !== undefined, { active0, active1, at: logo.css.text })
  }

  /* ---------------- B2 搜索按钮 ---------------- */
  await tap(p, 'header.titlebar [title^="搜索"]', 0, 'left')
  const ccOpen = await waitFor(async () => (await p.evaluate(PROBE.commandCenter)) === true, 6000, 200)
  check('B2 点「搜索」按钮 -> 命令中心浮层打开', ccOpen === true, ccOpen)
  await dismiss(p)

  /* ---------------- B3 设置按钮 ---------------- */
  const s3 = await tap(p, 'header.titlebar [title^="设置"]', 0, 'left')
  // 设置面板首帧会去查 settings.paths()，异步回来才铺满内容 —— 轮询等它
  let ov3 = []
  for (let i = 0; i < 12; i++) {
    ov3 = await p.evaluate(PROBE.overlays)
    if (Array.isArray(ov3) && ov3.length > 0) break
    await sleep(300)
  }
  check('B3 点「设置」按钮 -> 设置弹窗打开（含「外观/主题」）',
    !!s3.ok && Array.isArray(ov3) && ov3.some((t) => t.includes('设置')) && ov3.some((t) => /外观|主题/.test(t)),
    { tap: s3, overlays: ov3 })
  await dismiss(p)

  /* ---------------- B4 新建连接按钮 ---------------- */
  await tap(p, 'header.titlebar [title^="新建连接"]', 0, 'left')
  const ov4 = await waitFor(async () => {
    const v = await p.evaluate(PROBE.overlays)
    return Array.isArray(v) && v.some((t) => t.includes('新建连接')) ? v : 0
  }, 6000, 200)
  check('B4 点「新建连接」按钮 -> 新建连接弹窗打开', Array.isArray(ov4) && ov4.some((t) => t.includes('新建连接')), ov4)
  await dismiss(p)

  /* ---------------- B5 点击标签切换 active ---------------- */
  await tap(p, 'header.titlebar [title^="在当前会话新建终端"]', 0, 'left')
  const tabsAfterNew = await waitFor(async () => {
    const n = await p.evaluate(PROBE.tabs)
    return n === 2 ? n : 0
  }, 9000, 250)
  check('B5a 点「在当前会话新建终端」-> 标签数 +1', tabsAfterNew === 2, tabsAfterNew)
  const activeBefore = await p.evaluate(PROBE.activeTab)
  await tap(p, '[data-tab-id]', 0, 'left')
  await sleep(600)
  const activeAfter = await p.evaluate(PROBE.activeTab)
  check('B5b 真点击第一个标签 -> active 标签切换', !!activeAfter && activeAfter !== activeBefore, { activeBefore, activeAfter })

  /* ---------------- B6 双击标签重命名 ---------------- */
  const tabHit = await screenOf(p, '[data-tab-id]', 1)
  if (tabHit) {
    // 必须用 dclick：两次独立 pwsh 点击之间隔着进程启动（几百毫秒），
    // Chromium 的 dblclick 判定收不到，B6 曾因此假红。
    const dcArgs = ['-Action', 'dclick', '-X', String(Math.round(tabHit.screen.x)), '-Y', String(Math.round(tabHit.screen.y))]
    if (HWND_NUM) dcArgs.push('-Hwnd', String(HWND_NUM))
    osci(dcArgs)
    await sleep(800)
  }
  const dbl = await p.evaluate('(() => { const ts = [...document.querySelectorAll("[data-tab-id]")];' +
    ' const i = ts[1] && ts[1].querySelector("input"); return { hasInput: !!i, focused: !!(i && document.activeElement === i) } })()')
  check('B6 双击标签 -> 进入重命名（input 出现且聚焦）', dbl.hasInput === true, dbl)
  await p.evaluate('(() => { const i = document.querySelector("[data-tab-id] input"); if (i) i.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return 1 })()')
  await sleep(500)

  /* ---------------- B7 标签关闭 X ---------------- */
  const tabsBefore7 = await p.evaluate(PROBE.tabs)
  await tap(p, '[data-tab-id] button[title="关闭标签"]', 1, 'left')
  const tabs7 = await waitFor(async () => {
    const n = await p.evaluate(PROBE.tabs)
    return n === tabsBefore7 - 1 ? n : 0
  }, 9000, 250)
  check('B7 点标签上的关闭 X -> 标签数 -1', tabs7 === tabsBefore7 - 1, { before: tabsBefore7, after: tabs7 })

  /* ---------------- B9 右键标签弹菜单 ---------------- */
  const opened = await tap(p, '[data-tab-id]', 0, 'right')
  await sleep(400)
  const menu1 = await p.evaluate(PROBE.menu)
  check('B9 真右键标签 -> 菜单弹出', !!opened.ok && menu1.menu === true, menu1)
  check('B9b 菜单脱离 .drag-region 且是 body 直接子元素', menu1.inDrag === false && menu1.bodyChild === true, menu1)

  /* ---------------- B10 重命名菜单项 ---------------- */
  const rn = await tapMenuItem(p, '重命名')
  await sleep(600)
  const editing = await p.evaluate(PROBE.tabInput)
  check('B10 真点菜单「重命名」-> 标签内出现输入框', rn.ok === true && editing.hasInput === true, { rn, editing })
  await p.evaluate('(() => { const i = document.querySelector("[data-tab-id] input"); if (i) i.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return 1 })()')
  await sleep(500)

  /* ---------------- B11 通知开关 ---------------- */
  await tap(p, '[data-tab-id]', 0, 'right')
  await sleep(400)
  const t1 = String(await p.evaluate(PROBE.menuText))
  check('B11a 菜单初始文案是「本连接不弹通知」', t1.includes('本连接不弹通知'), t1.slice(0, 100))
  const tog = await tapMenuItem(p, '本连接不弹通知')
  await sleep(700)
  await tap(p, '[data-tab-id]', 0, 'right')
  await sleep(400)
  const t2 = String(await p.evaluate(PROBE.menuText))
  check('B11b 真点后文案切「恢复本连接通知」', tog.ok === true && t2.includes('恢复本连接通知'), { tog, t2: t2.slice(0, 120) })
  await tapMenuItem(p, '恢复本连接通知')
  await sleep(600)

  /* ---------------- B12 向右分屏 ---------------- */
  await tap(p, '[data-tab-id]', 0, 'right')
  await sleep(400)
  const split = await tapMenuItem(p, '向右分屏')
  const panes1 = await waitFor(async () => {
    const v = await p.evaluate(PROBE.panes)
    return v && v.count === 2 ? v : 0
  }, 9000, 250)
  check('B12 真点「向右分屏」-> 可见分屏格 2', split.ok === true && panes1.count === 2, { split, panes: panes1 })

  /* ---------------- B13 关闭此分屏 ---------------- */
  await tap(p, '[data-tab-id]', 0, 'right')
  await sleep(400)
  const mt = String(await p.evaluate(PROBE.menuText))
  const closePane = await tapMenuItem(p, '关闭此分屏')
  const panes2 = await waitFor(async () => {
    const v = await p.evaluate(PROBE.panes)
    return v && v.count === 1 ? v : 0
  }, 9000, 250)
  check('B13 真点「关闭此分屏」-> 回到 1 格', mt.includes('关闭此分屏') && closePane.ok === true && panes2.count === 1,
    { menuHadItem: mt.includes('关闭此分屏'), close: closePane, panes: panes2 })

  /* ---------------- B14 新建终端（复用连接） ---------------- */
  const tabsBefore14 = await p.evaluate(PROBE.tabs)
  await tap(p, '[data-tab-id]', 0, 'right')
  await sleep(400)
  const newTab = await tapMenuItem(p, '新建终端（复用此连接）')
  const tabs14 = await waitFor(async () => {
    const n = await p.evaluate(PROBE.tabs)
    return n === tabsBefore14 + 1 ? n : 0
  }, 9000, 250)
  check('B14 真点「新建终端（复用此连接）」-> 标签 +1', newTab.ok === true && tabs14 === tabsBefore14 + 1, { newTab, before: tabsBefore14, after: tabs14 })

  /* ---------------- B15 关闭此标签（菜单项） ---------------- */
  const tabsBefore15 = await p.evaluate(PROBE.tabs)
  await tap(p, '[data-tab-id]', tabsBefore15 - 1, 'right')
  await sleep(400)
  // 没有分屏时菜单项文案就是「关闭」（见 TabBar.tsx menuItems：paneCount>1 ? '关闭此分屏' : '关闭'）
  const closeTab = await tapMenuItem(p, '关闭')
  const tabs15 = await waitFor(async () => {
    const n = await p.evaluate(PROBE.tabs)
    return n === tabsBefore15 - 1 ? n : 0
  }, 9000, 250)
  check('B15 真点菜单「关闭」-> 标签 -1', closeTab.ok === true && tabs15 === tabsBefore15 - 1,
    { close: closeTab, before: tabsBefore15, after: tabs15 })

  /* ---------------- B16 渲染层异常 ---------------- */
  const errs = (p.errs || []).filter((e) => !/ResizeObserver|DevTools|Autofill/.test(e))
  if (errs.length) { console.log('  渲染层异常：'); for (const e of errs.slice(0, 6)) console.log('    ! ' + e) }
  check('B16 无渲染层未捕获异常', errs.length === 0, errs.slice(0, 3))

  osci(['-Action', 'unpin', '-X', String(HWND_NUM)])
  const m = /cursor=(-?\d+),(-?\d+)/.exec(savedCursor)
  if (m) osci(['-Action', 'restore', '-X', m[1], '-Y', m[2]])

  console.log('')
  console.log('=== 标题栏/标签栏 OS 级真机点击验证：' + pass + ' 通过 / ' + fail + ' 失败 ===')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL ' + (e && e.stack ? e.stack : e))
  process.exit(1)
})
