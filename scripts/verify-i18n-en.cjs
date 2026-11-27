/**
 * English UI E2E check (`language: 'en'`).
 * Verifies welcome view, sidebar/activity bar, all 6 settings tabs, Command Center,
 * and Files panel render cleanly in English with zero leaked Han UI strings and zero horizontal overflow.
 */
const { spawn } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const ROOT = path.join(__dirname, '..')
const pickPort = (min, max) => min + Math.floor(Math.random() * (max - min))
const APP_PORT = Number(process.env.I18N_EN_CDP_PORT || pickPort(21000, 29000))
const USERDATA = path.join(os.tmpdir(), 'sw-i18n-en-probe')
const children = []

function killTree(c) {
  if (!c || c.killed) return
  try {
    spawn('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {}
}
function cleanup() {
  for (const c of children) killTree(c)
}
process.on('exit', cleanup)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log('  PASS  ' + name)
  } else {
    fail++
    console.log('  FAIL  ' + name + (detail !== undefined ? ' -> ' + JSON.stringify(detail) : ''))
  }
}

function connect(url) {
  const ws = new WebSocket(url)
  const pend = new Map()
  let seq = 0
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pend.has(m.id)) {
      const { resolve, reject } = pend.get(m.id)
      pend.delete(m.id)
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
    }
  })
  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++seq
      pend.set(id, { resolve: res, reject: rej })
      ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (pend.has(id)) {
          pend.delete(id)
          rej(new Error('timeout ' + method))
        }
      }, 45000)
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
  return { ready, evaluate, send, ws }
}

async function getTarget(port) {
  for (let i = 0; i < 60; i++) {
    try {
      const l = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json()
      const t = l.find((x) => x.type === 'page' && x.webSocketDebuggerUrl)
      if (t) return t
    } catch {}
    await sleep(400)
  }
  throw new Error('no target')
}

const OVERFLOW_EXPR = `(() => {
  const W = window.innerWidth;
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right <= W + 2 && r.left >= -2) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) continue;
    bad.push({ tag: el.tagName, left: Math.round(r.left), right: Math.round(r.right), text: (el.innerText || '').slice(0, 30) });
  }
  return { count: bad.length, sample: bad.slice(0, 3) };
})()`

async function main() {
  fs.rmSync(USERDATA, { recursive: true, force: true })
  fs.mkdirSync(path.join(USERDATA, 'data'), { recursive: true })
  fs.writeFileSync(
    path.join(USERDATA, 'data', 'settings.json'),
    JSON.stringify({ language: 'en' }),
    'utf-8'
  )

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const exe = process.platform === 'win32'
    ? path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
    : path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron')

  const app = spawn(
    exe,
    ['.', '--user-data-dir=' + USERDATA, '--remote-debugging-port=' + APP_PORT, '--disable-gpu', '--no-sandbox'],
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  children.push(app)

  const t = await getTarget(APP_PORT)
  const p = connect(t.webSocketDebuggerUrl)
  await p.ready
  for (let i = 0; i < 120; i++) {
    try {
      if (await p.evaluate('document.body && document.body.innerText.includes("New SSH")')) break
    } catch {}
    await sleep(250)
  }
  await sleep(600)

  console.log('\n[English UI E2E]')
  const welcomeText = await p.evaluate('document.body.innerText')
  check('Welcome view renders in English', welcomeText.includes('New SSH') && welcomeText.includes('Recent connections'), welcomeText.slice(0, 120))
  const overflowHome = await p.evaluate(OVERFLOW_EXPR)
  check('Welcome & home layout zero horizontal overflow', overflowHome.count === 0, overflowHome)

  // Activity bar English labels
  const labels = await p.evaluate(`[...document.querySelectorAll('[data-activity]')].map(el => el.getAttribute('aria-label'))`)
  check('Activity bar labels localized', labels.includes('Connections') && labels.includes('Files'), labels)

  // Open Settings & inspect all 6 tabs
  await p.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => (x.getAttribute('aria-label') || '') === 'Settings');
    if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return !!b;
  })()`)
  await sleep(700)
  const settingsTabExpect = {
    general: 'Appearance',
    terminal: 'Terminal',
    workflow: 'Behaviour',
    shortcuts: 'Shortcuts',
    security: 'Known host keys',
    system: 'Updates'
  }
  for (const [tabId, expected] of Object.entries(settingsTabExpect)) {
    await p.evaluate(`(() => {
      const tab = document.querySelector('[data-settings-tab="${tabId}"]');
      if (tab) tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    })()`)
    await sleep(300)
    const txt = await p.evaluate('document.body.innerText')
    const ov = await p.evaluate(OVERFLOW_EXPR)
    check(`Settings tab "${tabId}" shows "${expected}" without overflow`, txt.includes(expected) && ov.count === 0, { has: txt.includes(expected), ov })
  }
  // Close Settings
  await p.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(300)

  // Open Command Center (Ctrl+K)
  await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', modifiers: 2 })
  await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', modifiers: 2 })
  await sleep(500)
  const ccTxt = await p.evaluate('document.body.innerText')
  check('Command Center renders in English', ccTxt.includes('All commands') || ccTxt.includes('All Commands') || ccTxt.includes('Recently used'), ccTxt.slice(0, 200))
  await p.evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await sleep(300)

  // Switch Activity bar to Files
  await p.evaluate(`(() => {
    const f = document.querySelector('[data-activity="files"]');
    if (f) f.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
  })()`)
  await sleep(400)
  const filesTxt = await p.evaluate('document.body.innerText')
  const ovFiles = await p.evaluate(OVERFLOW_EXPR)
  check('Files view renders in English without overflow', !filesTxt.includes('连接后可浏览') && ovFiles.count === 0, { ovFiles })

  // Check zero untranslated Han chars in UI chrome (excluding command-rail seeded command data & language switcher labels)
  const hanLeak = await p.evaluate(`(() => {
    const chunks = [];
    for (const sel of ['header', 'nav[aria-label]', 'aside', 'footer', 'main']) {
      const el = document.querySelector(sel);
      if (el) chunks.push(el.innerText || '');
    }
    const t = chunks.join('\\n').replace(/简体中文|中文/g, '');
    const m = t.match(/[\\u4e00-\\u9fff]+/g);
    return m ? [...new Set(m)].slice(0, 10) : [];
  })()`)
  check('No untranslated Chinese chrome in core views', hanLeak.length === 0, hanLeak)

  try { p.ws.close() } catch {}
  cleanup()
  await sleep(400)
  try { fs.rmSync(USERDATA, { recursive: true, force: true }) } catch {}
  console.log(`\n通过 ${pass}  失败 ${fail}`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('FATAL', e)
  cleanup()
  process.exit(1)
})
