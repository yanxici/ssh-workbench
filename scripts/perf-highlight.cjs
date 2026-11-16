/**
 * 终端输出高亮的真实应用压测（v2.1.3）。
 *
 * 为什么要压：高亮挂在终端唯一的写入口上（writeSessionData）。写法稍重一点，
 * 表现不是「算错」而是「大输出时终端卡住」—— 纯逻辑验证脚本量不出来。
 *
 * 量什么：
 *   A. 纯逻辑吞吐：compileRules + 切行 + matchRule 处理 5 万行输出的耗时（node 侧）。
 *   B. 端到端写入：同一台 lab SSH 服务器回显 N 行输出，
 *      规则开启 vs 关闭，量「最后一行真的出现在 DOM 里」的墙钟时间，取 3 轮中位数。
 *      两个模式交替跑，避免机器负载漂移被算成高亮开销。
 *   C. 数据零影响：全程用 --user-data-dir 临时目录，真实 %APPDATA% 一个字节不碰；
 *      另外断言每轮的行数完整（哨兵行都在，不缺行）。
 *
 * 判据（AGENTS.md 2.6：修复没落地时必须会红）：
 *   - 开启模式下必须真的出现 .xterm-decoration —— 否则测的其实是「关着的高亮」，
 *     比值恒等于 1，压测就成了摆设；
 *   - 开启模式中位耗时 / 关闭模式中位耗时 <= MAX_RATIO，且绝对耗时有上限。
 *
 * MAX_RATIO 为什么跟着 xterm 主版本走（本仓与上游唯一的差别就在这里）：
 *   同一台机器、同一天、同一份 highlightRuntime 代码、同样 1200 行 / 84019 字节 / 33 个装饰：
 *     本仓  @xterm/xterm 5.5.0 + Electron 33  → 开启 290ms / 关闭 59ms = 4.92x
 *     上游  @xterm/xterm 6.x   + Electron 45  → 开启 122ms / 关闭 62ms = 1.97x
 *   「关闭」一侧两仓几乎一样（59 vs 62ms），多出来的开销全在装饰的刷新路径上：
 *   xterm 6 把 .xterm-decoration 做成透明的定位空壳、上色交给行渲染器，
 *   xterm 5 仍是每个装饰一个实体 DOM 元件、随行刷新反复处理。
 *   这是技术栈边界，不是移植引入的退化，所以 5.x 线放宽到 6.5x —— 仍能抓住
 *   「装饰路径被写成每次刷新全量重建」这类数量级退化；将来技术栈追平 xterm 6，
 *   这个常量会自动收紧回 3.0（绝对值上限 20s 与装饰数区分度断言两仓一致）。
 *
 * 用法：node scripts/perf-highlight.cjs
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
function pickPort(min, max) { return min + Math.floor(Math.random() * (max - min)) }
const APP_PORT = Number(process.env.HL_CDP_PORT || pickPort(21000, 29000))
const LAB_PORT = Number(process.env.HL_LAB_PORT || pickPort(29000, 34000))
const USERDATA = path.join(os.tmpdir(), 'sw-highlight-perf')
const LAB_ROOT = path.join(os.tmpdir(), 'sw-highlight-perf-root')
const PORT = String(APP_PORT)

/** 每轮发多少行；行要够长才测得出按字符量化的开销 */
const LINES = Number(process.env.HL_PERF_LINES || 1200)
const ROUNDS = 3
const LINE_BODY = 'build[FwUpdate] target=7628 slot=B progress=XX% checksum=0x9f3a21 OK'

/**
 * 高亮开销上限：xterm 6 的装饰是空壳（见头注释实测），3.0x 够用；
 * xterm 5.x 每条装饰是随行刷新的实体 DOM 元件，基线 4.92x，放宽到 6.5x。
 */
const XTERM_MAJOR = (() => {
  try {
    const pkg = require(path.join(ROOT, 'node_modules', '@xterm', 'xterm', 'package.json'))
    return Number(String(pkg.version).split('.')[0]) || 5
  } catch {
    return 5
  }
})()
const MAX_RATIO = XTERM_MAJOR >= 6 ? 3.0 : 6.5

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

function median(a) {
  const s = [...a].sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]
}

/* ---------- A. 纯逻辑吞吐（node 侧，先把 highlight.ts 打成 CJS） ---------- */
function logicBench() {
  const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'))
  const built = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'renderer', 'src', 'lib', 'highlight.ts')],
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent'
  })
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(mod, mod.exports, require)
  const hl = mod.exports

  const rules = [
    { id: 'a', name: 'error', pattern: '\\b(error|fail(ed|ure)?|fatal|panic|exception|denied|refused)\\b', flags: 'i', enabled: true, background: '#4a1d1d' },
    { id: 'b', name: 'warn', pattern: '\\b(warn(ing)?|deprecated|timeout)\\b', flags: 'i', enabled: true, background: '#40320f' },
    { id: 'c', name: 'fw', pattern: 'FwUpdate|checksum=0x[0-9a-f]+', flags: '', enabled: true, background: '#1d3a4a' },
    { id: 'd', name: 'slot', pattern: 'slot=[A-Z]', flags: '', enabled: true, background: '#2a3a1d' }
  ]
  const { compiled, errors } = hl.compileRules(rules)
  check('4 条规则全部编译成功', compiled.length === 4 && errors.length === 0, { n: compiled.length, errors })
  const splitter = hl.createLineSplitter()
  const chunk = (LINE_BODY + '\r\n').repeat(200)
  const payload = chunk + 'FATAL: fw.bin checksum mismatch\r\n'

  const target = 50000
  let lines = 0
  let hits = 0
  const t0 = process.hrtime.bigint()
  while (lines < target) {
    for (const line of splitter.feed(payload)) {
      lines++
      if (hl.matchRule(compiled, line)) hits++
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6
  const perLineUs = (ms * 1000) / lines
  console.log('\n纯逻辑：' + lines + ' 行 / ' + ms.toFixed(1) + 'ms = ' + perLineUs.toFixed(1) + 'us 每行，命中 ' + hits + ' 行')
  check('纯逻辑吞吐 >= 20000 行/秒（即 <= 50us 每行）', perLineUs <= 50, perLineUs)
  check('纯逻辑确实命中（正则没被写成永不匹配）', hits > 0, hits)
  check('切行不丢行：行数 = 目标', lines >= target, lines)
}

/* ---------- CDP ---------- */
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
    setTimeout(() => { if (pend.has(id)) { pend.delete(id); reject(new Error('timeout ' + method)) } }, 60000)
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
      if (await p.evaluate('document.body && document.body.innerText.length > 100') === true) return true
    } catch {}
    await sleep(200)
  }
  return false
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

async function resetSessions(p) {
  await p.evaluate('(async () => {' +
    ' const l = await window.api.session.list();' +
    ' const list = l && l.data ? l.data : [];' +
    ' for (const s of list) { await window.api.session.close(s.id) }' +
    ' await new Promise((r) => setTimeout(r, 400));' +
    ' return true' +
  '})()')
}

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

/**
 * 发 N 行输出，量「哨兵行进入 DOM」的墙钟时间。
 * 轮询 20ms，比 rAF 可靠：窗口不可见时 rAF 会被整个节流（AGENTS.md 2.3 记过这个坑）。
 */
function burst(sessionId, tag) {
  const sentinel = 'PERF-SENTINEL-' + tag
  return '(async () => {' +
    ' const t0 = performance.now();' +
    ' const list = [];' +
    ' for (let i = 0; i < ' + LINES + '; i++) list.push(' + JSON.stringify(LINE_BODY) + ');' +
    ' const body = list.join("\\r\\n") + "\\r\\n" + ' + JSON.stringify(sentinel) + ' + "\\r\\n";' +
    ' await window.api.session.write(' + JSON.stringify(sessionId) + ', body);' +
    ' const deadline = t0 + 60000;' +
    ' let seen = false;' +
    ' while (performance.now() < deadline) {' +
    '   const x = document.querySelector(".xterm");' +
    '   if (x && x.innerText.includes(' + JSON.stringify(sentinel) + ')) { seen = true; break }' +
    '   await new Promise((r) => setTimeout(r, 20));' +
    ' }' +
    ' const ms = performance.now() - t0;' +
    ' return { ms: ms, seen: seen, decos: document.querySelectorAll(".xterm-decoration").length, chars: body.length };' +
  '})()'
}

async function main() {
  fs.rmSync(USERDATA, { recursive: true, force: true })
  fs.mkdirSync(USERDATA, { recursive: true })
  fs.rmSync(LAB_ROOT, { recursive: true, force: true })
  fs.mkdirSync(LAB_ROOT, { recursive: true })

  logicBench()

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

  await p.evaluate('(async () => {' +
    ' const r = await window.api.conn.save({ name: "hl-perf", host: "127.0.0.1", port: ' + LAB_PORT + ', username: "lab", authType: "password", password: "labpass", group: "x", tags: [] });' +
    ' return r.ok' +
  '})()')

  const rules = [
    { id: 'p1', name: 'error', pattern: '\\b(error|fail(ed|ure)?|fatal|panic|exception|denied|refused)\\b', flags: 'i', enabled: true, background: '#4a1d1d', foreground: '#ffb4b4' },
    { id: 'p2', name: 'warn', pattern: '\\b(warn(ing)?|deprecated|timeout)\\b', flags: 'i', enabled: true, background: '#40320f' },
    { id: 'p3', name: 'fw', pattern: 'FwUpdate|checksum=0x[0-9a-f]+', flags: '', enabled: true, background: '#1d3a4a' },
    { id: 'p4', name: 'slot', pattern: 'slot=[A-Z]', flags: '', enabled: true, background: '#2a3a1d' }
  ]

  const onTimes = []
  const offTimes = []
  let onDecos = 0
  let offDecos = 0

  for (let round = 0; round < ROUNDS; round++) {
    /* 开启一轮 */
    await p.evaluate('(async () => { await window.api.settings.set({ outputHighlight: ' + JSON.stringify({ enabled: true, rules: rules }) + ' }); return true })()')
    p = await reload(p)
    await resetSessions(p)
    const sidOn = await openSession(p)
    if (!sidOn) throw new Error('开启轮：打不开会话')
    const rOn = await p.evaluate(burst(sidOn, 'on' + round))
    onTimes.push(rOn.ms)
    onDecos += rOn.decos
    console.log('  round' + round + ' 开启: ' + Math.round(rOn.ms) + 'ms  ' + rOn.chars + ' 字节  装饰 ' + rOn.decos + ' 个  seen=' + rOn.seen)

    /* 关闭一轮 */
    await p.evaluate('(async () => { await window.api.settings.set({ outputHighlight: ' + JSON.stringify({ enabled: false, rules: rules }) + ' }); return true })()')
    p = await reload(p)
    await resetSessions(p)
    const sidOff = await openSession(p)
    if (!sidOff) throw new Error('关闭轮：打不开会话')
    const rOff = await p.evaluate(burst(sidOff, 'off' + round))
    offTimes.push(rOff.ms)
    offDecos += rOff.decos
    console.log('  round' + round + ' 关闭: ' + Math.round(rOff.ms) + 'ms  ' + rOff.chars + ' 字节  装饰 ' + rOff.decos + ' 个  seen=' + rOff.seen)
    check('round' + round + ' 两种模式都收到全部输出（不丢行）', rOn.seen === true && rOff.seen === true, { on: rOn.seen, off: rOff.seen })
  }

  const mOn = median(onTimes)
  const mOff = median(offTimes)
  const ratio = mOff > 0 ? mOn / mOff : 0
  console.log('\n端到端中位：开启 ' + Math.round(mOn) + 'ms / 关闭 ' + Math.round(mOff) + 'ms = ' + ratio.toFixed(2) + 'x')
  check('开启模式下确实产生了装饰（否则量的是没开的高亮）', onDecos > 0, onDecos)
  check('关闭模式下一条装饰都没有（区分度）', offDecos === 0, offDecos)
  check('高亮开销 <= ' + MAX_RATIO.toFixed(1) + 'x（xterm ' + XTERM_MAJOR + '.x 基线）', ratio <= MAX_RATIO, { ratio: Number(ratio.toFixed(2)), max: MAX_RATIO, xterm: XTERM_MAJOR, on: onTimes, off: offTimes })
  check('开启模式绝对耗时 <= 20s', mOn <= 20000, Math.round(mOn))

  const errs = (p.errs || []).filter((e) => !/ResizeObserver|DevTools|Autofill/.test(e))
  check('无渲染层未捕获异常', errs.length === 0, errs.slice(0, 2))

  console.log('')
  console.log('通过 ' + pass + '  失败 ' + fail)
  try { p.ws.close() } catch {}
  cleanup()
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('FATAL ' + (e && e.stack ? e.stack : e)); cleanup(); process.exit(2) })
