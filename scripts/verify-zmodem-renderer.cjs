/**
 * 渲染层 ZMODEM 集成回归：把真实的 src/renderer/src/lib/zmodem.ts 打包后跑起来，
 * 用假的 window.api + 真实的 zmodem.js 对端，验证本次修复。
 *
 * 覆盖：
 *   1) sz 接收：确认后必须 start()（发出 ZRINIT），对端才能把文件发出来；
 *   2) 文件内容经 saveBegin/saveAppend/saveFinish 落盘后逐字节一致；
 *   3) 远端重发起始帧（retract 旧 Detection）时不会卡死，也不会二次弹窗；
 *   4) 传输中 abortZmodem 能中断并给出提示；
 *   5) 选目录被取消时走「已取消」，不会静默挂起。
 *
 * 用法：node scripts/verify-zmodem-renderer.cjs
 * 输出：结果：N 通过 / M 失败
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-renderer-'))
const bundle = path.join(OUT_DIR, 'zmodem-bundle.cjs')

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

const Zmodem = require('zmodem.js')
const ZRINIT_FLAGS = ['CANFDX', 'CANOVIO', 'CANBRK', 'CANFC32']
const tick = () => new Promise((r) => setImmediate(r))

/** 造一个「假主进程 + 假 UI」，并把 lib 的导出接进这套环境 */
function loadLib() {
  const state = {
    dirToken: 'tok-1',
    pickDirCalls: 0,
    pickDirCanceled: false,
    saves: new Map(),
    saveBeginCalls: 0,
    appendCalls: 0,
    finishCalls: 0,
    files: new Map()
  }

  globalThis.window = {
    api: {
      zmodem: {
        pickFiles: async () => ({ ok: true, data: { canceled: true, files: [] } }),
        pickDir: async () => {
          state.pickDirCalls++
          if (state.pickDirCanceled) return { ok: true, data: { canceled: true } }
          return { ok: true, data: { canceled: false, token: state.dirToken, dir: 'C:/dl' } }
        },
        saveBegin: async (token, name) => {
          state.saveBeginCalls++
          if (token !== state.dirToken) return { ok: false, error: '保存文件夹已失效' }
          const saveId = 'save-' + state.saveBeginCalls
          state.saves.set(saveId, [])
          return { ok: true, data: { saveId, path: 'C:/dl/' + name } }
        },
        saveAppend: async (saveId, base64) => {
          state.appendCalls++
          const arr = state.saves.get(saveId)
          if (!arr) return { ok: false, error: '接收会话已失效' }
          const buf = Buffer.from(base64, 'base64')
          arr.push(buf)
          const total = arr.reduce((a, b) => a + b.length, 0)
          return { ok: true, data: { bytes: total } }
        },
        saveFinish: async (saveId) => {
          state.finishCalls++
          const arr = state.saves.get(saveId)
          if (!arr) return { ok: false, error: '接收会话已失效' }
          const buf = Buffer.concat(arr)
          state.saves.delete(saveId)
          state.files.set(saveId, buf)
          return { ok: true, data: { path: 'C:/dl/x', size: buf.length } }
        },
        sendBytes: async () => ({ ok: true, data: undefined })
      }
    }
  }

  esbuild.buildSync({
    stdin: {
      contents: `
        export * from './src/renderer/src/lib/zmodem'
      `,
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'error',
    define: { __ZM_TEST__: 'false' },
    alias: { '@shared': path.join(ROOT, 'src/shared') }
  })

  delete require.cache[require.resolve(bundle)]
  const lib = require(bundle)
  return { lib, state }
}

/**
 * 把 lib 的 Sentry 和真实的 zmodem.js 发送端接起来跑一次 sz。
 * @param {object} o
 * @param {object} o.lib 打包出来的渲染层模块
 * @param {Uint8Array} o.payload 远端要发的文件
 * @param {boolean} [o.reoffer] 是否在确认前多补发一次起始帧（模拟远端重发导致 retract）
 * @param {boolean} [o.abortMid] 是否在传输中途 abort
 * @param {boolean} [o.cancelPickDir] 选目录时取消
 */
async function runSz(o) {
  const { lib } = o
  const sessionId = 'sess-' + Math.random().toString(36).slice(2)
  const events = []
  let remote = null
  let confirmCalls = 0
  const toRemote = []

  lib.ensureZmodem(sessionId, {
    write: () => {},
    send: (bytes) => {
      toRemote.push(Buffer.from(bytes))
    },
    confirm: async () => {
      confirmCalls++
      // 需要复现「用户还没答复、远端已重发起始帧」时，把答复卡在闸门上
      while (!o.allowConfirm) await tick()
      return o.cancelPickDir ? false : true
    },
    afterTransfer: () => {}
  })
  lib.watchZmodem(sessionId, (p) => events.push(p))

  const pump = async (rounds = 500) => {
    for (let i = 0; i < rounds; i++) {
      let moved = false
      // 我方 -> 远端
      while (toRemote.length) {
        const buf = Buffer.concat(toRemote.splice(0, toRemote.length))
        if (!remote) {
          // 第一帧必须是我们发出的 ZRINIT —— 这就是 start() 是否被调用的判据
          const name = (() => {
            try {
              const copy = Buffer.from(buf)
              return Zmodem.Header.parse_hex(Array.from(copy)).NAME
            } catch {
              return null
            }
          })()
          if (name === 'ZRINIT') {
            remote = new Zmodem.Session.Send(
              Zmodem.Header.parse_hex(Array.from(buf))
            )
            // 远端发出的字节要回到我方 Sentry，而不是回灌给远端自己
            remote.set_sender((oct) => o.toSentry.push(Buffer.from(oct)))
            o.firstFrame = 'ZRINIT'
          }
        } else {
          try {
            remote.consume(Array.from(buf))
          } catch (e) {
            o.remoteError = o.remoteError || String(e)
          }
        }
        moved = true
      }
      // 远端 -> 我方：每个队列项模拟一次独立的 SSH 数据帧（不合并），
      // 这样「远端重发起始帧」才会真的走 Sentry 的 retract 分支。
      while (o.toSentry.length) {
        const buf = o.toSentry.shift()
        lib.feedZmodem(sessionId, buf.toString('base64'), buf.toString('latin1'))
        moved = true
        await tick()
      }
      await tick()
      if (!moved && !toRemote.length && !o.toSentry.length) return
    }
  }

  const zrq = () => Buffer.from(Zmodem.Header.build('ZRQINIT', [0, 0, 0, 0]).to_hex())
  o.allowConfirm = !o.reoffer
  o.toSentry = [zrq()]
  await pump()

  if (o.reoffer) {
    // 用户还没答复，远端已重发起始帧：旧 Detection 被 retract，新的接管
    o.toSentry.push(zrq())
    await pump()
    o.allowConfirm = true
    for (let i = 0; i < 30; i++) await tick()
    await pump()
  }

  // 等我们的 start() 把 ZRINIT 发出去（远端据此构造）
  for (let i = 0; i < 40 && !remote; i++) await pump(20)

  // 对端还没收到我们的 ZRINIT 时，会把 ZRQINIT 再补发一次。
  // 这一帧会落进已建立的会话里，库会抛 "Unhandled header: ZRQINIT"，
  // 必须当噪声吞掉，绝不能因此中止会话。
  if (remote && o.retransmitMid) {
    o.toSentry.push(zrq())
    await pump()
  }

  if (remote && o.payload) {
    let transfer = 'timeout'
    const offerP = remote.send_offer({ name: 'payload.bin', size: o.payload.length, mtime: new Date() })
    offerP.then((t) => {
      transfer = t
    })
    for (let i = 0; i < 80 && transfer === 'timeout'; i++) {
      await pump(6)
      await tick()
    }
    if (transfer && transfer !== 'timeout') {
      const CHUNK = 700
      for (let off = 0; off < o.payload.length; off += CHUNK) {
        transfer.send(o.payload.subarray(off, Math.min(off + CHUNK, o.payload.length)))
        await pump(6)
        if (o.abortMid && off > 0 && !o.aborted) {
          o.aborted = true
          lib.abortZmodem(sessionId)
        }
      }
      let ended = false
      transfer.end().then(() => {
        ended = true
      })
      for (let i = 0; i < 60 && !ended; i++) {
        await pump(6)
        await tick()
      }
    }
  }

  await pump(20)
  for (let i = 0; i < 20; i++) await tick()

  lib.detachZmodem(sessionId)
  return { events, confirmCalls, remote, toRemote }
}

;(async () => {
  /* ---------- 1 + 2：正常接收一个文件，逐字节一致 ---------- */
  {
    const { lib, state } = loadLib()
    const payload = new Uint8Array(20000)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 17 + 3) & 0xff
    payload[5] = 0x18
    payload[6] = 0x10
    payload[7] = 0x0d
    payload[8] = 0x8a

    const ctx = { lib, payload }
    const { events, confirmCalls } = await runSz(ctx)
    const o = ctx
    check('接收方向确认后发出了 ZRINIT（start() 被调用）', o.firstFrame === 'ZRINIT', String(o.firstFrame))
    check('只弹一次确认（不会叠加弹窗）', confirmCalls === 1, `confirmCalls=${confirmCalls}`)
    check('接收前先选了保存文件夹', state.pickDirCalls === 1, `pickDirCalls=${state.pickDirCalls}`)
    check('建立了接收文件句柄', state.saveBeginCalls === 1, `saveBeginCalls=${state.saveBeginCalls}`)
    check('按块落盘（多块，不是一次性塞整份）', state.appendCalls >= 1, `appendCalls=${state.appendCalls}`)
    check('收尾调用了 saveFinish', state.finishCalls === 1, `finishCalls=${state.finishCalls}`)

    const saved = state.files.get('save-1')
    check('落盘内容字节数与源文件一致', !!saved && saved.length === payload.length,
      saved ? `${saved.length} vs ${payload.length}` : 'no file')
    check('落盘内容逐字节一致（含 ZDLE/CR/LF 转义）',
      !!saved && Buffer.compare(saved, Buffer.from(payload)) === 0)

    const phases = events.map((e) => e.phase)
    check('进度回调经历过 detected -> active -> done',
      phases.includes('detected') && phases.includes('active') && phases.includes('done'),
      phases.join(','))
    const done = events.filter((e) => e.phase === 'done').pop()
    check('done 事件带文件名', !!done && done.fileName === 'payload.bin', JSON.stringify(done))
    check('done 事件带最终大小', !!done && done.bytesDone === payload.length, JSON.stringify(done && done.bytesDone))
    check('没有出现 error 事件', !events.some((e) => e.phase === 'error'),
      JSON.stringify(events.filter((e) => e.phase === 'error')))
    check('远端侧无协议异常', !o.remoteError, String(o.remoteError))
  }

  /* ---------- 2b：对端补发 ZRQINIT（sz 没收到我方 ZRINIT 时的定时重传）不能打断会话 ---------- */
  {
    const { lib, state } = loadLib()
    const payload = new Uint8Array(4000)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 13 + 5) & 0xff

    const ctx = { lib, payload, retransmitMid: true }
    const { events } = await runSz(ctx)
    const saved = state.files.get('save-1')
    check('对端重发 ZRQINIT 时仍能完整收完',
      !!saved && saved.length === payload.length && Buffer.compare(saved, Buffer.from(payload)) === 0,
      saved ? `${saved.length} vs ${payload.length}` : 'no file')
    check('对端重发 ZRQINIT 不会触发 error 事件（不会被当成协议错误中止）',
      !events.some((e) => e.phase === 'error'),
      JSON.stringify(events.filter((e) => e.phase === 'error')))
  }

  /* ---------- 3：远端重发起始帧（旧 Detection 被 retract）也不能卡死 ---------- */
  {
    const { lib, state } = loadLib()
    const payload = new Uint8Array(3000)
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff

    const ctx = { lib, payload, reoffer: true }
    const { events, confirmCalls } = await runSz(ctx)
    const o = ctx
    check('远端重发起始帧时仍然成功握手', o.firstFrame === 'ZRINIT', String(o.firstFrame))
    check('重发场景最终落盘字节一致',
      (() => {
        const saved = state.files.get('save-1')
        return !!saved && saved.length === payload.length && Buffer.compare(saved, Buffer.from(payload)) === 0
      })(),
      `files=${[...state.files.entries()].map(([k, v]) => k + ':' + v.length).join(',')} expect=${payload.length}`)
    check('重发场景没有卡在 error', !events.some((e) => e.phase === 'error'),
      JSON.stringify(events.filter((e) => e.phase === 'error')))
    check('重发场景没有额外弹窗（最多 1 次确认）', confirmCalls <= 1, `confirmCalls=${confirmCalls}`)
  }

  /* ---------- 4：中途中断 ---------- */
  {
    const { lib, state } = loadLib()
    const payload = new Uint8Array(60000)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff

    const ctx = { lib, payload, abortMid: true }
    const { events } = await runSz(ctx)
    const errs = events.filter((e) => e.phase === 'error')
    check('中断后给出「已中断传输」提示',
      errs.some((e) => (e.message || '').includes('已中断')),
      JSON.stringify(errs))
    check('中断不会调用 saveFinish（半截文件不当作完成）', state.finishCalls === 0,
      `finishCalls=${state.finishCalls}`)
  }

  /* ---------- 5：选目录被取消 ---------- */
  {
    const { lib, state } = loadLib()
    state.pickDirCanceled = true
    const { events } = await runSz({ lib, payload: new Uint8Array(10) })
    const errs = events.filter((e) => e.phase === 'error')
    check('取消选目录时明确报错，不静默挂起',
      errs.some((e) => (e.message || '').includes('保存文件夹')),
      JSON.stringify(errs))
    check('取消选目录后不再建立接收文件', state.saveBeginCalls === 0,
      `saveBeginCalls=${state.saveBeginCalls}`)
  }

  /* ---------- 6：确认弹窗挂着时点「中断」必须立刻退出（不能死在 await 上） ---------- */
  {
    const { lib, state } = loadLib()
    const sessionId = 's-cancel-confirm'
    let confirmCalls = 0
    const events = []
    lib.watchZmodem(sessionId, (p) => events.push(p))
    lib.ensureZmodem(sessionId, {
      write: () => {},
      send: () => {},
      confirm: () => {
        confirmCalls += 1
        return new Promise(() => {}) // 用户在弹窗上还没答复
      }
    })
    const zrq = Zmodem.Header.build('ZRQINIT', [0, 0, 0, 0]).to_hex()
    lib.feedZmodem(sessionId, Buffer.from(zrq).toString('base64'), Buffer.from(zrq).toString('latin1'))
    for (let i = 0; i < 20; i++) await tick()

    lib.abortZmodem(sessionId)
    for (let i = 0; i < 40; i++) await tick()

    check('弹窗期间点中断：确认流程被解除（prompting 复位，不再永久挂起）',
      confirmCalls === 1 && lib.getZmodemProgress(sessionId)?.phase !== 'detected',
      `confirmCalls=${confirmCalls} snap=${JSON.stringify(lib.getZmodemProgress(sessionId))}`)

    // 中断后远端重新发起始帧，必须能重新弹一次确认（不能被「流程在路上」挡住）
    lib.feedZmodem(sessionId, Buffer.from(zrq).toString('base64'), Buffer.from(zrq).toString('latin1'))
    for (let i = 0; i < 20; i++) await tick()
    check('中断后下次 sz 仍能重新询问（不会永久哑掉）', confirmCalls === 2,
      `confirmCalls=${confirmCalls}`)
    lib.abortZmodem(sessionId)
    lib.detachZmodem(sessionId)
  }

  /* ---------- 7：手动「选择文件夹」入口（对话框没弹出来时的兜底） ---------- */
  {
    const { lib, state } = loadLib()
    const sessionId = 's-manual-dir'
    lib.ensureZmodem(sessionId, { write: () => {}, send: () => {}, confirm: () => Promise.resolve(false) })
    const ok = await lib.chooseZmodemSaveDir(sessionId)
    check('进度面板能手动选保存文件夹（兜底入口可用）', ok === true && state.pickDirCalls === 1,
      `ok=${ok} pickDirCalls=${state.pickDirCalls}`)
    const snap = lib.getZmodemProgress(sessionId)
    check('手动选目录后提示实际保存路径', !!snap && (snap.message || '').includes('C:/dl'),
      JSON.stringify(snap))
    const ok2 = await lib.chooseZmodemSaveDir(sessionId)
    check('手动选目录可重复调用（换一个文件夹）', ok2 === true && state.pickDirCalls === 2,
      `pickDirCalls=${state.pickDirCalls}`)
    lib.detachZmodem(sessionId)
  }

  /* ---------- 8：进度快照（切标签页/重挂载后必须能恢复面板，否则卡死没出口） ---------- */
  {
    const { lib, state } = loadLib()
    const sessionId = 's-snapshot'
    let confirmCalls = 0
    lib.ensureZmodem(sessionId, {
      write: () => {},
      send: () => {},
      confirm: () => {
        confirmCalls += 1
        return new Promise(() => {}) // 用户还没答复：停在「等待确认」
      }
    })
    // 让 Sentry 认出一个真实起始帧
    const zrq = Zmodem.Header.build('ZRQINIT', [0, 0, 0, 0]).to_hex()
    lib.feedZmodem(sessionId, Buffer.from(zrq).toString('base64'), Buffer.from(zrq).toString('latin1'))
    for (let i = 0; i < 40; i++) await tick()

    const snap = lib.getZmodemProgress(sessionId)
    check('检测到传输但用户未答复时仍留有进度快照',
      !!snap && snap.phase === 'detected' && snap.direction === 'receive',
      JSON.stringify(snap))
    check('快照能支撑界面恢复「中断」按钮（phase 为 detected 而非空）',
      snap?.phase === 'detected', String(snap?.phase))
    check('未答复期间不重复弹确认', confirmCalls === 1, `confirmCalls=${confirmCalls}`)

    // 用户按 Esc / 点「中断」：必须真的能退出，且之后快照不再是传输态
    lib.abortZmodem(sessionId)
    for (let i = 0; i < 10; i++) await tick()
    const after = lib.getZmodemProgress(sessionId)
    check('中断后不会继续停留在传输态', !after || after.phase !== 'active',
      JSON.stringify(after))
    lib.detachZmodem(sessionId)
    check('会话销毁后快照一并清理', lib.getZmodemProgress(sessionId) === null,
      JSON.stringify(lib.getZmodemProgress(sessionId)))
  }

  console.log('')
  if (fails.length) {
    console.log('失败项：')
    for (const f of fails) console.log('  FAIL  ' + f)
    console.log('')
  }
  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
})()
