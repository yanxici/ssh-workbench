/**
 * 动效自检（阶段 1）。
 *
 * 为什么静态断言 + 一次 computed style 抽查，而不是录屏/截图：
 *   动效在时间维度上，截图只能证明终态；本机也没有录帧能力。
 *   真正能区分「改没改」的是三件事：
 *     A. 样式表里存在抬升/入场/关闭三组规则，且数值是定案的那一版；
 *     B. 组件上确实挂了类与错峰参数（CSS 写了没人用等于没写）；
 *     C. 开关链路闭合：settings → html.motion-off → 计算样式真的归零。
 *
 * 每条断言都满足「修复未落地时会红」：删掉任何一处编辑，对应断言立刻 FAIL。
 *
 * 用法：node scripts/verify-motion.cjs
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
function pickPort(min, max) { return min + Math.floor(Math.random() * (max - min)) }
const APP_PORT = Number(process.env.MOTION_CDP_PORT || pickPort(21000, 29000))
const USERDATA = path.join(os.tmpdir(), 'sw-motion-probe-' + process.pid + '-' + Date.now())
const children = []
const sockets = []
function killTree(c) { if (!c) return; try { c.kill() } catch {}
  try { spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
function cleanup() { for (const c of children) killTree(c) }
process.on('exit', cleanup)
/* 套件里（run-all-verify 用 spawnSync 接管管道）必须自己收尾：
   WebSocket 与 Electron 子进程会一直握着事件循环，之前会把整套 verify 卡死。
   这里给硬超时 + 结束时显式退出，杜绝「结果已打印但进程不退」。 */
const WATCHDOG_MS = Number(process.env.MOTION_WATCHDOG_MS || 150000)
const watchdog = setTimeout(() => {
  console.error('探针超时：' + WATCHDOG_MS + 'ms 内未结束，按失败退出')
  finish(1)
}, WATCHDOG_MS)
watchdog.unref()
function finish(code) {
  clearTimeout(watchdog)
  for (const ws of sockets) { try { ws.close() } catch {} }
  cleanup()
  /* 留一点时间把 stdout 冲进管道，再硬退出 —— 否则管道模式可能丢最后几行 */
  setTimeout(() => process.exit(code), 150)
}
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')) }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PORT = String(APP_PORT)
async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json()
      const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (p) return p
    } catch {}
    await sleep(400)
  }
  throw new Error('no target')
}
function connect(url) {
  const ws = new WebSocket(url)
  const pending = new Map()
  let seq = 0
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    }
  })
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)) } }, 45000)
  })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception && r.exceptionDetails.exception.description)
    return r.result.value
  }
  sockets.push(ws)
  return { ready, send, evaluate, ws }
}
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
/* 取某个 CSS 块（从 selector 起到配对的 }），用于断言「这段规则里确实写了这几行」 */
function cssBlock(css, selector) {
  const i = css.indexOf(selector)
  if (i < 0) return ''
  let depth = 0
  let started = false
  for (let j = i; j < css.length; j++) {
    if (css[j] === '{') { depth++; started = true }
    else if (css[j] === '}') { depth--; if (started && depth === 0) return css.slice(i, j + 1) }
  }
  return ''
}

async function main() {
  const css = read('src/renderer/src/styles/index.css')
  const cmdCenter = read('src/renderer/src/components/commands/CommandCenter.tsx')
  const cmdCard = read('src/renderer/src/components/commands/CommandCard.tsx')
  const tabBar = read('src/renderer/src/components/layout/TabBar.tsx')
  const sidebar = read('src/renderer/src/components/connections/ConnectionSidebar.tsx')
  const sectionUi = read('src/renderer/src/components/settings/sectionUi.tsx')
  const types = read('src/shared/types.ts')
  const mainSettings = read('src/main/store/repo/settings.ts')
  const store = read('src/renderer/src/stores/settingsStore.ts')
  const expSection = read('src/renderer/src/components/settings/ExperimentalSection.tsx')

  console.log('\n[A. 样式表：抬升 / 入场 / 关闭]')
  /* 主线是 Tailwind 3：没有 @theme，--shadow-lift 直接定义在默认 :root 主题块里 */
  check('--shadow-lift 在默认主题块定义（Tailwind 3 无 @theme）', /--shadow-lift:\s*0 1px 2px rgb\((?:0 0 0|15 23 42) \/ 0\.0[56]\)/.test(css))
  const liftDefs = css.match(/--shadow-lift:\s*0 /g) || []
  /* 三处主题块各一份：默认 :root、.light、.dark。少一份就会在某个主题下没有投影 */
  check('三套主题各定义一份 --shadow-lift', liftDefs.length === 3, liftDefs.length)
  check('暗色用深投影片而不是浅色 rgb(15 23 42)', /\n\s*--shadow-lift: 0 1px 2px rgb\(0 0 0 \/ 0\.4\)/.test(css))

  const hoverLift = cssBlock(css, ".motion-lift:hover:not([data-active='true'])")
  check('悬停抬升把选中卡排除在选择器里', hoverLift.includes('translateY(-1px)'), hoverLift.slice(0, 120))
  check('悬停用 --shadow-lift 而不是 --shadow-pop', hoverLift.includes('var(--shadow-lift)'))
  const pressLift = cssBlock(css, '.motion-lift:active')
  /* 按下必须「回落 + 微缩」：只缩不回落会停在半抬位置，看起来像粘住 */
  check('按下回落并缩放 0.98', pressLift.includes('translateY(0)') && pressLift.includes('scale(0.98)'), pressLift.slice(0, 140))
  check('按下比抬升快（60ms）', pressLift.includes('60ms'))
  const liftBase = cssBlock(css, '.motion-lift {')
  check('抬升段同列 transition 且覆盖 transform/box-shadow', liftBase.includes('transform 120ms') && liftBase.includes('box-shadow 120ms'), liftBase.slice(0, 160))

  const wallIn = cssBlock(css, '@keyframes wall-in')
  check('入场关键帧 4px 上移淡入', wallIn.includes('translateY(4px)') && wallIn.includes('opacity: 0'), wallIn.slice(0, 160))
  check('.motion-in 用 wall-in 且 both 收尾', /\.motion-in\s*{[^}]*animation:\s*wall-in 180ms[^}]*both/.test(css))

  const conn = cssBlock(css, '.conn-hint::before')
  check('连接行左条是伪元素（零布局占用）', conn.includes("content: ''") && conn.includes('position: absolute'), conn.slice(0, 140))
  check('连接行左条预设 opacity 0 再淡入', conn.includes('opacity: 0') && css.includes('.conn-hint:hover::before'))
  /* Tailwind 3 的 rotate-90 是 --tw-rotate 合成的 transform，过渡列写 transform 才有效 */
  check('chevron 用 transform 过渡（Tailwind 3 的 rotate-90 走 transform）', /\.chev-rot\s*{[^}]*transition:\s*transform/.test(css))
  check('活动栏只改底色、不含 transform', /\.activity-item:not\(\.activity-item-active\):hover\s*{[^}]*background-color/.test(css))

  /* 主线按钮是 @layer components 里的 .btn，不是 Tailwind 4 的 @utility */
  const btnUtil = cssBlock(css, '.btn {')
  check('.btn 按下缩到 0.97', btnUtil.includes('active:scale-[0.97]'), btnUtil.slice(0, 200))
  check('.btn 过渡列含 transform（Tailwind 3 按下缩放走 transform）', btnUtil.includes('transform]'))
  check('.btn-icon 按下缩到 0.94', cssBlock(css, '.btn-icon {').includes('active:scale-[0.94]'))

  const off = cssBlock(css, '.motion-off *:not(.xterm-cursor-blink),')
  check('.motion-off 通配关掉 transition 与 animation 且豁免 .xterm-cursor-blink', off.includes('transition: none !important') && off.includes('animation: none !important'), off.slice(0, 160))
  const offLift = cssBlock(css, '.motion-off .motion-lift,')
  /* 只关 transition 不归零 transform，等于把动画换成瞬移 —— 必须显式清掉 */
  check('.motion-off 把位移与投影归零', offLift.includes('transform: none !important') && offLift.includes('box-shadow: none !important'))

  console.log('\n[B. 组件挂了类与参数]')
  check('命令墙卡片挂 motion-lift + motion-in', cmdCenter.includes('rounded-lg border px-2 py-1.5 motion-lift motion-in'))
  check('命令墙卡片有动画延迟', cmdCenter.includes('animationDelay: `${delay}ms`'))
  check('错峰只给前 12 张、其余统一 144ms', cmdCenter.includes('i >= 0 && i < 12 ? i * 12 : 144'))
  check('范围索引与新建命令都有按压缩放', (cmdCenter.match(/active:scale-\[0\.98\]/g) || []).length >= 2, (cmdCenter.match(/active:scale-\[0\.98\]/g) || []).length)
  check('CommandCard 暴露 data-active（CSS 靠它排除选中卡）', cmdCard.includes('data-active={active}'))
  check('CommandCard 挂 motion-lift', cmdCard.includes('text-left motion-lift motion-in'))
  check('标签页关闭按钮未激活时淡入', tabBar.includes('opacity-0 group-hover:opacity-100'))
  check('标签页关闭按钮过渡含 opacity', tabBar.includes('transition-[color,background-color,opacity]'))
  check('连接行挂 conn-hint', sidebar.includes("'conn-hint focus-visible:bg-hover"))
  check('连接分组箭头是旋转而非互切', sidebar.includes("cn('chev-rot shrink-0', !isCollapsed && 'rotate-90')"))
  check('连接分组不再有双图标三元', !sidebar.includes('isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />'))
  check('设置分组箭头同通道', sectionUi.includes("cn('chev-rot shrink-0 text-ink-3', open && 'rotate-90')"))
  check('sectionUi 未留未使用的 ChevronDown 导入', sectionUi.includes("import { ChevronRight } from 'lucide-react'"))

  console.log('\n[C. 开关链路闭合]')
  check('ExperimentalFlags 有 motion', /motion\?:\s*boolean/.test(types))
  check('主进程默认 motion: true', /experimental: \{ tokens: \{\}, terminalRenderer: 'dom', motion: true \}/.test(mainSettings))
  check('渲染层 FALLBACK 同步 motion: true', /experimental: \{ tokens: \{\}, terminalRenderer: 'dom', motion: true \}/.test(store))
  check('applyMotion 折算 prefers-reduced-motion', store.includes('prefers-reduced-motion: reduce') && store.includes("classList.toggle('motion-off'"))
  const applyCalls = (store.match(/applyMotion\(/g) || []).length
  /* 定义 1 次 + load 1 次 + update 1 次 + 媒体监听 1 次；少一处就会「改了设置不生效」 */
  check('applyMotion 四处都接上了', applyCalls >= 4, applyCalls)
  check('设置页有动效开关且默认视为开', expSection.includes('settings.experimental?.motion !== false') && expSection.includes('motion: on'))

  console.log('\n[D. 计算样式真的归零]')
  try { fs.rmSync(USERDATA, { recursive: true, force: true }) } catch { /* 还有残留进程占着目录时留给系统清理 */ }
  fs.mkdirSync(USERDATA, { recursive: true })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const exe = process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron')
  if (!fs.existsSync(exe)) throw new Error('找不到 Electron 二进制：' + exe)
  const app = spawn(exe, ['.', '--user-data-dir=' + USERDATA, '--remote-debugging-port=' + APP_PORT, '--disable-gpu', '--no-sandbox'], { cwd: ROOT, env, stdio: 'ignore' })
  children.push(app)
  await sleep(9000)
  const t = await getTarget()
  const p = connect(t.webSocketDebuggerUrl)
  await p.ready
  await p.send('Runtime.enable')
  let ready = false
  for (let i = 0; i < 150; i++) {
    try { if (await p.evaluate('document.body && document.body.innerText.length > 100')) { ready = true; break } } catch {}
    await sleep(200)
  }
  if (!ready) throw new Error('应用 30s 内未就绪')

  const probeSrc = [
    '(() => {',
    "const mk = (cls) => { const el = document.createElement('div'); el.className = cls; el.style.width = '100px'; el.style.height = '20px'; document.body.appendChild(el); return el }",
    'const out = {}',
    "out.mediaReduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches",
    "out.hasOffClass = document.documentElement.classList.contains('motion-off')",
    "const lift = mk('motion-lift')",
    "const btn = document.querySelector('.btn') || mk('btn')",
    "const curStyle = document.createElement('style')",
    "curStyle.textContent = '@keyframes _probe_blink { 50% { opacity: 0; } } .xterm-cursor.xterm-cursor-blink { animation: _probe_blink 1s step-end infinite; }'",
    "document.head.appendChild(curStyle)",
    "const cur = mk('xterm-cursor xterm-cursor-blink')",
    "const wall = mk('motion-in')",
    "document.documentElement.classList.remove('motion-off')",
    'out.liftTransition = getComputedStyle(lift).transitionProperty',
    'out.btnTransition = getComputedStyle(btn).transitionProperty',
    "out.shadowVar = getComputedStyle(document.documentElement).getPropertyValue('--shadow-lift').trim()",
    "document.documentElement.classList.add('motion-off')",
    'out.liftOff = getComputedStyle(lift).transitionProperty',
    'out.btnOff = getComputedStyle(btn).transitionProperty',
    'out.liftOffTransform = getComputedStyle(lift).transform',
    'out.wallOffAnim = getComputedStyle(wall).animationName',
    'out.cursorOffAnim = getComputedStyle(cur).animationName',
    "out.btnTag = btn.tagName + '|' + String(btn.className).slice(0, 80)",
    'out.btnOffAll = getComputedStyle(btn).transition',
    'out.htmlClass = document.documentElement.className',
    "out.btnMatchesWildcard = btn.matches('.motion-off *')",
    'out.btnInDoc = btn.getRootNode() === document',
    "out.btnInline = btn.getAttribute('style') || null",
    "out.freshOff = getComputedStyle(mk('btn btn-primary')).transitionProperty",
    'out.sheets = document.styleSheets.length',
    "document.documentElement.classList.remove('motion-off')",
    'lift.remove()',
    'cur.remove()',
    'wall.remove()',
    'curStyle.remove()',
    'return out',
    '})()',
  ].join('\n')
  const probe = await p.evaluate(probeSrc)
  /* 本机（远程桌面/VM）常常把「减少动态效果」开着，此时 .motion-off 默认就挂在 html 上。
     所以断言「类的存在与否 == 系统偏好」，而不是「默认没有这个类」——
     这正是开关链路要保证的东西：链路没接时 mediaReduce 为 true 而类不在，必红。 */
  check('motion-off 与系统偏好一致（链路闭合）', probe.hasOffClass === probe.mediaReduce, { hasOffClass: probe.hasOffClass, mediaReduce: probe.mediaReduce })
  check('摘掉 .motion-off 后卡片过渡恢复 transform/box-shadow', probe.liftTransition.includes('transform') && probe.liftTransition.includes('box-shadow'), probe.liftTransition)
  check('摘掉 .motion-off 后 .btn 过渡含 transform（否则按下跳变）', probe.btnTransition.includes('transform'), probe.btnTransition)
  check('--shadow-lift 解析出实际投影而非空串', probe.shadowVar.startsWith('0 1px 2px'), probe.shadowVar)
  check('挂上 .motion-off 后卡片过渡归零', probe.liftOff === 'none', probe.liftOff)
  check('挂上 .motion-off 后 .btn 过渡归零', probe.btnOff === 'none', probe)
  check('挂上 .motion-off 后位移归零', probe.liftOffTransform === 'none', probe.liftOffTransform)
  check('挂上 .motion-off 后界面入场动画归零', probe.wallOffAnim === 'none', probe.wallOffAnim)
  check('挂上 .motion-off 后终端光标闪烁动画保留', probe.cursorOffAnim === '_probe_blink', probe.cursorOffAnim)

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败')
  finish(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error('探针异常：' + (e && e.message)); finish(1) })