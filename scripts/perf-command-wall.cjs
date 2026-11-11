/**
 * 压测：命令墙（右侧命令栏）在真实应用里的几何与交互。
 * 用法：./node_modules/electron/dist/electron.exe scripts/perf-command-wall.cjs
 *
 * 为什么用临时 userData：
 *   应用有单实例锁，用户正在用的窗口持有锁，直接起第二个进程只会打印
 *   「another instance holds the lock」然后退出。所以把真实的 data/ 复制到
 *   临时目录再启动：既绕开锁，又保证渲染的是用户真实的 129 条命令
 *   （几何结论必须基于真实数据才有意义）。
 *   真实目录全程只读，结束时比对 commands.json 的 sha256，必须没变。
 *
 * 判据设计（AGENTS.md 2.6：断言要在「修复没落地时会红」）：
 *   - 列数：旧实现固定 3 列；这里断言默认宽度下 grid 实际列数 = 4 → 旧实现必红。
 *   - 卡片等高：旧实现卡高 47~51px 且随名字长短跳动；这里断言全部等高且 ≤40 → 旧实现必红。
 *   - 截断数：旧实现 380 宽下 129 条里 93 条变省略号；这里断言 ≤1 → 旧实现必红。
 *   - 浮层：旧实现用原生 title，DOM 里没有 role="tooltip" → 旧实现必红。
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const fs = require('node:fs')

const REAL_UD = path.join(os.homedir(), 'AppData', 'Roaming', 'ssh-workbench')
const TMP_UD = path.join(os.tmpdir(), 'sshw-perf-wall-' + Date.now())
fs.mkdirSync(TMP_UD, { recursive: true })
for (const sub of ['data', 'backups', 'reports']) {
  const src = path.join(REAL_UD, sub)
  if (fs.existsSync(src)) fs.cpSync(src, path.join(TMP_UD, sub), { recursive: true })
}

app.setPath('userData', TMP_UD)
require(path.join(__dirname, '..', 'out', 'main', 'index.js'))

const CMD_FILE = path.join(REAL_UD, 'data', 'commands.json')
const TMP_CMD_FILE = path.join(TMP_UD, 'data', 'commands.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) pass++
  else fail++
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail !== undefined ? '  -> ' + detail : ''))
}

function sha(file) {
  if (!fs.existsSync(file)) return 'absent'
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 80; i++) {
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (win) break
    await sleep(250)
  }
  if (!win) throw new Error('没有找到应用窗口')
  await sleep(3500)
  const run = (code) => win.webContents.executeJavaScript(code, true)

  console.log('\n[命令墙] 真实应用几何与交互（临时库 ' + path.basename(TMP_UD) + '）')

  const beforeRev = sha(CMD_FILE)
  check('临时库含真实命令', sha(TMP_CMD_FILE) === beforeRev, beforeRev.slice(0, 12))

  /* ---------- 1. 命令栏可见 ---------- */
  let panel = await run(`!!document.querySelector('[data-testid="command-panel"]')`)
  if (!panel) {
    await run("document.querySelector('.activity-item[aria-pressed]')?.click()")
    await sleep(700)
    panel = await run(`!!document.querySelector('[data-testid="command-panel"]')`)
  }
  check('命令栏已渲染', panel)
  if (!panel) { console.log('\n无法继续：命令栏不可见'); app.exit(1); return }

  /* ---------- 2. 卡片数 = 命令总数 ---------- */
  const wall = await run(`(() => {
    const p = document.querySelector('[data-testid="command-panel"]')
    const cards = [...p.querySelectorAll('[data-cmd-id]')]
    const grid = cards[0]?.parentElement ?? null
    const cs = grid ? getComputedStyle(grid) : null
    const rail = p.parentElement
    return {
      cards: cards.length,
      railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
      gridCols: cs ? cs.gridTemplateColumns.split(' ').filter(Boolean).length : 0,
      total: Number((p.querySelector('.panel-count') || {}).textContent || 0)
    }
  })()`)
  check('卡片数与命令总数一致', wall.cards === wall.total, wall.cards + ' / ' + wall.total)
  check('读到命令栏宽度', wall.railWidth > 0, wall.railWidth + 'px')

  /* ---------- 3. 列数由宽度决定 ---------- */
  const expectCols = wall.railWidth < 360 ? 3 : wall.railWidth < 480 ? 4 : 5
  check('列数 = wallColumns(宽度)', wall.gridCols === expectCols, 'grid ' + wall.gridCols + ' 列，期望 ' + expectCols)
  check('不是旧的固定 3 列', !(wall.railWidth >= 360 && wall.gridCols === 3), wall.gridCols + ' 列 @ ' + wall.railWidth + 'px')

  /* ---------- 4. 卡片等高 ---------- */
  const geom = await run(`(() => {
    const cards = [...document.querySelectorAll('[data-testid="command-panel"] [data-cmd-id]')]
    const hs = cards.map((c) => Math.round(c.getBoundingClientRect().height))
    return { uniq: [...new Set(hs)].sort((a, b) => a - b), max: Math.max(...hs), n: hs.length }
  })()`)
  check('所有卡片等高', geom.uniq.length === 1, '高度集合 ' + JSON.stringify(geom.uniq))
  check('卡片高度 ≤ 40px（旧实现 47~51）', geom.max <= 40, geom.max + 'px / ' + geom.n + ' 张')

  /* ---------- 5. 名字截断数 ---------- */
  const trunc = await run(`(() => {
    const cards = [...document.querySelectorAll('[data-testid="command-panel"] [data-cmd-id]')]
    let bad = 0
    const sample = []
    for (const c of cards) {
      const nm = c.querySelector('span')
      if (!nm) continue
      if (nm.scrollHeight > nm.clientHeight + 1) { bad++; if (sample.length < 3) sample.push(nm.textContent) }
    }
    return { bad, total: cards.length, sample }
  })()`)
  check('名字截断 ≤ 1 条（旧实现 93/129）', trunc.bad <= 1, trunc.bad + ' / ' + trunc.total + (trunc.sample.length ? ' (' + trunc.sample.join('，') + ')' : ''))

  /* ---------- 6. 卡内不再有命令行 ---------- */
  const noCmdLine = await run(`(() => {
    const c = document.querySelector('[data-testid="command-panel"] [data-cmd-id]')
    return c ? c.querySelectorAll('.font-mono').length === 0 : false
  })()`)
  check('卡片内不再显示命令行', noCmdLine)

  /* ---------- 7. 悬停浮层 ---------- */
  const tip = await run(`(async () => {
    const c = document.querySelector('[data-testid="command-panel"] [data-cmd-id]')
    if (!c) return { ok: false }
    c.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    c.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 150))
    const t = document.querySelector('[role="tooltip"]')
    return { ok: !!t, text: t ? t.textContent : null, hasTitle: c.hasAttribute('title') }
  })()`)
  check('悬停出现自绘浮层（role=tooltip）', tip.ok && !!tip.text)
  check('浮层含命令全文', !!tip.text && tip.text.length > 8, (tip.text || '').slice(0, 46) + '…')
  check('卡片不再用原生 title', tip.hasTitle === false)

  /* ---------- 8. 键盘 ↑↓ 步长 = 列数 ---------- */
  const kb = await run(`(async () => {
    const p = document.querySelector('[data-testid="command-panel"]')
    const cards = [...p.querySelectorAll('[data-cmd-id]')]
    const cols = cards[0] ? getComputedStyle(cards[0].parentElement).gridTemplateColumns.split(' ').filter(Boolean).length : 0
    const pick = () => [...p.querySelectorAll('[data-cmd-id]')].findIndex((c) => c.className.includes('bg-select'))
    const before = pick()
    const target = p.querySelector('[data-cmd-id]')
    target.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 100))
    const from = pick()
    p.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    await new Promise((r) => setTimeout(r, 150))
    const after = pick()
    return { before, from, after, cols }
  })()`)
  check('↓ 跨一行（步长 = 列数）', kb.from >= 0 && kb.after - kb.from === kb.cols, 'from ' + kb.from + ' → ' + kb.after + '，列数 ' + kb.cols)

  /* ---------- 9. 宽度扫描：改栏宽 → 列数跟着变（走真实 ResizeObserver） ---------- */
  const sweep = await run(`(async () => {
    const p = document.querySelector('[data-testid="command-panel"]')
    const rail = p.parentElement
    const orig = rail.style.width
    const out = []
    for (const w of [340, 400, 600]) {
      rail.style.width = w + 'px'
      await new Promise((r) => setTimeout(r, 260))
      const cards = [...p.querySelectorAll('[data-cmd-id]')]
      const grid = cards[0] ? cards[0].parentElement : null
      const cols = grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0
      let bad = 0
      for (const c of cards) {
        const nm = c.querySelector('span')
        if (nm && nm.scrollHeight > nm.clientHeight + 1) bad++
      }
      out.push({ w, cols, bad, total: cards.length })
    }
    rail.style.width = orig
    await new Promise((r) => setTimeout(r, 260))
    return out
  })()`)
  const expectAt = (w) => (w < 360 ? 3 : w < 480 ? 4 : 5)
  for (const row of sweep) {
    check(row.w + 'px → ' + expectAt(row.w) + ' 列', row.cols === expectAt(row.w), '实际 ' + row.cols + ' 列')
  }
  const at340 = sweep.find((r) => r.w === 340)
  const at400 = sweep.find((r) => r.w === 400)
  // 340 / 3 列每卡 107px，两行约 15 字；库里最长那条「同步封禁场站代码（代码需上传）」
  // 正好 15 字，卡在边缘会省略号 —— 这是设计已接受的唯一例外（悬停可看全名）。
  check('340 宽（下限）截断 ≤ 1 条', at340.bad <= 1, at340.bad + ' / ' + at340.total)
  check('400 宽（新默认）名字截断 ≤ 1', at400.bad <= 1, at400.bad + ' / ' + at400.total)

  /* ---------- 10. 数据零影响 ---------- */
  check('真实 commands.json 未被改动', sha(CMD_FILE) === beforeRev, beforeRev.slice(0, 12))

  console.log('\n命令墙压测：' + pass + ' 通过，' + fail + ' 失败')
  try { fs.rmSync(TMP_UD, { recursive: true, force: true }) } catch {}
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => {
  console.error('压测异常：', e)
  app.exit(1)
})
