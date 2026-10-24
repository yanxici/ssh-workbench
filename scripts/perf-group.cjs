/**
 * 压测：在真实用户数据（约 2790 条连接）上跑连接分组的批量操作。
 * 用法：./node_modules/electron/dist/electron.exe scripts/perf-group.cjs --perf
 * 需要 app.setPath('userData') 指向真实数据目录，故先于 require 主进程设置。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const os = require('node:os')

// 指向真实 userData，才能读到用户的 2790 条连接
app.setPath('userData', path.join(os.homedir(), 'AppData', 'Roaming', 'ssh-workbench'))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  -> ' + detail : ''}`)
}
const q = (s) => JSON.stringify(s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

require(path.join(__dirname, '..', 'out', 'main', 'index.js'))

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 60; i++) {
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (win) break
    await sleep(250)
  }
  if (!win) throw new Error('没有找到应用窗口')
  await sleep(3000)

  const run = (code) => win.webContents.executeJavaScript(code, true)

  console.log('\n[压测] 真实用户数据上的连接分组操作')

  const info = await run(`(async () => {
    const r = await window.api.conn.list()
    const list = r.data ?? r
    const m = new Map()
    for (const c of list) m.set(c.group || '默认', (m.get(c.group || '默认') ?? 0) + 1)
    let best = null
    for (const [g, n] of m) if (!best || n > best.n) best = { g, n }
    return { total: list.length, biggest: best, groups: m.size }
  })()`)
  check('读到真实连接', info.total > 2000, `${info.total} 条 / ${info.groups} 个分组`)
  check('找到最大分组', info.biggest !== null, JSON.stringify(info.biggest))

  if (!info.biggest) { app.exit(1); return }

  const G = info.biggest.g
  const N = info.biggest.n
  const TMP = G + '-压测临时'

  // --- 整组重命名往返 ---
  const t1 = Date.now()
  const mv = await run(`(async () => {
    const r = await window.api.conn.renameGroup(${q(G)}, ${q(TMP)})
    return r.data ?? r
  })()`)
  const ms1 = Date.now() - t1
  check(`整组重命名迁移 ${N} 条`, mv === N, String(mv))
  console.log(`  INFO  ${N} 条整组重命名（IPC + 落盘）耗时 ${ms1}ms`)
  check(`${N} 条重命名 < 5000ms`, ms1 < 5000, ms1 + 'ms')

  const t2 = Date.now()
  const back = await run(`(async () => {
    const r = await window.api.conn.renameGroup(${q(TMP)}, ${q(G)})
    return r.data ?? r
  })()`)
  const ms2 = Date.now() - t2
  check('改回原名条数一致', back === N, String(back))
  console.log(`  INFO  ${N} 条改回原名耗时 ${ms2}ms`)

  // --- 数据完整性：改名往返后总数与分组不变 ---
  const after = await run(`(async () => {
    const r = await window.api.conn.list()
    const list = r.data ?? r
    const m = new Map()
    for (const c of list) m.set(c.group || '默认', (m.get(c.group || '默认') ?? 0) + 1)
    return { total: list.length, inG: m.get(${q(G)}) ?? 0, groups: m.size }
  })()`)
  check('往返后连接总数不变', after.total === info.total, `${info.total} -> ${after.total}`)
  check('往返后分组数不变', after.groups === info.groups, `${info.groups} -> ${after.groups}`)
  check('原分组条数完全还原', after.inG === N, `${N} -> ${after.inG}`)

  // --- 并发 rename 压力：验证 JsonStore 的读改写串行锁 ---
  console.log('\n[压测] 并发 rename（验证读改写串行，不丢更新）')
  const CONC = 12
  const t3 = Date.now()
  const conc = await run(`(async () => {
    const names = Array.from({ length: ${CONC} }, (_, i) => ${q(G)} + '-并发' + i)
    const ops = names.map((to) => window.api.conn.renameGroup(${q(G)}, to))
    const res = await Promise.all(ops)
    return res.map((r) => r.data ?? r)
  })()`)
  const ms3 = Date.now() - t3
  console.log(`  INFO  ${CONC} 个并发 rename 耗时 ${ms3}ms，返回 ${JSON.stringify(conc.slice(0, 3))}...`)
  check('并发 rename 全部返回数字', conc.every((x) => typeof x === 'number'))

  // 并发后数据必须仍然完整（第一条抢到了改名，其余因源分组已空返回 0）
  const afterConc = await run(`(async () => {
    const r = await window.api.conn.list()
    const list = r.data ?? r
    const m = new Map()
    for (const c of list) m.set(c.group || '默认', (m.get(c.group || '默认') ?? 0) + 1)
    let tmpTotal = 0
    let tmpName = null
    for (const [g, n] of m) if (g.startsWith(${q(G)} + '-并发')) { tmpTotal += n; tmpName = g }
    return { total: list.length, tmpTotal, tmpName, inG: m.get(${q(G)}) ?? 0 }
  })()`)
  check('并发后连接总数仍不变（无丢失）', afterConc.total === info.total, `${afterConc.total} vs ${info.total}`)
  check('并发改名后该组连接仍在（\u672a\u4e22\u5931）', afterConc.tmpTotal + afterConc.inG === N, `${afterConc.tmpTotal}+${afterConc.inG} vs ${N}`)

  // 还原
  if (afterConc.tmpName) {
    await run(`(async () => {
      await window.api.conn.renameGroup(${q(afterConc.tmpName)}, ${q(G)})
    })()`)
  }
  const final = await run(`(async () => {
    const r = await window.api.conn.list()
    const list = r.data ?? r
    const m = new Map()
    for (const c of list) m.set(c.group || '默认', (m.get(c.group || '默认') ?? 0) + 1)
    return { total: list.length, inG: m.get(${q(G)}) ?? 0, groups: m.size }
  })()`)
  check('最终还原：总数、分组数、该组条数全部一致',
    final.total === info.total && final.groups === info.groups && final.inG === N,
    JSON.stringify(final))

  const failed = results.filter((r) => !r.ok)
  console.log(`\n结果：${results.length - failed.length} 通过 / ${failed.length} 失败\n`)
  app.exit(failed.length === 0 ? 0 : 1)
}).catch((e) => {
  console.error('压测异常:', e)
  app.exit(2)
})
