// 拆分后功能面：真调每个 IPC 域的代表通道（走真实主进程）
const port = process.argv[2] || '9347'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/json/list')
      const l = await r.json()
      const p = l.find((t) => t.type === 'page')
      if (p) return p
    } catch {}
    await sleep(500)
  }
  throw new Error('no target')
}
function connect(url) {
  const ws = new WebSocket(url)
  const pending = new Map()
  const errs = []
  let seq = 0
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const o = pending.get(m.id)
      pending.delete(m.id)
      m.error ? o.reject(new Error(JSON.stringify(m.error))) : o.resolve(m.result)
      return
    }
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || 'uncaught')
  })
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')) } }, 40000)
  })
  const evaluate = async (e) => {
    const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }
  return { ws, ready, evaluate, errs }
}
const results = [];
function check(n, ok, d) { results.push(ok); console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? ' - ' + d : '')) }
(async () => {
  const t = await getTarget()
  const cdp = connect(t.webSocketDebuggerUrl)
  await cdp.ready
  await sleep(1200)
  const domains = [
    ['errors', 'window.api.errors.stats()'],
    ['connections', 'window.api.conn.list()'],
    ['sessions', 'window.api.session.list()'],
    ['commands', 'window.api.command.list()'],
    ['history', "window.api.history.list({})"],
    ['settings', 'window.api.settings.paths()'],
    ['knownHosts', 'window.api.knownHosts.list()'],
    ['sftpScan', "window.api.sftp.scanFolders(['D:/ssh-workbench/package.json'])"],
    ['localFs', 'window.api.local.home()'],
    ['logs', 'window.api.logs.list()'],
    ['tunnels', 'window.api.tunnel.list()'],
    ['clip', 'window.api.clip.read()'],
    ['diag', 'window.api.diag.reports()'],
    ['profiles', 'window.api.profiles.list()'],
    ['metrics', 'window.api.metrics.states()'],
    ['backups', 'window.api.backups.list()'],
    ['update', 'window.api.update.state()']
  ]
  for (const [name, expr] of domains) {
    let r = null
    try { r = await cdp.evaluate(expr) } catch (e) { r = { ok: false, error: String(e.message) } }
    check(name + ' domain ok', r && r.ok === true, r && !r.ok ? r.error : '')
  }
  check('no uncaught exceptions', cdp.errs.length === 0, cdp.errs.slice(0, 2).join(' | '))
  cdp.ws.close()
  const failed = results.filter((x) => !x).length
  console.log('')
  console.log((results.length - failed) + '/' + results.length + ' passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error('ERR', e.message); process.exit(2) })
