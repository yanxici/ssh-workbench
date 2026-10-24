/**
 * 端到端验证：加载**真实主进程构建产物**（out/main/index.js），
 * 用它自己创建的窗口执行 window.api.conn.*，
 * 链路完整：渲染层 -> preload -> IPC -> 主进程 repository -> JSON 落盘。
 *
 * 用法：./node_modules/electron/dist/electron.exe scripts/e2e-group.cjs
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? '  -> ' + detail : ''}`)
}
const q = (s) => JSON.stringify(s)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 先把真实应用整个跑起来：注册全部 IPC、创建窗口
require(path.join(__dirname, '..', 'out', 'main', 'index.js'))

app.whenReady().then(async () => {
  // 等真实窗口出现并加载完
  let win = null
  for (let i = 0; i < 60; i++) {
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (win) break
    await sleep(250)
  }
  if (!win) throw new Error('没有找到应用窗口')
  await sleep(3000)

  const run = (code) => win.webContents.executeJavaScript(code, true)
  console.log('\n[E2E] 真实应用内验证连接分组')

  const baseline = await run(`(async () => {
    const r = await window.api.conn.list()
    return { count: (r.data ?? r).length }
  })()`)
  check('能读到现有连接', baseline.count > 0, `${baseline.count} 条`)

  const G1 = 'E2E-测试分组-' + Date.now()
  const G2 = G1 + '-已改名'

  const created = await run(`(async () => {
    const cur = await window.api.settings.get()
    const s0 = cur.data ?? cur
    const res = await window.api.settings.set({
      connectionGroups: [...(s0.connectionGroups ?? []), ${q(G1)}]
    })
    const s1 = res.data ?? res
    return { has: (s1.connectionGroups ?? []).includes(${q(G1)}) }
  })()`)
  check('新建分组后 settings 里能看到它', created.has === true)

  const madeConn = await run(`(async () => {
    const res = await window.api.conn.save({
      name: 'E2E测试连接', host: '192.0.2.10', port: 22, username: 'e2e',
      authType: 'password', group: ${q(G1)}, tags: ['e2e']
    })
    const c = res.data ?? res
    return { id: c && c.id, group: c && c.group }
  })()`)
  check('连接保存成功并落在新分组', madeConn.id != null && madeConn.group === G1, JSON.stringify(madeConn))

  await run(`(async () => {
    for (const n of ['E2E测试连接2', 'E2E测试连接3']) {
      await window.api.conn.save({
        name: n, host: '192.0.2.11', port: 22, username: 'e2e',
        authType: 'password', group: ${q(G1)}, tags: []
      })
    }
  })()`)

  const beforeRename = await run(`(async () => {
    const r = await window.api.conn.list()
    return { n: (r.data ?? r).filter((c) => c.group === ${q(G1)}).length }
  })()`)
  check('分组内共 3 条连接', beforeRename.n === 3, String(beforeRename.n))

  const t0 = Date.now()
  const renamed = await run(`(async () => {
    const res = await window.api.conn.renameGroup(${q(G1)}, ${q(G2)})
    return { moved: res.data ?? res }
  })()`)
  const renameMs = Date.now() - t0
  check('renameGroup 返回迁移条数 = 3', renamed.moved === 3, JSON.stringify(renamed))
  check(`重命名 3 条耗时 ${renameMs}ms (<2000ms)`, renameMs < 2000, renameMs + 'ms')

  const afterRename = await run(`(async () => {
    const r = await window.api.conn.list()
    const list = r.data ?? r
    return {
      inNew: list.filter((c) => c.group === ${q(G2)}).length,
      inOld: list.filter((c) => c.group === ${q(G1)}).length
    }
  })()`)
  check('改名后新分组有 3 条', afterRename.inNew === 3, String(afterRename.inNew))
  check('旧分组名不再有任何连接', afterRename.inOld === 0, String(afterRename.inOld))

  const deleted = await run(`(async () => {
    const res = await window.api.conn.deleteGroup(${q(G2)})
    return { removed: res.data ?? res }
  })()`)
  check('deleteGroup 返回删除条数 = 3', deleted.removed === 3, JSON.stringify(deleted))

  const afterDelete = await run(`(async () => {
    const r = await window.api.conn.list()
    return { left: (r.data ?? r).filter((c) => c.group === ${q(G2)}).length }
  })()`)
  check('删除后该分组不再有连接', afterDelete.left === 0, String(afterDelete.left))

  await run(`(async () => {
    const cur = await window.api.settings.get()
    const s0 = cur.data ?? cur
    await window.api.settings.set({
      connectionGroups: (s0.connectionGroups ?? []).filter(
        (g) => g !== ${q(G1)} && g !== ${q(G2)}
      )
    })
  })()`)

  console.log('\n[压测] 真实数据量下的整组重命名（IPC + 落盘往返）')
  const big = await run(`(async () => {
    const r = await window.api.conn.list()
    const list = r.data ?? r
    const m = new Map()
    for (const c of list) m.set(c.group || '默认', (m.get(c.group || '默认') ?? 0) + 1)
    let best = null
    for (const [g, n] of m) if (!best || n > best.n) best = { g, n }
    return best
  })()`)
  check('找到最大分组', big && big.n > 0, JSON.stringify(big))

  if (big && big.n > 100) {
    const tmp = big.g + '-压测临时'
    const t1 = Date.now()
    const mv = await run(`(async () => {
      const res = await window.api.conn.renameGroup(${q(big.g)}, ${q(tmp)})
      return res.data ?? res
    })()`)
    const ms1 = Date.now() - t1
    check(`整组重命名迁移 ${big.n} 条`, mv === big.n, String(mv))
    console.log(`  INFO  ${big.n} 条整组重命名（IPC+落盘）耗时 ${ms1}ms`)
    check(`${big.n} 条重命名在 5s 内完成`, ms1 < 5000, ms1 + 'ms')

    const t2 = Date.now()
    const back = await run(`(async () => {
      const res = await window.api.conn.renameGroup(${q(tmp)}, ${q(big.g)})
      return res.data ?? res
    })()`)
    const ms2 = Date.now() - t2
    check('改回原名后条数一致', back === big.n, String(back))
    console.log(`  INFO  ${big.n} 条改回原名耗时 ${ms2}ms`)

    const restored = await run(`(async () => {
      const r = await window.api.conn.list()
      return { n: (r.data ?? r).filter((c) => (c.group || '默认') === ${q(big.g)}).length }
    })()`)
    check('数据已还原，无丢失', restored.n === big.n, String(restored.n))
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n结果：${results.length - failed.length} 通过 / ${failed.length} 失败\n`)
  app.exit(failed.length === 0 ? 0 : 1)
}).catch((e) => {
  console.error('E2E 异常:', e)
  app.exit(2)
})
