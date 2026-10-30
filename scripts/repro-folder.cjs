#!/usr/bin/env node
/**
 * 上传文件夹的真实环境复现：真 SFTP 服务器 + 真应用 + 真对话框补丁。
 *
 * 造一个刁钻的目录：深层嵌套、空目录、中文/空格/特殊字符名、批量小文件、
 * 然后走 uploadFolderDialog（= 工具栏「上传文件夹」的实际链路），
 * 最后逐个比对远端磁盘。
 *
 * 用法：node scripts/repro-folder.cjs [--app=PATH_TO_EXE]
 */
const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')

const ROOT_DIR = path.resolve(__dirname, '..')
const SFTP_PORT = 2301
const APP_PORT = 9361
const MAIN_PORT = 9362
const TMP = process.env.TEMP || os.tmpdir()
const SRC = path.join(TMP, 'repro-src')
const DST = path.join(TMP, 'repro-dst')
const USERDATA = path.join(TMP, 'repro-userdata')

const argApp = process.argv.find((a) => a.startsWith('--app='))
const APP_EXE = argApp ? argApp.slice(6) : null

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex')

function buildFixture() {
  fs.rmSync(SRC, { recursive: true, force: true })
  fs.rmSync(DST, { recursive: true, force: true })
  fs.mkdirSync(DST, { recursive: true })

  const put = (rel, content) => {
    const p = path.join(SRC, ...rel.split('/'))
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }

  /* 1. 六层深嵌套 */
  put('proj/src/deep/a/b/c/d/e/f.txt', 'deep-level-6')
  /* 2. 中文目录 + 空格 */
  put('proj/中文 目录/文件 1.txt', 'unicode-content')
  /* 3. 特殊字符名 */
  put("proj/weird#%&'()[]{} 名字.txt", 'weird-name')
  /* 4. 空目录（两层都是空的） */
  fs.mkdirSync(path.join(SRC, 'proj', 'emptyTop', 'child'), { recursive: true })
  /* 5. 只有子目录、内有文件的中间目录 */
  put('proj/nested/level1/level2/x.txt', 'nested')
  /* 6. 批量小文件 */
  for (let i = 0; i < 120; i++) {
    put(`proj/bulk/f${String(i).padStart(3, '0')}.txt`, `bulk-${i}`)
  }
  /* 7. 符号链接/junction：真实项目里 node_modules/.bin、pnpm、OneDrive 到处都是 */
  try {
    fs.symlinkSync(SRC, path.join(SRC, 'proj', 'junctionLoop'), 'junction')
  } catch (e) {
    console.log('[fixture] junction 创建失败 ' + e.message)
  }

  /* 8. 隐藏/点号开头 */
  put('proj/.hidden/secret.txt', 'hidden')

  const stats = countTree(SRC)
  console.log(`[fixture] 文件 ${stats.files} 个，目录 ${stats.dirs} 个，${SRC}`)
  return stats
}

function countTree(dir) {
  let files = 0
  let dirs = 0
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name)
      // 链接不计入文件数：上传时会刻意跳过，统计里算进去会让等待永远超时
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        dirs++
        walk(full)
      } else files++
    }
  }
  walk(dir)
  return { files, dirs }
}

function treeMap(dir, base = dir, out = {}) {
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    const rel = path.relative(base, full).split(path.sep).join('/')
    if (e.isDirectory()) {
      out[rel + '/'] = 'dir'
      treeMap(full, base, out)
    } else if (e.isSymbolicLink()) {
      out[rel] = 'link'
    } else out[rel] = md5(full)
  }
  return out
}

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
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
    }
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
  return { evalJs, close: () => ws.close() }
}

async function waitFor(fn, timeoutMs, stepMs = 250) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await fn()) return true
    await sleep(stepMs)
  }
  return false
}

async function main() {
  const children = []
  const kill = (c) => {
    if (!c || c.killed) return
    try {
      spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
    } catch {}
  }
  const cleanup = () => children.forEach(kill)
  process.on('exit', cleanup)
  process.on('uncaughtException', (e) => {
    console.error('[repro] 异常', e)
    cleanup()
    process.exit(1)
  })

  const stats = buildFixture()

  /* 1. SFTP 服务器 */
  const srv = spawn(process.execPath, [path.join(__dirname, 'lab-sftp-server.cjs')], {
    env: { ...process.env, SFTP_ROOT: DST, SFTP_PORT: String(SFTP_PORT), SFTP_PASS: 'labpass', SFTP_HOST_KEY: path.join(TMP, 'repro-host-key.pem') },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  children.push(srv)
  srv.stdout.on('data', (d) => {
    if (process.env.VERBOSE) process.stdout.write('[srv] ' + d)
  })

  /* 2. 应用 */
  fs.rmSync(USERDATA, { recursive: true, force: true })
  const exe = APP_EXE || require('electron')
  const args = APP_EXE
    ? [`--user-data-dir=${USERDATA}`, `--remote-debugging-port=${APP_PORT}`, `--inspect=${MAIN_PORT}`]
    : ['.', `--user-data-dir=${USERDATA}`, `--remote-debugging-port=${APP_PORT}`, `--inspect=${MAIN_PORT}`]
  const appEnv = { ...process.env }
  delete appEnv.ELECTRON_RUN_AS_NODE
  const app = spawn(exe, args, { cwd: ROOT_DIR, env: appEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(app)
  const appLog = []
  app.stdout.on('data', (d) => appLog.push(String(d)))
  app.stderr.on('data', (d) => appLog.push(String(d)))

  const up = await waitFor(async () => {
    try {
      const l = await (await fetch(`http://127.0.0.1:${APP_PORT}/json/list`)).json()
      return l.some((x) => x.type === 'page' && x.webSocketDebuggerUrl)
    } catch {
      return false
    }
  }, 40000)
  if (!up) throw new Error('应用没起来\n' + appLog.join('').slice(-2000))

  let page = await attach(APP_PORT, 'page')
  const mainCdp = await attach(MAIN_PORT, 'main')

  /* 3. 补丁对话框：按 properties 分派 */
  await mainCdp.evalJs(
    `(() => {
      const electron = (typeof require === 'function' ? require : process.mainModule.require)('electron')
      globalThis.__repro = { dirs: [], calls: [] }
      electron.dialog.showOpenDialog = async (a, b) => {
        const opts = (b && b.properties) ? b : (a || {})
        const isDir = Array.isArray(opts.properties) && opts.properties.includes('openDirectory')
        globalThis.__repro.calls.push(isDir ? 'dir' : 'file')
        return { canceled: false, filePaths: isDir ? globalThis.__repro.dirs : [] }
      }
      return 'patched'
    })()`,
    true
  )
  await mainCdp.evalJs(`globalThis.__repro.dirs = ${JSON.stringify([SRC])}; 'set'`, true)

  /* 渲染层可能因保存连接而重载：求值失败就重挂一次再重试 */
  const evalRetry = async (expr) => {
    for (let i = 0; i < 4; i++) {
      try {
        return await page.evalJs(expr)
      } catch (e) {
        const msg = String(e && e.message)
        if (!/context was destroyed|Cannot find context/i.test(msg)) throw e
        await sleep(1500)
        try { page.close() } catch {}
        page = await attach(APP_PORT, 'page')
      }
    }
    throw new Error('求值反复失败：' + expr.slice(0, 60))
  }

  /* 4. 建连接 / 开会话 */
  const conn = await evalRetry(
    `window.api.conn.save({ name: 'repro', host: '127.0.0.1', port: ${SFTP_PORT}, username: 'lab', authType: 'password', password: 'labpass', group: 'repro', tags: [] }).then(r => JSON.stringify(r))`
  )
  if (!/"ok":true/.test(conn)) throw new Error('建连接失败 ' + conn)
  /* conn.save 会触发渲染层重载，旧 CDP 上下文失效，必须重新附着 */
  await sleep(2000)
  page.close()
  page = await attach(APP_PORT, 'page')
  const connId = JSON.parse(conn).data.id
  const sid = 'repro-session-1'
  await evalRetry(
    `window.api.session.open({ sessionId: '${sid}', connectionId: '${connId}', cols: 120, rows: 32 }).then(r => JSON.stringify(r))`
  )
  await sleep(2500)

  /* 5. 走真实链路：uploadFolderDialog(sid, '/updir', true) */
  const t0 = Date.now()
  const res = await evalRetry(
    `window.api.sftp.uploadFolderDialog('${sid}', '/updir', true).then(r => JSON.stringify(r))`
  )
  console.log(`[upload] ${res}  用时 ${Date.now() - t0}ms`)
  const calls = await mainCdp.evalJs(`JSON.stringify(globalThis.__repro.calls)`, true)
  console.log(`[dialog] 调用序列 ${calls}`)

  if (/"canceled":false/.test(res)) {
    const m = /"count":(\d+)/.exec(res)
    const count = m ? Number(m[1]) : 0
    const done = await waitFor(
      () => countTree(DST).files >= stats.files,
      Math.max(60000, count * 300)
    )
    console.log(`[wait] 落盘等待 ${done ? 'ok' : '超时'}`)
  }

  /* 6. 比对 */
  const expectAll = treeMap(SRC, SRC, {})
  /* 符号链接本就不该传，从期望里摘掉，单独断言「远端不能出现」 */
  const expectLinks = Object.keys(expectAll).filter((k) => expectAll[k] === 'link')
  const expect = {}
  for (const [k, v] of Object.entries(expectAll)) if (v !== 'link') expect[k] = v
  /* 远端落点 = 目标目录/本地目录名（keepRoot），所以基准取那个同名目录 */
  const landing = path.join(DST, 'updir', path.basename(SRC))
  const got = treeMap(landing, landing, {})
  const missing = []
  const wrong = []
  const extraDirs = []
  for (const [k, v] of Object.entries(expect)) {
    if (!(k in got)) missing.push(k)
    else if (v !== 'dir' && got[k] !== v) wrong.push(k)
  }
  for (const [k, v] of Object.entries(got)) {
    if (v === 'dir' && !(k in expect)) extraDirs.push(k)
  }
  const emptyDirs = ['proj/emptyTop/', 'proj/emptyTop/child/']
  const emptyMissing = emptyDirs.filter((d) => !(d in got))

  const total = Object.keys(expect).length
  console.log(`\n[expect] ${total} 项（含目录）`)
  console.log(`[got]    ${Object.keys(got).length} 项`)
  console.log(`[missing] ${missing.length}`)
  missing.slice(0, 20).forEach((m) => console.log('   - ' + m))
  if (missing.length > 20) console.log(`   ... 共 ${missing.length}`)
  console.log(`[md5 不一致] ${wrong.length}`)
  wrong.slice(0, 10).forEach((m) => console.log('   ! ' + m))
  console.log(`[空目录缺失] ${emptyMissing.length ? emptyMissing.join(', ') : '无'}`)
  if (extraDirs.length) console.log(`[多余] ${extraDirs.slice(0, 5).join(', ')}`)

  const jl = path.join(landing, 'proj', 'junctionLoop')
  console.log(`[junction] 远端存在: ${fs.existsSync(jl)} ${fs.existsSync(jl) ? 'size=' + fs.statSync(jl).size : ''}`)
  const junctionLeaked = fs.existsSync(jl)
  const pass = missing.length === 0 && wrong.length === 0 && emptyMissing.length === 0 && !junctionLeaked
  console.log(`\n==== ${pass ? 'PASS' : 'FAIL'} ====`)

  page.close()
  mainCdp.close()
  cleanup()
  await sleep(500)
  process.exit(pass ? 0 : 1)
}

main()
