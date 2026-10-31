/**
 * 压测：连接分组的批量操作（重命名迁移、并发 rename 的读改写串行锁）。
 * 用法：./node_modules/electron/dist/electron.exe scripts/perf-group.cjs --perf
 *
 * 数据安全（重要）：
 *   全程只操作脚本自建的临时分组，绝不碰用户真实连接。
 *   旧版本直接取用户库里「最大的真实分组」做 rename 往返 + 12 路并发改名，
 *   中途崩溃或并发异常就会把用户的真实分组名改坏、脏写 connections.json。
 *   现在照 perf-opt.cjs 的做法：先造 N 条假连接，测完只删自己造的那些。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const os = require('node:os')

/*
 * userData 仍指向真实目录（应用读的就是它），但下面的测试数据完全自建，
 * 结束时按 group 前缀精确清理，并对「清理数 == 预期数」做断言，
 * 确保不会把垃圾留在用户库里、也不会误删用户数据。
 */
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

  console.log('\n[压测] 连接分组批量操作（自建测试数据）')

  // 基线：只读，用于最后核对用户真实数据一条都没动
  const base = await run(`(async () => {
    const r = await window.api.conn.list()
    const list = r.data ?? r
    return { total: list.length, ids: list.map((c) => c.id).sort() }
  })()`)
  console.log(`  INFO  基线：用户库 ${base.total} 条连接`)
  check('读到连接库', base.total >= 0, `${base.total} 条`)

  const STAMP = Date.now()
  const G = `PERF-分组测试-${STAMP}`
  const TMP = `${G}-临时`
  const N = 300

  // --- 自建测试数据 ---
  const made = await run(`(async () => {
    const ids = []
    for (let i = 0; i < ${N}; i++) {
      const res = await window.api.conn.save({
        name: 'PERF-G-' + i,
        host: '192.0.2.' + (i % 250),
        port: 22,
        username: 'perf',
        authType: 'password',
        group: ${q(G)},
        tags: ['perf-group']
      })
      const c = res.data ?? res
      if (c && c.id) ids.push(c.id)
    }
    const r = await window.api.conn.list()
    const inGroup = (r.data ?? r).filter((c) => c.group === ${q(G)}).length
    return { made: ids.length, inGroup }
  })()`)
  check(`自建 ${N} 条测试连接`, made.made === N, String(made.made))
  check(`测试分组内有 ${N} 条`, made.inGroup === N, String(made.inGroup))

  if (made.made !== N) {
    console.log('  测试数据没造全，中止（不做任何破坏性操作）')
    app.exit(1)
    return
  }

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

  // --- 数据完整性：改名往返后测试组内条数不变 ---
  const after = await run(`(async () => {
    const r = await window.api.conn.list()
    const list = r.data ?? r
    return { total: list.length, inG: list.filter((c) => c.group === ${q(G)}).length }
  })()`)
  check('往返后测试分组条数完全还原', after.inG === N, `${N} -> ${after.inG}`)

  // --- 并发 rename：验证 JsonStore 的读改写串行锁 ---
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

  // 并发后测试数据必须仍在（第一条抢到改名，其余因源分组已空返回 0）
  const afterConc = await run(`(async () => {
    const r = await window.api.conn.list()
    const list = r.data ?? r
    const inConcurrent = list.filter((c) => c.group && c.group.startsWith(${q(G)} + '-并发'))
    const inG = list.filter((c) => c.group === ${q(G)}).length
    const name = inConcurrent.length ? inConcurrent[0].group : null
    return { total: list.length, tmpTotal: inConcurrent.length, tmpName: name, inG }
  })()`)
  check('并发改名后测试连接未丢失', afterConc.tmpTotal + afterConc.inG === N,
    `${afterConc.tmpTotal}+${afterConc.inG} vs ${N}`)

  // --- 清理：只删自己造的数据 ---
  const cleanup = await run(`(async () => {
    const g = ${q(G)}
    const r = await window.api.conn.list()
    const mine = (r.data ?? r).filter((c) => c.group && c.group.startsWith(g))
    const ids = mine.map((c) => c.id)
    const res = ids.length ? await window.api.conn.removeMany(ids) : { data: 0 }
    return { removed: res.data ?? res, expected: ids.length }
  })()`)
  check('测试数据全部清理（删除数 == 预期数）', cleanup.removed === cleanup.expected,
    `${cleanup.removed}/${cleanup.expected}`)

  // --- 终局核对：用户真实连接一条不少、一个新 id 都没多 ---
  const final = await run(`(async () => {
    const r = await window.api.conn.list()
    const list = r.data ?? r
    return { total: list.length, ids: list.map((c) => c.id).sort() }
  })()`)
  check('用户库连接总数与基线一致', final.total === base.total, `${base.total} -> ${final.total}`)
  check('用户库 id 集合与基线完全一致',
    JSON.stringify(final.ids) === JSON.stringify(base.ids),
    final.ids.length === base.ids.length ? 'id 集合相同' : 'id 集合不同')

  const failed = results.filter((r) => !r.ok)
  console.log(`\n结果：${results.length - failed.length} 通过 / ${failed.length} 失败\n`)
  app.exit(failed.length === 0 ? 0 : 1)
}).catch((e) => {
  console.error('压测异常:', e)
  app.exit(2)
})
