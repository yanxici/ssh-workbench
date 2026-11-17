// 端到端：真实打包产物（win-unpacked）在 SSHWB_UPDATE_URL 指向 Gitee feed 时的更新状态
// 用法：node scripts/probe-gitee-update-e2e.cjs [port]
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')
const os = require('os')

const PORT = process.argv[2] || '9411'
const FEED = process.env.FEED || 'https://gitee.com/w3554334905/ssh-workbench/releases/download/v2.2.0'
const EXE = 'D:\\ssh-workbench\\.tmp\\old-app\\SSH Workbench.exe'
const UDD = path.join('D:\\ssh-workbench\\.tmp', 'ud-e2e-gitee')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + PORT + '/json/list')
      const l = await r.json()
      const p = l.find((t) => t.type === 'page')
      if (p) return p
    } catch {}
    await sleep(500)
  }
  throw new Error('no CDP target')
}

function connect(url) {
  const ws = new WebSocket(url)
  const pending = new Map(); let seq = 0
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { const o = pending.get(m.id); pending.delete(m.id); m.error ? o.reject(new Error(JSON.stringify(m.error))) : o.resolve(m.result) }
  })
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq; pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')) } }, 40000)
  })
  const evaluate = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }
  return { ws, ready, evaluate }
}

;(async () => {
  fs.rmSync(UDD, { recursive: true, force: true })
  const env = { ...process.env, SSHWB_UPDATE_URL: FEED }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(EXE, ['--user-data-dir=' + UDD, '--remote-debugging-port=' + PORT], { env, stdio: 'ignore', cwd: 'D:\\ssh-workbench' })
  const logs = []
  try {
    const t = await getTarget()
    const cdp = connect(t.webSocketDebuggerUrl)
    await cdp.ready
    await sleep(1500)
    console.log('phase@1.5s:', JSON.stringify(await cdp.evaluate('window.api.update.state().then(r=>r.data)')).slice(0, 300))
    // 用 SSHWB_UPDATE_URL 覆盖 feed 后，手动触发一次强制检查
    await cdp.evaluate('window.api.update.check(true)')
    let st = null
    for (let i = 0; i < 40; i++) {
      st = await cdp.evaluate('window.api.update.state().then(r=>r.data)')
      if (st && (st.phase === 'available' || st.phase === 'error' || st.phase === 'idle')) break
      await sleep(1000)
    }
    console.log('ATEV:', JSON.stringify({ phase: st && st.phase, current: st && st.currentVersion, latest: st && st.latestVersion, error: st && st.error }).slice(0, 600))
    if (st && st.phase === 'available' && !process.env.SKIP_DOWNLOAD) {
      const t0 = Date.now()
      await cdp.evaluate('void window.api.update.download(); true')
      let ds = null
      for (let i = 0; i < 300; i++) {
        ds = await cdp.evaluate('window.api.update.state().then(r=>r.data)')
        if (ds && (ds.phase === 'downloaded' || ds.phase === 'error')) break
        await sleep(1000)
      }
      console.log('DL:', JSON.stringify({ phase: ds && ds.phase, percent: ds && ds.percent, total: ds && ds.total, err: ds && ds.error, secs: Math.round((Date.now() - t0) / 1000) }))
    }
  } catch (e) {
    console.log('ERR', e.message)
  } finally {
    try { child.kill() } catch {}
    await sleep(1500)
    process.exit(0)
  }
})()
