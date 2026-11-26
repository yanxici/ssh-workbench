/**
 * ZMODEM 批量下载「同名跳过 + 变大覆盖旧文件」回归测试：
 * 1) 主进程 src/main/ipc/zmodem.ts：
 *    - 同名同大小跳过（含 1970-01-01 / mtime=0 文件、老版本落盘文件、0 字节文件、编号完整副本）；
 *    - 同名且本地更大/远端 size=null 时保守跳过；
 *    - 远端更大（增长日志 / 本地残缺文件）走临时 .part 原子覆盖原文件，不生成 (1)/(2)；
 *    - 覆盖途中 canceled / aborted 必须删除临时 .part 且保持原文件完好；
 *    - 并发写入占位（claimedPaths）、同名目录不误跳也不覆盖；
 *    - skipExisting=false 时关闭跳过与覆盖，恢复编号保留；
 *    - 不再改写本机文件修改时间（避免产生 1970 空白修改日期）。
 * 2) 渲染层 src/renderer/src/lib/zmodem.ts + 真实主进程 IPC + 真实 zmodem.js Send 端：
 *    - 混合批次（含 1970 mtime 已存在归档、增长日志覆盖旧文件、新文件、尾文件跳过）；
 *    - 全批次跳过、首跳过尾下载、单文件跳过、取消勾选恢复编号。
 * 3) ZmodemOverlay.tsx 确认弹窗契约检查。
 *
 * 用法：node scripts/verify-zmodem-skip.cjs
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const esbuild = require('esbuild')
const Zmodem = require('zmodem.js')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-skip-'))

let pass = 0
let fail = 0
const fails = []
function check(name, ok, detail = '') {
  if (ok) pass++
  else {
    fail++
    fails.push(`${name}${detail ? ' -> ' + detail : ''}`)
  }
}

const tick = () => new Promise((r) => setImmediate(r))
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const rendererBundle = path.join(OUT_DIR, 'renderer-zmodem.cjs')
const mainIpcBundle = path.join(OUT_DIR, 'main-ipc-zmodem.cjs')

async function buildBundles() {
  await esbuild.build({
    stdin: {
      contents: `export * from './src/renderer/src/lib/zmodem'`,
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: rendererBundle,
    logLevel: 'error',
    define: { __ZM_TEST__: 'false' },
    alias: { '@shared': path.join(ROOT, 'src/shared') }
  })

  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/main/ipc/zmodem.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: mainIpcBundle,
    logLevel: 'error',
    alias: { '@shared': path.join(ROOT, 'src/shared') },
    plugins: [
      {
        name: 'stub-main-deps',
        setup(build) {
          build.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stub' }))
          build.onResolve({ filter: /^\.\.\/windowRef$/ }, () => ({ path: 'windowRef', namespace: 'stub' }))
          build.onResolve({ filter: /^\.\.\/util\/dialogDirs$/ }, () => ({ path: 'dialogDirs', namespace: 'stub' }))
          build.onResolve({ filter: /^\.\.\/ssh\/sessionManager$/ }, () => ({ path: 'sessionManager', namespace: 'stub' }))
          build.onResolve({ filter: /^\.\/handle$/ }, () => ({ path: 'handle', namespace: 'stub' }))
          build.onLoad({ filter: /.*/, namespace: 'stub' }, (args) => {
            if (args.path === 'electron') {
              return {
                contents: `
                  module.exports = {
                    BrowserWindow: function () {},
                    dialog: { showOpenDialog: async (...a) => globalThis.__zmMockDialog(...a) }
                  }
                `
              }
            }
            if (args.path === 'windowRef') return { contents: `module.exports = { dialogParent: () => null }` }
            if (args.path === 'dialogDirs') {
              return {
                contents: `module.exports = { dialogDefaultPath: () => '', rememberDialogDir: () => {}, rememberDialogPick: () => {} }`
              }
            }
            if (args.path === 'sessionManager') {
              return {
                contents: `module.exports = { sessionManager: { writeBytes: (...a) => globalThis.__zmMockWriteBytes(...a) } }`
              }
            }
            if (args.path === 'handle') {
              return {
                contents: `
                  module.exports = {
                    handle: (ch, fn) => {
                      globalThis.__zmHandlers = globalThis.__zmHandlers || new Map()
                      globalThis.__zmHandlers.set(ch, async (...args) => {
                        try { return { ok: true, data: await fn(...args) } }
                        catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) } }
                      })
                    }
                  }
                `
              }
            }
            return { contents: '' }
          })
        }
      }
    ]
  })
}

function loadMainIpc() {
  globalThis.__zmHandlers = new Map()
  globalThis.__zmMockDialog = async () => ({ canceled: true, filePaths: [] })
  globalThis.__zmMockWriteBytes = () => ({ ok: true })
  delete require.cache[require.resolve(mainIpcBundle)]
  const mod = require(mainIpcBundle)
  mod.registerZmodemIpc()
  return { mod, handlers: globalThis.__zmHandlers }
}

/** 把真实渲染层 lib/zmodem.ts 直接接到真实主进程 ipc/zmodem.ts 上 */
function loadIntegrated(saveDir) {
  const { handlers } = loadMainIpc()
  globalThis.__zmMockDialog = async () => ({ canceled: false, filePaths: [saveDir] })
  const records = []
  globalThis.window = {
    api: {
      zmodem: {
        pickFiles: (...a) => handlers.get('zm:pick-files')(...a),
        pickDir: (...a) => handlers.get('zm:pick-dir')(...a),
        saveBegin: (...a) => handlers.get('zm:save-begin')(...a),
        saveAppend: (...a) => handlers.get('zm:save-append')(...a),
        saveFinish: (...a) => handlers.get('zm:save-finish')(...a),
        sendBytes: async () => ({ ok: true, data: { ok: true } })
      },
      transfer: {
        upsert: async (rec) => {
          records.push(rec)
          return { ok: true, data: undefined }
        }
      }
    }
  }
  delete require.cache[require.resolve(rendererBundle)]
  const lib = require(rendererBundle)
  return { lib, handlers, records }
}

/** 用真实 Zmodem.Session.Send 驱动一次多文件 sz 批量下载 */
async function runBatchSz({ lib, files, confirmResult = true }) {
  const sid = 'batch-' + Math.random().toString(36).slice(2)
  const events = []
  const toRemote = []
  const toSentry = []
  let remote = null
  const offerResults = []

  lib.watchZmodem(sid, (p) => events.push(p))
  lib.ensureZmodem(sid, {
    write: () => {},
    send: (bytes) => {
      toRemote.push(Buffer.from(bytes))
    },
    confirm: async () => confirmResult,
    afterTransfer: () => {}
  })

  const pump = async (rounds = 120) => {
    for (let i = 0; i < rounds; i++) {
      let moved = false
      while (toRemote.length) {
        const buf = Buffer.concat(toRemote.splice(0, toRemote.length))
        if (!remote) {
          let hdr = null
          try {
            hdr = Zmodem.Header.parse_hex(Array.from(buf))
          } catch {
            /* ignore */
          }
          if (hdr && hdr.NAME === 'ZRINIT') {
            remote = new Zmodem.Session.Send(hdr)
            remote.set_sender((oct) => toSentry.push(Buffer.from(oct)))
          }
        } else {
          try {
            remote.consume(Array.from(buf))
          } catch {
            /* ignore */
          }
        }
        moved = true
      }
      while (toSentry.length) {
        const buf = toSentry.shift()
        lib.feedZmodem(sid, buf.toString('base64'), buf.toString('latin1'))
        moved = true
        await tick()
      }
      await tick()
      if (!moved && !toRemote.length && !toSentry.length) return
    }
  }

  toSentry.push(Buffer.from(Zmodem.Header.build('ZRQINIT', [0, 0, 0, 0]).to_hex()))
  for (let i = 0; i < 40 && !remote; i++) await pump(20)

  if (remote) {
    for (let idx = 0; idx < files.length; idx++) {
      const f = files[idx]
      let settled = false
      let transfer = null
      const offerP = remote.send_offer({
        name: f.name,
        size: f.data.length,
        mtime: f.mtime,
        files_remaining: files.length - idx
      })
      offerP.then((t) => {
        transfer = t
        settled = true
      })
      for (let i = 0; i < 200 && !settled; i++) {
        await pump(10)
        if (!settled) await wait(5)
      }
      if (!settled) {
        offerResults.push({ name: f.name, status: 'timeout' })
        break
      }
      if (!transfer) {
        offerResults.push({ name: f.name, status: 'skipped' })
        await pump(10)
        continue
      }
      offerResults.push({ name: f.name, status: 'sent' })
      let ended = false
      const endP = transfer.end(Array.from(f.data))
      endP.then(() => {
        ended = true
      })
      for (let i = 0; i < 200 && !ended; i++) {
        await pump(10)
        if (!ended) await wait(5)
      }
    }

    let closed = false
    let closeErr = null
    try {
      const closeP = remote.close()
      closeP.then(() => {
        closed = true
      })
      for (let i = 0; i < 200 && !closed; i++) {
        await pump(10)
        if (!closed) await wait(5)
      }
    } catch (e) {
      closeErr = String(e)
    }
    if (closeErr) events.push({ phase: 'error', message: closeErr })
  }

  const activeAfter = lib.isZmodemActive(sid)
  lib.detachZmodem(sid)
  return { events, offerResults, activeAfter }
}

;(async () => {
  await buildBundles()

  /* ========== 1) 主进程 IPC：同名跳过 + 变大原子覆盖旧文件 ========== */
  {
    const { handlers } = loadMainIpc()
    const tmpDir = fs.mkdtempSync(path.join(OUT_DIR, 'ipc-'))
    globalThis.__zmMockDialog = async () => ({ canceled: false, filePaths: [tmpDir] })
    const pick = await handlers.get('zm:pick-dir')()
    const tok = pick.data.token

    const remote2026 = 1795528064

    // T1: 实测复现 —— 本地已存在同名同大小文件，即使修改时间是 1970-01-01 (mtime=0)，必须直接跳过！
    const epochPath = path.join(tmpDir, 'robotTestDebug_2026-11-24_21-47-44.log')
    fs.writeFileSync(epochPath, Buffer.alloc(100, 0x61))
    fs.utimesSync(epochPath, 0, 0)
    const r1 = await handlers.get('zm:save-begin')(tok, 'robotTestDebug_2026-11-24_21-47-44.log', {
      skipExisting: true,
      size: 100,
      mtime: remote2026
    })
    check(
      'T1 实测复现：本地同名文件 mtime=1970-01-01 (0) 且同大小，直接跳过不重复下载',
      r1.ok &&
        r1.data.skipped === true &&
        r1.data.path === epochPath &&
        !fs.existsSync(path.join(tmpDir, 'robotTestDebug_2026-11-24_21-47-44 (1).log')),
      JSON.stringify(r1)
    )

    // T2: 同名且同大小、远端 mtime 更晚也直接跳过（不再因时钟差/mtime 误重下）
    const samePath = path.join(tmpDir, 'same.log')
    fs.writeFileSync(samePath, Buffer.alloc(50, 0x31))
    fs.utimesSync(samePath, 1700000000, 1700000000)
    const r2 = await handlers.get('zm:save-begin')(tok, 'same.log', {
      skipExisting: true,
      size: 50,
      mtime: remote2026
    })
    check(
      'T2 同名同大小即使远端 mtime 更晚也直接跳过',
      r2.ok && r2.data.skipped === true && r2.data.path === samePath,
      JSON.stringify(r2)
    )

    // T3: 远端文件变大（活动日志增长或本地为残缺文件）-> 走临时 .part 原子覆盖旧文件，不生成 (1)
    const growPath = path.join(tmpDir, 'robotTestDebug.log')
    fs.writeFileSync(growPath, Buffer.alloc(100, 0x63))
    const newPayload = Buffer.alloc(250, 0x64)
    const r3 = await handlers.get('zm:save-begin')(tok, 'robotTestDebug.log', {
      skipExisting: true,
      size: 250,
      mtime: remote2026
    })
    // 写入期间原文件必须保持 100B 完整，直至 saveFinish 才原子替换
    let midOldSize = -1
    let f3 = null
    if (r3.ok && !r3.data.skipped) {
      await handlers.get('zm:save-append')(r3.data.saveId, newPayload.toString('base64'))
      midOldSize = fs.statSync(growPath).size
      f3 = await handlers.get('zm:save-finish')(r3.data.saveId)
    }
    const leftovers3 = fs.readdirSync(tmpDir).filter((n) => n.startsWith('robotTestDebug.') || n.includes('.part'))
    check(
      'T3(a) 远端变大时写入过程不破坏旧文件，saveFinish 后原子覆盖为新内容且不生成 (1) 与残留 .part',
      r3.ok &&
        !r3.data.skipped &&
        midOldSize === 100 &&
        f3?.ok &&
        f3.data.path === growPath &&
        f3.data.size === 250 &&
        Buffer.compare(fs.readFileSync(growPath), newPayload) === 0 &&
        !fs.existsSync(path.join(tmpDir, 'robotTestDebug (1).log')) &&
        !leftovers3.some((n) => n.endsWith('.part')),
      `midOldSize=${midOldSize} f3=${JSON.stringify(f3)} files=${fs.readdirSync(tmpDir).join(',')}`
    )

    // T3(b): 覆盖完成后，下次同大小再次下载直接跳过
    const r3Again = await handlers.get('zm:save-begin')(tok, 'robotTestDebug.log', {
      skipExisting: true,
      size: 250,
      mtime: remote2026
    })
    check(
      'T3(b) 覆盖完成后二次同大小下载命中跳过',
      r3Again.ok && r3Again.data.skipped === true && r3Again.data.path === growPath,
      JSON.stringify(r3Again)
    )

    // T4: 覆盖途中被用户中断或异常 aborted -> 删除临时 .part，原文件完好无损！
    const keepPath = path.join(tmpDir, 'keep-old.log')
    const oldBuf = Buffer.from('OLD-VALID-LOG-100'.padEnd(100, 'X'))
    fs.writeFileSync(keepPath, oldBuf)
    const r4a = await handlers.get('zm:save-begin')(tok, 'keep-old.log', {
      skipExisting: true,
      size: 300,
      mtime: remote2026
    })
    if (r4a.ok && !r4a.data.skipped) {
      await handlers.get('zm:save-append')(r4a.data.saveId, Buffer.alloc(120, 0x77).toString('base64'))
      await handlers.get('zm:save-finish')(r4a.data.saveId, { aborted: true })
    }
    const r4c = await handlers.get('zm:save-begin')(tok, 'keep-old.log', {
      skipExisting: true,
      size: 300,
      mtime: remote2026
    })
    if (r4c.ok && !r4c.data.skipped) {
      await handlers.get('zm:save-append')(r4c.data.saveId, Buffer.alloc(80, 0x78).toString('base64'))
      await handlers.get('zm:save-finish')(r4c.data.saveId, { canceled: true })
    }
    const partLeft = fs.readdirSync(tmpDir).filter((n) => n.endsWith('.part'))
    check(
      'T4 覆盖途中 aborted / canceled 均清理临时 .part 且原文件保持完好无损',
      Buffer.compare(fs.readFileSync(keepPath), oldBuf) === 0 && partLeft.length === 0,
      `len=${fs.statSync(keepPath).size} parts=${partLeft.join(',')}`
    )

    // T5: 历史目录里已有编号完整副本（如原文件残缺 100B，(2) 是完整 250B）-> 命中完整副本跳过，不重复下
    fs.writeFileSync(path.join(tmpDir, 'hist.log'), Buffer.alloc(100, 0x11))
    fs.writeFileSync(path.join(tmpDir, 'hist (1).log'), Buffer.alloc(50, 0x12))
    const hist2 = path.join(tmpDir, 'hist (2).log')
    fs.writeFileSync(hist2, Buffer.alloc(250, 0x13))
    const r5 = await handlers.get('zm:save-begin')(tok, 'hist.log', {
      skipExisting: true,
      size: 250,
      mtime: remote2026
    })
    check(
      'T5 历史编号副本 hist (2).log 已有同大小完整文件时直接跳过',
      r5.ok && r5.data.skipped === true && r5.data.path === hist2,
      JSON.stringify(r5)
    )

    // T6: 同名已存在且远端 size 更小或为 null -> 直接跳过（不覆盖已有文件）
    const r6a = await handlers.get('zm:save-begin')(tok, 'same.log', {
      skipExisting: true,
      size: 20,
      mtime: remote2026
    })
    const r6b = await handlers.get('zm:save-begin')(tok, 'same.log', {
      skipExisting: true,
      size: null,
      mtime: remote2026
    })
    check(
      'T6 同名文件已存在且远端 size 更小或为 null 时直接跳过',
      r6a.ok && r6a.data.skipped === true && r6b.ok && r6b.data.skipped === true,
      `r6a=${JSON.stringify(r6a)} r6b=${JSON.stringify(r6b)}`
    )

    // T7: skipExisting=false 时关闭跳过与覆盖，恢复编号保留
    const r7 = await handlers.get('zm:save-begin')(tok, 'same.log', {
      skipExisting: false,
      size: 50,
      mtime: remote2026
    })
    if (r7.ok && !r7.data.skipped) await handlers.get('zm:save-finish')(r7.data.saveId, { canceled: true })
    check(
      'T7 skipExisting=false 时不跳过也不覆盖，按原规则编号保存为 same (1).log',
      r7.ok && !r7.data.skipped && r7.data.path === path.join(tmpDir, 'same (1).log'),
      JSON.stringify(r7)
    )

    // T8: 并发写入中的文件（claimedPaths 占位）不被误跳也不被并发覆盖
    const bOpen = await handlers.get('zm:save-begin')(tok, 'busy.log', {
      skipExisting: true,
      size: 0,
      mtime: remote2026
    })
    const bConc = await handlers.get('zm:save-begin')(tok, 'busy.log', {
      skipExisting: true,
      size: 0,
      mtime: remote2026
    })
    if (bOpen.ok && !bOpen.data.skipped) await handlers.get('zm:save-finish')(bOpen.data.saveId, { canceled: true })
    if (bConc.ok && !bConc.data.skipped) await handlers.get('zm:save-finish')(bConc.data.saveId, { canceled: true })
    check(
      'T8 并发写入中的文件（claimedPaths 占位）不被误跳，分配独立路径',
      bOpen.ok && !bOpen.data.skipped && bConc.ok && !bConc.data.skipped && bOpen.data.path !== bConc.data.path,
      `${JSON.stringify(bOpen)} vs ${JSON.stringify(bConc)}`
    )

    // T9: 同名目录不误判为已下载文件，也不覆盖目录
    const dirName = 'subdir'
    fs.mkdirSync(path.join(tmpDir, dirName))
    const r9 = await handlers.get('zm:save-begin')(tok, dirName, {
      skipExisting: true,
      size: 0,
      mtime: remote2026
    })
    if (r9.ok && !r9.data.skipped) await handlers.get('zm:save-finish')(r9.data.saveId, { canceled: true })
    check(
      'T9 目标路径为目录时不误跳也不覆盖，退回 subdir (1)',
      r9.ok && !r9.data.skipped && r9.data.path === path.join(tmpDir, 'subdir (1)'),
      JSON.stringify(r9)
    )

    // T10: 落盘不再调用 utimes 改写本机修改时间（即使远端带异常 1970 时间戳也不会写出空白修改日期）
    const bNew = await handlers.get('zm:save-begin')(tok, 'fresh.log', {
      skipExisting: true,
      size: 12,
      mtime: 100
    })
    await handlers.get('zm:save-append')(bNew.data.saveId, Buffer.from('123456789012').toString('base64'))
    await handlers.get('zm:save-finish')(bNew.data.saveId)
    const freshMtimeSec = Math.floor(fs.statSync(bNew.data.path).mtimeMs / 1000)
    const nowSec = Math.floor(Date.now() / 1000)
    check(
      'T10 落盘保持本机当前修改时间，不被远端异常时间戳改坏成 1970 空白日期',
      Math.abs(nowSec - freshMtimeSec) < 30,
      `freshMtimeSec=${freshMtimeSec} nowSec=${nowSec}`
    )

    // T11: 已存在的 0 字节空文件直接跳过
    const emptyPath = path.join(tmpDir, 'empty.log')
    fs.writeFileSync(emptyPath, Buffer.alloc(0))
    const r11 = await handlers.get('zm:save-begin')(tok, 'empty.log', {
      skipExisting: true,
      size: 0,
      mtime: remote2026
    })
    check(
      'T11 已存在的 0 字节空文件命中跳过',
      r11.ok && r11.data.skipped === true && r11.data.path === emptyPath,
      JSON.stringify(r11)
    )
  }

  /* ========== 2) 端到端批量 ZMODEM 协议集成（真实 IPC + 真实 Send 对端） ========== */
  {
    const saveDir = fs.mkdtempSync(path.join(OUT_DIR, 'e2e-'))
    const mtimeDate = new Date(1795528064 * 1000)

    const dataActiveOld = Buffer.alloc(100, 0x30)
    const dataActiveNew = Buffer.alloc(240, 0x31)
    const dataA = Buffer.alloc(100, 0x41)
    const dataB = Buffer.alloc(120, 0x42)
    const dataC = Buffer.alloc(80, 0x43)
    const dataD = Buffer.alloc(90, 0x44)

    // 预置：活动日志 live.log(100B)、归档 a.log(100B, mtime=0 即 1970!)、归档 c.log(80B)
    fs.writeFileSync(path.join(saveDir, 'live.log'), dataActiveOld)
    fs.writeFileSync(path.join(saveDir, 'a.log'), dataA)
    fs.utimesSync(path.join(saveDir, 'a.log'), 0, 0)
    fs.writeFileSync(path.join(saveDir, 'c.log'), dataC)

    // T12: 混合批次 —— live.log 变大覆盖旧文件、a.log(1970 mtime) 跳过、b.log 新建、c.log 尾文件跳过
    const env1 = loadIntegrated(saveDir)
    const run1 = await runBatchSz({
      lib: env1.lib,
      files: [
        { name: 'live.log', data: dataActiveNew, mtime: mtimeDate },
        { name: 'a.log', data: dataA, mtime: mtimeDate },
        { name: 'b.log', data: dataB, mtime: mtimeDate },
        { name: 'c.log', data: dataC, mtime: mtimeDate }
      ]
    })
    const last1 = run1.events[run1.events.length - 1]
    const recordedNames1 = [...new Set(env1.records.map((r) => r.fileName))].sort()
    check(
      'T12(a) 混合批次：live.log 变大原地覆盖、a(1970)/c 零流量 ZSKIP、b 新建落盘，无 (1) 副本',
      run1.offerResults.map((x) => `${x.name}:${x.status}`).join(',') ===
        'live.log:sent,a.log:skipped,b.log:sent,c.log:skipped' &&
        Buffer.compare(fs.readFileSync(path.join(saveDir, 'live.log')), dataActiveNew) === 0 &&
        Buffer.compare(fs.readFileSync(path.join(saveDir, 'b.log')), dataB) === 0 &&
        fs.readdirSync(saveDir).sort().join(',') === 'a.log,b.log,c.log,live.log',
      `offers=${JSON.stringify(run1.offerResults)} files=${fs.readdirSync(saveDir).join(',')}`
    )
    check(
      'T12(b) 尾文件跳过后会话正常收尾且最终 phase=done 汇总下载 2 / 跳过 2',
      run1.activeAfter === false &&
        !run1.events.some((e) => e.phase === 'error') &&
        last1?.phase === 'done' &&
        /下载\s*2/.test(last1.message || '') &&
        /跳过\s*2/.test(last1.message || ''),
      `active=${run1.activeAfter} last=${JSON.stringify(last1)}`
    )
    check(
      'T12(c) 传输记录只含实际下载的 b.log 与 live.log，不被跳过项污染',
      recordedNames1.join(',') === 'b.log,live.log',
      JSON.stringify(recordedNames1)
    )

    // T13: 再次下载同一批 4 个文件 -> 全部跳过！
    const env2 = loadIntegrated(saveDir)
    const run2 = await runBatchSz({
      lib: env2.lib,
      files: [
        { name: 'live.log', data: dataActiveNew, mtime: mtimeDate },
        { name: 'a.log', data: dataA, mtime: mtimeDate },
        { name: 'b.log', data: dataB, mtime: mtimeDate },
        { name: 'c.log', data: dataC, mtime: mtimeDate }
      ]
    })
    const last2 = run2.events[run2.events.length - 1]
    check(
      'T13(a) 全批次 4/4 全部 ZSKIP 跳过，目录不新增任何文件',
      run2.offerResults.every((x) => x.status === 'skipped') &&
        run2.offerResults.length === 4 &&
        fs.readdirSync(saveDir).sort().join(',') === 'a.log,b.log,c.log,live.log',
      `offers=${JSON.stringify(run2.offerResults)} files=${fs.readdirSync(saveDir).join(',')}`
    )
    check(
      'T13(b) 全批次跳过后干净结束且最终 phase=done 提示全部跳过，无多余传输记录',
      run2.activeAfter === false &&
        !run2.events.some((e) => e.phase === 'error') &&
        last2?.phase === 'done' &&
        /4/.test(last2.message || '') &&
        /跳过/.test(last2.message || '') &&
        env2.records.length === 0,
      `active=${run2.activeAfter} last=${JSON.stringify(last2)} records=${env2.records.length}`
    )

    // T14: 首文件跳过 + 尾文件下载
    const env3 = loadIntegrated(saveDir)
    const run3 = await runBatchSz({
      lib: env3.lib,
      files: [
        { name: 'a.log', data: dataA, mtime: mtimeDate },
        { name: 'd.log', data: dataD, mtime: mtimeDate }
      ]
    })
    const doneEvents3 = run3.events.filter((e) => e.phase === 'done')
    check(
      'T14 首文件跳过 + 尾文件下载：仅发一条 done 且含已跳过数，d.log 完整落盘',
      run3.activeAfter === false &&
        run3.offerResults.map((x) => `${x.name}:${x.status}`).join(',') === 'a.log:skipped,d.log:sent' &&
        doneEvents3.length === 1 &&
        /跳过\s*1/.test(doneEvents3[0].message || '') &&
        fs.existsSync(path.join(saveDir, 'd.log')) &&
        Buffer.compare(fs.readFileSync(path.join(saveDir, 'd.log')), dataD) === 0,
      `done=${JSON.stringify(doneEvents3)} offers=${JSON.stringify(run3.offerResults)}`
    )

    // T15: 用户取消勾选 skipExisting -> 同名文件照常下载并加序号，不覆盖原文件
    const env4 = loadIntegrated(saveDir)
    const run4 = await runBatchSz({
      lib: env4.lib,
      confirmResult: { accepted: true, skipExisting: false },
      files: [{ name: 'a.log', data: dataA, mtime: mtimeDate }]
    })
    check(
      'T15 确认返回 { accepted: true, skipExisting: false } 时不跳过也不覆盖，落盘为 a (1).log',
      run4.offerResults.length === 1 &&
        run4.offerResults[0].status === 'sent' &&
        fs.existsSync(path.join(saveDir, 'a (1).log')) &&
        Buffer.compare(fs.readFileSync(path.join(saveDir, 'a (1).log')), dataA) === 0,
      `offers=${JSON.stringify(run4.offerResults)} files=${fs.readdirSync(saveDir).join(',')}`
    )

    // T16: 单文件已存在时走 ZSKIP 收尾并汇报 done
    const env5 = loadIntegrated(saveDir)
    const run5 = await runBatchSz({
      lib: env5.lib,
      files: [{ name: 'd.log', data: dataD, mtime: mtimeDate }]
    })
    const last5 = run5.events[run5.events.length - 1]
    check(
      'T16 单文件已存在时走 ZSKIP 收尾，最终 phase=done 且无多余传输记录',
      run5.activeAfter === false &&
        run5.offerResults.length === 1 &&
        run5.offerResults[0].status === 'skipped' &&
        last5?.phase === 'done' &&
        last5.bytesDone === dataD.length &&
        last5.bytesTotal === dataD.length &&
        /已跳过/.test(last5.message || '') &&
        env5.records.length === 0,
      `active=${run5.activeAfter} last=${JSON.stringify(last5)} records=${env5.records.length}`
    )
  }

  /* ========== 3) UI 契约：ZmodemOverlay 提供默认勾选的跳过复选框 ========== */
  {
    const overlaySrc = fs.readFileSync(
      path.join(ROOT, 'src/renderer/src/components/terminal/ZmodemOverlay.tsx'),
      'utf8'
    )
    const i18nSrc = fs.readFileSync(
      path.join(ROOT, 'src/renderer/src/i18n/index.ts'),
      'utf8'
    )
    check(
      'T17 ZmodemOverlay 确认弹窗提供默认勾选的 skipExisting 复选框且词表说明变大覆盖旧文件',
      /useState\(true\)/.test(overlaySrc) &&
        /type="checkbox"/.test(overlaySrc) &&
        /skipExisting/.test(overlaySrc) &&
        /accepted:\s*true/.test(overlaySrc) &&
        /覆盖/.test(i18nSrc),
      'missing checkbox or overwrite wording'
    )
  }

  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  console.log('')
  if (fails.length) {
    console.log('失败项：')
    for (const f of fails) console.log('  FAIL  ' + f)
    console.log('')
  }
  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
})().catch((e) => {
  console.error(e)
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  process.exit(1)
})
