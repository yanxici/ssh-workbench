/**
 * 验证批量删除：一次 IPC 删除 N 条，且数据真的从磁盘消失。
 * 用临时分组做，跑完自清理。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const os = require('node:os')

app.setPath('userData', path.join(os.homedir(), 'AppData', 'Roaming', 'ssh-workbench'))
require(path.join(__dirname, '..', 'out', 'main', 'index.js'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : '')) }
}

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 60; i++) {
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (win) break
    await sleep(250)
  }
  await sleep(3000)
  const run = (c) => win.webContents.executeJavaScript(c, true)
  const G = 'DELTEST-' + Date.now()

  const base = await run('(async () => { const r = await window.api.conn.list(); return (r.data ?? r).length })()')
  console.log('\n[批量删除验证] 基线 ' + base + ' 条')

  // 建 10 条
  await run(`(async () => {
    for (let i = 0; i < 10; i++) {
      await window.api.conn.save({
        name: 'DEL-' + i, host: '192.0.2.' + i, port: 22, username: 'd',
        authType: 'password', group: '${G}', tags: []
      })
    }
  })()`)

  const made = await run(`(async () => {
    const r = await window.api.conn.list()
    return (r.data ?? r).filter((c) => c.group === '${G}').length
  })()`)
  check('创建 10 条测试连接', made === 10, String(made))

  // 一次批量删除
  const del = await run(`(async () => {
    const r = await window.api.conn.list()
    const ids = (r.data ?? r).filter((c) => c.group === '${G}').map((c) => c.id)
    const t0 = performance.now()
    const res = await window.api.conn.removeMany(ids)
    return { removed: res.data ?? res, ms: performance.now() - t0, reqCount: ids.length }
  })()`)
  check('removeMany 返回删除条数 10', del.removed === 10, JSON.stringify(del.removed))
  console.log('  INFO  10 条批量删除耗时 ' + del.ms.toFixed(1) + 'ms（一次 IPC）')

  const after = await run(`(async () => {
    const r = await window.api.conn.list()
    const all = r.data ?? r
    return { left: all.filter((c) => c.group === '${G}').length, total: all.length }
  })()`)
  check('组内已清空', after.left === 0, String(after.left))
  check('总数回到基线', after.total === base, after.total + ' vs ' + base)

  const failed = fail
  console.log('\n结果：' + pass + ' 通过 / ' + failed + ' 失败\n')
  app.exit(failed === 0 ? 0 : 1)
}).catch((e) => { console.error(e); app.exit(2) })
