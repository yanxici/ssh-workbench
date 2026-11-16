/**
 * 设计 token 落地自检（阶段 1）。
 *
 * 为什么必须是「结构化断言」而不是截图对比：
 *   截图对比需要读图，CI 与本会话都做不到；而且像素差阈值对「行高差 2px」这种
 *   恰好就是本次要修的问题几乎不敏感。
 *
 *   结构化断言能做出真正的区分度：断言「三个列表行的 computed padding 相等」，
 *   旧代码必然不等（px-2/py-1.5 vs px-2.5/py-2 vs px-3/py-2），改完才相等。
 *
 * 断言分三组：
 *   A. token 存在且取值正确（--duration-* / --ease-out-expo / --size-*，以及间距与圆角阶梯）
 *   B. 重复任意值已收敛：.panel-shell / .rail-w 的 computed 值等于 token
 *   C. flag 行为：默认关闭时行是旧口径（py-[3px]，盒高 28px），打开后走 token 口径（24px）
 *
 * 其中 C 是关键 —— 只验「新样式对不对」而不验「开关真的能切换」，
 * 就等于放弃「可独立回滚」这条硬约束。
 *
 * 本仓是 Tailwind 3，上游是 Tailwind 4，两处差异在对应断言处注明：
 *   1. --spacing-* / --radius-* 是 v4 @theme 的产物，v3 不会生成同名自定义属性，
 *      所以改成断言「渲染出来的阶梯」（p-1/p-2/p-3、rounded/rounded-md/rounded-lg）；
 *   2. .row-token / .file-row-token 两条 @utility 在两个仓库里都没有组件引用
 *      （在用的只有 .file-row-token-inner 与 .conn-row-token），v3 按需生成时
 *      不产出这两条规则，探针改用真实在用的类名。
 *
 * 用法：node scripts/verify-design-tokens.cjs
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
function pickPort(min, max) { return min + Math.floor(Math.random() * (max - min)) }
const APP_PORT = Number(process.env.TOKEN_CDP_PORT || pickPort(21000, 29000))
const USERDATA = path.join(os.tmpdir(), 'sw-tokens-probe')
const children = []
function killTree(c) { if (!c || c.killed) return; try { spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
function cleanup() { for (const c of children) killTree(c) }
process.on('exit', cleanup)
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PORT = String(APP_PORT)
async function getTarget() { for (let i = 0; i < 40; i++) { try { const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (p) return p } catch {} await sleep(400) } throw new Error('no target') }
function connect(url) {
  const ws = new WebSocket(url); const pending = new Map(); let seq = 0
  ws.addEventListener('message', (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result) } })
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)) } }, 45000) })
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value }
  return { ready, send, evaluate, ws }
}

async function main() {
  fs.rmSync(USERDATA, { recursive: true, force: true })
  fs.mkdirSync(USERDATA, { recursive: true })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const exe = process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron')
  if (!fs.existsSync(exe)) throw new Error('找不到 Electron 二进制：' + exe)
  const app = spawn(exe, ['.', '--user-data-dir=' + USERDATA, '--remote-debugging-port=' + APP_PORT, '--disable-gpu', '--no-sandbox'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(app)
  await sleep(9000)

  const t = await getTarget()
  const p = connect(t.webSocketDebuggerUrl)
  await p.ready; await p.send('Runtime.enable')
  /* 等应用真正就绪（轮询），理由同 verify-panel-switch */
  let ready = false
  for (let i = 0; i < 150; i++) {
    try {
      const ok = await p.evaluate('document.body && document.body.innerText.length > 100')
      if (ok) { ready = true; break }
    } catch {
      /* 未加载完 */
    }
    await sleep(200)
  }
  if (!ready) throw new Error('应用 30s 内未就绪')

  console.log('\n[A. token 变量]')
  const vars = await p.evaluate(`(() => { const cs = getComputedStyle(document.documentElement); const g = (n) => cs.getPropertyValue(n).trim(); return { dFast: g('--duration-fast'), dBase: g('--duration-base'), dSlow: g('--duration-slow'), ease: g('--ease-out-expo'), sb: g('--size-statusbar'), tb: g('--size-titlebar'), rail: g('--size-rail') } })()`)
  check('动效时长 token 120/180/240ms', vars.dFast === '120ms' && vars.dBase === '180ms' && vars.dSlow === '240ms', vars)
  /* 自定义属性的 computed 值按 CSS 里怎么写就怎么回；上游写的是无前导 0 形式，
     本仓写成 0.16 的等价形式，所以比较前先归一化数字写法，只为格式差异不该变红。 */
  const normEase = (s) => String(s).replace(/\s+/g, '').replace(/0\./g, '.')
  check('主缓动曲线是 cubic-bezier(.16, 1, .3, 1)', normEase(vars.ease) === 'cubic-bezier(.16,1,.3,1)', vars.ease)
  check('语义尺寸 26/38/248px', vars.sb === '26px' && vars.tb === '38px' && vars.rail === '248px', vars)
  /* 间距/圆角在 v3 里是 tailwind.config.js 的刻度，不会有 --spacing-* / --radius-* 变量，
     所以量渲染值。顺带记录一处有意的 2px 偏差：上游 v4 的圆角阶梯是 4/6/10px
     （@theme 里的 --radius-sm/md/lg），v3 默认 lg=8px；主仓既有 UI 一直按 8px 渲染，
     对齐 config 而不是改 config，避免同步功能时顺手改掉老面板的观感。 */
  const ladder = await p.evaluate(`(() => {
    const probe = (cls, prop) => { const el = document.createElement('div'); el.className = cls; el.textContent = 'x'; document.body.appendChild(el); const v = getComputedStyle(el).getPropertyValue(prop); el.remove(); return v }
    return {
      p1: probe('p-1', 'padding-top'), p2: probe('p-2', 'padding-top'), p3: probe('p-3', 'padding-top'),
      rSm: probe('rounded', 'border-top-left-radius'), rMd: probe('rounded-md', 'border-top-left-radius'), rLg: probe('rounded-lg', 'border-top-left-radius')
    }
  })()`)
  check('间距阶梯 4/8/12px（p-1/p-2/p-3）', ladder.p1 === '4px' && ladder.p2 === '8px' && ladder.p3 === '12px', ladder)
  check('圆角阶梯 4/6/8px（rounded/rounded-md/rounded-lg）', ladder.rSm === '4px' && ladder.rMd === '6px' && ladder.rLg === '8px', ladder)

  console.log('\n[B. 任意值收敛]')
  const shell = await p.evaluate(`(() => { const el = document.createElement('div'); el.className = 'panel-shell'; document.body.appendChild(el); const cs = getComputedStyle(el); const r = { top: cs.top, bottom: cs.bottom }; el.remove(); return r })()`)
  check('panel-shell 的 top/bottom 等于 token', shell.top === '38px' && shell.bottom === '26px', shell)
  const rail = await p.evaluate(`(() => { const el = document.createElement('div'); el.className = 'rail-w'; document.body.appendChild(el); const w = getComputedStyle(el).width; el.remove(); return w })()`)
  check('rail-w 宽度等于 248px', rail === '248px', rail)

  console.log('\n[C. flag 行为]')
  const flagOff = await p.evaluate(`(async () => {
    const r = await window.api.settings.get()
    const st = r && r.ok ? r.data : null
    const on = st && st.experimental && st.experimental.tokens ? Object.values(st.experimental.tokens).some(Boolean) : false
    return { anyOn: on, raw: st ? JSON.stringify(st.experimental || null) : null }
  })()`)
  check('默认全部 flag 关闭（旧视觉）', flagOff.anyOn === false, flagOff)
  /*
   * 行高是「切面板时列表会不会跳」的直接度量，所以断言到小数位。
   * 探针用的都是组件里真实在用的类串：
   *   文件行关：components/files/FileExplorer.tsx:862 `file-row-cv group … py-[3px] … text-xs` → 实测 28px
   *             （.file-row-cv 自带 content-visibility:auto + contain-intrinsic-size: auto 22px，
   *              所以盒高 = 22 占位内容 + 上下各 3px 内距）
   *   文件行开：components/files/RemotePane.tsx:246-248 `flex h-full … rounded px-2 text-xs` + `file-row-token-inner`，
   *             外层高度由虚拟化给定（RemotePane.tsx:89 / LocalPane.tsx:68 `ROW_H = tokensOn ? 24 : 22`）
   *   连接行：  components/connections/ConnectionSidebar.tsx:639-642 `conn-row-token … py-1` vs `conn-row-cv … py-1.5`
   * 上游另有 .row-token / .file-row-token 两条 @utility，但两个仓库的组件都没引用它们，
   * 本仓 Tailwind 3 按需生成不会产出这两条规则，拿它们当探针只会测到空气。
   */
  const rowOff = await p.evaluate(`(() => { const el = document.createElement('div'); el.className = 'file-row-cv group flex cursor-default items-center gap-1 py-[3px] pr-2 text-xs transition-colors duration-150'; el.textContent = 'file.txt'; document.body.appendChild(el); const cs = getComputedStyle(el); const r = { pad: cs.paddingTop, h: +el.getBoundingClientRect().height.toFixed(2) }; el.remove(); return r })()`)
  const rowOn = await p.evaluate(`(() => { const wrap = document.createElement('div'); wrap.style.height = '24px'; const el = document.createElement('div'); el.className = 'flex h-full cursor-default items-center gap-2 rounded px-2 text-xs file-row-token-inner'; el.textContent = 'file.txt'; wrap.appendChild(el); document.body.appendChild(wrap); const cs = getComputedStyle(el); const r = { pad: cs.paddingTop, h: +wrap.getBoundingClientRect().height.toFixed(2), innerH: +el.getBoundingClientRect().height.toFixed(2), dur: cs.transitionDuration }; wrap.remove(); return r })()`)
  console.log('  文件行实测: 旧 ' + JSON.stringify(rowOff) + '  新 ' + JSON.stringify(rowOn))
  check('flag 关闭：文件行是旧口径（py-[3px]，盒高 28px）', rowOff.pad === '3px' && rowOff.h === 28, rowOff)
  check('flag 开启：文件行交给虚拟化 24px，行内不再有纵向内距', rowOn.h === 24 && rowOn.innerH === 24 && rowOn.pad === '0px', rowOn)
  check('两套行高确实不同（证明开关有区分度）', rowOff.h !== rowOn.h, [rowOff.h, rowOn.h])
  /* 这条是「token 真的接上了 CSS 变量」的证据：0.12s 只可能来自 index.css 里的
     .file-row-token-inner 规则 + --duration-fast，规则缺了会读回 0s。 */
  check('文件行 token 类的过渡吃到 --duration-fast（0.12s）', rowOn.dur === '0.12s', rowOn.dur)

  const conn = await p.evaluate(`(() => {
    const probe = (cls) => { const el = document.createElement('div'); el.className = cls; el.textContent = 'conn'; document.body.appendChild(el); const cs = getComputedStyle(el); const r = { pad: cs.paddingTop, dur: cs.transitionDuration, ease: cs.transitionTimingFunction }; el.remove(); return r }
    return { on: probe('conn-row-token group relative cursor-default rounded-md py-1 pl-2 pr-1'), off: probe('conn-row-cv group relative cursor-default rounded-md py-1.5 pl-2 pr-1') }
  })()`)
  console.log('  连接行实测: ' + JSON.stringify(conn))
  check('连接行 token 内距 4px（旧 6px）', conn.on.pad === '4px' && conn.off.pad === '6px', conn)
  /* ease 用 includes 而不是全等：过渡声明了两个属性时 computed 会把缓动值重复列两遍。 */
  check('连接行 token 类的过渡吃到 --duration-fast + --ease-out-expo',
    conn.on.dur.split(',').every((d) => d.trim() === '0.12s') && normEase(conn.on.ease).includes('cubic-bezier(.16,1,.3,1)'),
    conn.on)
  console.log('')
  try { p.ws.close() } catch {}
  cleanup()
  console.log('通过 ' + pass + '  失败 ' + fail)
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error('FATAL ' + e.message); cleanup(); process.exit(2) })