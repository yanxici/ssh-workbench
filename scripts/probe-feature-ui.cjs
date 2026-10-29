// 视觉核对：设置 → 已知主机指纹 / 文件面板上传文件夹按钮
const port = process.argv[2] || '9339'
const fs = require('fs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch {}
    await sleep(500)
  }
  throw new Error('CDP target not found')
}

function connect(url) {
  const ws = new WebSocket(url)
  const pending = new Map()
  let seq = 0
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    }
  })
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id)
          reject(new Error('timeout: ' + method))
        }
      }, 30000)
    })
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed')
    return r.result.value
  }
  return { ws, ready, send, evaluate }
}

;(async () => {
  const target = await getTarget()
  const cdp = connect(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(1200)

  const shot = async (name) => {
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' })
    const p = require('path').join(__dirname, '..', 'stress-test-results', name)
    fs.mkdirSync(require('path').dirname(p), { recursive: true })
    fs.writeFileSync(p, Buffer.from(r.data, 'base64'))
    console.log('saved', p)
  }

  // 打开设置
  await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'')==='设置')
    btn && btn.click()
    return !!btn
  })()`)
  await sleep(700)

  // 展开「已知主机指纹」分区
  const expanded = await cdp.evaluate(`(() => {
    const ov = document.querySelector('.modal-overlay')
    if (!ov) return 'no-modal'
    const head = [...ov.querySelectorAll('button')].find(b => (b.textContent||'').includes('已知主机指纹'))
    if (!head) return 'no-section'
    head.click()
    return 'clicked'
  })()`)
  console.log('knownhosts section:', expanded)
  await sleep(800)
  const info = await cdp.evaluate(`(() => {
    const ov = document.querySelector('.modal-overlay')
    const t = ov ? ov.innerText : ''
    return {
      hasSection: t.includes('已知主机指纹'),
      hasCheckAll: t.includes('检查全部更新'),
      hasHint: t.includes('设备重装或固件升级后指纹会变'),
      rows: ov ? ov.querySelectorAll('button[title*="探测设备当前指纹"]').length : 0
    }
  })()`)
  console.log('settings probe:', JSON.stringify(info))
  await shot('feature-knownhosts.png')

  // 关掉设置，看文件面板工具栏
  await cdp.evaluate(`(() => {
    const ov = document.querySelector('.modal-overlay')
    const btn = ov && [...ov.querySelectorAll('button')].find(b => (b.getAttribute('title')||'')==='关闭')
    if (btn) btn.click()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    return true
  })()`)
  await sleep(500)
  await cdp.evaluate(`(() => {
    const el = document.querySelector('[data-activity="files"]'); el && el.click(); return !!el
  })()`)
  await sleep(900)
  const filesInfo = await cdp.evaluate(`(() => {
    const titles = [...document.querySelectorAll('button[title]')].map(b => b.getAttribute('title'))
    return {
      uploadFolder: titles.filter(t => t.includes('上传文件夹')),
      uploadFile: titles.filter(t => t.includes('上传文件'))
    }
  })()`)
  console.log('files toolbar:', JSON.stringify(filesInfo))
  await shot('feature-upload-folder.png')

  cdp.ws.close()
  process.exit(0)
})().catch((e) => {
  console.error('PROBE ERROR:', e.message)
  process.exit(2)
})
