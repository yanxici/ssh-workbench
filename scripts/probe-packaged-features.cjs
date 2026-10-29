// 打包产物里的新功能核对：preload API / IPC 通道 / 设置与文件面板的 UI 入口
// 用法：先启动打包后的 exe（带 --remote-debugging-port），再 node scripts/probe-packaged-features.cjs <port>
const port = process.argv[2] || '9341'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      const p = list.find((t) => t.type === 'page')
      if (p) return p
    } catch {}
    await sleep(500)
  }
  throw new Error('no CDP target')
}

function connect(url) {
  const ws = new WebSocket(url)
  const pending = new Map()
  const errors = []
  let seq = 0
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const o = pending.get(m.id)
      pending.delete(m.id)
      m.error ? o.reject(new Error(JSON.stringify(m.error))) : o.resolve(m.result)
      return
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.exception?.description || 'uncaught')
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
          reject(new Error('timeout ' + method))
        }
      }, 40000)
    })
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }
  return { ws, ready, evaluate, errors }
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
}

;(async () => {
  const t = await getTarget()
  const cdp = connect(t.webSocketDebuggerUrl)
  await cdp.ready
  await sleep(1200)

  // 1) preload 暴露的新 API 必须存在于打包产物
  const api = await cdp.evaluate(`({
    probe: typeof window.api?.knownHosts?.probe,
    refresh: typeof window.api?.knownHosts?.refresh,
    uploadFolderDialog: typeof window.api?.sftp?.uploadFolderDialog,
    scanFolders: typeof window.api?.sftp?.scanFolders
  })`)
  check('knownHosts.probe 存在', api.probe === 'function', api.probe)
  check('knownHosts.refresh 存在', api.refresh === 'function', api.refresh)
  check('sftp.uploadFolderDialog 存在', api.uploadFolderDialog === 'function', api.uploadFolderDialog)
  check('sftp.scanFolders 存在', api.scanFolders === 'function', api.scanFolders)

  // 2) 真打一次 main：非法指纹必须被拒（证明通道通了、校验生效）
  const badFp = await cdp.evaluate(`window.api.knownHosts.refresh('127.0.0.1', 1, 'nope')`)
  check('known:refresh 拒绝非法指纹', badFp && badFp.ok === false, JSON.stringify(badFp).slice(0, 90))

  // 3) 目录扫描走真实主进程
  const scan = await cdp.evaluate(`window.api.sftp.scanFolders(['D:/ssh-workbench/package.json'])`)
  check(
    'sftp:scan-folders 统计正确',
    scan && scan.ok === true && scan.data.totalFiles === 1,
    scan && scan.ok ? JSON.stringify(scan.data.items) : String(scan && scan.error)
  )

  // 4) 设置 → 已知主机指纹分区
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '') === '设置')
    b && b.click()
    return !!b
  })()`)
  await sleep(800)
  for (let i = 0; i < 3; i++) {
    const done = await cdp.evaluate(`(() => {
      const ov = document.querySelector('.modal-overlay')
      const t = ov ? ov.innerText : ''
      return t.includes('暂无记录') || t.includes('检查全部更新')
    })()`)
    if (done) break
    await cdp.evaluate(`(() => {
      const ov = document.querySelector('.modal-overlay')
      const h = ov && [...ov.querySelectorAll('button')].find(b => (b.textContent || '').includes('已知主机指纹'))
      if (h) h.click()
      return !!h
    })()`)
    await sleep(600)
  }
  const kh = await cdp.evaluate(`(() => {
    const ov = document.querySelector('.modal-overlay')
    const t = ov ? ov.innerText : ''
    const empty = t.includes('暂无记录')
    const full = t.includes('检查全部更新') && t.includes('设备重装或固件升级后指纹会变')
    return { has: t.includes('已知主机指纹'), state: empty ? 'empty' : (full ? 'with-rows' : 'unknown') }
  })()`)
  check('设置里有「已知主机指纹」分区', kh.has)
  check('分区渲染完整（空态 或 批量按钮+说明）', kh.state !== 'unknown', kh.state)
  await cdp.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(700)

  // 5) 文件面板：点一次若已在该视图则会收起侧栏，这里按「看到就停」的方式定位
  let files = null
  for (let i = 0; i < 3; i++) {
    files = await cdp.evaluate(`(() => {
      const body = document.body.innerText
      const titles = [...document.querySelectorAll('button[title]')].map(b => b.getAttribute('title'))
      return {
        visible: body.includes('还没有连接任何设备') || titles.some(t => t.includes('上传文件夹')),
        guide: body.includes('还没有连接任何设备'),
        uploadFolder: titles.filter(t => t.includes('上传文件夹'))
      }
    })()`)
    if (files.visible) break
    await cdp.evaluate(`(() => {
      const e = document.querySelector('[data-activity="files"]')
      if (e) e.click()
      return !!e
    })()`)
    await sleep(900)
  }
  check(
    '文件面板已渲染（未连接=引导页，已连接=有上传文件夹按钮）',
    !!files && files.visible,
    files && files.guide ? '引导页（无会话）' : (files ? files.uploadFolder.join(' | ') : 'null')
  )

  check('无未捕获异常', cdp.errors.length === 0, cdp.errors.slice(0, 2).join(' | '))
  cdp.ws.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => {
  console.error('ERR', e.message)
  process.exit(2)
})
