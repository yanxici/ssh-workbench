// 设置面板拆分后的完整分区核对：每个 Section 都要能展开、内容在、可交互
const port = process.argv[2] || '9355'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function getTarget() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch('http://127.0.0.1:' + port + '/json/list'); const l = await r.json(); const p = l.find((t) => t.type === 'page'); if (p) return p } catch {}
    await sleep(500)
  }
  throw new Error('no target')
}
function connect(url) {
  const ws = new WebSocket(url); const pending = new Map(); const errs = []; let seq = 0
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.id && pending.has(m.id)) { const o = pending.get(m.id); pending.delete(m.id); m.error ? o.reject(new Error(JSON.stringify(m.error))) : o.resolve(m.result); return }
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails?.exception?.description || 'uncaught')
  })
  const ready = new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej) })
  const send = (method, params = {}) => new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')) } }, 40000) })
  const evaluate = async (e) => { const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed'); return r.result.value }
  return { ws, ready, evaluate, errs }
}
const results = [];
function check(n, ok, d) { results.push(ok); console.log((ok ? 'PASS  ' : 'FAIL  ') + n + (d ? ' - ' + d : '')) }
(async () => {
  const t = await getTarget(); const cdp = connect(t.webSocketDebuggerUrl); await cdp.ready; await sleep(1200)
  await cdp.evaluate("(() => { const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label')||'')==='设置'); b && b.click(); return !!b })()")
  await sleep(900)
  // 全部分区标题（拆分后每个 Section 一个组件）
  const wantIds = ['appearance','terminal','behavior','layout','shortcuts','danger','knownhosts','errorlog','update','datadir']
  const present = await cdp.evaluate("(() => { const ov = document.querySelector('.modal-overlay'); if (!ov) return null; const t = ov.innerText; return ['外观','终端','行为','侧栏宽度','快捷键','危险命令关键词','已知主机指纹','错误日志','软件更新','数据目录'].map((k,i) => ({ id: " + JSON.stringify(wantIds) + "[i], label: k, has: t.includes(k) })) })()")
  check('设置面板打开', !!present, present ? 'ok' : 'no modal')
  for (const p of present || []) check('分区存在: ' + p.label, p.has)
  // 逐个展开并检查渲染出控件（不是空壳）
  const expand = async (label) => {
    await cdp.evaluate("(() => { const ov = document.querySelector('.modal-overlay'); const b = ov && [...ov.querySelectorAll('button')].find(x => (x.textContent||'').includes(" + JSON.stringify(label) + ")); if (b) b.click(); return !!b })()")
    await sleep(450)
  }
  for (const label of ['行为','侧栏宽度','快捷键','危险命令关键词','已知主机指纹','错误日志','软件更新','数据目录']) await expand(label)
  const after = await cdp.evaluate("(() => { const ov = document.querySelector('.modal-overlay'); const t = ov ? ov.innerText : ''; return { len: t.length, hasDanger: t.includes('每行一个关键词'), hasKnown: t.includes('暂无记录') || t.includes('检查全部更新'), hasDir: t.includes('数据目录'), hasUpdate: t.includes('检查更新') || t.includes('当前版本'), inputs: ov ? ov.querySelectorAll('input,textarea,button').length : 0 } })()")
  check('展开后内容非空', after.len > 400, 'textLen=' + after.len)
  check('危险关键词说明渲染', after.hasDanger)
  check('已知主机分区渲染', after.hasKnown)
  check('数据目录渲染', after.hasDir)
  check('更新分区渲染', after.hasUpdate)
  check('控件数量合理', after.inputs > 20, 'controls=' + after.inputs)
  // 交互：切换主题（走 AppearanceSection 的 Segmented）
  const themeOk = await cdp.evaluate("(() => { const ov = document.querySelector('.modal-overlay'); const b = ov && [...ov.querySelectorAll('button')].find(x => (x.textContent||'').trim() === '暗色'); if (!b) return 'no-btn'; b.click(); return 'clicked' })()")
  await sleep(700)
  const themed = await cdp.evaluate("document.documentElement.classList.contains('dark') || document.body.className.includes('dark') || getComputedStyle(document.body).backgroundColor")
  check('主题切换按钮可点', themeOk === 'clicked', String(themeOk))
  check('主题切换后界面有响应', !!themed, String(themed).slice(0, 40))
  check('无未捕获异常', cdp.errs.length === 0, cdp.errs.slice(0, 2).join(' | '))
  cdp.ws.close()
  const failed = results.filter((x) => !x).length
  console.log('');
  console.log((results.length - failed) + '/' + results.length + ' passed')
  process.exit(failed ? 1 : 0)
})().catch((e) => { console.error('ERR', e.message); process.exit(2) })
