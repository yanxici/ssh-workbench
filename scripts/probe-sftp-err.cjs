const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const os = require('node:os')
app.setPath('userData', path.join(os.homedir(), 'AppData', 'Roaming', 'ssh-workbench'))
require(path.join(__dirname, '..', 'out', 'main', 'index.js'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 60; i++) {
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (win) break
    await sleep(250)
  }
  await sleep(3000)
  const run = (c) => win.webContents.executeJavaScript(c, true)

  const raw = await run(`(async () => {
    const t0 = performance.now()
    const res = await window.api.sftp.list('__nonexistent__', '/').catch((e) => ({ thrown: String(e) }))
    return { ms: performance.now() - t0, res: JSON.parse(JSON.stringify(res ?? null)) }
  })()`)
  console.log(JSON.stringify(raw, null, 2))

  // 同时确认调用是否真的快速返回（不挂起）
  const timing = await run(`(async () => {
    const t0 = performance.now()
    try { await window.api.sftp.home('__nonexistent__') } catch (e) {}
    return performance.now() - t0
  })()`)
  console.log('home on bad session ms:', timing)
  app.exit(0)
}).catch((e) => { console.error(e); app.exit(1) })
