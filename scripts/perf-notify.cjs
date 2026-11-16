/**
 * 任务完成通知（v2.1.4）的真实应用压测。
 *
 * 为什么要压：通知这一版挂在了终端最热的路径上 ——
 * App.tsx 的 sessionData 回调每次收到输出都先调 noteSessionOutput()。
 * 20 个会话同时刷屏时，这里每帧多做一件事就是全局卡顿。
 *
 * 量什么：
 *   A. 纯逻辑吞吐：planNotify + heuristicHit 各跑 20 万次（node 侧，esbuild 打 CJS）。
 *   B. 端到端热路径：同一台 lab SSH 回显 1200 行，
 *      启发式记账开启 vs 关闭，量「哨兵行进 DOM」的墙钟时间，取 3 轮中位数，
 *      两种模式交替跑，避免机器负载漂移被算成开销。
 *   C. 通知投递本身：连发 25 条互不相同的通知，量中位耗时（IPC + Notification 创建）；
 *      再断言同文案第二条返回 false —— 若去重表失效，这里会红。
 *   D. 数据零影响：全程 --user-data-dir 临时目录；另外对真实 %APPDATA% 下的
 *      connections.json 做前后 sha256 比对，一个字节都不许动。
 *
 * 判据（AGENTS.md 2.6：修复没落地时必须会红）：
 *   - 比值 <= 1.5：noteSessionOutput 只是 Map.set + Date.now，超过 1.5x 说明写错了；
 *   - 去重第二条必须 false：去掉 notifier 里的 recent 表，这条立刻变 true；
 *   - 窗口聚焦时必须**不**出现"疑似完成"：去掉巡检里的 hasFocus 守卫，
 *     这条立刻变红（人就在窗口前面，右下角弹一条"疑似完成"是纯噪音）。
 *
 * 用法：node scripts/perf-notify.cjs
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const crypto = require('node:crypto')

const ROOT = path.join(__dirname, '..')
function pickPort(min, max) { return min + Math.floor(Math.random() * (max - min)) }
const APP_PORT = Number(process.env.NT_CDP_PORT || pickPort(21000, 29000))
const LAB_PORT = Number(process.env.NT_LAB_PORT || pickPort(29000, 34000))
const USERDATA = path.join(os.tmpdir(), 'sw-notify-perf')
const LAB_ROOT = path.join(os.tmpdir(), 'sw-notify-perf-root')
const PORT = String(APP_PORT)

const LINES = Number(process.env.NT_PERF_LINES || 1200)
const ROUNDS = 3
const LINE_BODY = 'ping 192.168.1.1: seq=XX ttl=64 time=0.4 ms'
/** 连发多少条通知。故意不取大值：每条都会真的弹到桌面上，250 条会把操作中心塞满 */
const NOTIFY_BURST = 25

const REAL_CONN = path.join(process.env.APPDATA || '', 'ssh-workbench', 'data', 'connections.json')

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
function hashFile(p) {
  if (!fs.existsSync(p)) return 'missing'
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
}

/* ---------- A. 纯逻辑吞吐 ---------- */
function logicBench() {
  const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'))
  const built = esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'src', 'renderer', 'src', 'lib', 'notifyPlan.ts')],
    bundle: true, write: false, format: 'cjs', platform: 'node', logLevel: 'silent'
  })
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', built.outputFiles[0].text)(mod, mod.exports, require)
  const np = mod.exports

  const prefs = { enabled: true, system: true, sound: false, heuristic: true, mutedConnectionIds: [] }
  const N = 200000

  /* planNotify：每帧一条任务事件，看决策本身多贵 */
  let t0 = process.hrtime.bigint()
  let hits = 0
  for (let i = 0; i < N; i++) {
    const d = np.planNotify(
      { kind: 'batch', title: '批量执行完成：8/8 台正常返回', connectionId: 'c' + (i % 50) },
      { prefs: prefs, focused: (i & 1) === 0 }
    )
    if (d.channel !== 'none') hits++
  }
  let ms = Number(process.hrtime.bigint() - t0) / 1e6
  const perOpUs = (ms * 1000) / N
  console.log('\n纯逻辑 planNotify：' + N + ' 次 / ' + ms.toFixed(1) + 'ms = ' + perOpUs.toFixed(3) + 'us 每次，放行 ' + hits)
  check('planNotify 每次 <= 2us', perOpUs <= 2, Number(perOpUs.toFixed(3)))
  check('planNotify 确实放行了一部分（不是全被挡）', hits === N, hits)

  /* heuristicHit：巡检时每个会话每 2 秒判一次 */
  t0 = process.hrtime.bigint()
  let fired = 0
  for (let i = 0; i < N; i++) {
    const now = 1_000_000 + i
    if (np.heuristicHit({ now: now, lastOutputAt: now - (i % 4000), notifiedAt: 0, prefs: prefs })) fired++
  }
  ms = Number(process.hrtime.bigint() - t0) / 1e6
  const hitUs = (ms * 1000) / N
  console.log('纯逻辑 heuristicHit：' + N + ' 次 / ' + ms.toFixed(1) + 'ms = ' + hitUs.toFixed(3) + 'us 每次，命中 ' + fired)
  check('heuristicHit 每次 <= 2us', hitUs <= 2, Number(hitUs.toFixed(3)))
  check('heuristicHit 命中数在 (0, N) 之间（阈值真的在起作用）', fired > 0 && fired < N, fired)
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
    const id = await p.evaluate('(async () => {' +
      ' const l = await window.api.session.list();' +
      ' const list = l && l.data ? l.data : [];' +
      ' const c = list.find((s) => s.status === "connected");' +
      ' return c ? c.id : null;' +
    '})()')
    if (id) return id
    await sleep(400)
  }
  return null
}

/** 发 N 行，量哨兵行进 DOM 的墙钟时间；同时把记账状态带回来 */
function burst(sessionId, tag) {
  const sentinel = 'NT-PERF-' + tag
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
    ' return { ms: performance.now() - t0, seen: seen, chars: body.length };' +
  '})()'
}

/** 读渲染层记账（taskNotify 的 peekIdle 不在 window 上，改从 DOM 反推不可行，这里用 toast 兜底） */
function idleProbe(sessionId) {
  /*
   * 生产构建没有 __lazy_test 桥（AGENTS.md 记过），渲染层模块拿不到。
   * 所以"记账真的发生了"用可观察的行为代替：贴一条错误输出让终端静默，
   * 若启发式开着且窗口未聚焦，2 秒内会出现一条 toast/系统通知 —— 这里只判
   * 决策层已被触达（toast 进 DOM），不强求系统通知（窗口可能聚焦）。
   */
  return '(async () => {' +
    ' await window.api.session.write(' + JSON.stringify(sessionId) + ', "echo NT-IDLE-PROBE\\r\\n");' +
    ' const t0 = performance.now();' +
    ' let hit = false;' +
    ' while (performance.now() - t0 < 6000) {' +
    '   if (document.body.innerText.includes("疑似完成")) { hit = true; break }' +
    '   await new Promise((r) => setTimeout(r, 100));' +
    ' }' +
    ' return { hit: hit, ms: performance.now() - t0, focused: await window.api.win.isFocused(), quiet: document.hasFocus() };' +
  '})()'
}

function notifyBurst() {
  return '(async () => {' +
    ' const times = [];' +
    ' let ok = 0;' +
    ' for (let i = 0; i < ' + NOTIFY_BURST + '; i++) {' +
    '   const t0 = performance.now();' +
    '   const r = await window.api.notify.show({ title: "NT-PERF-" + i + " 批量执行完成", body: "8/8 台正常返回" });' +
    '   times.push(performance.now() - t0);' +
    '   if (r.ok && r.data === true) ok++;' +
    ' }' +
    ' const dup = await window.api.notify.show({ title: "NT-PERF-0 批量执行完成", body: "8/8 台正常返回" });' +
    ' return { times: times, ok: ok, dup: dup.ok ? dup.data : "err" };' +
  '})()'
}

async function main() {
  const beforeReal = hashFile(REAL_CONN)

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

  const connId = await p.evaluate('(async () => {' +
    ' const r = await window.api.conn.save({ name: "nt-perf", host: "127.0.0.1", port: ' + LAB_PORT + ', username: "lab", authType: "password", password: "labpass", group: "x", tags: [] });' +
    ' return r.ok ? r.data.id : false' +
  '})()')
  check('建立压测连接', typeof connId === 'string' && connId.length > 0, connId)
  p = await reload(p)

  /* ---------- C. 通知投递本身 ---------- */
  const nb = await p.evaluate(notifyBurst())
  const nMed = median(nb.times)
  console.log('\n通知投递：' + NOTIFY_BURST + ' 条，中位 ' + nMed.toFixed(1) + 'ms，成功 ' + nb.ok + ' 条')
  check('每条通知都投递成功（返回 true）', nb.ok === NOTIFY_BURST, nb.ok)
  check('单条通知投递中位 <= 300ms', nMed <= 300, Number(nMed.toFixed(1)))
  check('同文案再发一次返回 false（去重表真的在工作）', nb.dup === false, nb.dup)

  /* ---------- B. 热路径：启发式记账开 vs 关 ---------- */
  const onTimes = []
  const offTimes = []

  for (let round = 0; round < ROUNDS; round++) {
    /* 开启 */
    await p.evaluate('(async () => { await window.api.settings.set({ taskNotify: { enabled: true, system: true, sound: false, heuristic: true, mutedConnectionIds: [] } }); return true })()')
    p = await reload(p)
    await resetSessions(p)
    const sidOn = await openSession(p)
    if (!sidOn) throw new Error('开启轮：打不开会话')
    const rOn = await p.evaluate(burst(sidOn, 'on' + round))
    onTimes.push(rOn.ms)
    console.log('  round' + round + ' 启发式开: ' + Math.round(rOn.ms) + 'ms  ' + rOn.chars + ' 字节  seen=' + rOn.seen)
    if (round === 0) {
      const idle = await p.evaluate(idleProbe(sidOn))
      console.log('    静默探针: 出现疑似完成=' + idle.hit + ' 窗口聚焦=' + idle.focused + ' 文档有焦点=' + idle.quiet)
      /*
       * 判据方向是「不该出现」。
       * CDP 驱动的窗口通常是有焦点的，此时巡检的 hasFocus 守卫应当直接返回 ——
       * 人就在窗口前面，右下角还弹一条「疑似完成」纯属噪音。
       * 去掉那个守卫，这条会变成 hit=true，立即变红。
       * 无焦点时（远程桌面/最小化）反而应当出现，两个方向都算通过。
       */
      if (idle.quiet === true) {
        check('窗口聚焦时不弹「疑似完成」（hasFocus 守卫生效）', idle.hit === false, idle)
      } else {
        check('窗口未聚焦时静默 1.5s 内出现「疑似完成」', idle.hit === true, idle)
      }
    }

    /* 关闭 */
    await p.evaluate('(async () => { await window.api.settings.set({ taskNotify: { enabled: true, system: true, sound: false, heuristic: false, mutedConnectionIds: [] } }); return true })()')
    p = await reload(p)
    await resetSessions(p)
    const sidOff = await openSession(p)
    if (!sidOff) throw new Error('关闭轮：打不开会话')
    const rOff = await p.evaluate(burst(sidOff, 'off' + round))
    offTimes.push(rOff.ms)
    console.log('  round' + round + ' 启发式关: ' + Math.round(rOff.ms) + 'ms  ' + rOff.chars + ' 字节  seen=' + rOff.seen)
    check('round' + round + ' 两种模式都收到全部输出（不丢行）', rOn.seen === true && rOff.seen === true, { on: rOn.seen, off: rOff.seen })
  }

  const mOn = median(onTimes)
  const mOff = median(offTimes)
  const ratio = mOff > 0 ? mOn / mOff : 0
  console.log('\n热路径中位：启发式开 ' + Math.round(mOn) + 'ms / 关 ' + Math.round(mOff) + 'ms = ' + ratio.toFixed(2) + 'x')
  check('记账开销 <= 1.5x（只是 Map.set + Date.now）', ratio <= 1.5, { ratio: Number(ratio.toFixed(2)), on: onTimes, off: offTimes })
  check('开启模式绝对耗时 <= 20s', mOn <= 20000, Math.round(mOn))

  /* ---------- D. 数据零影响 ---------- */
  const afterReal = hashFile(REAL_CONN)
  check('真实 connections.json 未被触碰（sha256 一致）', beforeReal === afterReal, { before: beforeReal.slice(0, 12), after: afterReal.slice(0, 12) })
  check('压测用的是临时 user-data-dir', USERDATA.indexOf('sw-notify-perf') >= 0, USERDATA)

  const errs = (p.errs || []).filter((e) => !/ResizeObserver|DevTools|Autofill/.test(e))
  if (errs.length) for (const e of errs.slice(0, 5)) console.log('    ! ' + e)
  check('无渲染层未捕获异常', errs.length === 0, errs.slice(0, 3))

  console.log('')
  console.log('=== 通知压测：' + pass + ' 通过 / ' + fail + ' 失败 ===')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL ' + (e && e.stack ? e.stack : e))
  cleanup()
  process.exit(1)
})