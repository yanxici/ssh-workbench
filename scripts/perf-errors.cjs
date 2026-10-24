/**
 * 错误日志 + 自动重连 的真实应用端到端验证。
 * 走完整 IPC 链路，验证落盘、脱敏、去重、UI 数据可用。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

app.setPath('userData', path.join(os.homedir(), 'AppData', 'Roaming', 'ssh-workbench'))
require(path.join(__dirname, '..', 'out', 'main', 'index.js'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : '')) }
}

const errFile = path.join(os.homedir(), 'AppData', 'Roaming', 'ssh-workbench', 'data', 'error-log.json')

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 60; i++) {
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (win) break
    await sleep(250)
  }
  await sleep(3000)
  const run = (c) => win.webContents.executeJavaScript(c, true)

  console.log('\n[错误日志 + 自动重连] 真实应用验证')

  // 记录基线，测完恢复
  const before = fs.existsSync(errFile) ? fs.readFileSync(errFile, 'utf-8') : null
  const baseCount = before ? JSON.parse(before).length : 0
  console.log('  INFO  基线错误记录 ' + baseCount + ' 条')

  /* ---------- 1. IPC 失败自动进日志 ---------- */
  await run(`window.api.sftp.list('__nope__', '/').catch(() => {})`)
  await sleep(400)
  const listed = await run('(async () => { const r = await window.api.errors.list(); return (r.data ?? r).length })()')
  check('IPC 失败被自动记录', listed > baseCount, baseCount + ' -> ' + listed)
  check('记录已落盘', fs.existsSync(errFile))

  /* ---------- 2. 落盘内容检查 + 脱敏 ---------- */
  await run(`window.api.errors.report({ source: 'test', title: '带密码的错误', detail: 'connect password=SuperSecret123 host=x' })`)
  await sleep(400)
  const raw = fs.readFileSync(errFile, 'utf-8')
  check('敏感值未落盘（脱敏生效）', !raw.includes('SuperSecret123'), raw.includes('SuperSecret123') ? '明文密码出现在日志文件里' : 'ok')
  check('脱敏标记存在', raw.includes('***'))

  /* ---------- 3. 去重聚合 ---------- */
  const dupBefore = await run('(async () => { const r = await window.api.errors.list(); return (r.data ?? r).length })()')
  for (let i = 0; i < 10; i++) {
    await run(`window.api.errors.report({ source: 'dup-test', title: '重复错误', detail: 'same' })`)
  }
  await sleep(500)
  const dupAfter = await run(`(async () => {
    const r = await window.api.errors.list()
    const list = r.data ?? r
    const hit = list.find((e) => e.source === 'renderer:dup-test')
    return { total: list.length, count: hit ? hit.count : 0 }
  })()`)
  check('10 次相同错误只新增 1 条', dupAfter.total - dupBefore === 1, `新增 ${dupAfter.total - dupBefore} 条`)
  check('count 累加为 10', dupAfter.count === 10, String(dupAfter.count))

  /* ---------- 4. 统计接口 ---------- */
  const stats = await run('(async () => { const r = await window.api.errors.stats(); return r.data ?? r })()')
  check('stats.total 大于 0', stats && stats.total > 0, JSON.stringify(stats).slice(0, 80))
  check('stats.bySource 有内容', Array.isArray(stats.bySource) && stats.bySource.length > 0)

  /* ---------- 5. 删除单条 ---------- */
  const delTest = await run(`(async () => {
    const r = await window.api.errors.list()
    const list = r.data ?? r
    const target = list.find((e) => e.source === 'renderer:dup-test')
    if (!target) return { ok: false }
    await window.api.errors.remove(target.id)
    const r2 = await window.api.errors.list()
    const after = r2.data ?? r2
    return { ok: true, gone: !after.some((e) => e.id === target.id) }
  })()`)
  check('删除单条生效', delTest.ok && delTest.gone === true, JSON.stringify(delTest))

  /* ---------- 6. 自动重连：设置项可读写 ---------- */
  const rcSettings = await run(`(async () => {
    const cur = await window.api.settings.get()
    const s0 = cur.data ?? cur
    const d1 = s0.autoReconnect
    await window.api.settings.set({ autoReconnect: false })
    const c2 = await window.api.settings.get()
    const s2 = c2.data ?? c2
    await window.api.settings.set({ autoReconnect: d1 !== false })
    return { defaultOn: d1 !== false, offWorks: s2.autoReconnect === false }
  })()`)
  check('自动重连默认开启', rcSettings.defaultOn === true, String(rcSettings.defaultOn))
  check('关闭开关能生效', rcSettings.offWorks === true)

  /* ---------- 7. 取消重连接口存在且安全 ---------- */
  const cancelOk = await run(`(async () => {
    const r = await window.api.session.reconnectCancel('__nonexistent__')
    return { ok: true, res: JSON.parse(JSON.stringify(r ?? null)) }
  })()`)
  check('对不存在的会话取消重连不报错', cancelOk.ok === true, JSON.stringify(cancelOk.res).slice(0, 80))

  /* ---------- 8. UI 面板可达 ---------- */
  const uiOk = await run(`(() => {
    return { hasApi: typeof window.api.errors.list === 'function', bodyLen: document.body.innerText.length }
  })()`)
  check('渲染层可调用 errors API', uiOk.hasApi === true)
  check('界面正常渲染', uiOk.bodyLen > 100, String(uiOk.bodyLen))

  /* ---------- 清理：恢复错误日志到基线 ---------- */
  await run('window.api.errors.clear()')
  if (before !== null) fs.writeFileSync(errFile, before, 'utf-8')
  await sleep(300)
  const restored = fs.existsSync(errFile) ? JSON.parse(fs.readFileSync(errFile, 'utf-8')).length : 0
  check('测试数据已清理（恢复基线）', restored === baseCount, restored + ' vs ' + baseCount)

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n')
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.error('异常:', e); app.exit(2) })
