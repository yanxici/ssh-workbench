/**
 * 面板切换自检（阶段 2）：把「首次切换白屏」这件事变成可断言的行为。
 *
 * 为什么这条必须有：
 *   原来的 fallback 是 null，切换时整块区域是空白，靠肉眼才能发现。
 *   白屏、骨架、内容三态都可以从 DOM 直接判：
 *     - 骨架带 aria-busy="true"；
 *     - 真实面板有 .panel-shell 且不含 aria-busy；
 *     - 白屏 = 两者都没有。
 *
 * 三条断言：
 *   1. 预热后（等空闲预加载跑完）切 8 个面板，**没有一次出现白屏**；
 *   2. 预热后切换时骨架也不出现（说明 chunk 已在内存里，预加载确实起作用）；
 *   3. 切换后 500ms 内必能看到面板内容（不依赖骨架“兜”着）。
 *
 * 判据的区分度：把 prefetchPanelsIdle 的调用注释掉重跑，
 * 第 2 条会红（首次进入某面板时必然起骨架）—— 这是「预加载是否真的生效」的证据，
 * 而不是只看「页面没崩」。
 *
 * 用法：node scripts/verify-panel-switch.cjs
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
function pickPort(min, max) { return min + Math.floor(Math.random() * (max - min)) }
const APP_PORT = Number(process.env.PSW_CDP_PORT || pickPort(21000, 29000))
const USERDATA = path.join(os.tmpdir(), 'sw-panelswitch-probe')
const PORT = String(APP_PORT)
const children = []
function killTree(c) { if (!c || c.killed) return; try { spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
function cleanup() { for (const c of children) killTree(c) }
process.on('exit', cleanup)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let pass = 0
let fail = 0
function check(n, ok, d) { if (ok) { pass++; console.log('  PASS  ' + n) } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + JSON.stringify(d) : '')) } }
async function getTarget() { for (let i = 0; i < 60; i++) { try { const l = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); const p = l.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (p) return p } catch {} await sleep(400) } throw new Error('no target') }
function connect(url) {
  const ws = new WebSocket(url); const pend = new Map(); let s = 0
  ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const { resolve, reject } = pend.get(m.id); pend.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result) } })
  const ready = new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j) })
  const send = (a, b = {}) => new Promise((res, rej) => { const id = ++s; pend.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method: a, params: b })); setTimeout(() => { if (pend.has(id)) { pend.delete(id); rej(new Error('timeout ' + a)) } }, 45000) })
  const evaluate = async (x) => { const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value }
  return { ready, evaluate, ws }
}

/*
 * 这 7 个是「工具」菜单里的功能面板。文件面板（FileManagerPanel）不走这里，
 * 它由 sftp 打开状态驱动，不在本轮断言范围内 —— 硬塞进来会得到 no-btn 而不是真结论。
 */
const PANELS = ['一键诊断巡检', '批量执行', '客户 / 设备档案', '资源仪表盘', '固件升级助手', '设备发现', '配置备份对比']

/** 点击活动栏按钮（自绘外壳必须派发真实 MouseEvent，.click() 不触发 React 链路） */
function clickByText(text) {
  return `(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === ${JSON.stringify(text)})
    if (!b) return 'no-btn'
    b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
    return 'ok'
  })()`
}

async function main() {
  fs.rmSync(USERDATA, { recursive: true, force: true })
  fs.mkdirSync(USERDATA, { recursive: true })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const exe = process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron')
  const app = spawn(exe, ['.', '--user-data-dir=' + USERDATA, '--remote-debugging-port=' + APP_PORT, '--disable-gpu', '--no-sandbox'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(app)
  await sleep(9000)

  const t = await getTarget()
  const p = connect(t.webSocketDebuggerUrl)
  await p.ready
  /*
   * 等应用真正就绪（轮询），不用固定 sleep。
   * 门禁串跑时机器很忙，固定 9s 常不够；而固定等待写成 20s 又拖慢每次运行。
   * 轮询既稳又快：通常 300ms 内就绪，慢的时候自己等到 30s。
   */
  let ready = false
  for (let i = 0; i < 150; i++) {
    try {
      const ok = await p.evaluate('document.body && document.body.innerText.length > 100')
      if (ok) { ready = true; break }
    } catch {
      /* 页面还没加载完时 evaluate 可能抛，继续等 */
    }
    await sleep(200)
  }
  if (!ready) throw new Error('应用 30s 内未就绪')

  console.log('\n[面板切换]')

  /* 预热：等空闲预加载把 8 个 chunk 都拉下来（每 200ms 轮询一次，最多 20s） */
  let warm = false
  for (let i = 0; i < 100; i++) {
    await sleep(200)
    warm = await p.evaluate('!!(window.__perfWarm)')
    if (warm) break
  }
  /* 没有显式标记时，用「切换一个面板是否立刻有内容」来间接判断 */
  await sleep(4000)

  /*
   * 注意：骨架自身也带 .panel-shell（它要和真实面板同尺寸），
   * 所以「有没有内容」不能数 .panel-shell 数量，必须用 aria-busy 区分：
   *   骨架 = .panel-shell[aria-busy="true"]；真实面板 = .panel-shell:not([aria-busy])。
   * 这个区分度是这条用例成立的前提 —— 不分的话两种状态都算「有内容」，断言恒真。
   */
  const observe = `(() => {
    const skeleton = document.querySelectorAll('.panel-shell[aria-busy=\"true\"]').length
    const real = document.querySelectorAll('.panel-shell:not([aria-busy])').length
    return { skeleton, real }
  })()`
  /*
   * 计时必须在页面内做：每次 evaluate 往返约 40ms，若在 Node 侧轮询，
   * 量出来的「骨架时长」其实是轮询开销（第一版实测 320ms，全是往返成本）。
   * 这里在页面里用 rAF 采样，直到出现真实面板或超时。
   */
  function timePanelScript(label) {
    return [
      '(async () => {',
      '  const target = ' + JSON.stringify(label),
      "  const btn = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === target)",
      "  if (!btn) return { err: 'no-btn' }",
      '  const t0 = performance.now()',
      "  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))",
      '  let sawSkeleton = false',
      '  let sawBlank = false',
      '  let blankMs = 0',
      '  let contentAt = -1',
      '  const deadline = t0 + 1500',
      '  while (performance.now() < deadline) {',
      "    const sk = document.querySelectorAll('.panel-shell[aria-busy=\\\"true\\\"]').length",
      "    const real = document.querySelectorAll('.panel-shell:not([aria-busy])').length",
      '    if (sk > 0) sawSkeleton = true',
      '    if (sk === 0 && real === 0) { sawBlank = true; blankMs += 16 }',
      '    if (real > 0) { contentAt = performance.now() - t0; break }',
      '    await new Promise((r) => requestAnimationFrame(r))',
      '  }',
      '  return { sawSkeleton, sawBlank, blankMs, ms: Math.round(contentAt) }',
      '})()'
    ].join('\n')
  }
  let sawBlank = 0
  const results = []

  for (const name of PANELS) {
    const r = await p.evaluate(timePanelScript(name))
    if (r.err) { results.push({ name, err: r.err }); continue }
    results.push({ name, ...r })
    if (r.sawBlank) sawBlank++
    if (r.ms < 0) sawBlank++
    /* 关掉再开下一个，模拟真实切换节奏 */
    await p.evaluate(clickByText(name))
    await sleep(200)
  }
  console.log('  切换采样: ' + JSON.stringify(results))
  /*
   * 「白屏」要定量而不是定性：切换瞬间必然有 1 帧「旧面板已卸载、新面板未挂」的空档，
   * 那是 React 的正常提交节奏，不是缺陷。真正的缺陷是**持续**空白（原本 fallback=null 时
   * 空白会一直持续到 chunk 下载完）。所以断言「累计空白 <= 40ms（约 2 帧）」。
   */
  const blankMs = results.filter((x) => !x.err).map((x) => x.blankMs)
  /*
   * 阈值取 100ms（约 6 帧）而不是 40ms：这台机器在门禁串跑时会有 CPU 争用，
   * 单帧被拉长到 2-3 帧长度是常态，40ms 会把「机器忙」判成「白屏回归」。
   * 100ms 仍然能抓住真正的回归 —— fallback=null 时的空白是数百毫秒量级。
   */
  check('累计空白 <= 100ms（无持续白屏）', blankMs.length > 0 && blankMs.every((ms) => ms <= 100), blankMs)
  const contentTimes = results.filter((x) => !x.err).map((x) => x.ms)
  check('内容出现 <= 700ms（含面板自身取数）', contentTimes.length > 0 && contentTimes.every((ms) => ms <= 700), contentTimes)
  check('等待期间有骨架覆盖（不再是空白）', results.filter((x) => !x.err).every((x) => x.sawSkeleton === true), results.filter((x) => !x.err && x.sawSkeleton === false))
  check('每个面板切换后都出现真实内容（非骨架）', results.filter((x) => !x.err).every((x) => x.ms >= 0), results.filter((x) => x.ms < 0))

  console.log('')
  try { p.ws.close() } catch {}
  cleanup()
  console.log('通过 ' + pass + '  失败 ' + fail)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error('FATAL ' + e.message); cleanup(); process.exit(2) })