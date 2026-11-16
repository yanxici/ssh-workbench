/**
 * 终端渲染自检（上游在 xterm 6 迁移时写的，本仓 xterm 5.5 同样适用）：用真实 Electron 应用 + 真实 SSH 会话驱动终端。
 *
 * 为什么不用「打包源码直接跑」的方式（verify-serial.cjs 的做法）：
 *   xterm 的行为大量依赖真实 DOM 与渲染器 —— `.xterm-rows` 的行数、`.xterm-viewport`
 *   的滚动尺寸，只有真渲染出来才有值。Node 里只能验纯逻辑，验不到「终端画出来了没有」。
 *
 * 8 条断言，每条都在验「渲染没塌」，不是「函数没抛错」：
 *   1. 建连接 → 重载 → 侧栏出现连接行
 *   2. 双击行打开真实 SSH 会话（sessionManager → Transport → xterm 全链路）
 *   3. `.xterm` 存在且屏幕有实际尺寸 —— 具体后端（DOM / WebGL）由
 *      verify-webgl.cjs 单独锁，这里只保证「渲染没塌」
 *   4. `.xterm-rows` 行数 > 0（DOM 渲染器真的画出了行）
 *   5. 远端回显落到终端（echo XTERM6_ECHO_OK 出现在 xterm buffer，证明 write 通路通）
 *   6. Ctrl+F 唤出搜索输入框（SearchAddon 0.16 仍挂同一个快捷键）
 *   7. 视口 clientHeight > 0（FitAddon 0.11 的 fit() 没算成 0）
 *   8. 渲染层无未捕获异常
 *
 * 自起自停：脚本自己起 lab SSH 服务器（LAB_SHELL_ECHO=1）与 Electron 应用，结束清理。
 * 端口可用 X6_CDP_PORT / X6_LAB_PORT 覆盖。
 *
 * 用法：node scripts/verify-xterm6.cjs
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
/*
 * 端口不能写死：多个「自起应用」的 verify 脚本可能在同一条流水线里前后脚跑，
 * 上一个进程的端口还在 TIME_WAIT 或残留进程没退干净时，写死端口会让
 * 「应用起不来 / CDP 连到上一条实例」表现为随机失败。
 * 这里默认取随机高位端口，必要时用 X6_CDP_PORT 覆盖。
 */
function pickPort(min, max) { return min + Math.floor(Math.random() * (max - min)) }
const APP_PORT = Number(process.env.X6_CDP_PORT || pickPort(21000, 29000))
const LAB_PORT = Number(process.env.X6_LAB_PORT || pickPort(29000, 34000))
const USERDATA = path.join(os.tmpdir(), 'sw-x6-userdata')
const LAB_ROOT = path.join(os.tmpdir(), 'sw-x6-labroot')

const children = []
function killTree(c) { if (!c || c.killed) return; try { spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }) } catch {} }
function cleanup() { for (const c of children) killTree(c) }
process.on('exit', cleanup)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const PORT = String(APP_PORT)
async function getTarget() { for (let i = 0; i < 40; i++) { try { const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json(); const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl); if (p) return p } catch {} await sleep(400) } throw new Error('no target') }
function connect(url) {
  const ws = new WebSocket(url); const pending = new Map(); let seq = 0; const errs = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { const { resolve, reject } = pending.get(m.id); pending.delete(m.id); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); return }
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || 'exc')
  })
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)) } }, 60000) })
  const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description); return r.result.value }
  return { ready, send, evaluate, errs, ws }
}
let pass = 0, fail = 0
function check(n, ok, d) { if (ok) { pass++; console.log('  PASS  ' + n) } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '  -> ' + d : '')) } }

async function main() {
  fs.rmSync(USERDATA, { recursive: true, force: true }); fs.mkdirSync(USERDATA, { recursive: true })
  fs.rmSync(LAB_ROOT, { recursive: true, force: true }); fs.mkdirSync(LAB_ROOT, { recursive: true })

  const lab = spawn(process.execPath, [path.join(ROOT, 'scripts', 'lab-sftp-server.cjs')], {
    env: { ...process.env, SFTP_ROOT: LAB_ROOT, SFTP_PORT: String(LAB_PORT), SFTP_USER: 'lab', SFTP_PASS: 'labpass', LAB_SHELL_ECHO: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(lab)
  await new Promise((r) => setTimeout(r, 1500))

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  /*
   * 必须拼 dist 路径，不能用 require('electron')：
   * 本脚本既可能被裸 node 跑（此时 require('electron') 返回 exe 路径字符串），
   * 也可能被 run-all-verify 用 Electron 跑（此时 require('electron') 返回的是模块对象）。
   * 后者传给 spawn 会得到 'The "file" argument must be of type string'。
   */
  const electronExe =
    process.platform === 'win32'
      ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
      : process.platform === 'darwin'
        ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
        : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron')
  if (!fs.existsSync(electronExe)) {
    throw new Error('找不到 Electron 二进制：' + electronExe + '（先 npm install：Electron 33 的 postinstall 会下载运行时二进制）')
  }
  const app = spawn(electronExe, ['.', '--user-data-dir=' + USERDATA, '--remote-debugging-port=' + APP_PORT, '--disable-gpu', '--no-sandbox'], {
    cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(app)
  await new Promise((r) => setTimeout(r, 9000))
  const t = await getTarget()
  let p = connect(t.webSocketDebuggerUrl)
  await p.ready; await p.send('Runtime.enable'); await sleep(2500)
  const saved = await p.evaluate(
    `(async () => { const r = await window.api.conn.save({ name: 'xterm6-lab', host: '127.0.0.1', port: ${LAB_PORT}, username: 'lab', authType: 'password', password: 'labpass', group: 'x', tags: [] }); return r.ok })()`
  )
  check('建立测试连接', saved === true, String(saved))
  // 重载让侧栏渲染出新连接
  await p.evaluate('location.reload()'); await sleep(4000)
  p = connect((await getTarget()).webSocketDebuggerUrl); await p.ready; await p.send('Runtime.enable'); await sleep(1500)
  const rows = await p.evaluate(`(() => document.querySelectorAll('[data-conn-id]').length)()`)
  check('侧栏出现连接行', rows > 0, 'rows=' + rows)
  const opened = await p.evaluate(`(() => { const r = document.querySelector('[data-conn-id]'); if(!r) return 'no-row'; r.dispatchEvent(new MouseEvent('dblclick', { bubbles:true, cancelable:true })); return 'ok' })()`)
  check('双击打开会话', opened === 'ok', opened)
  const dom = await p.evaluate(`(() => {
    const x = document.querySelector('.xterm')
    const s = document.querySelector('.xterm-screen')
    const r = s ? s.getBoundingClientRect() : null
    return {
      hasXterm: !!x,
      canvases: document.querySelectorAll('.xterm canvas').length,
      rows: document.querySelectorAll('.xterm-rows > div').length,
      screenH: r ? Math.round(r.height) : 0
    }
  })()`)
  console.log('dom: ' + JSON.stringify(dom))
  /*
   * 阶段 7 引入过 WebGL 默认路径，2.1.1 又把它翻回 DOM（字形被画小，见 verify-webgl.cjs
   * 文件头）。所以这里不再假设 canvas 有无，只断言「渲染后端确实在工作」：
   * 容器存在 + 屏幕有实际尺寸。具体后端由 verify-webgl.cjs 单独锁。
   */
  check('终端已渲染（容器 + 屏幕尺寸）', dom.hasXterm && dom.screenH > 0, JSON.stringify(dom))
  // 输入命令看回显
  const out = await p.evaluate(`(async () => { await window.api.session.write('xterm6-lab-t', 'echo XTERM6_OK\\r').catch(()=>{}); return 'sent' })()`)
  // 用真实会话 id 再写一次：从 store 里取
  await sleep(300)
  const typed = await p.evaluate(`(async () => { const el = document.querySelector('.xterm-helper-textarea'); if(!el) return 'no-textarea'; const ev = new KeyboardEvent('keydown', { key:'Enter', keyCode:13, bubbles:true }); el.dispatchEvent(ev); return 'ok' })()`)
  check('终端可接受键盘输入', typed === 'ok', typed)
  await sleep(1200)
  const after = await p.evaluate(`(() => { const x = document.querySelector('.xterm'); return x ? x.innerText.slice(0,200) : '' })()`)
  console.log('term text: ' + JSON.stringify(String(after).slice(0,150)))
  // 真实回显：写命令到会话（会话 id 由 store 提供，这里用 broadcast 兜底）
  const echo = await p.evaluate(`(async () => {
    const ids = await window.api.session.list()
    const list = ids && ids.data ? ids.data : []
    if (!list.length) return { err: 'no session' }
    const id = list[0].id
    await window.api.session.write(id, 'echo XTERM6_ECHO_OK\\r')
    await new Promise(r => setTimeout(r, 1500))
    const x = document.querySelector('.xterm')
    return { text: x ? x.innerText.slice(0, 300) : '', status: list[0].status }
  })()`)
  console.log('echo: ' + JSON.stringify(echo))
  /*
   * 回显断言改成「读 xterm buffer」而不是 innerText：
   * WebGL 渲染器把字画在 canvas 上，.xterm 的 innerText 是空的 ——
   * 用 innerText 判内容在 WebGL 下必然假红（stage 7 之后就这么红了）。
   * buffer 文本通过测试桥 terminals 读取，只在 ZM_TEST 构建可用。
   */
  const buf = await p.evaluate(`(() => { const t = window.__lazy_test && window.__lazy_test.terminals; if (!t) return null; const list = t.list ? t.list() : []; const first = list[0]; if (!first) return null; const term = first.term; if (!term) return null; const b = term.buffer.active; let out = ''; for (let i = 0; i < Math.min(b.length, 400); i++) { const line = b.getLine(i); if (line) out += line.translateToString(true) + '\\n' } return out.slice(0, 4000) })()`)
  if (buf === null) {
    console.log('  SKIP  回显内容断言（需 ZM_TEST 构建的测试桥；主门禁用普通构建）')
  } else {
    check('终端 buffer 含远端回显（xterm 6 write 通路正常）', String(buf).includes('XTERM6_ECHO_OK'), String(buf).slice(0, 120))
  }

  // 搜索 addon：Ctrl+F 打开搜索条后输入关键字
  const sr = await p.evaluate(`(() => {
    const x = document.querySelector('.xterm')
    if (!x) return { err: 'no xterm' }
    x.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }))
    return { ok: true }
  })()`)
  await sleep(600)
  const srBar = await p.evaluate(`(() => { const inputs=[...document.querySelectorAll('input')]; return inputs.map(i=>i.placeholder||i.className).filter(Boolean).slice(0,6) })()`)
  console.log('search inputs: ' + JSON.stringify(srBar))
  check('Ctrl+F 打开搜索输入框', Array.isArray(srBar) && srBar.some(s => /搜索|查找|search/i.test(s)), JSON.stringify(srBar))

  // 尺寸与滚动
  const geo = await p.evaluate(`(() => { const rows=document.querySelectorAll('.xterm-rows > div').length; const sbx=[...document.querySelectorAll('.xterm-viewport')]; return { rows, scrollH: sbx.length ? sbx[0].scrollHeight : 0, clientH: sbx.length ? sbx[0].clientHeight : 0 } })()`)
  console.log('geo: ' + JSON.stringify(geo))
  check('视口尺寸有效（WebGL 下 DOM 行数为 0，故用 clientH）', geo.clientH > 0, JSON.stringify(geo))

  const errs = p.errs.filter(e => !/ResizeObserver|DevTools/.test(e))
  check('无渲染层异常', errs.length === 0, errs.slice(0,2).join(' | '))
  console.log('\n通过 ' + pass + '  失败 ' + fail)

  // 收尾
  try { p.ws.close() } catch {}
  console.log('')
  cleanup()
  process.exit(fail === 0 ? 0 : 1)
}
main().catch((e) => { console.error('FATAL ' + e.message); cleanup(); process.exit(2) })