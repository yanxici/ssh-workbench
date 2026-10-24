/**
 * 拆解搜索耗时：分别测 input 事件处理、React commit、首屏 DOM 数量。
 * 目的：搞清楚 96s 到底是产品问题还是测量方式问题。
 */
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
  await sleep(3500)
  const run = (c) => win.webContents.executeJavaScript(c, true)

  const r = await run(`(async () => {
    const input = document.querySelector('input[placeholder*="搜索连接"]')
    if (!input) return { error: 'no input' }
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set

    // 先展开分组（默认折叠），才能测到真实行数
    const groupBtn = document.querySelector('[data-testid="connection-sidebar"] button')
    const out = { steps: [] }

    const t0 = performance.now()
    groupBtn && groupBtn.click()
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
    out.steps.push({ step: 'expand group', ms: +(performance.now() - t0).toFixed(1), rows: document.querySelectorAll('[data-conn-id]').length })

    const t1 = performance.now()
    setter.call(input, '机器人')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    out.steps.push({ step: 'input event sync', ms: +(performance.now() - t1).toFixed(1) })

    const t2 = performance.now()
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)))
    out.steps.push({ step: '2x rAF after input', ms: +(performance.now() - t2).toFixed(1), rows: document.querySelectorAll('[data-conn-id]').length })

    await new Promise((res) => setTimeout(res, 300))
    out.steps.push({ step: 'after 300ms settle', rows: document.querySelectorAll('[data-conn-id]').length, withCv: document.querySelectorAll('.conn-row-cv').length })

    out.final = { rows: document.querySelectorAll('[data-conn-id]').length, cv: document.querySelectorAll('.conn-row-cv').length }
    return out
  })()`)
  console.log(JSON.stringify(r, null, 2))
  app.exit(0)
}).catch((e) => { console.error(e); app.exit(1) })
