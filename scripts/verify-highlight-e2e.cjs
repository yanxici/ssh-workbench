/**
 * 终端输出高亮的真实应用验证（v2.1.3）。
 *
 * 为什么必须跑真应用而不是只跑 verify-highlight.cjs 的纯逻辑：
 *   纯逻辑只能证明「哪一行该染」，证明不了「染到了哪一行」。xterm 的 decoration 挂在
 *   一个 marker 上，marker 的坐标是「相对光标的行偏移」—— 偏移算错一行，界面上表现为
 *   「红条整体上移/下移一格」，而函数返回值一切正常。这类错误只有把真实终端画出来、
 *   量 DOM 的 top 才能发现。
 *
 * 断言成对出现（AGENTS.md 2.6 的区分度要求）：
 *   - 开规则 → 有 .xterm-decoration，且它覆盖的那一行文本确实含命中词；
 *   - 关开关 → 同样的输出不再产生任何装饰（关掉若无效，这条必红）；
 *   - 恢复默认（rules 传空数组）→ 又有了（内置两条规则真的进了编译表，不是空表直通）。
 *   第三条不是冗余：前两条用的一直是自定义规则，内置默认值漂移了前两条照样绿。
 *
 * 走 location.reload 而不是直接调渲染层 store：本脚本跑在**生产构建**上（没有
 * ZM_TEST 测试桥），reload 后 settingsStore.load() 会把刚落盘的规则重新应用一遍 ——
 * 这同时验证了「重启后规则还在」这条持久化路径。
 *
 * 自起自停：自己起 lab SSH 服务器（LAB_SHELL_ECHO=1 原样回显）与 Electron 应用。
 * 端口可用 HL_CDP_PORT / HL_LAB_PORT 覆盖。
 *
 * 用法：node scripts/verify-highlight-e2e.cjs
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
function pickPort(min, max) { return min + Math.floor(Math.random() * (max - min)) }
const APP_PORT = Number(process.env.HL_CDP_PORT || pickPort(21000, 29000))
const LAB_PORT = Number(process.env.HL_LAB_PORT || pickPort(29000, 34000))
const USERDATA = path.join(os.tmpdir(), 'sw-highlight-e2e')
const LAB_ROOT = path.join(os.tmpdir(), 'sw-highlight-labroot')
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

/**
 * 量装饰覆盖了哪一行。
 * deco 的 rect.top 与第一行的 rect.top 之差除以行高得到行号，再取该行 DOM 文本 ——
 * 这样「装饰存在」和「装饰染对了行」是两件事，可以分开断言。
 */
const PROBE = '(() => {' +
  ' const rows = [...document.querySelectorAll(".xterm-rows > div")];' +
  ' if (!rows.length) return { rows: 0, decos: [] };' +
  ' const base = rows[0].getBoundingClientRect();' +
  ' const cellH = base.height || 1;' +
  ' const decos = [...document.querySelectorAll(".xterm-decoration")].map((d) => {' +
  '  const r = d.getBoundingClientRect();' +
  '  const row = Math.round((r.top - base.top) / cellH);' +
  '  const el = rows[row];' +
  '  const cs = getComputedStyle(d);' +
  '  return { row: row, w: Math.round(r.width), h: Math.round(r.height),' +
  '    bg: cs.backgroundColor || "", inline: d.getAttribute("style") || "",' +
  '    cls: d.className, html: d.outerHTML.slice(0, 400),' +
  '    cells: el ? [...el.children].map((c) => ({ bg: getComputedStyle(c).backgroundColor, fg: getComputedStyle(c).color, t: (c.textContent || "").slice(0, 12) })).slice(0, 4) : null,' +
  '    cellCount: el ? el.children.length : -1,' +
  '    text: el ? el.innerText : null };' +
  ' });' +
  ' return { rows: rows.length, decos: decos };' +
'})()'

/** 关掉所有已有会话：reload 之后主进程里的会话还活着，不关会拿到上一轮的 id */
async function resetSessions(p) {
  await p.evaluate('(async () => {' +
    ' const l = await window.api.session.list();' +
    ' const list = l && l.data ? l.data : [];' +
    ' for (const s of list) { await window.api.session.close(s.id) }' +
    ' await new Promise((r) => setTimeout(r, 400));' +
    ' const l2 = await window.api.session.list();' +
    ' return (l2 && l2.data ? l2.data.length : 0);' +
  '})()')
}

/** 双击侧栏连接行打开真实 SSH 会话，返回会话 id */
async function openSession(p) {
  await p.evaluate('(() => { const r = document.querySelector("[data-conn-id]"); if (!r) return "no-row"; r.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true })); return "ok" })()')
  for (let i = 0; i < 50; i++) {
    const info = await p.evaluate('(async () => {' +
      ' const l = await window.api.session.list();' +
      ' const list = l && l.data ? l.data : [];' +
      ' const c = list.find((s) => s.status === "connected");' +
      ' return c ? { id: c.id } : null;' +
    '})()')
    if (info && info.id) return info.id
    await sleep(400)
  }
  return null
}

/** 往会话写一行输出并等回显落进终端 */
function feed(sessionId, line) {
  return '(async () => {' +
    /* 必须发 CRLF：lab 服务器原样回显我们写的字节，只发 \\r 的话终端只回车不换行，
     * 切行器永远等不到 \\n，一行都不会落进缓冲区 —— 那时候「没有装饰」其实
     * 是「压根没有完整行」，跟高亮有没有生效完全无关。 */
    ' await window.api.session.write(' + JSON.stringify(sessionId) + ', ' + JSON.stringify(line + '\r\n') + ');' +
    ' await new Promise((r) => setTimeout(r, 1000));' +
    ' return true' +
  '})()'
}

async function reload(p) {
  await p.evaluate('location.reload()')
  await sleep(3500)
  const t = await getTarget()
  const q = connect(t.webSocketDebuggerUrl)
  await q.ready
  await q.send('Runtime.enable')
  if (!(await waitReady(q))) throw new Error('reload 后应用未就绪')
  return q
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

  let p = connect((await getTarget()).webSocketDebuggerUrl)
  await p.ready
  await p.send('Runtime.enable')
  if (!(await waitReady(p))) throw new Error('应用 30s 内未就绪')

  const saved = await p.evaluate('(async () => {' +
    ' const r = await window.api.conn.save({ name: "hl-lab", host: "127.0.0.1", port: ' + LAB_PORT + ', username: "lab", authType: "password", password: "labpass", group: "x", tags: [] });' +
    ' return r.ok' +
  '})()')
  check('建立测试连接', saved === true, saved)

  const rules = [{ id: 'e2e-denied', name: 'denied', pattern: 'denied', flags: 'i', enabled: true, background: '#4a1d1d', foreground: '#ffb4b4' }]

  /* ---------- 第一轮：自定义规则开 → 必须染色且染对行 ---------- */
  await p.evaluate('(async () => { await window.api.settings.set({ outputHighlight: ' + JSON.stringify({ enabled: true, rules: rules }) + ' }); return true })()')
  p = await reload(p)
  await resetSessions(p)
  const sid1 = await openSession(p)
  check('双击打开真实 SSH 会话', typeof sid1 === 'string' && sid1.length > 0, sid1)
  await p.evaluate(feed(sid1, 'tar: /fw.bin: Cannot open: Permission denied'))
  let probe = await p.evaluate(PROBE)
  console.log('  probe1: rows=' + probe.rows + ' decos=' + JSON.stringify(probe.decos))
  check('命中行出现装饰（规则生效）', Array.isArray(probe.decos) && probe.decos.length > 0, probe.decos && probe.decos.length)
  const hitRow = (probe.decos || []).find((d) => /denied/i.test(String(d.text || '')))
  check('装饰落在含命中词的那一行（marker 偏移正确）', !!hitRow, (probe.decos || []).map((d) => d.text))
  check('装饰是整行宽（不是一格）', !!hitRow && hitRow.w >= 200, hitRow && hitRow.w)
  /* 颜色必须量「行内 cell」，不能量装饰 div。
   * xterm 6 的 .xterm-decoration 只是个透明的定位空壳（BufferDecorationRenderer._createElement
   * 只写 width/height/top/line-height），规则色是在 DomRendererRowFactory 里逐个 cell 覆盖上去的：
   * forEachDecorationAtCell 命中后把该 cell 的 bg/fg 改成 CM_RGB 并套规则色。
   * 所以量 d.style.backgroundColor 永远是空串 / rgba(0,0,0,0)，据此判「没上色」是假红。 */
  const hitCells = (hitRow && hitRow.cells) || []
  const bgCells = hitCells.filter((c) => /74, ?29, ?29|4a1d1d/i.test(String(c.bg)))
  const fgCells = hitCells.filter((c) => /255, ?180, ?180|ffb4b4/i.test(String(c.fg)))
  check(
    '命中行的字符带规则底色',
    bgCells.length >= 3 && bgCells.length * 2 >= hitCells.length,
    hitRow && { cellCount: hitRow.cellCount, bgCells: bgCells.length, sample: hitCells.slice(0, 3) }
  )
  check(
    '命中行的字符带规则文字色',
    fgCells.length >= 3,
    hitRow && { fgCells: fgCells.length, sample: hitCells.slice(0, 3) }
  )
  const wrong = (probe.decos || []).filter((d) => d.text !== null && !/denied/i.test(String(d.text)))
  check('没有误染无关行', wrong.length === 0, wrong.map((d) => d.text))

  /* ---------- 第二轮：关开关 → 同样的输出必须一条装饰都不产生 ---------- */
  await p.evaluate('(async () => { await window.api.settings.set({ outputHighlight: ' + JSON.stringify({ enabled: false, rules: rules }) + ' }); return true })()')
  p = await reload(p)
  await resetSessions(p)
  const sid2 = await openSession(p)
  check('关闭高亮后仍能开会话', typeof sid2 === 'string', sid2)
  await p.evaluate(feed(sid2, 'tar: /fw.bin: Cannot open: Permission denied'))
  probe = await p.evaluate(PROBE)
  console.log('  probe2: rows=' + probe.rows + ' decos=' + JSON.stringify(probe.decos))
  check('关闭开关后不再染色（区分度）', (probe.decos || []).length === 0, probe.decos && probe.decos.length)
  const text2 = await p.evaluate('(() => { const x = document.querySelector(".xterm"); return x ? x.innerText.slice(0, 400) : "" })()')
  check('关闭后输出照常显示（写入通路没被一起关掉）', /denied/i.test(String(text2)), String(text2).slice(0, 120))

  /* ---------- 第三轮：把 outputHighlight 整个删掉 → 回落到内置两条默认规则 ----------
   * 注意不能拿 { rules: [] } 来测默认值：按设计，空数组是「用户自己把规则删光了」，
   * 要原样尊重（highlight.ts normalizeHighlight 的注释写了三种输入的区别）。
   * 真正走默认值的是「这个键根本不存在」—— 对应老配置升级上来的用户。
   */
  await p.evaluate('(async () => { await window.api.settings.set({ outputHighlight: undefined }); return true })()')
  const afterSet = await p.evaluate('(async () => { const r = await window.api.settings.get(); return r.ok ? r.data.outputHighlight : "no-data" })()')
  check('删掉 outputHighlight 后回读为空（老配置形态）', afterSet === null || afterSet === undefined, afterSet)
  p = await reload(p)
  await resetSessions(p)
  const sid3 = await openSession(p)
  check('恢复默认后仍能开会话', typeof sid3 === 'string', sid3)
  await p.evaluate(feed(sid3, 'cat /etc/shadow: Permission denied'))
  probe = await p.evaluate(PROBE)
  console.log('  probe3: rows=' + probe.rows + ' decos=' + JSON.stringify(probe.decos))
  check('没有 outputHighlight 键时回落到内置默认规则', (probe.decos || []).length > 0, probe.decos && probe.decos.length)

  /* ---------- 设置页可见性：分区真的挂上去了 ---------- */
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
  const panel = await p.evaluate('(() => document.body.innerText.slice(0, 6000))()')
  check('设置面板出现「输出高亮」分区', String(panel).includes('输出高亮'), String(panel).slice(0, 120))
  check('试匹配框可见', String(panel).includes('试匹配'), null)

  const errs = (p.errs || []).filter((e) => !/ResizeObserver|DevTools|Autofill/.test(e))
  check('无渲染层未捕获异常', errs.length === 0, errs.slice(0, 2))

  console.log('')
  console.log('通过 ' + pass + '  失败 ' + fail)
  try { p.ws.close() } catch {}
  cleanup()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL ' + (e && e.stack ? e.stack : e)); cleanup(); process.exit(2) })
