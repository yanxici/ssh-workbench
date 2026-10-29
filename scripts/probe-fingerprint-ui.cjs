// 交互核对：点「指纹」按钮 → 探测失败必须给出可读错误，且不炸界面
const port = process.argv[2] || '9339'
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
  throw new Error('no target')
}
function connect(url) {
  const ws = new WebSocket(url)
  const pending = new Map()
  const errors = []
  let seq = 0
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id)
      pending.delete(m.id)
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
      return
    }
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails?.exception?.description || 'uncaught')
  })
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)) } }, 40000)
  })
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed')
    return r.result.value
  }
  return { ws, ready, send, evaluate, errors }
}
;(async () => {
  const t = await getTarget()
  const cdp = connect(t.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await sleep(1000)
  await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label')||'')==='设置')
    btn && btn.click(); return !!btn
  })()`)
  await sleep(600)
  // 分区开合状态会被 localStorage 记住：先确保它是展开的（看不见行就再点一次）
  for (let i = 0; i < 3; i++) {
    const hasRows = await cdp.evaluate(`(() => {
      const ov = document.querySelector('.modal-overlay')
      return !!ov && !!ov.querySelector('button[title*="探测设备当前指纹"]')
    })()`)
    if (hasRows) break
    await cdp.evaluate(`(() => {
      const ov = document.querySelector('.modal-overlay')
      const head = ov && [...ov.querySelectorAll('button')].find(b => (b.textContent||'').includes('已知主机指纹'))
      if (head) head.click()
      return !!head
    })()`)
    await sleep(600)
  }
  const clicked = await cdp.evaluate(`(() => {
    const ov = document.querySelector('.modal-overlay')
    const b = ov && ov.querySelector('button[title*="探测设备当前指纹"]')
    if (!b) return 'no-button'
    b.click()
    return 'clicked'
  })()`)
  console.log('probe click:', clicked)
  // 探测超时是 10s（不可达地址会等满），这里留足余量
  await sleep(14000)
  const after = await cdp.evaluate(`(() => {
    const ov = document.querySelector('.modal-overlay')
    const t = ov ? ov.innerText : ''
    return {
      hasError: t.includes('探测失败'),
      errorLine: (t.split('\\n').find(l => l.includes('探测失败')) || '').slice(0, 120),
      busy: !!ov && !!ov.querySelector('button[disabled]')
    }
  })()`)
  console.log('after probe:', JSON.stringify(after))
  console.log('exceptions:', cdp.errors.length ? cdp.errors.slice(0,2).join(' | ') : 'none')
  cdp.ws.close()
  const ok = after.hasError && cdp.errors.length === 0
  process.exit(ok ? 0 : 1)
})().catch((e) => { console.error('ERR', e.message); process.exit(2) })
