/**
 * 终端渲染后端自检：默认 DOM + WebGL 可选 + 软件渲染不白屏 + **字形确实按配置字号光栅化**。
 *
 * 历史（2026-11 两次修订，结论不同，别只看第一段）：
 *   ① v2.1.1：发现 WebGL 下字形明显小于格子（同一行 `MWMWMWMW  lllll  iiiii`，dpr=1、scale 4
 *      截图列投影：格子 pitch 两路径都是 32~33px，但 WebGL 墨迹 27/34/27/34… 而 DOM 是
 *      31/31/31/31…，细笔 `i`/`l` 只剩 5~7px）。当时判定为「addon 图集栅格化的黑箱回归」，
 *      处理方式是把默认后端翻回 DOM 绕开。
 *   ② v2.1.2：真根因找到了 —— addon 拼 canvas font 时在非斜体分支留下**前导空格**
 *      （`\`\${D} \${S} \${size}px …\`` 里 D 为空串），Chromium 的 canvas font 解析器不 trim，
 *      整串判非法、setter 静默保留初始值 `10px sans-serif`。图集按 10px 光栅化再贴进按
 *      `fontSize × dpr` 算出的格子 → 字小、笔画细、四周空白多（肉眼读作「字距变宽」）。
 *      渲染层用 `src/renderer/src/lib/canvasFont.ts` 的 normalize 补丁兜住，并在挂 WebGL 前
 *      做一次 `isCanvasFontApplied()` 自检，不成立就回落 DOM。
 *      所以「WebGL 一定把字画小」已经不成立，本脚本 B 段现在直接断言真实 fillText 的 font。
 *
 * 判据用 canvas 存在性：xterm 的 DOM 渲染器不创建 canvas，WebGL 渲染器创建一个。
 * 这比读内部字段可靠 —— addon 没有公开「我是否已激活」的接口。
 *
 * 三段（B/C 需重启，因为 addon 在 Terminal 构造时决定）：
 *   A. 默认设置：终端**无** canvas（DOM 渲染器）+ 有 DOM 行 + 有绘制尺寸；
 *   B. experimental.terminalRenderer='webgl'：终端**有** canvas（WebGL 激活），
 *      且 fillText 实际用的 font 必须是 `fontSize × dpr` 且字体族来自配置；
 *   C. experimental.softwareRender=true：关硬件加速后不白屏。
 *
 * 字形探针的时机很重要：图集在 WebGL 初始化时一次性预热 94 个字符，
 * 猴补丁必须装在 location.reload() 之后、双击建会话之前（见 FONT_PROBE）。
 *
 * 用法：node scripts/verify-webgl.cjs
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
function pickPort(min, max) { return min + Math.floor(Math.random() * (max - min)) }
const LAB_PORT = Number(process.env.WG_LAB_PORT || pickPort(29000, 34000))
const USERDATA = path.join(os.tmpdir(), 'sw-webgl-probe')
const LAB_ROOT = path.join(os.tmpdir(), 'sw-webgl-root')
const children = []
let PORT = '0'
function killTree(c) { if (!c || c.killed) return; try { spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
function cleanup() { for (const c of children) killTree(c) }
process.on('exit', cleanup)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(n, ok, d) { if (ok) { pass++; console.log('  PASS  ' + n) } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + JSON.stringify(d) : '')) } }
function connect(url) {
  const ws = new WebSocket(url); const pend = new Map(); let s = 0
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result) } })
  const ready = new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
  const send = (a, b = {}) => new Promise((res, rej) => { const id = ++s; pend.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method: a, params: b })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('timeout ' + a)) } }, 60000) })
  const evaluate = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value }
  return { ready, evaluate, ws }
}
async function launch(port) {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const exe = process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron')
  const app = spawn(exe, ['.', '--user-data-dir=' + USERDATA, '--remote-debugging-port=' + port, '--no-sandbox'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(app)
  await sleep(3000)
  let target = null
  for (let i = 0; i < 80; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
      const t = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
      if (t) { target = t; break }
    } catch {}
    await sleep(400)
  }
  if (!target) throw new Error('no target')
  PORT = String(port)
  const p = connect(target.webSocketDebuggerUrl)
  await p.ready
  for (let i = 0; i < 150; i++) {
    try { if (await p.evaluate('document.body && document.body.innerText.length > 100')) break } catch {}
    await sleep(200)
  }
  return p
}
/*
 * 打开会话必须走真实 UI 链路（保存连接 → 重载 → 双击侧栏行）。
 * 直接用 window.api.session.open 只会让主进程建会话，渲染层不会创建标签与终端，
 * 于是 .xterm 永远不存在 —— 第一版就栽在这里（6 条断言里 4 条因环境假红）。
 */
/*
 * 字形光栅化探针：包一层 fillText 记录「真正生效的 canvas font」。
 * 必须装在 **重载之后、双击建会话之前** —— 图集是在 WebGL 初始化时一次性预热 94 个字符，
 * 装晚了就只剩空记录。
 */
const FONT_PROBE = '(() => { window.__fonts = []; const f = CanvasRenderingContext2D.prototype.fillText; CanvasRenderingContext2D.prototype.fillText = function (t, x, y, m) { window.__fonts.push(this.font); return f.call(this, t, x, y, m) } })()'

async function openSession(p, tag, opts = {}) {
  const sid = 'wg-' + tag
  const saved = await p.evaluate('(async () => { const r = await window.api.conn.save({ name: ' + JSON.stringify(sid) + ', host: "127.0.0.1", port: ' + LAB_PORT + ', username: "lab", authType: "password", password: "labpass", group: "w", tags: [] }); return r.ok })()')
  if (!saved) return { err: 'save failed' }
  await p.evaluate('location.reload()')
  await sleep(4000)
  const t2 = await (async () => {
    for (let i = 0; i < 60; i++) {
      try {
        const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
        const t = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
        if (t) return t
      } catch {}
      await sleep(400)
    }
    return null
  })()
  if (!t2) return { err: 'no target after reload' }
  const q = connect(t2.webSocketDebuggerUrl)
  await q.ready
  if (opts.fontProbe) await q.evaluate(FONT_PROBE)
  for (let i = 0; i < 100; i++) {
    try { if (await q.evaluate('document.querySelectorAll("[data-conn-id]").length > 0')) break } catch {}
    await sleep(200)
  }
  const opened = await q.evaluate('(() => { const r = document.querySelector("[data-conn-id]"); if (!r) return "no-row"; r.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); return "ok" })()')
  if (opened !== 'ok') return { err: opened }
  let up = false
  for (let i = 0; i < 120; i++) {
    try { if (await q.evaluate('!!document.querySelector(".xterm")')) { up = true; break } } catch {}
    await sleep(200)
  }
  await sleep(1200)
  /*
   * 判据说明（第一版写错了，这里改正）：
   *   - WebGL 渲染器**不创建 .xterm-rows 的 DOM 行**（它直接画在 canvas 上），
   *     所以「DOM 行数 > 0」不能用来判断「终端画出来了」；
   *   - `disableHardwareAcceleration()` 只是关掉**硬件**加速，Chromium 仍会用
   *     SwiftShader 软件光栅化提供 WebGL —— 因此 canvas 依然存在，
   *     「软件渲染 ⇒ DOM 回落」这个推论是**错的**。
   *     真正的 DOM 回落只在 WebGL 上下文创建失败时发生。
   * 所以断言拆开：DOM 后端看「无 canvas + 有 DOM 行」，WebGL 后端看「有 canvas」，
   * 两者共同看「终端容器有实际尺寸」。
   */
  const res = await q.evaluate('(() => { const x = document.querySelector(".xterm"); const sc = x ? x.querySelector(".xterm-screen") : null; const r = sc ? sc.getBoundingClientRect() : null; return { hasXterm: !!x, canvases: document.querySelectorAll(".xterm canvas").length, rowsEl: document.querySelectorAll(".xterm-rows > div").length, screenW: r ? Math.round(r.width) : 0, screenH: r ? Math.round(r.height) : 0 } })()')
  res.termUp = up
  if (opts.fontProbe) {
    const fonts = await q.evaluate('window.__fonts || []')
    const uniq = [...new Set(fonts)]
    res.fontCalls = fonts.length
    res.fontUniq = uniq.slice(0, 3)
    res.dpr = await q.evaluate('window.devicePixelRatio')
  }
  try { q.ws.close() } catch {}
  return res
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

  console.log('')
  console.log('[A. 默认路径（DOM 渲染器）]')
  let p = await launch(pickPort(21000, 29000))
  const a = await openSession(p, 'a')
  console.log('  ' + JSON.stringify(a))
  check('终端已渲染', a.hasXterm === true, a)
  check('默认走 DOM 渲染器（无 .xterm canvas）', a.canvases === 0, a)
  check('DOM 渲染器产出真实行（.xterm-rows 有子节点）', a.rowsEl > 0, a)
  check('终端有实际绘制尺寸（画出来了）', a.screenW > 0 && a.screenH > 0, a)
  try { p.ws.close() } catch {}
  killTree(children.pop())
  await sleep(1500)

  console.log('')
  console.log('[B. WebGL 路径（experimental.terminalRenderer=webgl）]')
  const dir = path.join(USERDATA, 'data')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ experimental: { tokens: {}, terminalRenderer: 'webgl' } }), 'utf-8')
  p = await launch(pickPort(21000, 29000))
  const flag = await p.evaluate('(async () => { const r = await window.api.settings.get(); return r.ok ? r.data.experimental.terminalRenderer : null })()')
  check('设置里读回 terminalRenderer=webgl', flag === 'webgl', flag)
  const b = await openSession(p, 'b', { fontProbe: true })
  console.log('  ' + JSON.stringify(b))
  check('WebGL 后端下终端正常显示（有尺寸）', b.hasXterm === true && b.screenW > 0 && b.screenH > 0, b)
  /*
   * 只断言「WebGL 被真正启用」，不断言字形尺寸：
   * 该回归本身（字形被画小）就是 WebGL 后端的已知问题，写进断言会让门禁常红；
   * 我们要守的是「默认不用 WebGL」，即 A 段的 canvases === 0。
   */
  check('WebGL 渲染器已激活（存在 .xterm canvas）', b.canvases > 0, b)
  /*
   * 字形光栅化断言（这次修复的守门）：
   * @xterm/addon-webgl 0.19.0 拼 canvas font 时在非斜体分支留下前导空格
   * （`${''} ${fontWeight} ${size}px ...`），Chromium 的 canvas font 解析器不 trim，
   * 整串判非法、setter 静默保留初始值 10px sans-serif —— 图集按 10px 光栅化、
   * 再塞进按配置字号算出的格子里，表现就是「字变小、笔画细、看着像字距变宽」。
   * 渲染层用 canvasFont.ts 的 normalize 补丁兜住了；这里直接看真实 fillText 用的 font。
   * 本仓装的是 @xterm/addon-webgl 0.18.0（xterm 5.5 线；上述复现出自上游 0.19.0/xterm 6 线），
   * 补丁与自检照旧保留 —— 存在即无害，将来换 addon 版本时它就是护栏。
   */
  const px = (b.fontUniq || []).map((f) => parseFloat((/(\d+(?:\.\d+)?)px/.exec(f) || [])[1] || '0'))
  const wantPx = 13.5 * (b.dpr || 1)
  check('WebGL 图集未退回 canvas 默认 10px', px.length > 0 && px.every((v) => Math.abs(v - 10) > 0.5), b.fontUniq)
  check('WebGL 图集字号与 dpr 一致（' + wantPx + 'px）', px.length > 0 && px.every((v) => Math.abs(v - wantPx) < 0.6), { px, wantPx })
  check('WebGL 图集字体族来自配置（非 sans-serif 兜底）', (b.fontUniq || []).every((f) => !/\bsans-serif\b/.test(f)), b.fontUniq)
  check('图集预热确实发生了（fillText 有调用）', (b.fontCalls || 0) > 0, b.fontCalls)
  try { p.ws.close() } catch {}
  killTree(children.pop())
  await sleep(1500)

  console.log('')
  console.log('[C. 软件渲染路径（softwareRender=true，默认 DOM 后端）]')
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ experimental: { tokens: {}, softwareRender: true } }), 'utf-8')
  p = await launch(pickPort(21000, 29000))
  const sf = await p.evaluate('(async () => { const r = await window.api.settings.get(); return r.ok ? !!r.data.experimental.softwareRender : null })()')
  check('设置里读回 softwareRender=true', sf === true, sf)
  const c = await openSession(p, 'c')
  console.log('  ' + JSON.stringify(c))
  check('软件渲染下终端仍正常显示（有尺寸）', c.hasXterm === true && c.screenW > 0 && c.screenH > 0, c)
  /*
   * 不断言 c.canvases === 0：SwiftShader 仍提供 WebGL，canvas 会存在。
   * 这里只断言「软件渲染下没有因为关掉硬件加速而白屏」—— 那才是真正的风险。
   */
  check('软件渲染下未出现渲染空白（尺寸有效）', c.screenH > 0, c)
  try { p.ws.close() } catch {}

  console.log('')
  cleanup()
  console.log('通过 ' + pass + '  失败 ' + fail)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error('FATAL ' + e.message); cleanup(); process.exit(2) })
