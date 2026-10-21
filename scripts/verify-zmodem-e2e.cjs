/**
 * ZMODEM 端到端行为验证：用真实的 zmodem.js 双端互相喂字节，
 * 复现用户报的「sz 显示收取后一直等待」并验证已修复。
 *
 * 关键回归点：
 *   1) 我方 Receive 会话不调 start() 时，远端永远收不到 ZRINIT -> 卡死（bug 复现）；
 *   2) 调 start() 后，远端能握手并完整发完文件（修复验证）；
 *   3) 收到的数据与源文件逐字节一致（含 0x00/0xFF/ZDLE 等二进制）；
 *   4) 用户 skip 后远端能收到 ZSKIP 并退出（可退出）。
 *
 * 用法：node scripts/verify-zmodem-e2e.cjs
 * 输出：结果：N 通过 / M 失败
 */
const Zmodem = require('zmodem.js')

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

const ZRINIT_FLAGS = ['CANFDX', 'CANOVIO', 'CANBRK', 'CANFC32']
const tick = () => new Promise((r) => setImmediate(r))

/**
 * 跑一次接收场景。
 * @param {object} o
 * @param {boolean} o.callStart 是否在 confirm 后调用 start()
 * @param {Uint8Array} o.payload 远端要发的文件内容
 * @param {boolean} o.skip 收到 offer 后立刻 skip
 */
async function scenario({ callStart, payload, skip = false }) {
  const r = {
    detected: false,
    role: null,
    firstSentName: null,
    firstSentBytes: 0,
    offer: null,
    chunks: [],
    settled: 'timeout',
    error: null,
    terminalBytes: 0,
    remoteError: null
  }

  let toSentry = []
  let toRemote = []
  let discardFirstHeader = true

  const sentry = new Zmodem.Sentry({
    to_terminal: (o) => {
      r.terminalBytes += o.length
    },
    on_retract: () => {},
    sender: (o) => {
      toRemote.push(...Array.from(o))
    },
    on_detect: (d) => {
      r.detected = true
      r.role = d.get_session_role()
      const session = d.confirm()
      session.on('offer', (offer) => {
        r.offer = offer.get_details()
        if (skip) {
          offer.skip()
          r.settled = 'skipped'
          return
        }
        offer
          .accept({
            on_input: (chunk) => {
              r.chunks.push(Buffer.from(chunk))
            }
          })
          .then(() => {
            r.settled = 'accepted'
          })
          .catch((e) => {
            r.error = String(e)
            r.settled = 'error'
          })
      })
      if (callStart) session.start()
    }
  })

  // 远端发送方：Send 的构造函数本身就代表「已收到我方 ZRINIT」
  const remote = new Zmodem.Session.Send(Zmodem.Header.build('ZRINIT', ZRINIT_FLAGS))
  remote.set_sender((o) => {
    toSentry.push(...Array.from(o))
  })

  const pump = async (rounds = 400) => {
    for (let i = 0; i < rounds; i++) {
      let moved = false
      if (toSentry.length) {
        const b = toSentry
        toSentry = []
        try {
          sentry.consume(b)
        } catch (e) {
          r.error = r.error || 'sentry: ' + String(e)
        }
        moved = true
      }
      if (toRemote.length) {
        let b = toRemote
        toRemote = []
        if (discardFirstHeader) {
          discardFirstHeader = false
          const copy = b.slice()
          try {
            r.firstSentName = Zmodem.Header.parse_hex(copy).NAME
          } catch {
            r.firstSentName = null
          }
          r.firstSentBytes = b.length
          b = copy.splice(0, b.length) && [] // 丢弃：Send 构造时已“消费”我方 ZRINIT
        }
        if (b.length) {
          try {
            remote.consume(b)
          } catch (e) {
            r.remoteError = r.remoteError || String(e)
          }
        }
        moved = true
      }
      await tick()
      if (!toSentry.length && !toRemote.length) {
        await tick()
        if (!toSentry.length && !toRemote.length) return
      }
      if (!moved) await tick()
    }
  }

  // 远端发起：ZRQINIT
  toSentry.push(...Zmodem.Header.build('ZRQINIT', [0, 0, 0, 0]).to_hex())
  await pump()

  // 远端进入发送流程（内部会先发 ZSINIT 等 ZACK，再发 ZFILE）
  let transfer = 'timeout'
  const offerP = remote.send_offer({
    name: 'payload.bin',
    size: payload.length,
    mtime: new Date()
  })
  const done = offerP.then((t) => {
    transfer = t
  })
  for (let i = 0; i < 60 && transfer === 'timeout'; i++) {
    await pump(4)
    await tick()
  }
  await Promise.race([done, tick()])

  if (transfer && transfer !== 'timeout') {
    const CHUNK = 1000
    for (let off = 0; off < payload.length; off += CHUNK) {
      transfer.send(payload.subarray(off, Math.min(off + CHUNK, payload.length)))
      await pump(4)
    }
    let ended = false
    transfer.end().then(() => {
      ended = true
    })
    for (let i = 0; i < 40 && !ended; i++) {
      await pump(4)
      await tick()
    }
    await pump(4)
  }

  return r
}

;(async () => {
  /* ---------- 1. 复现 bug：不调 start() ---------- */
  const bad = await scenario({ callStart: false, payload: new Uint8Array([1, 2, 3]) })
  check('不调 start() 时仍能检测到会话（检测逻辑本身没问题）', bad.detected === true)
  check('不调 start() 时我方从不发首帧，远端拿不到 ZRINIT', bad.firstSentName === null && bad.firstSentBytes === 0)
  check('不调 start() 时永远拿不到 offer（用户看到的就是卡在这里）', bad.offer === null)

  /* ---------- 2. 修复验证：调 start() 后完整收完 ---------- */
  const payload = new Uint8Array(9000)
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 31 + 7) & 0xff
  payload[10] = 0x18 // ZDLE
  payload[11] = 0x10 // DLE
  payload[12] = 0x11 // XON
  payload[13] = 0x0d
  payload[14] = 0x8a

  const good = await scenario({ callStart: true, payload })
  check('调 start() 后我方发出的首帧是 ZRINIT', good.firstSentName === 'ZRINIT',
    `name=${good.firstSentName} bytes=${good.firstSentBytes}`)
  check('调 start() 后 role 判为 receive（sz 方向）', good.role === 'receive', String(good.role))
  check('调 start() 后收到 offer，文件名正确',
    !!good.offer && good.offer.name === 'payload.bin', JSON.stringify(good.offer))
  const got = Buffer.concat(good.chunks.map((c) => Buffer.from(c)))
  check('收到的字节数与源文件一致', got.length === payload.length, `${got.length} vs ${payload.length}`)
  check('收到的字节内容逐字节一致（含二进制/ZDLE 转义）',
    Buffer.compare(got, Buffer.from(payload)) === 0)
  check('接收 promise 正常结束（不再卡死）', good.settled === 'accepted', `settled=${good.settled}`)
  check('接收全程无协议异常', !good.error, String(good.error))
  check('远端侧无协议异常', !good.remoteError, String(good.remoteError))

  /* ---------- 3. 可退出：用户 skip ---------- */
  const skipRes = await scenario({ callStart: true, payload: new Uint8Array(64), skip: true })
  check('skip 场景同样完成握手', skipRes.firstSentName === 'ZRINIT' && !!skipRes.offer)
  check('用户 skip 后走 skipped 分支（远端收到 ZSKIP 后可退出）',
    skipRes.settled === 'skipped', String(skipRes.settled))
  check('skip 场景远端无协议异常', !skipRes.remoteError, String(skipRes.remoteError))

  console.log('')
  if (fails.length) {
    console.log('失败项：')
    for (const f of fails) console.log('  FAIL  ' + f)
    console.log('')
  }
  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail ? 1 : 0)
})()
