#!/usr/bin/env node
/**
 * 真实 UI 级 E2E 回归（文件管理链路）—— 不是「调 IPC 看看返回 ok」那种假测试。
 *
 * 做法：自带一个真 SSH/SFTP 服务器（scripts/lab-sftp-server.cjs）→ 启动真实 Electron 应用
 * → 通过 CDP 点真实按钮/右键菜单/弹窗输入 → 断言「远端磁盘 / 本地磁盘 / md5」。
 * 任何一步点不动、断言不过，直接 FAIL 并带出当时的 DOM 与 toast。
 *
 * 覆盖：新建目录 / 进入目录 / 上传文件 / 上传文件夹（保留目录名）/ 双击编辑远端文件并保存
 *      / 右键下载文件 / 右键下载目录 / 下载到默认目录 / 重命名 / 删除 / 刷新
 *
 * 用法：
 *   node scripts/e2e-ui-sftp.cjs              # 功能回归
 *   node scripts/e2e-ui-sftp.cjs --stress     # 追加压测：320 个文件 + 2 个大文件，全量 md5 校验
 *   node scripts/e2e-ui-sftp.cjs --keep       # 跑完不杀应用（排查用）
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const net = require('node:net')

const ROOT_DIR = path.resolve(__dirname, '..')
const TMP = process.env.TEMP || '.'
const APP_PORT = Number(process.env.E2E_APP_PORT || 9357)
const MAIN_PORT = Number(process.env.E2E_MAIN_PORT || 9358)
const SFTP_PORT = Number(process.env.E2E_SFTP_PORT || 2299)

const LAB_ROOT = path.join(TMP, 'e2e-sftp-root')
const LOCAL_SRC = path.join(TMP, 'e2e-local-src')
const DL_DIR = path.join(TMP, 'e2e-dl')
const USERDATA = path.join(TMP, 'e2e-userdata')

const STRESS = process.argv.includes('--stress')
const KEEP = process.argv.includes('--keep')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function log(...a) {
  console.log(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '))
}
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`)
  return !!ok
}
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex')
function md5Local(p) {
  try {
    return md5(p)
  } catch {
    return null
  }
}
function treeFiles(dir, base = dir, out = {}) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    const rel = path.relative(base, full).split(path.sep).join('/')
    if (e.isSymbolicLink()) continue
    if (e.isDirectory()) {
      out[rel + '/'] = 'dir'
      treeFiles(full, base, out)
    }
    else out[rel] = md5(full)
  }
  return out
}
/** 只取文件项（去掉空目录的 dir 标记），用于 md5 多重集比对 */
function fileOnly(map) {
  const out = {}
  for (const [k, v] of Object.entries(map)) if (v !== 'dir') out[k] = v
  return out
}

async function waitFor(fn, timeoutMs, stepMs = 250) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(stepMs)
  }
  return false
}

/* ---------------- CDP ---------------- */
async function attach(port, want) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const t = list.find((x) => x.webSocketDebuggerUrl && (want === 'main' ? true : x.type === 'page'))
  if (!t) throw new Error(`${want}: ${port} 无可用 target`)
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  let id = 0
  const pending = new Map()
  const events = []
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
      return
    }
    if (m.method) events.push(m)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id
      pending.set(i, { resolve, reject })
      ws.send(JSON.stringify({ id: i, method, params }))
    })
  const evalJs = async (expression, api = false) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
      includeCommandLineAPI: api
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails))
    }
    return r.result.value
  }
  return { ws, send, evalJs, events, close: () => ws.close() }
}

/* ---------------- 页面侧 SDK ---------------- */
const PAGE_SDK = `
window.__e2e = {
  props(n){ if(!n) return null; const k = Object.keys(n).find(x => x.startsWith('__reactProps$')); return k ? n[k] : null },
  ev(){ return { preventDefault(){}, stopPropagation(){}, nativeEvent:{}, clientX:240, clientY:320, button:0, buttons:0, target:null } },
  find(node, names){
    let c = node, d = 0
    while (c && d < 8) { const p = this.props(c); if (p) { for (const n of names) if (typeof p[n] === 'function') return p[n] } c = c.parentElement; d++ }
    return null
  },
  rows(){ return Array.from(document.querySelectorAll('[data-file-path]')) },
  row(name){ return this.rows().find(r => (r.textContent || '').includes(name)) || null },
  dblclick(name){ const r = this.row(name); if(!r) return 'no-row'; const f = this.find(r, ['onDoubleClick','onDblClick']); if(!f) return 'no-handler'; f(this.ev()); return 'ok' },
  ctx(name){ const r = this.row(name); if(!r) return 'no-row'; const f = this.find(r, ['onContextMenu']); if(!f) return 'no-handler'; f(this.ev()); return 'ok' },
  ctxBlank(){
    const cands = Array.from(document.querySelectorAll('.overflow-auto, .scroll-thin'))
    for (const c of cands) { const p = this.props(c); if (p && typeof p.onContextMenu === 'function') { p.onContextMenu(this.ev()); return 'ok' } }
    return 'no-blank-container'
  },
  menu(re){ const rx = new RegExp(re); const els = Array.from(document.querySelectorAll('body *')).filter(e => e.children.length <= 1 && (e.textContent||'').trim().length < 26 && rx.test((e.textContent||'').trim())); for (const el of els) { const f = this.find(el, ['onClick']); if (f) { f(this.ev()); return el.textContent.trim() } } return null },
  pickDirInModal(name){ const m = document.querySelector('.modal'); if (!m) return 'no-modal'; const els = Array.from(m.querySelectorAll('*')).filter(e => e.children.length <= 1 && (e.textContent||'').trim() === name); for (const el of els) { const f = this.find(el, ['onClick']); if (f) { f(this.ev()); return 'ok' } } return 'no-item' },
  modalDirValue(){ const i = document.querySelector('.modal input'); return i ? i.value : null },
  modalTitleHas(s){ const m = document.querySelector('.modal'); return m && (m.textContent||'').includes(s) ? 'ok' : null },
  btn(re){ const rx = new RegExp(re); const b = Array.from(document.querySelectorAll('button')).find(x => rx.test(x.getAttribute('title') || '')); if(!b) return false; b.click(); return true },
  setValue(el, v){ const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; const d = Object.getOwnPropertyDescriptor(proto, 'value').set; d.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) },
  modalInput(){ return document.querySelector('.modal input') || null },
  prompt(v){ const i = this.modalInput(); if(!i) return 'no-input'; this.setValue(i, v); const b = Array.from(document.querySelectorAll('.modal button')).find(x => x.textContent.trim() === '确定'); if(!b) return 'no-confirm'; b.click(); return 'ok' },
  confirmDanger(){ const bs = Array.from(document.querySelectorAll('.modal button')); const b = bs.find(x => (x.className||'').includes('btn-danger')) || bs.find(x => x.textContent.trim() === '删除'); if(!b) return 'no-btn'; b.click(); return 'ok' },
  editorTextarea(){ return Array.from(document.querySelectorAll('textarea')).find(t => !t.closest('.xterm')) || null },
  editorContent(){ const t = this.editorTextarea(); return t ? t.value : null },
  editorType(v){ const t = this.editorTextarea(); if(!t) return 'no-editor'; this.setValue(t, v); return 'ok' },
  editorSave(){ const b = Array.from(document.querySelectorAll('.modal button')).find(x => /保存到远端/.test(x.textContent)); if(!b) return 'no-save'; b.click(); return 'ok' },
  closeModal(){ const b = Array.from(document.querySelectorAll('.modal button')).find(x => /^(取消|关闭)$/.test(x.textContent.trim())); if(!b) return 'no-close'; b.click(); return 'ok' },
  modalOpen(){ return !!document.querySelector('.modal') },
  toastTexts(){ return Array.from(document.querySelectorAll('body *')).filter(e => e.children.length === 0 && e.closest('[data-toast], .toast')).map(e => e.textContent.trim()).slice(0, 6) },
  currentDir(){
    const els = Array.from(document.querySelectorAll('span[title]')).filter(e => (e.getAttribute('title') || '').startsWith('/'))
    /* 侧栏底部那一行显示的是当前目录，取最后一个（面板顺序靠后） */
    return els.length ? els[els.length - 1].getAttribute('title') : null
  },
  sidebarOpen(){ return Array.from(document.querySelectorAll('button')).some(b => /^上传文件/.test(b.getAttribute('title') || '')) },
  openSidebar(){ if (this.sidebarOpen()) return 'already'; const b = Array.from(document.querySelectorAll('button')).find(x => x.getAttribute('title') === '文件'); if(!b) return 'no-btn'; b.click(); return 'clicked' },
  sessionReady(){ return document.querySelectorAll('.xterm').length > 0 },
  openSession(){ const r = document.querySelector('[data-conn-id]'); if(!r) return 'no-conn'; const f = this.find(r, ['onDoubleClick','onDblClick']); if(!f) return 'no-handler'; f(this.ev()); return 'ok' }
}
'sdk-ready'
`

/* ---------------- 主流程 ---------------- */
async function main() {
  const started = Date.now()
  const children = []
  const killTree = (child) => {
    if (!child || child.killed) return
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        child.kill('SIGKILL')
      }
    } catch {}
  }
  const cleanup = () => {
    if (KEEP) return
    for (const c of children) killTree(c)
  }
  process.on('exit', cleanup)
  process.on('uncaughtException', (e) => {
    console.error('[e2e] 异常', e)
    cleanup()
    process.exit(1)
  })

  /* 1. 准备目录 */
  for (const d of [LAB_ROOT, LOCAL_SRC, DL_DIR, USERDATA]) fs.rmSync(d, { recursive: true, force: true })
  fs.mkdirSync(LAB_ROOT, { recursive: true })
  fs.mkdirSync(LOCAL_SRC, { recursive: true })
  fs.mkdirSync(DL_DIR, { recursive: true })
  fs.mkdirSync(USERDATA, { recursive: true })

  const srcFile = path.join(LOCAL_SRC, 'one.txt')
  fs.writeFileSync(srcFile, 'e2e payload v1\n' + 'x'.repeat(200) + '\n')
  const srcFolder = path.join(LOCAL_SRC, 'folderA')
  fs.mkdirSync(path.join(srcFolder, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(srcFolder, 'a.txt'), 'folder a\n')
  fs.writeFileSync(path.join(srcFolder, 'nested', 'deep.bin'), crypto.randomBytes(64 * 1024))
  /* 空目录（含两层空）与 junction：真实项目里到处都是，历史上一个丢、一个变 0 字节假文件 */
  fs.mkdirSync(path.join(srcFolder, 'emptySub', 'emptyLeaf'), { recursive: true })
  const srcFolderB = path.join(LOCAL_SRC, 'folderB')
  fs.mkdirSync(path.join(srcFolderB, 'onlyEmpty', 'leaf'), { recursive: true })
  fs.writeFileSync(path.join(srcFolderB, 'b.txt'), 'folder b\n')
  let junctionMade = false
  if (process.platform === 'win32') {
    try {
      fs.symlinkSync(srcFolder, path.join(srcFolder, 'junctionLoop'), 'junction')
      junctionMade = true
    } catch {
      /* 无权限创建 junction 就跳过这部分断言 */
    }
  }

  /* 2. 起 SFTP 服务器 */
  const sftp = spawn(process.execPath, [path.join(ROOT_DIR, 'scripts', 'lab-sftp-server.cjs')], {
    env: { ...process.env, SFTP_ROOT: LAB_ROOT, SFTP_PORT: String(SFTP_PORT), SFTP_USER: 'lab', SFTP_PASS: 'labpass' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(sftp)
  sftp.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write('[sftp] ' + d))
  sftp.stderr.on('data', (d) => process.stderr.write('[sftp:err] ' + d))
  const sftpUp = await waitFor(
    () =>
      new Promise((res) => {
        const s = net.connect(SFTP_PORT, '127.0.0.1')
        s.on('connect', () => (s.end(), res(true)))
        s.on('error', () => res(false))
      }),
    10000,
    200
  )
  if (!sftpUp) throw new Error('SFTP 服务器没起来')

  /* 3. 起应用（E2E_APP 指向打包后的 exe，用来验证「真正要发出去的那个二进制」） */
  const electronPath = process.env.E2E_APP || require('electron')
  const appArgs = process.env.E2E_APP
    ? [`--user-data-dir=${USERDATA}`, `--remote-debugging-port=${APP_PORT}`, `--inspect=${MAIN_PORT}`]
    : ['.', `--user-data-dir=${USERDATA}`, `--remote-debugging-port=${APP_PORT}`, `--inspect=${MAIN_PORT}`]
  const appEnv = { ...process.env }
  delete appEnv.ELECTRON_RUN_AS_NODE
  const app = spawn(electronPath, appArgs, {
    cwd: ROOT_DIR,
    env: appEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(app)
  const appLog = []
  app.stdout.on('data', (d) => {
    appLog.push(String(d))
    if (process.env.E2E_VERBOSE) process.stdout.write('[app] ' + d)
  })
  app.stderr.on('data', (d) => appLog.push(String(d)))

  const pageUp = await waitFor(async () => {
    try {
      const l = await (await fetch(`http://127.0.0.1:${APP_PORT}/json/list`)).json()
      return l.some((x) => x.type === 'page' && x.webSocketDebuggerUrl)
    } catch {
      return false
    }
  }, 60000, 400)
  if (!pageUp) throw new Error('应用 CDP 没起来：\n' + appLog.join('').slice(-2000))

  const mainCdp = await attach(MAIN_PORT, 'main')
  let page = await attach(APP_PORT, 'page')
  await page.send('Runtime.enable')
  await page.send('Log.enable')

  const jsErrors = []
  const collectErrors = (cdp) => {
    for (const e of cdp.events) {
      if (e.method === 'Runtime.exceptionThrown') {
        jsErrors.push(e.params.exceptionDetails?.exception?.description || 'exception')
      } else if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') {
        jsErrors.push(e.params.entry.text)
      }
    }
  }

  /* 4. 主进程打补丁：接管系统文件对话框 */
  await mainCdp.evalJs(
    `(() => {
      const electron = (typeof require === 'function' ? require : process.mainModule.require)('electron')
      globalThis.__e2e = { files: [], dirs: [], calls: [] }
      electron.dialog.showOpenDialog = async (a, b) => {
        const opts = (b && b.properties) ? b : (a || {})
        const isDir = Array.isArray(opts.properties) && opts.properties.includes('openDirectory')
        const val = isDir ? globalThis.__e2e.dirs : globalThis.__e2e.files
        globalThis.__e2e.calls.push({ isDir, val: val.slice() })
        if (!val || !val.length) return { canceled: true, filePaths: [] }
        return { canceled: false, filePaths: val.slice() }
      }
      return true
    })()`,
    true
  )

  const setDialog = async (kind, paths) =>
    mainCdp.evalJs(`(globalThis.__e2e.${kind} = ${JSON.stringify(paths)}, true)`, true)
  const dialogCalls = async () => mainCdp.evalJs('globalThis.__e2e.calls.length', true)

  const reload = async () => {
    await page.evalJs('location.reload(), 1')
    await sleep(1500)
    page.close()
    page = await attach(APP_PORT, 'page')
    await page.send('Runtime.enable')
    await page.send('Log.enable')
  }
  const sdk = async () => {
    await page.evalJs(PAGE_SDK)
  }

  /* 5. 建连接 → 重载 → 注入 SDK */
  const conn = await page.evalJs(
    `window.api.conn.save({ name: 'e2e-lab', host: '127.0.0.1', port: ${SFTP_PORT}, username: 'lab', authType: 'password', password: 'labpass', group: 'e2e', tags: [] }).then(r => JSON.stringify(r))`
  )
  check('建连接', /"ok":true/.test(conn), String(conn).slice(0, 120))
  await reload()
  await sdk()
  await sleep(800)

  /* S1 开会话 */
  const opened = await page.evalJs('window.__e2e.openSession()')
  const connUp = await waitFor(() => page.evalJs('window.__e2e.sessionReady()'), 20000)
  check('双击连接开会话', opened === 'ok' && connUp, `openSession=${opened}`)

  /* S2 文件侧栏 */
  await page.evalJs('window.__e2e.openSidebar()')
  const sideUp = await waitFor(() => page.evalJs('window.__e2e.sidebarOpen()'), 15000)
  check('打开文件侧栏', sideUp, '')

  const dirNow = async () => page.evalJs('window.__e2e.currentDir()')
  const remoteExists = (p) => fs.existsSync(path.join(LAB_ROOT, p.replace(/^\//, '')))
  const rows = async () => page.evalJs('window.__e2e.rows().length')
  const refresh = async () => {
    await page.evalJs(`window.__e2e.btn('^刷新当前目录$')`)
    await sleep(1200)
  }

  /* S3 新建目录（空白处右键 → 新建文件夹 → 输入 → 确定） */
  const ctxBlank = await page.evalJs(`window.__e2e.ctxBlank()`)
  await sleep(600)
  const mk = await page.evalJs(`window.__e2e.menu('^新建文件夹$')`)
  await sleep(500)
  const mkPrompt = await page.evalJs(`window.__e2e.prompt('e2e')`)
  const mkOk = await waitFor(() => remoteExists('/e2e'), 8000)
  await refresh()
  check('空白处右键 → 新建文件夹', ctxBlank === 'ok' && mk === '新建文件夹' && mkPrompt === 'ok' && mkOk, `ctx=${ctxBlank} menu=${mk} prompt=${mkPrompt}`)

  /* S4 进入 /e2e */
  const enter = await page.evalJs(`window.__e2e.dblclick('e2e')`)
  const entered = await waitFor(async () => (await dirNow()) === '/e2e', 8000)
  check('双击进入目录', enter === 'ok' && entered, `dir=${await dirNow()}`)

  /* S5 上传单文件 */
  await setDialog('files', [srcFile])
  await page.evalJs(`window.__e2e.btn('^上传文件到')`)
  await sleep(1200)
  const upConfirm = await page.evalJs(`window.__e2e.menu('^选择文件并上传$') || 'no-confirm'`)
  const upOk = await waitFor(() => remoteExists('/e2e/one.txt'), 20000)
  const upMd5 = upOk && md5Local(path.join(LAB_ROOT, 'e2e', 'one.txt')) === md5Local(srcFile)
  await refresh()
  check('上传单文件（工具栏 → 目标目录 → 选文件）', upOk && upMd5, `confirm=${upConfirm} md5=${upMd5}`)

  /* S6 上传文件夹（保留目录名） */
  await setDialog('dirs', [srcFolder])
  await page.evalJs(`window.__e2e.btn('^上传文件夹到')`)
  /* 新行为：先弹「上传文件夹到远端目录」，确认落点后才选本地文件夹 */
  const folderDlgTitle = await page.evalJs(`window.__e2e.modalTitleHas('上传文件夹到远端目录')`)
  const folderConfirm = await page.evalJs(`window.__e2e.menu('^选择文件夹并上传$') || 'no-confirm'`)
  const upDirOk = await waitFor(
    () =>
      remoteExists('/e2e/folderA/a.txt') &&
      remoteExists('/e2e/folderA/nested/deep.bin') &&
      remoteExists('/e2e/folderA/emptySub/emptyLeaf'),
    30000
  )
  const srcTree = treeFiles(srcFolder)
  const upTree = treeFiles(path.join(LAB_ROOT, 'e2e', 'folderA'))
  const upDirSame = JSON.stringify(srcTree) === JSON.stringify(upTree)
  const junctionLeaked = junctionMade && remoteExists('/e2e/folderA/junctionLoop')
  await refresh()
  check(
    '上传文件夹（保留同名目录 + 空目录 + 跳过链接）',
    upDirOk && upDirSame && folderDlgTitle === 'ok' && folderConfirm === '选择文件夹并上传' && !junctionLeaked,
    `目标目录弹窗=${folderDlgTitle} confirm=${folderConfirm} 结构一致=${upDirSame} 空目录=${remoteExists('/e2e/folderA/emptySub/emptyLeaf')} 链接泄漏=${junctionLeaked}`
  )

  /* S6b 上传文件夹 → 自选下级目标目录（用户明确抱怨过的场景） */
  fs.mkdirSync(path.join(LAB_ROOT, 'e2e', 'sub-target'), { recursive: true })
  await refresh()
  await setDialog('dirs', [srcFolderB])
  await page.evalJs(`window.__e2e.btn('^上传文件夹到')`)
  /* 目录列表是异步拉的，等它出现再点，避免测成「弹窗还没加载」 */
  const subListed = await waitFor(
    async () => (await page.evalJs(`window.__e2e.pickDirInModal('sub-target')`)) === 'ok',
    10000,
    300
  )
  const pickSub = subListed ? 'ok' : 'no-item'
  await sleep(400)
  const subDirValue = await page.evalJs(`window.__e2e.modalDirValue()`)
  const subConfirm = await page.evalJs(`window.__e2e.menu('^选择文件夹并上传$') || 'no-confirm'`)
  const subOk = await waitFor(
    () => remoteExists('/e2e/sub-target/folderB/b.txt') && remoteExists('/e2e/sub-target/folderB/onlyEmpty/leaf'),
    30000
  )
  const subTreeSame =
    JSON.stringify(treeFiles(srcFolderB)) ===
    JSON.stringify(treeFiles(path.join(LAB_ROOT, 'e2e', 'sub-target', 'folderB')))
  await refresh()
  check(
    '上传文件夹到所选下级目录（弹窗内逐级选择）',
    pickSub === 'ok' && String(subDirValue).endsWith('/sub-target') && subOk && subTreeSame,
    `pick=${pickSub} 目录=${subDirValue} confirm=${subConfirm} 落盘=${subOk} 结构一致=${subTreeSame}`
  )

  /* S7 双击编辑远端文件并保存 */
  const edOpen = await page.evalJs(`window.__e2e.dblclick('one.txt')`)
  const edLoaded = await waitFor(async () => (await page.evalJs('window.__e2e.editorContent()')) !== null, 10000)
  const edContent = await page.evalJs('window.__e2e.editorContent()')
  const edSame = edContent === fs.readFileSync(srcFile, 'utf8')
  await page.evalJs(`window.__e2e.editorType('e2e payload v2 (edited in UI)\\n')`)
  await page.evalJs(`window.__e2e.editorSave()`)
  const edSaved = await waitFor(() => {
    try {
      return fs.readFileSync(path.join(LAB_ROOT, 'e2e', 'one.txt'), 'utf8').startsWith('e2e payload v2')
    } catch {
      return false
    }
  }, 15000)
  const bakOk = remoteExists('/e2e/one.txt.bak')
  check('双击打开远端文件 → 读到原文', edOpen === 'ok' && edLoaded && edSame, `同内容=${edSame}`)
  check('编辑器保存 → 远端更新 + .bak 备份', edSaved && bakOk, `bak=${bakOk}`)
  await page.evalJs('window.__e2e.closeModal()')
  await sleep(600)

  /* S8 右键下载文件 */
  fs.rmSync(DL_DIR, { recursive: true, force: true })
  fs.mkdirSync(DL_DIR, { recursive: true })
  await setDialog('dirs', [DL_DIR])
  await page.evalJs(`window.__e2e.ctx('one.txt')`)
  await sleep(700)
  const dlItem = await page.evalJs(`window.__e2e.menu('^下载$')`)
  const dlOk = await waitFor(() => fs.existsSync(path.join(DL_DIR, 'one.txt')), 20000)
  const dlSame = dlOk && md5Local(path.join(DL_DIR, 'one.txt')) === md5Local(path.join(LAB_ROOT, 'e2e', 'one.txt'))
  check('右键下载文件', dlItem === '下载' && dlOk && dlSame, `item=${dlItem} md5=${dlSame}`)

  /* S9 右键下载目录 */
  const dlFolderDir = path.join(DL_DIR, 'folder-out')
  fs.mkdirSync(dlFolderDir, { recursive: true })
  await setDialog('dirs', [dlFolderDir])
  await page.evalJs(`window.__e2e.ctx('folderA')`)
  await sleep(700)
  const dlDirItem = await page.evalJs(`window.__e2e.menu('^下载此目录$')`)
  const dlDirOk = await waitFor(
    () => fs.existsSync(path.join(dlFolderDir, 'folderA', 'nested', 'deep.bin')),
    30000
  )
  const dlDirSame = dlDirOk && JSON.stringify(treeFiles(path.join(dlFolderDir, 'folderA'))) === JSON.stringify(treeFiles(path.join(LAB_ROOT, 'e2e', 'folderA')))
  check('右键下载目录（递归）', dlDirItem === '下载此目录' && dlDirOk && dlDirSame, `item=${dlDirItem} 结构一致=${dlDirSame}`)

  /* S10 下载到默认「下载」文件夹 */
  const beforeCalls = await dialogCalls()
  await page.evalJs(`window.__e2e.ctx('folderA')`)
  await sleep(700)
  const dlDefItem = await page.evalJs(`window.__e2e.menu('^下载到')`)
  const afterCalls = await dialogCalls()
  check('下载到默认目录（不弹系统对话框）', dlDefItem !== null && afterCalls === beforeCalls, `item=${dlDefItem} 对话框调用 ${beforeCalls}→${afterCalls}`)

  /* S11 重命名 */
  await refresh()
  await page.evalJs(`window.__e2e.ctx('one.txt')`)
  await sleep(700)
  const rnItem = await page.evalJs(`window.__e2e.menu('^重命名$')`)
  await sleep(500)
  const rnDone = await page.evalJs(`window.__e2e.prompt('two.txt')`)
  const rnOk = await waitFor(() => remoteExists('/e2e/two.txt') && !remoteExists('/e2e/one.txt'), 10000)
  await refresh()
  check('右键重命名', rnItem === '重命名' && rnDone === 'ok' && rnOk, `item=${rnItem}`)

  /* S12 删除 */
  await page.evalJs(`window.__e2e.ctx('two.txt')`)
  await sleep(700)
  const delItem = await page.evalJs(`window.__e2e.menu('^(删除|删除目录)$')`)
  await sleep(600)
  const delConfirm = await page.evalJs('window.__e2e.confirmDanger()')
  const delOk = await waitFor(() => !remoteExists('/e2e/two.txt'), 10000)
  await refresh()
  check('右键删除（含确认框）', delItem === '删除' && delConfirm === 'ok' && delOk, `item=${delItem}`)

  /* S13 删除目录 */
  await page.evalJs(`window.__e2e.ctx('folderA')`)
  await sleep(700)
  const delDirItem = await page.evalJs(`window.__e2e.menu('^删除目录$')`)
  await sleep(600)
  await page.evalJs('window.__e2e.confirmDanger()')
  const delDirOk = await waitFor(() => !remoteExists('/e2e/folderA'), 15000)
  await refresh()
  check('右键删除目录（递归）', delDirItem === '删除目录' && delDirOk, `item=${delDirItem}`)

  /* S14 刷新不炸 */
  await refresh()
  const rowCount = await rows()
  check('刷新后列表可用', rowCount >= 0, `行数=${rowCount}`)

  /* ---------------- 压测 ---------------- */
  if (STRESS) {
    const bigDir = path.join(LOCAL_SRC, 'stress')
    fs.rmSync(bigDir, { recursive: true, force: true })
    fs.mkdirSync(bigDir, { recursive: true })
    const N = 320
    let totalBytes = 0
    for (let i = 0; i < N; i++) {
      const buf = crypto.randomBytes(2 * 1024)
      fs.writeFileSync(path.join(bigDir, `f${String(i).padStart(3, '0')}.bin`), buf)
      totalBytes += buf.length
    }
    for (let i = 0; i < 2; i++) {
      const buf = crypto.randomBytes(5 * 1024 * 1024)
      fs.writeFileSync(path.join(bigDir, `big${i}.bin`), buf)
      totalBytes += buf.length
    }
    fs.mkdirSync(path.join(LAB_ROOT, 'e2e'), { recursive: true })
    await setDialog('dirs', [bigDir])
    const tUp = Date.now()
    await page.evalJs(`window.__e2e.btn('^上传文件夹到')`)
    await sleep(600)
    const stressConfirm = await page.evalJs(`window.__e2e.menu('^选择文件夹并上传$') || 'no-confirm'`)
    if (!/选择文件夹并上传/.test(stressConfirm || ''))
      throw new Error('压测：目标目录确认按钮没点到 ' + stressConfirm)
    const expect = N + 2
    const allUp = await waitFor(() => {
      const dst = path.join(LAB_ROOT, 'e2e', 'stress')
      if (!fs.existsSync(dst)) return false
      return fs.readdirSync(dst).length >= expect
    }, 180000, 500)
    const upSec = ((Date.now() - tUp) / 1000).toFixed(1)
    await sleep(3000)
    const dst = path.join(LAB_ROOT, 'e2e', 'stress')
    const srcTreeBig = treeFiles(bigDir)
    const dstTreeBig = treeFiles(dst)
    const sameKeys = Object.keys(srcTreeBig).length === Object.keys(dstTreeBig).length
    const bad = Object.keys(srcTreeBig).filter((k) => srcTreeBig[k] !== dstTreeBig[k])
    check(
      `压测上传 ${expect} 个文件（${(totalBytes / 1024 / 1024).toFixed(1)} MB）`,
      allUp && sameKeys && bad.length === 0,
      `${upSec}s, 结构一致=${sameKeys}, md5 不符=${bad.length}${bad.length ? ' → ' + bad.slice(0, 3).join(',') : ''}`
    )

    /* 回读下载校验：右键 stress 目录 → 下载此目录（按 md5 多重集比对，不依赖本地落盘路径） */
    const dlStress = path.join(DL_DIR, 'stress-back')
    fs.rmSync(dlStress, { recursive: true, force: true })
    fs.mkdirSync(dlStress, { recursive: true })
    await setDialog('dirs', [dlStress])
    await refresh()
    await page.evalJs(`window.__e2e.ctx('stress')`)
    await sleep(800)
    const dlItem2 = await page.evalJs(`window.__e2e.menu('^下载此目录$')`)
    const tDl = Date.now()
    const want = Object.values(fileOnly(srcTreeBig)).sort()
    const backOk = await waitFor(() => {
      const got = Object.values(fileOnly(treeFiles(dlStress))).sort()
      return got.length >= want.length && got.join() === want.join()
    }, 180000, 500)
    const dlSec = ((Date.now() - tDl) / 1000).toFixed(1)
    const backTree = fileOnly(treeFiles(dlStress))
    const gotList = Object.values(backTree).sort()
    const dlBad = want.filter((h, i) => gotList[i] !== h)
    check(
      `压测下载回读 ${expect} 个文件`,
      backOk && dlBad.length === 0 && gotList.length === want.length,
      `item=${dlItem2} ${dlSec}s, 回读=${gotList.length}/${want.length}, md5 不符=${dlBad.length}`
    )

    check(
      '压测吞吐',
      true,
      `上传 ${(totalBytes / 1024 / 1024 / (Number(upSec) || 1)).toFixed(1)} MB/s，下载 ${(totalBytes / 1024 / 1024 / (Number(dlSec) || 1)).toFixed(1)} MB/s`
    )
  }

  /* ---------------- 渲染层错误 ---------------- */
  collectErrors(page)
  collectErrors(mainCdp)
  const realErrors = jsErrors.filter(
    (e) => !/DevTools|Autofill|net::ERR_|updater|Download the React DevTools/i.test(e)
  )
  check('渲染层无未捕获异常/错误日志', realErrors.length === 0, realErrors.slice(0, 2).join(' | ').slice(0, 300))

  /* ---------------- 汇总 ---------------- */
  const failed = results.filter((r) => !r.ok)
  const total = ((Date.now() - started) / 1000).toFixed(1)
  log('')
  log(`==== ${results.length - failed.length}/${results.length} PASS，用时 ${total}s ====`)
  if (failed.length) {
    log('失败项：')
    for (const f of failed) log(`  - ${f.name} ${f.detail || ''}`)
  }
  cleanup()
  setTimeout(() => process.exit(failed.length ? 1 : 0), 300)
}

main().catch((e) => {
  console.error('[e2e] 失败:', e && e.stack)
  process.exit(1)
})
