/**
 * 任务完成通知（v2.1.4）的真实应用验证。
 *
 * 为什么必须跑真应用：verify-notify.cjs 只能证明「该不该弹」的决策对，
 * 证明不了「弹得出去」。系统通知这一层依赖 Electron 主进程的 Notification、
 * 依赖 AppUserModelID、依赖实例不被 GC —— 全是纯逻辑碰不到的地方。
 *
 * 断言判据（每条都对应一个真会出错的实现方式）：
 *   N1 弹得出去        —— 没有 setAppUserModelId / 实例被 GC 回收时是 false；
 *   N2 5 秒内同文案去重 —— 没有去重表时批量任务会刷出一排一样的通知；
 *   N3 不同文案不去重   —— 若把去重写成"第一次之后全挡"，这条会红（区分度）；
 *   N4 空标题不弹       —— 空白标题的通知在操作中心里只剩一个应用图标；
 *   N5 静音菜单真的写回 —— 只验证菜单出现是假绿，必须看 settings.json 里的
 *      mutedConnectionIds 真的多了这个连接 id，再点一次能删掉。
 *
 * 用法：node scripts/verify-notify-e2e.cjs
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
function pickPort(min, max) { return min + Math.floor(Math.random() * (max - min)) }
const APP_PORT = Number(process.env.NT_CDP_PORT || pickPort(21000, 29000))
const LAB_PORT = Number(process.env.NT_LAB_PORT || pickPort(29000, 34000))
const USERDATA = path.join(os.tmpdir(), 'sw-notify-e2e')
const LAB_ROOT = path.join(os.tmpdir(), 'sw-notify-labroot')
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

  /* ---------------- 一、主进程通知通道 ---------------- */
  const show = (title, body) => '(async () => {' +
    ' const r = await window.api.notify.show({ title: ' + JSON.stringify(title) + ', body: ' + JSON.stringify(body || '') + ' });' +
    ' return r.ok === true ? r.data : "err:" + r.error;' +
  '})()'

  const first = await p.evaluate(show('NT-E2E-1 批量执行完成', '8/8 台正常返回'))
  check('N1 系统通知弹得出去（返回 true）', first === true, first)

  const second = await p.evaluate(show('NT-E2E-1 批量执行完成', '8/8 台正常返回'))
  check('N2 5 秒内同文案被去重（返回 false）', second === false, second)

  const third = await p.evaluate(show('NT-E2E-1 批量执行完成', '另一批结果'))
  check('N3 正文不同则不算重复（去重不是"只弹第一条"）', third === true, third)

  const empty = await p.evaluate(show('   ', 'x'))
  check('N4 空标题不弹', empty === false, empty)

  /* ---------------- 二、偏好落盘 ---------------- */
  await p.evaluate('(async () => { await window.api.settings.set({ taskNotify: { enabled: true, system: true, sound: false, heuristic: true, mutedConnectionIds: [] } }); return true })()')
  const prefs = await p.evaluate('(async () => { const r = await window.api.settings.get(); return r.ok ? r.data.taskNotify : null })()')
  check(
    'N5 taskNotify 落盘并原样回读',
    !!prefs && prefs.enabled === true && prefs.heuristic === true && Array.isArray(prefs.mutedConnectionIds),
    prefs
  )

  /* ---------------- 三、建连接并刷新渲染层 ---------------- */
  /*
   * 必须 reload 再跑 UI 流程。
   * conn.save 是主进程直写，渲染层的 connectionStore 不会自己知道多了一条 ——
   * 不刷新侧栏里根本没有 [data-conn-id] 行，双击无从谈起（第一版就栽在这）。
   */
  const saved = await p.evaluate('(async () => {' +
    ' const r = await window.api.conn.save({ name: "nt-lab", host: "127.0.0.1", port: ' + LAB_PORT + ', username: "lab", authType: "password", password: "labpass", group: "x", tags: [] });' +
    ' return r.ok ? (r.data && r.data.id) : false' +
  '})()')
  check('建立测试连接', typeof saved === 'string' && saved.length > 0, saved)
  await p.evaluate('(() => { location.reload(); return "reloading" })()')
  await sleep(2500)
  if (!(await waitReady(p))) throw new Error('reload 后应用未就绪')

  /* ---------------- 四、设置面板 ---------------- */
  await p.evaluate('(() => {' +
    ' const b = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || "") === "设置");' +
    ' if (!b) return "no-btn";' +
    ' b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));' +
    ' return "ok"' +
  '})()')
  await sleep(600)
  await p.evaluate('(() => {' +
    ' const tab = document.querySelector("[data-settings-tab=\\"terminal\\"]");' +
    ' if (tab) tab.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));' +
    ' return !!tab' +
  '})()')
  await sleep(800)
  const panel = String(await p.evaluate('(() => document.body.innerText.slice(0, 8000))()'))
  check('设置面板出现「通知」分区', panel.includes('任务完成通知'), panel.slice(0, 120))
  check('四个开关都在（总开关/系统/提示音/启发式）',
    panel.includes('窗口在后台时用系统通知') && panel.includes('提示音') && panel.includes('疑似完成'),
    null)

  /* ---------------- 五、标签右键静音真实写回 ---------------- */
  // 关掉设置面板，否则它盖住了标签栏的右键菜单
  await p.evaluate('(() => {' +
    ' const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "完成");' +
    ' if (b) b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));' +
    ' return !!b' +
  '})()')
  await sleep(800)

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

  const openMenu = await p.evaluate('(() => {' +
    ' const tab = document.querySelector("[data-tab-id]");' +
    ' if (!tab) return "no-tab";' +
    ' const r = tab.getBoundingClientRect();' +
    ' tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }));' +
    ' return "ok"' +
  '})()')
  await sleep(600)
  const menuText = String(await p.evaluate('(() => document.body.innerText.slice(0, 8000))()'))
  check('标签右键菜单出现「本连接不弹通知」', openMenu === 'ok' && menuText.includes('本连接不弹通知'), openMenu)

  // 点它 —— 走的是真实 UI 链路：菜单 → toggleMuteConnection → settings.update → 落盘
  const clicked = await p.evaluate('(() => {' +
    ' const el = [...document.querySelectorAll("button,div,span")].filter((x) => (x.textContent || "").trim() === "本连接不弹通知").pop();' +
    ' if (!el) return "no-item";' +
    ' el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));' +
    ' return "ok"' +
  '})()')
  await sleep(1200)
  const muted = await p.evaluate('(async () => { const r = await window.api.settings.get(); return r.ok ? r.data.taskNotify : null })()')
  check(
    'N6 点静音后连接 id 真的写进了 mutedConnectionIds',
    clicked === 'ok' && !!muted && Array.isArray(muted.mutedConnectionIds) && muted.mutedConnectionIds.indexOf(saved) >= 0,
    { clicked: clicked, saved: saved, muted: muted && muted.mutedConnectionIds }
  )

  // 再点一次「恢复本连接通知」—— 验证是切换而不是单向加
  await p.evaluate('(() => {' +
    ' const tab = document.querySelector("[data-tab-id]");' +
    ' const r = tab.getBoundingClientRect();' +
    ' tab.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + 10 }));' +
    ' return "ok"' +
  '})()')
  await sleep(600)
  const restoreVisible = String(await p.evaluate('(() => document.body.innerText.slice(0, 8000))()'))
  check('静音后菜单文案变成「恢复本连接通知」', restoreVisible.includes('恢复本连接通知'), null)
  await p.evaluate('(() => {' +
    ' const el = [...document.querySelectorAll("button,div,span")].filter((x) => (x.textContent || "").trim() === "恢复本连接通知").pop();' +
    ' if (el) el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));' +
    ' return !!el' +
  '})()')
  await sleep(1200)
  const unmuted = await p.evaluate('(async () => { const r = await window.api.settings.get(); return r.ok ? r.data.taskNotify : null })()')
  check(
    'N7 再点一次恢复（列表里删干净）',
    !!unmuted && Array.isArray(unmuted.mutedConnectionIds) && unmuted.mutedConnectionIds.indexOf(saved) < 0,
    unmuted && unmuted.mutedConnectionIds
  )

  /* ---------------- 五、Windows 焦点查询通道 ---------------- */
  const focused = await p.evaluate('(async () => { const v = await window.api.win.isFocused(); return typeof v })()')
  check('N8 win.isFocused() 返回布尔（渲染层据此决定发系统通知还是 toast）', focused === 'boolean', focused)

  const errs = (p.errs || []).filter((e) => !/ResizeObserver|DevTools|Autofill/.test(e))
  if (errs.length) {
    console.log('  渲染层异常：')
    for (const e of errs.slice(0, 6)) console.log('    ! ' + e)
  }
  check('无渲染层未捕获异常', errs.length === 0, errs.slice(0, 3))

  console.log('')
  console.log('=== 通知真实应用验证：' + pass + ' 通过 / ' + fail + ' 失败 ===')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL ' + (e && e.stack ? e.stack : e))
  cleanup()
  process.exit(1)
})