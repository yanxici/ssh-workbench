// 打包产物冒烟：连 CDP 检查渲染层健康度、各视图视觉溢出、设置面板可开。
// 用法：
//   Start-Process "dist-v13\win-unpacked\SSH Workbench.exe" -ArgumentList '--remote-debugging-port=9337'
//   node scripts/smoke-cdp.cjs 9337
//
// 为什么溢出用「元素矩形超出视口」而不是 scrollWidth > clientWidth：
// 侧栏里大量 `truncate` 文本本身就是 scrollWidth 大于 clientWidth 的（这正是省略号的工作方式），
// 按 scrollWidth 判会把每一行截断文本都算成溢出，几百个假报。视觉溢出只认真正画到窗口外的盒子。
const port = process.argv[2] || '9337'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function getTarget() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page')
      if (page) return page
    } catch {}
    await sleep(500)
  }
  throw new Error(`CDP target not found on 127.0.0.1:${port}`)
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
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
    }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails?.exception?.description || 'uncaught exception')
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
          reject(new Error(`timeout: ${method}`))
        }
      }, 30000)
    })

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      awaitPromise: true,
      returnByValue: true
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || 'evaluate failed')
    }
    return r.result.value
  }

  return { ws, ready, send, evaluate, errors }
}

const results = []
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** 真正画到视口外、且可见的盒子才算视觉溢出 */
const VISUAL_OVERFLOW = `(() => {
  const W = window.innerWidth, H = window.innerHeight;
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right <= W + 2 && r.left >= -2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    if (Number(cs.opacity) === 0) continue;
    // 刻意贴在视口外的浮层（悬浮菜单 left-full 未展开时）不算
    if (cs.position === 'absolute' || cs.position === 'fixed') {
      if (cs.visibility === 'hidden' && Number(cs.opacity) === 0) continue;
    }
    bad.push({ tag: el.tagName, cls: (el.className || '').toString().slice(0, 60),
               left: Math.round(r.left), right: Math.round(r.right) });
  }
  return { W, H, count: bad.length, sample: bad.slice(0, 4) };
})()`

const CLOSE_POPUPS = `(() => {
  for (const el of document.querySelectorAll('.modal-overlay')) {
    const btn = el.querySelector('button[title="关闭"]');
    if (btn) { btn.click(); continue; }
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return document.querySelectorAll('.modal-overlay').length;
})()`

;(async () => {
  const target = await getTarget()
  const cdp = connect(target.webSocketDebuggerUrl)
  await cdp.ready
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await sleep(1500)

  // 上一轮残留的弹层先清掉，否则会污染溢出扫描
  await cdp.evaluate(CLOSE_POPUPS)
  await sleep(400)

  const title = await cdp.evaluate('document.title')
  check('页面标题', title === 'SSH Workbench', String(title))

  check('渲染层已挂载', await cdp.evaluate('!!document.querySelector("#root")?.children.length'))

  const activityCount = await cdp.evaluate('document.querySelectorAll("[data-activity]").length')
  check('活动栏入口齐全（≥5）', activityCount >= 5, `${activityCount} 个`)

  for (const view of ['connections', 'files', 'history', 'logs', 'tunnels']) {
    const clicked = await cdp.evaluate(`(() => {
      const el = document.querySelector('[data-activity="${view}"]');
      if (!el) return false;
      el.click();
      return true;
    })()`)
    if (!clicked) {
      check(`视图 ${view} 可点开`, false, '未找到入口')
      continue
    }
    await sleep(700)
    const probe = await cdp.evaluate(VISUAL_OVERFLOW)
    check(
      `视图 ${view} 无视觉溢出`,
      probe.count === 0,
      probe.count
        ? probe.sample.map((b) => `${b.tag}.${b.cls} [${b.left},${b.right}]`).join(' | ')
        : `视口 ${probe.W}x${probe.H}`
    )
  }

  await cdp.evaluate(CLOSE_POPUPS)
  await sleep(300)

  // 设置面板：活动栏底部那个按钮只有 aria-label="设置"
  const settingsClicked = await cdp.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')]
      .find(b => (b.getAttribute('aria-label') || '') === '设置');
    if (!btn) return false;
    btn.click();
    return true;
  })()`)
  await sleep(900)
  const modalTitle = await cdp.evaluate(
    'document.querySelector(".modal-overlay .modal-title")?.textContent ?? null'
  )
  check('设置面板可打开', settingsClicked && modalTitle === '设置', `title=${modalTitle}`)

  // 「跟随终端目录」开关在「行为」分区里（分区默认折叠，先展开再找）
  const followToggle = await cdp.evaluate(`(() => {
    const ov = document.querySelector('.modal-overlay');
    if (!ov) return 'no-modal';
    const sec = [...ov.querySelectorAll('button, [role="button"], .settings-section-head')]
      .find(e => (e.textContent || '').includes('行为'));
    if (sec) sec.click();
    return 'ok';
  })()`)
  await sleep(600)
  const followVisible = await cdp.evaluate(
    'document.querySelector(".modal-overlay")?.innerText.includes("跟随终端目录") ?? false'
  )
  check('设置里有「跟随终端目录」开关', followToggle === 'ok' && followVisible,
    `expand=${followToggle} visible=${followVisible}`)

  await cdp.evaluate(CLOSE_POPUPS)
  await sleep(500)

  check('无 console.error / 未捕获异常', cdp.errors.length === 0, cdp.errors.slice(0, 3).join(' | '))

  cdp.ws.close()
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => {
  console.error('SMOKE ERROR:', e.message)
  process.exit(2)
})
