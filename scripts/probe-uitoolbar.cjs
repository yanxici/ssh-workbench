/**
 * 验证「选中连接不再出现顶部操作栏」。
 * 直接操作真实 DOM：展开分组 → 单击一行 → 检查上方有没有多出横栏。
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
  await sleep(3500)
  const run = (c) => win.webContents.executeJavaScript(c, true)

  console.log('\n[UI] 选中交互验证')

  const r = await run(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
    const sidebar = document.querySelector('[data-testid="connection-sidebar"]')
    if (!sidebar) return { error: 'no sidebar' }

    // 展开默认折叠的分组
    const groupBtn = sidebar.querySelector('button')
    if (groupBtn) groupBtn.click()
    await sleep(500)

    const rows = sidebar.querySelectorAll('[data-conn-id]')
    if (rows.length === 0) return { error: 'no rows' }

    // 记录点击前的侧栏高度与内容
    const beforeHeight = sidebar.getBoundingClientRect().height
    const beforeRowY = rows[0].getBoundingClientRect().top
    const beforeText = sidebar.innerText

    // 单击第一行
    rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await sleep(300)

    const afterHeight = sidebar.getBoundingClientRect().height
    const afterRowY = rows[0].getBoundingClientRect().top
    const afterText = sidebar.innerText

    return {
      rows: rows.length,
      beforeHeight, afterHeight,
      beforeRowY, afterRowY,
      hasSelectedBar: afterText.includes('已选 ') && !beforeText.includes('已选 '),
      barGone: !afterText.includes('移到分组') || beforeText.includes('移到分组'),
      rowShifted: Math.abs(afterRowY - beforeRowY) > 1
    }
  })()`)

  if (r.error) {
    check('侧栏可用', false, r.error)
  } else {
    console.log('  INFO  行数 ' + r.rows + '，点击前后行 Y 位移 ' + (r.afterRowY - r.beforeRowY).toFixed(1) + 'px')
    check('单击后不出现「已选 N 条」横栏', r.hasSelectedBar === false, String(r.hasSelectedBar))
    check('单击后列表位置不跳动', r.rowShifted === false, '位移 ' + (r.afterRowY - r.beforeRowY).toFixed(1) + 'px')
    check('侧栏高度不变', Math.abs(r.afterHeight - r.beforeHeight) < 1, r.beforeHeight + ' -> ' + r.afterHeight)
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n')
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => { console.error(e); app.exit(2) })
