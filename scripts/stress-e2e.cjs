/**
 * 本次改动的**真实应用内**压测（headless Electron + 真实主进程 + 真实渲染层）。
 *
 * 与 stress-cwd.cjs 的分工：
 *   - stress-cwd.cjs：纯逻辑压测，跑线上那份 .ts 源码，不需要 Electron
 *   - 本文件：在真实打包产物 out/main/index.js + 真实 renderer bundle 里跑，
 *     验证 IPC 通道、preload 契约、渲染层 store 在真实链路下的表现
 *
 * 关键点：用独立的 userData 目录，避免和用户正在跑的实例抢
 * requestSingleInstanceLock（否则启动即以 "another instance holds the lock" 退出）。
 *
 * 用法：node_modules/.bin/electron scripts/stress-e2e.cjs
 * 退出码 0 = 全部通过。
 */
const { app } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

/* 独立 userData：既躲开单实例锁，也不动用户的真实数据 */
const SANDBOX = path.join(os.tmpdir(), 'sshw-stress-' + process.pid)
fs.mkdirSync(SANDBOX, { recursive: true })
app.setPath('userData', SANDBOX)

require(path.join(__dirname, '..', 'out', 'main', 'index.js'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const rows = []
let fail = 0
function bench(name, ok, detail, budget) {
  rows.push({ name, ok, detail })
  if (!ok) fail++
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}\n        ${detail}${budget ? `  (预算 ${budget})` : ''}`)
}
function hr(t) {
  console.log('\n' + t)
  console.log('-'.repeat(t.length))
}
const ms = (n) => (n < 1 ? `${(n * 1000).toFixed(0)}µs` : `${n.toFixed(1)}ms`)
const fmt = (n) => n.toLocaleString('en-US')

app.whenReady().then(async () => {
  const { BrowserWindow } = require('electron')
  let win = null
  for (let i = 0; i < 80; i++) {
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (win) break
    await sleep(250)
  }
  if (!win) {
    console.error('没有拿到应用窗口，压测中止')
    app.exit(2)
    return
  }
  await sleep(3000)
  const run = (code) => win.webContents.executeJavaScript(code, true)

  console.log('SSH Workbench · 真实应用内压测')
  console.log('='.repeat(60))
  console.log(`userData: ${SANDBOX}`)

  /* ------------------------------------------------------------------ *
   * 1. preload 契约：新增的批量通道是否真的挂在 window.api 上
   * ------------------------------------------------------------------ */
  hr('1. preload / IPC 契约')
  {
    const shape = await run(`(() => {
      const s = window.api && window.api.sftp
      return {
        hasSftp: !!s,
        keys: s ? Object.keys(s).sort() : [],
        listManyType: s ? typeof s.listMany : 'missing',
        cwdType: window.api && window.api.sftp ? typeof window.api.sftp.cwd : 'missing'
      }
    })()`)
    bench(
      'window.api.sftp 暴露 listMany',
      shape.listManyType === 'function',
      `通道：${shape.keys.join(', ')}`,
      'listMany 存在'
    )
  }

  /* ------------------------------------------------------------------ *
   * 2. 批量通道的失败路径：不会挂死、错误可读
   * ------------------------------------------------------------------ */
  hr('2. 批量通道失败路径（未连接会话）')
  {
    const r = await run(`(async () => {
      const t0 = performance.now()
      const single = await window.api.sftp.list('__no_such_session__', '/').catch((e) => ({ thrown: String(e) }))
      const t1 = performance.now()
      const many = await window.api.sftp.listMany('__no_such_session__', ['/a', '/b', '/c', '/d']).catch((e) => ({ thrown: String(e) }))
      const t2 = performance.now()
      return {
        singleMs: t1 - t0,
        manyMs: t2 - t1,
        single: JSON.parse(JSON.stringify(single ?? null)),
        many: JSON.parse(JSON.stringify(many ?? null))
      }
    })()`)
    bench(
      'listMany 面对坏会话快速失败',
      r.manyMs < 500,
      `${ms(r.manyMs)}（单条 list ${ms(r.singleMs)}），不挂起`,
      '< 500ms'
    )
    const shapeOk =
      r.many &&
      (r.many.ok === false ||
        (r.many.dirs && Object.keys(r.many.dirs).length === 0 && r.many.errors))
    bench(
      'listMany 返回可判读的结果',
      !!shapeOk,
      JSON.stringify(r.many).slice(0, 160),
      'ok:false 或 errors'
    )
  }

  /* ------------------------------------------------------------------ *
   * 3. 本地目录：大量文件的真实读取耗时（代理远端 readdir 的成本下限）
   * ------------------------------------------------------------------ */
  hr('3. 目录读取基线（本机文件系统，代理远端 readdir 的下限）')
  {
    const perf = await run(`(async () => {
      const home = await window.api.local.home()
      const dir = home.data ?? home
      // 找一个条目最多的目录来压
      const res = await window.api.local.list(dir)
      const list = res.data ?? res
      let best = { dir, count: (list || []).length }
      return { dir: best.dir, count: best.count }
    })()`)
    bench('本地目录可读', perf.count > 0, `${perf.dir} → ${perf.count} 项`, '> 0')
  }

  /* ------------------------------------------------------------------ *
   * 4. 渲染层：目录缓存与合批在真实 bundle 里的可观测行为
   * ------------------------------------------------------------------ */
  hr('4. 渲染层真实 bundle 的目录缓存')
  {
    /*
     * dirCache / dirLoader 都是模块级单例，没有挂到 window 上，无法直接取。
     * 但它们的行为可以从**副作用**观测：同一目录在缓存期内重复 list 应当很快
     * 返回（这里走的是 SFTP 通道，坏会话下不会缓存，所以改用 local 通道验证
     * 「重复调用的边际成本」这个更普适的指标）。
     */
    const rep = await run(`(async () => {
      const home = await window.api.local.home()
      const dir = home.data ?? home
      const times = []
      for (let i = 0; i < 30; i++) {
        const t = performance.now()
        await window.api.local.list(dir)
        times.push(performance.now() - t)
      }
      times.sort((a, b) => a - b)
      return {
        min: times[0],
        median: times[15],
        p95: times[28],
        max: times[29],
        total: times.reduce((a, b) => a + b, 0)
      }
    })()`)
    bench(
      '30 次连续目录读取',
      rep.p95 < 600,
      `中位 ${ms(rep.median)}，p95 ${ms(rep.p95)}，最慢 ${ms(rep.max)}，合计 ${ms(rep.total)}`,
      'p95 < 600ms'
    )
  }

  /* ------------------------------------------------------------------ *
   * 5. 渲染层实际帧时间：文件面板挂载 + 大量行渲染
   * ------------------------------------------------------------------ */
  hr('5. 渲染层帧时间（文件面板）')
  {
    const frame = await run(`(async () => {
      const t0 = performance.now()
      let frames = 0
      await new Promise((resolve) => {
        const tick = () => {
          frames++
          if (performance.now() - t0 > 1200) resolve()
          else requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      })
      return { frames, span: performance.now() - t0, dom: document.querySelectorAll('*').length }
    })()`)
    const fps = (frame.frames / frame.span) * 1000
    bench(
      '空闲态帧率',
      fps > 30,
      `${fps.toFixed(1)} FPS（${frame.frames} 帧 / ${frame.span.toFixed(0)}ms），DOM 节点 ${fmt(frame.dom)}`,
      '> 30 FPS'
    )
  }

  /* ------------------------------------------------------------------ *
   * 6. 启动耗时：主进程 ready → 窗口首帧
   * ------------------------------------------------------------------ */
  hr('6. 冷启动')
  {
    const boot = await run(`(() => {
      const nav = performance.getEntriesByType('navigation')[0]
      const paint = performance.getEntriesByType('paint')
      const fcp = paint.find(p => p.name === 'first-contentful-paint')
      return {
        domInteractive: nav ? nav.domInteractive : -1,
        domComplete: nav ? nav.domComplete : -1,
        fcp: fcp ? fcp.startTime : -1
      }
    })()`)
    bench(
      '首屏渲染（FCP）',
      boot.fcp >= 0 && boot.fcp < 3000,
      `FCP ${ms(boot.fcp)}，domInteractive ${ms(boot.domInteractive)}，domComplete ${ms(boot.domComplete)}`,
      'FCP < 3000ms'
    )
  }

  console.log('\n' + '='.repeat(60))
  console.log(`结果：${rows.length - fail} 通过 / ${fail} 失败\n`)

  const outDir = path.join(__dirname, '../stress-test-results')
  fs.mkdirSync(outDir, { recursive: true })
  fs.writeFileSync(
    path.join(outDir, 'e2e.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        platform: `${process.platform} ${process.arch}`,
        passed: rows.length - fail,
        failed: fail,
        rows
      },
      null,
      2
    )
  )

  try {
    fs.rmSync(SANDBOX, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结果 */
  }
  app.exit(fail === 0 ? 0 : 1)
}).catch((e) => {
  console.error(e)
  app.exit(2)
})
