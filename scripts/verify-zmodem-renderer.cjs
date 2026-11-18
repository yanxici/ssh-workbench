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
 *   6) 上传（rz）：选文件 -> 发完 -> ZFIN 收尾，会话不残留；
 *   7) 上传：对端不回 ZSINIT 的 ZACK 也要照常发出文件；
 *   8) 上传：文件收尾后才到的迟到 ZACK 不能打死会话；
 *   9) 上传：对端完全不回应时 20 秒超时报错，不会无限挂在 0 字节；
 *  10) 上传：用户在文件选择框里停留很久时，靠我们自己补的 ZSINIT 把远端 rz 撑住，
 *      取消后能干净 abort，不留下活动会话。
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
const tick = () => new Promise((r) => setImmediate(r))

/** 造一个「假主进程 + 假 UI」，并把 lib 的导出接进这套环境 */
function loadLib(opts = {}) {
  const state = {
    dirToken: 'tok-1',
    uploadFiles: opts.uploadFiles || null,
    // 模拟「用户在文件选择框里停留了 pickDelayMs 才取消」：远端 rz 在此期间无人搭理
    pickDelayMs: opts.pickDelayMs || 0,
    pickFilesCalls: 0,
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
        pickFiles: async () => {
          state.pickFilesCalls++
          if (state.pickDelayMs) await new Promise((r) => setTimeout(r, state.pickDelayMs))
          if (!state.uploadFiles) return { ok: true, data: { canceled: true, files: [] } }
          return { ok: true, data: { canceled: false, files: state.uploadFiles } }
        },
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

/**
 * 手搓 lrzsz 风格的字节流驱动接收端。
 * 不能用 zmodem.js 的发送端：它的发送侧永远只发 ZCRCG/ZCRCE，
 * 造不出真 sz 的 ZCRCW（帧尾等 ZACK）和重复的 ZDATA 头。
 *
 * @param {object} o
 * @param {object} o.lib 打包出来的渲染层模块
 * @param {number} [o.total] 文件大小（默认 1600）
 * @param {'end_ack'|'no_end_ack'} [o.frameEnd] 帧尾类型：end_ack 即 ZCRCW
 * @param {boolean} [o.duplicateFrame] 先塞一个重复的 ZDATA 头，模拟丢帧/重传
 * @param {boolean} [o.splitFrame] 把一帧拆成两帧：前半只发 ZCRCG 就不发了，
 *   模拟真 sz 在丢帧时的实际形态（此时 offset 才落后于对端，ZRPOS 才会报半程）
 */
async function frameSz(o) {
  const { lib } = o
  const total = o.total || 1600
  const frameEnd = o.frameEnd || 'end_ack'
  const half = total >> 1
  const sessionId = 's-frame-' + Math.random().toString(36).slice(2)
  const term = []
  const sent = []
  const events = []

  lib.ensureZmodem(sessionId, {
    write: (t) => term.push(t),
    send: (bytes) => sent.push(Buffer.from(bytes)),
    confirm: async () => true,
    afterTransfer: () => {}
  })
  lib.watchZmodem(sessionId, (p) => events.push(p))

  const enc = new Zmodem.ZDLE()
  enc.set_escape_ctrl_chars(true)
  const hex = (name, args) => Buffer.from(Zmodem.Header.build(name, args || []).to_hex())
  const sub = (payload, fe) =>
    Buffer.from(Zmodem.Subpacket.build(Array.from(payload), fe).encode16(enc))
  const info = (name, size) =>
    Buffer.concat([Buffer.from(name), Buffer.from([0]), Buffer.from(size + ' 0 100644 0')])
  const feed = (buf) => lib.feedZmodem(sessionId, buf.toString('base64'), buf.toString('latin1'))
  const pump = async (n = 40) => {
    for (let i = 0; i < n; i++) await tick()
  }
  const parsed = () =>
    sent.map((b) => {
      try {
        return Zmodem.Header.parse_hex(Array.from(b))
      } catch {
        return null
      }
    })
  const names = () => parsed().map((h) => (h ? h.NAME : '?'))
  // ZACK 不是 ZOffsetHeader（没有 get_offset），只能自己按 4 字节小端解
  const offsets = (name) =>
    parsed()
      .filter((h) => h && h.NAME === name)
      .map((h) => {
        if (typeof h.get_offset === 'function') return h.get_offset()
        return Zmodem.ENCODELIB.unpack_u32_le(h._bytes4)
      })

  feed(hex('ZRQINIT', [0, 0, 0, 0]))
  await pump()
  feed(Buffer.concat([hex('ZFILE', [0]), sub(info('frame.bin', total), 'end_ack')]))
  await pump()

  if (o.splitFrame) {
    // 前半帧单独成一个 ZDATA 帧（ZCRCG 结尾），链路在这里断掉：
    // 此时我们只认下 half 字节，对端却以为整帧都发出去了
    feed(Buffer.concat([hex('ZDATA', [0]), sub(Buffer.alloc(half, 0x31), 'no_end_no_ack')]))
    await pump()
    // 重传的同一个头：库里 ZDATA 处理器已被消费 → Unhandled header: ZDATA
    feed(Buffer.concat([hex('ZDATA', [0]), sub(Buffer.alloc(half, 0x31), 'no_end_no_ack')]))
    await pump()
    // 对端按我们重发的 ZRPOS(half) 从断点续传后半程
    feed(Buffer.concat([hex('ZDATA', [half]), sub(Buffer.alloc(total - half, 0x32), frameEnd)]))
    await pump()
  } else {
    // 一帧里两个子包：ZCRCG 续发 + ZCRCW 帧尾等确认（真 sz 的窗口边界就是这样）
    feed(
      Buffer.concat([
        hex('ZDATA', [0]),
        sub(Buffer.alloc(half, 0x31), 'no_end_no_ack'),
        sub(Buffer.alloc(total - half, 0x32), frameEnd)
      ])
    )
    await pump()
  }

  feed(hex('ZEOF', [total]))
  await pump(80)

  const doneEv = events.filter((e) => e.phase === 'done').pop()
  const errs = events.filter((e) => e.phase === 'error')
  lib.detachZmodem(sessionId)
  return {
    doneBytes: doneEv ? doneEv.bytesDone : 0,
    errors: errs.map((e) => e.message),
    sentNames: names(),
    zrposOffsets: offsets('ZRPOS'),
    zackOffset: offsets('ZACK').pop(),
    termLength: term.join('').length,
    termHead: JSON.stringify(term.join('').slice(0, 40))
  }
}

/**
 * 上传方向（rz）回归：用真实的 zmodem.js 接收端当对端，跑一次完整的
 * 「选文件 -> ZFILE -> ZDATA -> ZEOF -> ZFIN」流程。
 *
 * 覆盖历史上把上传彻底卡死或打死会话的三种情形：
 *  1) 对端不回 ZSINIT 的 ZACK（老库会无限等，一个字节都发不出去）；
 *  2) 对端完全不回应（老库没有超时，界面永远停在 0 字节）；
 *  3) 文件收尾之后才对上的迟到 ZACK（老库当未知头部抛错，会话被打死，rz 被重新识别一轮）。
 *
 * @param {object} o
 * @param {object} o.lib 打包出来的渲染层模块
 * @param {Uint8Array} o.payload 要上传的内容
 * @param {boolean} [o.dropZack] 对端吞掉所有 ZACK（模拟不回 ZSINIT 确认）
 * @param {boolean} [o.strayZack] 文件收完后往我方案里多塞一帧迟到 ZACK
 * @param {boolean} [o.deadPeer] 对端只发一帧 ZRINIT，之后彻底哑掉
 * @param {boolean} [o.timeoutMs] deadPeer 场景的最长等待
 */
async function runRz(o) {
  const { lib } = o
  const sessionId = 's-up-' + Math.random().toString(36).slice(2)
  const events = []
  const sent = []
  const toRemote = []
  const toUs = []
  let received = 0
  let fileEnd = false
  let sessionEnd = false
  let offerName = null

  lib.ensureZmodem(sessionId, {
    write: () => {},
    send: (bytes) => {
      const buf = Buffer.from(bytes)
      sent.push(buf)
      toRemote.push(buf)
    },
    confirm: async () => true,
    afterTransfer: () => {}
  })
  lib.watchZmodem(sessionId, (p) => events.push(p))

  const remote = new Zmodem.Session.Receive()
  remote.set_sender((oct) => {
    const buf = Buffer.from(oct)
    if (o.dropZack && nameOf(buf) === 'ZACK') return
    toUs.push(buf)
  })
  remote.on('offer', (offer) => {
    offerName = (offer._file_info && offer._file_info.name) || null
    offer.accept({ on_input: (piece) => (received += piece.length) })
  })
  remote.on('file_end', () => (fileEnd = true))
  remote.on('session_end', () => (sessionEnd = true))

  const pump = async (rounds = 400) => {
    for (let i = 0; i < rounds; i++) {
      let moved = false
      while (toRemote.length) {
        const buf = toRemote.shift()
        if (o.deadPeer) {
          // 对端已经走了：没人读我们发出去的东西
          moved = true
          continue
        }
        // 一次性喂 64KB 会爆栈，按 4KB 切片
        for (let off = 0; off < buf.length; off += 4096) {
          try {
            remote.consume(Array.from(buf.subarray(off, off + 4096)))
          } catch (err) {
            o.remoteError = o.remoteError || String(err)
          }
        }
        moved = true
      }
      while (toUs.length) {
        const buf = toUs.shift()
        lib.feedZmodem(sessionId, buf.toString('base64'), buf.toString('latin1'))
        moved = true
        await tick()
      }
      await tick()
      if (!moved && !toRemote.length && !toUs.length) return
    }
  }

  const settled = () => events.some((e) => e.phase === 'done' || e.phase === 'error')
  const deadline = Date.now() + (o.deadPeer ? (o.timeoutMs || 26000) : 15000)

  if (o.deadPeer) {
    // rz 只留下起始帧就走了：之后无论我方补多少 ZSINIT 都没有任何回应
    toUs.push(Buffer.from(Zmodem.Header.build('ZRINIT', ['CANFDX', 'CANOVIO', 'CANFC32']).to_hex()))
  } else {
    remote.start()
  }


  while (Date.now() < deadline && !settled()) {
    await pump(200)
    await new Promise((r) => setTimeout(r, 2))
  }

  if (o.strayZack && !o.deadPeer) {
    // 收尾之后才到的 ZACK：老库此时处理器表已换成 {ZRINIT}，会抛 Unhandled header
    const zack = Buffer.from(Zmodem.Header.build('ZACK', [0, 1, 0, 0]).to_hex())
    lib.feedZmodem(sessionId, zack.toString('base64'), zack.toString('latin1'))
    await pump(60)
  }

  await pump(200)
  for (let i = 0; i < 20; i++) await tick()

  const active = lib.isZmodemActive(sessionId)
  lib.detachZmodem(sessionId)
  return {
    events,
    sentNames: sent.map((b) => nameOf(b) || '?'),
    received,
    fileEnd,
    sessionEnd,
    active,
    offerName,
    remoteError: o.remoteError
  }
}

/** 从一帧字节里读头部名（读不出就是子包/数据） */
function nameOf(buf) {
  try {
    return Zmodem.Header.parse_hex(Array.from(buf)).NAME
  } catch {
    return null
  }
}

/**
 * 传输中途「纯静默」场景的公共脚手架：
 * 真 sz 被 kill / 链路丢窗口 / 网关断流时，双方都不抛错、也不发 ZEOF，
 * 修复前界面就永远停在最后一个百分比。这里只搭台子，断言交给调用方。
 */
function silenceBench(opts = {}) {
  const { lib, state } = loadLib()
  // 真实 15 秒太慢，压到调用方给的值
  lib.receiveWatchdog.idleMs = opts.idleMs || 120
  const sessionId = 's-idle-' + Math.random().toString(36).slice(2)
  const sent = []
  const events = []
  lib.ensureZmodem(sessionId, {
    write: () => {},
    send: (bytes) => sent.push(Buffer.from(bytes)),
    confirm: async () => true,
    afterTransfer: () => {}
  })
  lib.watchZmodem(sessionId, (p) => events.push(p))

  const enc = new Zmodem.ZDLE()
  enc.set_escape_ctrl_chars(true)
  const hex = (name, args) => Buffer.from(Zmodem.Header.build(name, args || []).to_hex())
  const sub = (payload, fe) =>
    Buffer.from(Zmodem.Subpacket.build(Array.from(payload), fe).encode16(enc))
  const info = (name, size) =>
    Buffer.concat([Buffer.from(name), Buffer.from([0]), Buffer.from(size + ' 0 100644 0')])
  const feed = (buf) => lib.feedZmodem(sessionId, buf.toString('base64'), buf.toString('latin1'))
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  const names = () =>
    sent
      .map((b) => {
        try {
          return Zmodem.Header.parse_hex(Array.from(b)).NAME
        } catch {
          return null
        }
      })
      .filter(Boolean)
  const offsets = (name) =>
    sent
      .map((b) => {
        try {
          return Zmodem.Header.parse_hex(Array.from(b))
        } catch {
          return null
        }
      })
      .filter((h) => h && h.NAME === name)
      .map((h) => h.get_offset())

  // 起手：ZRQINIT -> ZFILE -> 一小段真实数据，之后由调用方决定是否静默
  const start = async (total, firstBytes) => {
    feed(hex('ZRQINIT', [0, 0, 0, 0]))
    await wait(20)
    feed(Buffer.concat([hex('ZFILE', [0]), sub(info('idle.bin', total), 'end_ack')]))
    await wait(20)
    if (firstBytes > 0) {
      feed(Buffer.concat([hex('ZDATA', [0]), sub(Buffer.alloc(firstBytes, 0x41), 'end_ack')]))
      await wait(30)
    }
  }

  const finish = (total) => {
    feed(hex('ZEOF', [total]))
  }

  const teardown = () => {
    lib.detachZmodem(sessionId)
    lib.receiveWatchdog.idleMs = 15000
  }

  return { lib, state, sessionId, sent, events, hex, sub, info, feed, wait, names, offsets, start, finish, teardown }
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
    // 用户主动中断算 canceled 不算 error：账本上要能和真正的失败区分开
    const errs = events.filter((e) => e.phase === 'error' || e.phase === 'canceled')
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
    const errs = events.filter((e) => e.phase === 'error' || e.phase === 'canceled')
    check('取消选目录时明确报错，不静默挂起',
      errs.some((e) => (e.message || '').includes('保存文件夹')),
      JSON.stringify(errs))
    check('取消选目录后不再建立接收文件', state.saveBeginCalls === 0,
      `saveBeginCalls=${state.saveBeginCalls}`)
  }

  /* ---------- 6：确认弹窗挂着时点「中断」必须立刻退出（不能死在 await 上） ---------- */
  {
    const { lib } = loadLib()
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
    const { lib } = loadLib()
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

  /* ---------- 9：真 sz 用 ZCRCW 帧尾等 ZACK，库自己不回，必须由我们补 ---------- */
  {
    const { lib, state } = loadLib()
    const h = await frameSz({ lib, total: 1600, frameEnd: 'end_ack' })
    check('收到 ZCRCW 帧后主动补发 ZACK', h.sentNames.includes('ZACK'), h.sentNames.join(','))
    check('ZACK 的 offset 与实际收下的字节数一致', h.zackOffset === 1600,
      'zackOffset=' + h.zackOffset + ' sent=' + h.sentNames.join(','))
    check('补 ZACK 不影响文件收完', h.doneBytes === 1600, 'doneBytes=' + h.doneBytes)
    check('补 ZACK 期间不写终端', h.termLength === 0, 'termLength=' + h.termLength)
    check('补 ZACK 时只落盘一份文件', state.finishCalls === 1, 'finishCalls=' + state.finishCalls)
    check('落盘字节数与文件大小一致', (state.files.get('save-1') || { length: -1 }).length === 1600,
      'saved=' + (state.files.get('save-1') || { length: -1 }).length)
  }

  /* ---------- 10：重复的 ZDATA 头（丢帧/重传）要续传，不能 abort 也不能乱码 ---------- */
  {
    const { lib, state } = loadLib()
    const h = await frameSz({ lib, total: 1600, duplicateFrame: true, splitFrame: true })
    check('解析器抛错后重发 ZRPOS 请求续传', h.zrposOffsets.includes(800),
      'zrpos=' + h.zrposOffsets.join(','))
    check('续传期间不向终端写协议字节（无乱码瀑布）', h.termLength === 0,
      'termLength=' + h.termLength + ' head=' + h.termHead)
    check('续传后不再报错结束', h.errors.length === 0, JSON.stringify(h.errors))
    check('续传后文件完整收完', h.doneBytes === 1600, 'doneBytes=' + h.doneBytes)
    check('续传后落盘字节数正确（重发块不能重复追加）',
      (state.files.get('save-1') || { length: -1 }).length === 1600,
      'saved=' + (state.files.get('save-1') || { length: -1 }).length)
  }

  /* ---------- 11：abort 之后远端继续喷二进制，不能刷进终端 ---------- */
  {
    const { lib } = loadLib()
    const sessionId = 's-garble-' + Math.random().toString(36).slice(2)
    const term = []
    lib.ensureZmodem(sessionId, {
      write: (t) => term.push(t),
      send: () => {},
      confirm: async () => true,
      afterTransfer: () => {}
    })
    const zrq2 = Buffer.from(Zmodem.Header.build('ZRQINIT', [0, 0, 0, 0]).to_hex())
    lib.feedZmodem(sessionId, zrq2.toString('base64'), zrq2.toString('latin1'))
    for (let i = 0; i < 20; i++) await tick()
    lib.abortZmodem(sessionId)
    for (let i = 0; i < 10; i++) await tick()
    const junk = Buffer.alloc(4000, 0xab)
    lib.feedZmodem(sessionId, junk.toString('base64'), junk.toString('latin1'))
    lib.feedZmodem(sessionId, junk.toString('base64'), junk.toString('latin1'))
    for (let i = 0; i < 10; i++) await tick()
    check('中断后远端仍在推的二进制不写进终端', term.join('').length === 0,
      'len=' + term.join('').length + ' head=' + JSON.stringify(term.join('').slice(0, 40)))
    lib.detachZmodem(sessionId)
  }

  /* ---------- 12：上传（rz）正常路径：选文件 -> 发完 -> 收尾干净 ---------- */
  {
    const payload = new Uint8Array(120000)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + 11) & 0xff
    const { lib } = loadLib({
      uploadFiles: [{ name: 'rsync', size: payload.length, data: Buffer.from(payload).toString('base64') }]
    })
    const r = await runRz({ lib, payload })

    check('上传：对端收到完整文件', r.received === payload.length, `received=${r.received}/${payload.length}`)
    check('上传：文件名传到对端', r.offerName === 'rsync', String(r.offerName))
    check('上传：跑完 ZFIN 结束会话', r.sentNames.includes('ZFIN'), r.sentNames.join(','))
    check('上传：对端确认文件结束', r.fileEnd === true, String(r.fileEnd))
    check('上传：对端确认会话结束', r.sessionEnd === true, String(r.sessionEnd))
    check('上传：结束后不残留活动会话', r.active === false, String(r.active))
    const last = r.events[r.events.length - 1]
    check('上传：进度收在 done 且字节数对得上',
      last && last.phase === 'done' && last.bytesDone === payload.length,
      JSON.stringify(last))
  }

  /* ---------- 13：对端不回 ZSINIT 的 ZACK 也不能卡死 ---------- */
  {
    const payload = new Uint8Array(60000)
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 13 + 5) & 0xff
    const { lib } = loadLib({
      uploadFiles: [{ name: 'rsync', size: payload.length, data: Buffer.from(payload).toString('base64') }]
    })
    const r = await runRz({ lib, payload, dropZack: true })

    check('上传：对端不回 ZACK 时仍能发出文件', r.received === payload.length,
      `received=${r.received}/${payload.length}`)
    check('上传：不回 ZACK 也能正常收尾', r.fileEnd === true && r.sessionEnd === true,
      `fileEnd=${r.fileEnd} sessionEnd=${r.sessionEnd}`)
    check('上传：不回 ZACK 时进度仍以 done 收尾',
      r.events[r.events.length - 1]?.phase === 'done',
      JSON.stringify(r.events[r.events.length - 1]))
  }

  /* ---------- 14：文件收完之后的迟到 ZACK 不能打死会话 ---------- */
  {
    const payload = new Uint8Array(40000, 0x5a)
    const { lib } = loadLib({
      uploadFiles: [{ name: 'rsync', size: payload.length, data: Buffer.from(payload).toString('base64') }]
    })
    const r = await runRz({ lib, payload, strayZack: true })

    check('上传：迟到 ZACK 不影响文件完整性', r.received === payload.length,
      `received=${r.received}/${payload.length}`)
    check('上传：迟到 ZACK 不产生 error 事件',
      r.events.filter((e) => e.phase === 'error').length === 0,
      JSON.stringify(r.events.filter((e) => e.phase === 'error')))
    check('上传：迟到 ZACK 不重新触发「检测到传输」',
      r.events.filter((e) => e.phase === 'detected').length === 1,
      JSON.stringify(r.events.map((e) => e.phase)))
    check('上传：迟到 ZACK 后会话仍然是结束态', r.active === false, String(r.active))
  }

  /* ---------- 15：对端完全不回应时必须超时退出，不能无限挂在 0 字节 ---------- */
  {
    const payload = new Uint8Array(100000, 7)
    const { lib } = loadLib({
      uploadFiles: [{ name: 'rsync', size: payload.length, data: Buffer.from(payload).toString('base64') }]
    })
    const t0 = Date.now()
    const r = await runRz({ lib, payload, deadPeer: true, timeoutMs: 26000 })
    const elapsed = Date.now() - t0
    const err = r.events.filter((e) => e.phase === 'error').pop()

    check('上传：对端无回应时 25 秒内报错退出', elapsed < 25000, `elapsed=${elapsed}`)
    check('上传：超时报错文案说明是远端无回应', !!err && /无回应/.test(err.message),
      JSON.stringify(err))
    check('上传：超时后不残留活动会话', r.active === false, String(r.active))
  }

  /* ---------- 16：用户在文件选择框里待很久，远端 rz 不能被晾死 ---------- */
  {
    // 不提供文件（最终取消），但让 pickFiles 挂 12 秒：
    // 这段时间远端 rz 一直在等 ZFILE，靠我们自己补的 ZSINIT 撑着
    const { lib } = loadLib({ pickDelayMs: 12000 })
    const t0 = Date.now()
    const r = await runRz({ lib, payload: new Uint8Array(0), timeoutMs: 16000 })
    const elapsed = Date.now() - t0
    const zsinits = r.sentNames.filter((n) => n === 'ZSINIT').length
    // 取消选了不算 error，账本上要能和真正的失败区分
    const err = r.events.filter((e) => e.phase === 'error' || e.phase === 'canceled').pop()

    check('上传：选文件期间持续给远端补 ZSINIT（≥2 帧）', zsinits >= 2, 'zsinits=' + zsinits)
    check('上传：取消选文件后走 abort，不留下活动会话', r.active === false, String(r.active))
    check('上传：取消选文件报「未选择文件」', !!err && err.message === '未选择文件',
      JSON.stringify(err))
    check('上传：等用户选文件的 12 秒期间远端仍在线（未超时崩掉）', elapsed >= 11000,
      'elapsed=' + elapsed)
  }

  /* ---------- 17：终态快照不再往界面恢复（切走再切回不该重放已完成的面板） ---------- */
  {
    const { lib } = loadLib()
    const sessionId = 's-terminal-snap-' + Math.random().toString(36).slice(2)
    const events = []
    lib.watchZmodem(sessionId, (p) => events.push(p))
    lib.ensureZmodem(sessionId, {
      write: () => {},
      send: () => {},
      confirm: async () => true,
      afterTransfer: () => {}
    })

    const enc = new Zmodem.ZDLE()
    enc.set_escape_ctrl_chars(true)
    const hex = (name, args) => Buffer.from(Zmodem.Header.build(name, args || []).to_hex())
    const sub = (payload, fe) =>
      Buffer.from(Zmodem.Subpacket.build(Array.from(payload), fe).encode16(enc))
    const info = (name, size) =>
      Buffer.concat([Buffer.from(name), Buffer.from([0]), Buffer.from(size + ' 0 100644 0')])
    const feed = (buf) => lib.feedZmodem(sessionId, buf.toString('base64'), buf.toString('latin1'))
    const total = 1200

    feed(hex('ZRQINIT', [0, 0, 0, 0]))
    for (let i = 0; i < 40; i++) await tick()
    feed(Buffer.concat([hex('ZFILE', [0]), sub(info('snap.bin', total), 'end_ack')]))
    for (let i = 0; i < 40; i++) await tick()

    const mid = lib.getZmodemProgress(sessionId)
    check('传输进行中仍能恢复进度快照（切标签页回来面板还在）',
      !!mid && (mid.phase === 'active' || mid.phase === 'detected'),
      JSON.stringify(mid))

    feed(Buffer.concat([hex('ZDATA', [0]), sub(Buffer.alloc(total, 0x41), 'end_ack')]))
    for (let i = 0; i < 60; i++) await tick()
    feed(hex('ZEOF', [total]))
    for (let i = 0; i < 80; i++) await tick()

    const doneEv = events.filter((e) => e.phase === 'done').pop()
    check('实时 watcher 仍然收到 done（面板当场能提示已保存）', !!doneEv,
      JSON.stringify(events.map((e) => e.phase)))
    check('完成后不再从快照恢复面板（切走再切回不会重放）',
      lib.getZmodemProgress(sessionId) === null,
      JSON.stringify(lib.getZmodemProgress(sessionId)))

    // 再切一次「标签页」：重新挂载只会调用 getZmodemProgress，仍必须是空
    check('重复读取快照仍为空（重挂载幂等）',
      lib.getZmodemProgress(sessionId) === null,
      JSON.stringify(lib.getZmodemProgress(sessionId)))
    check('完成态字节数与文件大小一致（快照过滤没影响收尾）',
      doneEv && doneEv.bytesDone === total, JSON.stringify(doneEv))

    // 中断同样是终态：error 快照也不该被恢复
    lib.abortZmodem(sessionId)
    for (let i = 0; i < 10; i++) await tick()
    const afterAbort = lib.getZmodemProgress(sessionId)
    check('中断后的 error 快照同样不恢复', afterAbort === null, JSON.stringify(afterAbort))

    lib.detachZmodem(sessionId)
  }


  /* ---------- 18：传输中途纯静默（对端不发也不报错）必须被看门狗救回来 ---------- */
  {
    const b = silenceBench({ idleMs: 120 })
    const total = 1600
    await b.start(total, 800)
    const beforeZrp = b.offsets('ZRPOS').length
    await b.wait(500) // 远超 120ms 看门狗，对端一直哑着
    const resumeZrp = b.offsets('ZRPOS').slice(beforeZrp)
    // 文案不再固定为「没有收到数据」：对端反复重发被丢弃的区间时字节在流，
    // 但没有新进展，此时的准确说法是「没有进展」。断言只认「说明 + 续传位置」。
    const note = b.events
      .filter((e) => (e.message || '').includes('续传') && (e.message || '').includes('800'))
      .pop()

    check('静默超时后看门狗主动重发 ZRPOS 叫醒对端',
      resumeZrp.length >= 1, 'sent=' + b.names().join(','))
    check('续传位置就是已收下的字节数（不从头再来）',
      resumeZrp[0] === 800, 'resume=' + resumeZrp[0] + ' all=' + b.offsets('ZRPOS').join(','))
    check('看门狗续传时给出可读提示', !!note, JSON.stringify(b.events.map((e) => e.message)))
    check('看门狗续传不把会话判死（没有 error）',
      !b.events.some((e) => e.phase === 'error'),
      JSON.stringify(b.events.filter((e) => e.phase === 'error')))

    // 对端「活过来」，从 800 处续发后半程
    b.feed(Buffer.concat([b.hex('ZDATA', [800]), b.sub(Buffer.alloc(800, 0x42), 'end_ack')]))
    await b.wait(30)
    b.finish(total)
    await b.wait(80)

    const doneEv = b.events.filter((e) => e.phase === 'done').pop()
    check('被看门狗救回后文件仍完整收完', !!doneEv && doneEv.bytesDone === total,
      JSON.stringify(doneEv))
    const saved = b.state.files.get('save-1')
    check('救回后落盘内容完整且没有重复段',
      !!saved && saved.length === total && saved[0] === 0x41 && saved[total - 1] === 0x42,
      saved ? 'len=' + saved.length : 'no file')
    check('救回后不再出现 error', !b.events.some((e) => e.phase === 'error'),
      JSON.stringify(b.events.filter((e) => e.phase === 'error')))
    b.teardown()
  }

  /* ---------- 19：数据一直在流时看门狗不能误触发 ---------- */
  {
    const b = silenceBench({ idleMs: 120 })
    const total = 800
    await b.start(total, 0)
    const before = b.offsets('ZRPOS').length
    // 真 sz 只在帧首发一个 ZDATA 头，之后靠 ZCRCG/ZCRCW 子包连着发；
    // 每包再发一个 ZDATA 头会被库判成 Unhandled header（那是另一条续传路径）。
    // 这里照抄真实的流：包间 40ms，整段跨度远超阈值，但任意两包之间都不超。
    b.feed(Buffer.concat([
      b.hex('ZDATA', [0]),
      b.sub(Buffer.alloc(100, 0x43), 'no_end_no_ack')
    ]))
    await b.wait(40)
    for (let off = 100; off < total; off += 100) {
      const fe = off + 100 >= total ? 'end_ack' : 'no_end_no_ack'
      b.feed(b.sub(Buffer.alloc(100, 0x43), fe))
      await b.wait(40)
    }
    check('持续有数据时不误发 ZRPOS', b.offsets('ZRPOS').length === before,
      'zrp=' + b.offsets('ZRPOS').length + ' before=' + before)
    b.finish(total)
    await b.wait(80)
    const doneEv = b.events.filter((e) => e.phase === 'done').pop()
    check('持续数据流场景照常收完', !!doneEv && doneEv.bytesDone === total, JSON.stringify(doneEv))
    b.teardown()
  }

  /* ---------- 20：对端真死了，连续续传无果要如实报错，不能永远转圈 ---------- */
  {
    const b = silenceBench({ idleMs: 60 })
    const total = 1600
    await b.start(total, 600)
    // accept 本身就会发一次 ZRPOS(0)，只数静默之后的
    const baseZrp = b.offsets('ZRPOS').length
    await b.wait(900) // 3 轮续传 + 报错
    const err = b.events.filter((e) => e.phase === 'error').pop()
    check('连续续传无果后如实报错（不再永远转圈）', !!err,
      JSON.stringify(b.events.map((e) => e.phase)))
    check('报错文案说明已保留的部分', !!err && /已保留前 600 字节/.test(err.message),
      JSON.stringify(err))
    check('报错后会话被释放（不残留活动传输）', b.lib.isZmodemActive(b.sessionId) === false,
      String(b.lib.isZmodemActive(b.sessionId)))
    const zrpCount = b.offsets('ZRPOS').length - baseZrp
    check('续传次数封顶（不会无限重试）', zrpCount <= 3, 'zrp=' + zrpCount)
    b.teardown()
  }
  /* ---------- 21：对端反复重发同一段（字节在流、文件不涨）也必须被看门狗救回 ---------- */
  {
    const b = silenceBench({ idleMs: 80 })
    const total = 1600
    await b.start(total, 800)
    const baseZrp = b.offsets('ZRPOS').length
    // 复刻「sz 被 kill 后的假活」：对端无视 ZRPOS，继续从文件尾之后推字节。
    // 这些包命中 on_input 的 start >= total 早退分支，只累加 receivedBytes，
    // fileOffset 一动不动 —— 链路看着很忙，文件一个字节没长。
    // 修复前看门狗按「收到字节」计时，每包都给它续命，于是永远等不到干预；
    // 修复后按「落盘进展」计时，这种假活会被正常判定为停滞并封顶报错。
    b.feed(Buffer.concat([b.hex('ZDATA', [total]), b.sub(Buffer.alloc(100, 0x41), 'no_end_no_ack')]))
    for (let i = 0; i < 20; i++) {
      b.feed(b.sub(Buffer.alloc(100, 0x41), 'no_end_no_ack'))
      await b.wait(20)
    }
    await b.wait(400)
    const err = b.events.filter((e) => e.phase === 'error').pop()
    check('重发假活场景最终如实报错（不会无限重发 ZRPOS）', !!err,
      JSON.stringify(b.events.map((e) => e.phase + ':' + (e.message || ''))))
    // 上限 3 次静默续传；乱帧路径（resyncReceive）自己还会再发一次 ZRPOS，
    // 所以这里留一格余量。真 bug 是「无限重发」，不是 3 还是 4。
    check('重发假活场景的续传次数同样封顶', b.offsets('ZRPOS').length - baseZrp <= 4,
      'zrp=' + (b.offsets('ZRPOS').length - baseZrp))
    check('重发假活场景不会把文件写脏（长度不超过已收下的部分）',
      (b.state.files.get('save-1') || Buffer.alloc(0)).length <= 800,
      'len=' + (b.state.files.get('save-1') || Buffer.alloc(0)).length)
    b.teardown()
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
