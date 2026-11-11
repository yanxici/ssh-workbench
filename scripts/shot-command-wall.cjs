/**
 * 截图：右侧命令栏在 400 / 340 / 600 三档宽度下的实际渲染。
 * 用法：electron scripts/shot-command-wall.cjs
 * 输出：.shots/wall-{w}.png
 */
const { app, BrowserWindow } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const REAL_UD = path.join(os.homedir(), 'AppData', 'Roaming', 'ssh-workbench')
const TMP_UD = path.join(os.tmpdir(), 'sshw-shot-wall-' + Date.now())
fs.mkdirSync(TMP_UD, { recursive: true })
for (const sub of ['data']) {
  const src = path.join(REAL_UD, sub)
  if (fs.existsSync(src)) fs.cpSync(src, path.join(TMP_UD, sub), { recursive: true })
}
app.setPath('userData', TMP_UD)
require(path.join(__dirname, '..', 'out', 'main', 'index.js'))

const OUT = path.join(__dirname, '..', '.shots')
fs.mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

app.whenReady().then(async () => {
  let win = null
  for (let i = 0; i < 80; i++) {
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (win) break
    await sleep(250)
  }
  await sleep(4000)
  const run = (c) => win.webContents.executeJavaScript(c, true)
  /*
   * 必须先 show()：隐藏/被遮挡的窗口不参与合成，capturePage 会一直返回同一帧，
   * 三个宽度截出来是字节完全相同的图（第一次跑就踩了这个坑）。
   */
  win.show()
  win.setSize(1440, 900)
  await sleep(1200)

  for (const w of [600, 400, 340]) {
    const applied = await run(`(async () => {
      const p = document.querySelector('[data-testid="command-panel"]')
      p.parentElement.style.width = '${w}px'
      await new Promise((r) => setTimeout(r, 350))
      const cards = [...p.querySelectorAll('[data-cmd-id]')]
      const grid = cards[0] ? cards[0].parentElement : null
      return grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length : 0
    })()`)
    await sleep(900)
    const img = await win.webContents.capturePage()
    const file = path.join(OUT, 'wall-' + w + '.png')
    fs.writeFileSync(file, img.toPNG())
    console.log('shot ' + file + '  cols=' + applied)
  }
  try { fs.rmSync(TMP_UD, { recursive: true, force: true }) } catch {}
  app.exit(0)
}).catch((e) => { console.error(e); app.exit(1) })
