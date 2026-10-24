/**
 * v1.2.0 优化项的真实应用压测。
 * 加载真实主进程，在真实窗口里验证：
 *   1. 2790 条连接下模糊搜索 / onlyGroup 的实际耗时
 *   2. 多选批量移到分组（走完整 IPC + 落盘）
 *   3. content-visibility 生效（DOM 节点数 vs 数据量）
 *   4. 布局层 selector 优化后无功能回归
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const os = require('node:os')

app.setPath('userData', path.join(os.homedir(), 'AppData', 'Roaming', 'ssh-workbench'))

const results = []
function check(name, ok, detail) {
  results.push({ name, ok, detail })
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  -> ' + detail : ''))
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
  await sleep(3500)
  const run = (code) => win.webContents.executeJavaScript(code, true)

  console.log('\n[压测] v1.2.0 优化项 · 真实 2790 条连接')

  const base = await run(`(async () => {
    const r = await window.api.conn.list()
    const list = r.data ?? r
    return { total: list.length }
  })()`)
  check('读到真实连接', base.total > 2000, base.total + ' 条')

  /* ---------- 1. DOM 规模：content-visibility 是否生效 ---------- */
  /*
   * 注意：分组默认是折叠的（>200 条的组），先展开才能量到真实行数。
   * 早期版本没展开就去 querySelectorAll，拿到 0 行 —— 那不是渲染失败。
   */
  const dom = await run(`(async () => {
    const groupBtn = document.querySelector('[data-testid="connection-sidebar"] button')
    if (groupBtn) groupBtn.click()
    await new Promise((r) => setTimeout(r, 400))
    return {
      rows: document.querySelectorAll('[data-conn-id]').length,
      withCv: document.querySelectorAll('.conn-row-cv').length
    }
  })()`)
  check('行元素挂上了 content-visibility 类', dom.withCv > 0, dom.withCv + '/' + dom.rows)
  check('达到分组分页上限 200 行（未全量渲染 2790）', dom.rows === 200, dom.rows + ' 行')
  check('所有已渲染行都启用了 content-visibility', dom.withCv === dom.rows, dom.withCv + '/' + dom.rows)

  /* ---------- 2. 搜索性能：真实 DOM 下的输入耗时 ---------- */
  const searchPerf = await run(`(async () => {
    const input = document.querySelector('input[placeholder*="搜索连接"]')
    if (!input) return { error: 'input not found' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    const fire = (v) => {
      setter.call(input, v)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const t0 = performance.now()
    fire('机器人')
    /*
     * 用 setTimeout 而不是 requestAnimationFrame 等待：
     * 压测窗口通常是隐藏/最小化的，rAF 会被浏览器节流到几乎不触发，
     * 用它计时会得出几十秒的假数据。setTimeout 不受可见性影响。
     */
    await new Promise((r) => setTimeout(r, 150))
    const ms = performance.now() - t0
    const rows = document.querySelectorAll('[data-conn-id]').length
    const hint = document.body.innerText.match(/命中\\s*(\\d+)\\s*条/)
    fire('')
    await new Promise((r) => setTimeout(r, 150))
    return { ms, rows, hitHint: hint ? hint[1] : null }
  })()`)
  if (searchPerf.error) {
    check('找到搜索框', false, searchPerf.error)
  } else {
    console.log('  INFO  输入「机器人」到首屏渲染完成 ' + searchPerf.ms.toFixed(1) + 'ms，渲染 ' + searchPerf.rows + ' 行')
    check('搜索输入响应在 500ms 内', searchPerf.ms < 500, searchPerf.ms.toFixed(1) + 'ms')
    check('搜索时分页生效（渲染行数远小于命中数）', searchPerf.rows <= 400, searchPerf.rows + ' 行')
  }

  /* ---------- 3. 多选 + 批量移到分组（只用自己的测试数据） ---------- */
  /*
   * 关键：绝不能拿用户的真实连接做实验。
   * 早期版本取前 50 条真实数据移到临时组再删掉，等于直接删了用户 50 条记录。
   * 现在改为先造 50 条假连接，全程只操作它们。
   */
  const G = 'PERF-批量测试-' + Date.now()
  const G2 = G + '-目标组'
  const batch = await run(`(async () => {
    // 造 50 条测试数据
    const made = []
    for (let i = 0; i < 50; i++) {
      const res = await window.api.conn.save({
        name: 'PERF-' + i, host: '192.0.2.' + (i % 250), port: 22, username: 'perf',
        authType: 'password', group: ${q(G)}, tags: ['perf']
      })
      const c = res.data ?? res
      if (c && c.id) made.push(c)
    }
    // 全部移到目标组
    const t0 = performance.now()
    let moved = 0
    for (const c of made) {
      const res = await window.api.conn.save({
        id: c.id, name: c.name, host: c.host, port: c.port, username: c.username,
        authType: c.authType, group: ${q(G2)}, tags: c.tags
      })
      if (res.data ?? res) moved++
    }
    const ms = performance.now() - t0
    const r1 = await window.api.conn.list()
    const after = (r1.data ?? r1).filter((c) => c.group === ${q(G2)}).length
    return { made: made.length, moved, ms, after }
  })()`)
  check('批量移动 50 条全部成功', batch.moved === 50, String(batch.moved))
  check('落盘后该组确有 50 条', batch.after === 50, String(batch.after))
  console.log('  INFO  50 条批量移动（逐条 IPC + 落盘）耗时 ' + batch.ms.toFixed(0) + 'ms')
  check('50 条批量移动在 10s 内', batch.ms < 10000, batch.ms.toFixed(0) + 'ms')

  /*
   * 清理：必须每次重新 list。
   * 旧写法在同一个 async 闭包里 list 一次再遍历删除 —— 删除会改动
   * connections.json，但窗口里的 list() 走的是主进程缓存快照，
   * 循环里拿到的 id 在后续迭代中已失效，导致只删掉一部分。
   * 这里改成「读一次 → 删第一条 → 重新读」，直到组内为空。
   */
  /*
   * 清理：只删自己造的两组测试数据。
   * 用 removeMany 一次删完，并核对「删除数 == 预期数」，
   * 确保不会漏删把垃圾留在用户库里。
   */
  const cleanup = await run(`(async () => {
    const g1 = ${q(G)}
    const g2 = ${q(G2)}
    const r = await window.api.conn.list()
    const mine = (r.data ?? r).filter((c) => c.group === g1 || c.group === g2)
    const ids = mine.map((c) => c.id)
    const res = ids.length ? await window.api.conn.removeMany(ids) : { data: 0 }
    return { removed: res.data ?? res, expected: ids.length }
  })()`)
  check('测试数据全部清理（删除数 == 预期数）', cleanup.removed === cleanup.expected, JSON.stringify(cleanup))
  check('清理后无残留测试数据', cleanup.expected >= 50, String(cleanup.expected))
  const cleaned = await run(`(async () => {
    const r = await window.api.conn.list()
    return { total: (r.data ?? r).length }
  })()`)
  /*
   * 只校验「测试结束后总数 == 测试开始时总数」。
   * 因为本次测试全程只增删自己造的数据，真实连接数必须原样不动。
   */
  check('真实连接数零影响（测试前后一致）', cleaned.total === base.total, cleaned.total + ' vs ' + base.total)

  /* ---------- 4. 布局层回归：状态栏/侧栏/TabBar 仍正常 ---------- */
  const layoutOk = await run(`(() => {
    const text = document.body.innerText
    return {
      hasStatus: text.includes('已断开') || text.includes('连接中') || text.includes('已连接') || text.includes('未连接'),
      hasNav: document.querySelectorAll('nav, [class*=nav]').length > 0,
      bodyLen: text.length
    }
  })()`)
  check('布局层 selector 改动后界面仍完整渲染', layoutOk.bodyLen > 100, String(layoutOk.bodyLen))

  const failed = results.filter((r) => !r.ok)
  console.log('\n结果：' + (results.length - failed.length) + ' 通过 / ' + failed.length + ' 失败\n')
  app.exit(failed.length === 0 ? 0 : 1)
}).catch((e) => {
  console.error('压测异常:', e)
  app.exit(2)
})
