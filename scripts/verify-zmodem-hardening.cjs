/**
 * ZMODEM 全链路加固回归（P0-1 ~ P3-15）：
 * 直接打包真实的 src/renderer/src/lib/zmodem.ts、src/main/ipc/zmodem.ts、
 * src/main/ssh/sessionManager.ts（stub 外部 Electron/SSH 依赖）以及 ZmodemOverlay 源码契约，
 * 逐条验证「修复前必红、修复后必绿」的行为断言。
 *
 * 用法：node scripts/verify-zmodem-hardening.cjs
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const esbuild = require('esbuild')
const Zmodem = require('zmodem.js')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'zm-harden-'))

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

/* ------------------------------------------------------------------ *
 *  1) 打包渲染层 src/renderer/src/lib/zmodem.ts
 * ------------------------------------------------------------------ */
const rendererBundle = path.join(OUT_DIR, 'renderer-zmodem.cjs')
esbuild.buildSync({
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

function loadRendererLib(opts = {}) {
  const st = {
    dirToken: 'tok-h1',
    pickDirCalls: 0,
    pickDirCanceled: !!opts.pickDirCanceled,
    saveBeginCalls: 0,
    saveAppendCalls: 0,
    saveFinishCalls: 0,
    saves: new Map(),
    savePaths: new Map(),
    files: new Map()
  }
  globalThis.window = {
    api: {
      zmodem: {
        pickFiles: async () => {
          if (opts.uploadFiles) return { ok: true, data: { canceled: false, files: opts.uploadFiles } }
          return { ok: true, data: { canceled: true, files: [] } }
        },
        pickDir: async () => {
          st.pickDirCalls++
          if (st.pickDirCanceled) return { ok: true, data: { canceled: true } }
          return { ok: true, data: { canceled: false, token: st.dirToken, dir: 'C:/dl' } }
        },
        saveBegin: async (token, name) => {
          st.saveBeginCalls++
          if (opts.saveBeginFail) return { ok: false, error: opts.saveBeginFail }
          if (token !== st.dirToken) return { ok: false, error: '保存文件夹已失效' }
          const saveId = 'save-' + st.saveBeginCalls
          const p = 'C:/dl/' + name
          st.saves.set(saveId, [])
          st.savePaths.set(saveId, p)
          return { ok: true, data: { saveId, path: p } }
        },
        saveAppend: async (saveId, b64) => {
          st.saveAppendCalls++
          if (opts.appendDelayMs) await wait(opts.appendDelayMs)
          if (opts.failAppendAt && st.saveAppendCalls === opts.failAppendAt) {
            return { ok: false, error: opts.failAppendError || 'ENOSPC: 磁盘已满' }
          }
          const arr = st.saves.get(saveId)
          if (!arr) return { ok: false, error: '接收会话已失效' }
          const buf = Buffer.from(b64, 'base64')
          arr.push(buf)
          const total = arr.reduce((a, b) => a + b.length, 0)
          return { ok: true, data: { bytes: total } }
        },
        saveFinish: async (saveId, opts) => {
          st.saveFinishCalls++
          st.lastFinishOpts = opts
          const arr = st.saves.get(saveId)
          if (!arr) return { ok: false, error: '接收会话已失效' }
          const buf = Buffer.concat(arr)
          st.saves.delete(saveId)
          st.files.set(saveId, buf)
          return { ok: true, data: { path: st.savePaths.get(saveId) || 'C:/dl/x', size: buf.length } }
        },
        sendBytes: async () => ({ ok: true, data: { ok: true } })
      }
    }
  }
  delete require.cache[require.resolve(rendererBundle)]
  const lib = require(rendererBundle)
  return { lib, st }
}

const enc = new Zmodem.ZDLE()
enc.set_escape_ctrl_chars(true)
const hex = (name, args) => Buffer.from(Zmodem.Header.build(name, args || []).to_hex())
const sub16 = (payload, fe) =>
  Buffer.from(Zmodem.Subpacket.build(Array.from(payload), fe).encode16(enc))
const fileInfo = (name, size, filesRemaining) =>
  Buffer.concat([
    Buffer.from(name),
    Buffer.from([0]),
    Buffer.from(filesRemaining ? `${size} 0 100644 0 ${filesRemaining} ${size}` : `${size} 0 100644 0`)
  ])

/* ------------------------------------------------------------------ *
 *  2) 打包主进程 src/main/ipc/zmodem.ts（stub electron/windowRef/dialogDirs/sessionManager）
 * ------------------------------------------------------------------ */
const mainIpcBundle = path.join(OUT_DIR, 'main-ipc-zmodem.cjs')
async function buildMainIpc() {
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
                    dialog: {
                      showOpenDialog: async (...a) => globalThis.__zmMockDialog(...a)
                    }
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

;(async () => {
  await buildMainIpc()
  /* ========== P0-1：接收落盘队列背压 + saveAppend 失败即中断 ========== */
  {
    const { lib, st } = loadRendererLib({
      failAppendAt: 3,
      failAppendError: 'ENOSPC: 磁盘空间不足',
      appendDelayMs: 5
    })
    const sid = 'p0-1'
    const events = []
    lib.watchZmodem(sid, (p) => events.push(p))
    lib.ensureZmodem(sid, { write: () => {}, send: () => {}, confirm: async () => true })
    const feed = (buf) => lib.feedZmodem(sid, buf.toString('base64'), buf.toString('latin1'))

    // 256KB * 8 = 2MB，确保多次触发 flush；第 3 次 saveAppend 返回 ok:false
    const chunk256 = Buffer.alloc(256 * 1024, 0x41)
    const total = chunk256.length * 8
    feed(hex('ZRQINIT', [0, 0, 0, 0]))
    for (let i = 0; i < 20; i++) await tick()
    feed(Buffer.concat([hex('ZFILE', [0]), sub16(fileInfo('big.bin', total), 'end_ack')]))
    for (let i = 0; i < 20; i++) await tick()
    feed(hex('ZDATA', [0]))
    for (let k = 0; k < 8; k++) {
      // 每 256KB 分成 32 个 8KB 子包喂入，中间让出事件循环让异步失败回流
      for (let off = 0; off < chunk256.length; off += 8192) {
        const isLast = k === 7 && off + 8192 >= chunk256.length
        feed(sub16(chunk256.subarray(off, off + 8192), isLast ? 'end_no_ack' : 'no_end_no_ack'))
      }
      await wait(15)
    }
    await wait(80)

    const errEv = events.filter((e) => e.phase === 'error').pop()
    check('P0-1(a) saveAppend 失败后不再继续入队后续分块（调用次数止步于 3~4）',
      st.saveAppendCalls >= 3 && st.saveAppendCalls <= 4,
      `saveAppendCalls=${st.saveAppendCalls}`)
    check('P0-1(b) 最终上报 phase=error 且 message 含桩错误串',
      !!errEv && (errEv.message || '').includes('ENOSPC: 磁盘空间不足'),
      JSON.stringify(errEv))
    lib.detachZmodem(sid)
  }

  /* ========== P0-2：fileOffset===0 时 stall 看门狗必须有终态 ========== */
  {
    const { lib } = loadRendererLib()
    lib.receiveWatchdog.idleMs = 50
    const sid = 'p0-2'
    const events = []
    lib.watchZmodem(sid, (p) => events.push(p))
    lib.ensureZmodem(sid, { write: () => {}, send: () => {}, confirm: async () => true })
    const feed = (buf) => lib.feedZmodem(sid, buf.toString('base64'), buf.toString('latin1'))

    feed(hex('ZRQINIT', [0, 0, 0, 0]))
    // 不发任何 ZFILE / ZDATA，等 300ms
    await wait(300)

    const errs = events.filter((e) => e.phase === 'error')
    check('P0-2 fileOffset===0 持续无数据时 300ms 内出现且仅出现一条 error',
      errs.length === 1 && /远端始终没有开始发送/.test(errs[0].message || ''),
      `errs=${JSON.stringify(errs.map((e) => e.message))}`)
    check('P0-2 终态报错后释放活动会话', lib.isZmodemActive(sid) === false, String(lib.isZmodemActive(sid)))
    lib.receiveWatchdog.idleMs = 15000
    lib.detachZmodem(sid)
  }

  /* ========== P0-3：beginSave 真实失败不得伪装成 cancel，也不得 skip ========== */
  {
    const { lib } = loadRendererLib({ saveBeginFail: 'EACCES: 目录无写入权限' })
    const sid = 'p0-3'
    const events = []
    const sent = []
    lib.watchZmodem(sid, (p) => events.push(p))
    lib.ensureZmodem(sid, {
      write: () => {},
      send: (b) => sent.push(Buffer.from(b)),
      confirm: async () => true
    })
    const feed = (buf) => lib.feedZmodem(sid, buf.toString('base64'), buf.toString('latin1'))

    feed(hex('ZRQINIT', [0, 0, 0, 0]))
    for (let i = 0; i < 20; i++) await tick()
    feed(Buffer.concat([hex('ZFILE', [0]), sub16(fileInfo('deny.bin', 100), 'end_ack')]))
    for (let i = 0; i < 40; i++) await tick()

    const sentNames = sent.map((b) => {
      try { return Zmodem.Header.parse_hex(Array.from(b)).NAME } catch { return '?' }
    })
    const errEv = events.filter((e) => e.phase === 'error').pop()
    const cancelEv = events.filter((e) => e.phase === 'canceled')
    check('P0-3 saveBegin 失败上报 phase=error 且带具体原因（不伪装成 canceled）',
      !!errEv && (errEv.message || '').includes('EACCES: 目录无写入权限') && cancelEv.length === 0,
      `err=${JSON.stringify(errEv)} cancels=${cancelEv.length}`)
    check('P0-3 saveBegin 失败不发送 ZSKIP（未调用 offer.skip）',
      !sentNames.includes('ZSKIP'),
      `sent=${sentNames.join(',')}`)
    lib.detachZmodem(sid)
  }

  /* ========== P0-4：收窄 5 秒静默窗口（放行正常提示符、仍吞残渣与二进制乱码） ========== */
  {
    const { lib } = loadRendererLib()
    const sid = 'p0-4'
    const term = []
    lib.ensureZmodem(sid, { write: (t) => term.push(t), send: () => {}, confirm: async () => true })
    const feed = (buf) => lib.feedZmodem(sid, buf.toString('base64'), buf.toString('latin1'))

    // 先建立再中断会话，触发 suppressUntil = now + 5000
    feed(hex('ZRQINIT', [0, 0, 0, 0]))
    for (let i = 0; i < 20; i++) await tick()
    lib.abortZmodem(sid)
    for (let i = 0; i < 10; i++) await tick()

    // 1) 正常 shell 提示符应放行
    const prompt = Buffer.from('root@host:~$ ')
    feed(prompt)
    // 2) ZDLE 控制残渣必须被吞
    const zdle = Buffer.from('\x18\x18\x18')
    feed(zdle)
    // 3) 无效 UTF-8 二进制乱码仍必须被吞（保住既有测试 #11）
    const binary = Buffer.alloc(100, 0xab)
    feed(binary)
    for (let i = 0; i < 10; i++) await tick()

    const out = term.join('')
    check('P0-4 suppressUntil 窗口内放行正常提示符 "root@host:~$ "',
      out.includes('root@host:~$ '), JSON.stringify(out))
    check('P0-4 suppressUntil 窗口内仍吞掉 "\\x18\\x18\\x18" 与二进制乱码',
      !out.includes('\x18') && !out.includes('\uFFFD'), JSON.stringify(out))
    lib.detachZmodem(sid)
  }

  /* ========== P0-5：状态复位 + armAutoTimer 方向准确 ========== */
  {
    const { lib } = loadRendererLib()
    lib.receiveWatchdog.autoConfirmMs = 60
    const sid = 'p0-5'
    const events = []
    let allowConfirm = true
    lib.watchZmodem(sid, (p) => events.push(p))
    lib.ensureZmodem(sid, {
      write: () => {},
      send: () => {},
      confirm: async () => {
        while (!allowConfirm) await tick()
        return true
      }
    })
    const feed = (buf) => lib.feedZmodem(sid, buf.toString('base64'), buf.toString('latin1'))

    // 先完整跑一次 receive 并结束（session_end 应清空 state.direction）
    feed(hex('ZRQINIT', [0, 0, 0, 0]))
    for (let i = 0; i < 20; i++) await tick()
    feed(hex('ZFIN', [0]))
    for (let i = 0; i < 20; i++) await tick()
    feed(Buffer.from('OO'))
    for (let i = 0; i < 20; i++) await tick()

    // 再触发一次 send 方向（ZRINIT）并在用户确认前让 Detection 被普通输出 retract，进入 autoConfirm 超时
    allowConfirm = false
    feed(Buffer.from(Zmodem.Header.build('ZRINIT', ['CANFDX', 'CANOVIO', 'CANFC32']).to_hex()))
    for (let i = 0; i < 10; i++) await tick()
    feed(Buffer.from('stale-bytes'))
    for (let i = 0; i < 10; i++) await tick()
    allowConfirm = true
    await wait(160)

    const errEv = events.filter((e) => e.phase === 'error').pop()
    check('P0-5 receive 结束后 send 方向超时：direction=send 且文案提示 rz',
      !!errEv && errEv.direction === 'send' && /rz/i.test(errEv.message || ''),
      JSON.stringify(errEv))
    lib.receiveWatchdog.autoConfirmMs = 20000
    lib.detachZmodem(sid)
  }

  /* ========== P0-6：发送进度统一为单文件口径 ========== */
  {
    const a = Buffer.alloc(100, 0x61)
    const b = Buffer.alloc(100, 0x62)
    const { lib } = loadRendererLib({
      uploadFiles: [
        { name: 'f1.bin', path: 'C:/up/f1.bin', size: 100, data: a.toString('base64') },
        { name: 'f2.bin', path: 'C:/up/f2.bin', size: 100, data: b.toString('base64') }
      ]
    })
    const sid = 'p0-6'
    const events = []
    const toRemote = []
    const toUs = []
    lib.watchZmodem(sid, (p) => events.push(p))
    lib.ensureZmodem(sid, {
      write: () => {},
      send: (bytes) => toRemote.push(Buffer.from(bytes)),
      confirm: async () => true
    })
    const remote = new Zmodem.Session.Receive()
    remote.set_sender((oct) => toUs.push(Buffer.from(oct)))
    remote.on('offer', (offer) => { offer.accept({ on_input: () => {} }) })
    remote.start()
    for (let r = 0; r < 120; r++) {
      while (toUs.length) {
        const buf = toUs.shift()
        lib.feedZmodem(sid, buf.toString('base64'), buf.toString('latin1'))
      }
      while (toRemote.length) {
        const buf = toRemote.shift()
        try { remote.consume(Array.from(buf)) } catch { /* ignore */ }
      }
      await wait(5)
      if (events.filter((e) => e.phase === 'done').length >= 2 && !lib.isZmodemActive(sid)) break
    }

    const f1Active = events.filter((e) => e.phase === 'active' && e.fileName === 'f1.bin')
    const f2Active = events.filter((e) => e.phase === 'active' && e.fileName === 'f2.bin')
    const f1Last = f1Active[f1Active.length - 1]
    const f2Last = f2Active[f2Active.length - 1]
    check('P0-6 两文件各 100B：第 1 个文件满进度时 bytesDone===bytesTotal===100 且 fileIndex=1/2',
      !!f1Last && f1Last.bytesDone === 100 && f1Last.bytesTotal === 100 && f1Last.fileIndex === 1 && f1Last.fileCount === 2,
      JSON.stringify(f1Last))
    check('P0-6 两文件各 100B：第 2 个文件满进度时 bytesDone===bytesTotal===100 且 fileIndex=2/2',
      !!f2Last && f2Last.bytesDone === 100 && f2Last.bytesTotal === 100 && f2Last.fileIndex === 2 && f2Last.fileCount === 2,
      JSON.stringify(f2Last))
    lib.detachZmodem(sid)
  }

  /* ========== P1-7 / P1-8 / P1-9 / P1-10：主进程 ipc/zmodem.ts 四项加固 ========== */
  {
    const { mod, handlers } = loadMainIpc()
    const tmpDir = fs.mkdtempSync(path.join(OUT_DIR, 'dl-'))
    globalThis.__zmMockDialog = async () => ({ canceled: false, filePaths: [tmpDir] })

    // P1-8: safeFileName Windows 合规
    check('P1-8 safeFileName 导出可用', typeof mod.safeFileName === 'function')
    if (typeof mod.safeFileName === 'function') {
      const aux = mod.safeFileName('aux.txt')
      const dots = mod.safeFileName('a. . .')
      const longName = mod.safeFileName('x'.repeat(500) + '.log')
      check('P1-8 保留设备名 aux.txt 被加前缀避开', aux !== 'aux.txt' && /^_aux\.txt$/i.test(aux), aux)
      check('P1-8 尾部点与空格被剥离干净', !/[. ]$/.test(dots) && dots === 'a', JSON.stringify(dots))
      check('P1-8 超长文件名截断 <= 200 且保留扩展名',
        longName.length <= 200 && longName.endsWith('.log'), `len=${longName.length} tail=${longName.slice(-10)}`)
    }

    // P1-7: 同名并发 ZM_SAVE_BEGIN + TOCTOU 竞争（在 existsSync 与 writeFileSync 之间抢先建同名文件）
    const pickDir = await handlers.get('zm:pick-dir')()
    const tok = pickDir.data.token
    const [b1, b2] = await Promise.all([
      handlers.get('zm:save-begin')(tok, 'same.bin'),
      handlers.get('zm:save-begin')(tok, 'same.bin')
    ])
    check('P1-7 并发两次同名 saveBegin 返回不同路径',
      b1.ok && b2.ok && b1.data.path !== b2.data.path,
      `${b1.data?.path} vs ${b2.data?.path}`)
    await handlers.get('zm:save-append')(b1.data.saveId, Buffer.from('FIRST-12345').toString('base64'))
    await handlers.get('zm:save-append')(b2.data.saveId, Buffer.from('SECOND').toString('base64'))
    const f1 = await handlers.get('zm:save-finish')(b1.data.saveId)
    const f2 = await handlers.get('zm:save-finish')(b2.data.saveId)
    check('P1-7 两份同名并发文件字节各自完整互不破坏',
      f1.ok && f2.ok &&
        fs.readFileSync(b1.data.path, 'utf8') === 'FIRST-12345' &&
        fs.readFileSync(b2.data.path, 'utf8') === 'SECOND',
      `f1=${f1.data?.size} f2=${f2.data?.size}`)

    // 真实 TOCTOU 竞态：在 existsSync 返回 false 后、writeFileSync 前由另一写者抢建 race.bin；
    // 无 flag:'wx' + 重试会静默覆盖截断原文件内容，修复后必须触发 EEXIST 重试并落到 race (1).bin
    const racePath = path.join(tmpDir, 'race.bin')
    const origExists = fs.existsSync
    let injected = false
    fs.existsSync = function (p) {
      const exists = origExists.call(fs, p)
      if (!injected && String(p) === racePath && !exists) {
        injected = true
        fs.writeFileSync(racePath, 'PREEXISTING-DATA')
        return false
      }
      return exists
    }
    let bRace
    try {
      bRace = await handlers.get('zm:save-begin')(tok, 'race.bin')
    } finally {
      fs.existsSync = origExists
    }
    if (bRace?.ok) await handlers.get('zm:save-finish')(bRace.data.saveId)
    check('P1-7 TOCTOU 竞争下使用 wx 排他创建并重试新序号，绝不截断已存在文件',
      bRace?.ok && bRace.data.path !== racePath && fs.readFileSync(racePath, 'utf8') === 'PREEXISTING-DATA',
      `path=${bRace?.data?.path} content=${JSON.stringify(fs.readFileSync(racePath, 'utf8'))}`)

    // P1-9: 异步落盘（串行 100 次 append 字节正确且事件循环不被阻塞）
    const bAsync = await handlers.get('zm:save-begin')(tok, 'async.bin')
    let immediates = 0
    let running = true
    const pumpImm = () => {
      if (!running) return
      immediates++
      setImmediate(pumpImm)
    }
    setImmediate(pumpImm)
    const payload100 = Buffer.alloc(1024, 0x5a).toString('base64')
    for (let i = 0; i < 100; i++) {
      const r = await handlers.get('zm:save-append')(bAsync.data.saveId, payload100)
      if (!r.ok) throw new Error('append failed: ' + r.error)
    }
    running = false
    const fAsync = await handlers.get('zm:save-finish')(bAsync.data.saveId)
    const ipcSrc = fs.readFileSync(path.join(ROOT, 'src/main/ipc/zmodem.ts'), 'utf8')
    check('P1-9 串行 100 次异步 append 字节准确且事件循环期间正常调度',
      fAsync.ok && fAsync.data.size === 100 * 1024 && immediates >= 50 && !/appendFileSync/.test(ipcSrc),
      `size=${fAsync.data?.size} immediates=${immediates} hasSync=${/appendFileSync/.test(ipcSrc)}`)

    // P1-10: ZM_PICK_FILES 超 256MB 拒收且不调用 readFileSync（用稀疏文件造 >256MB st_size）
    const hugePath = path.join(tmpDir, 'huge.bin')
    const fd = fs.openSync(hugePath, 'w')
    fs.ftruncateSync(fd, 256 * 1024 * 1024 + 1024)
    fs.closeSync(fd)
    globalThis.__zmMockDialog = async () => ({ canceled: false, filePaths: [hugePath] })
    const origReadFileSync = fs.readFileSync
    let readHugeCalls = 0
    fs.readFileSync = function (p, ...rest) {
      if (String(p) === hugePath) {
        readHugeCalls++
        return Buffer.alloc(16)
      }
      return origReadFileSync.call(fs, p, ...rest)
    }
    let pickHuge
    try {
      pickHuge = await handlers.get('zm:pick-files')()
    } finally {
      fs.readFileSync = origReadFileSync
    }
    check('P1-10 单文件超过 256MB 返回错误且未调用 readFileSync',
      pickHuge.ok === false && /256MB/.test(pickHuge.error || '') && readHugeCalls === 0,
      `res=${JSON.stringify(pickHuge)} readHugeCalls=${readHugeCalls}`)
    fs.rmSync(hugePath, { force: true })
  }

  /* ========== P2-11：writeBytes 返回失败时渲染层 100ms 内报错，不等 20s 超时 ========== */
  {
    const { lib } = loadRendererLib()
    const sid = 'p2-11'
    const events = []
    lib.watchZmodem(sid, (p) => events.push(p))
    lib.ensureZmodem(sid, {
      write: () => {},
      send: async () => ({ ok: false, reason: '会话未连接' }),
      confirm: async () => true
    })
    const feed = (buf) => lib.feedZmodem(sid, buf.toString('base64'), buf.toString('latin1'))

    const t0 = Date.now()
    feed(hex('ZRQINIT', [0, 0, 0, 0]))
    for (let i = 0; i < 40 && !events.some((e) => e.phase === 'error'); i++) await wait(5)
    const elapsed = Date.now() - t0
    const errEv = events.filter((e) => e.phase === 'error').pop()
    check('P2-11 底层 sendBytes 返回 {ok:false, reason:"会话未连接"} 时 150ms 内立刻报错',
      !!errEv && (errEv.message || '').includes('会话未连接') && elapsed < 150,
      `elapsed=${elapsed} err=${JSON.stringify(errEv)}`)
    lib.detachZmodem(sid)

    // 同时核对 SessionManager.writeBytes 的源码返回契约（disconnected & trzsz）
    const smSrc = fs.readFileSync(path.join(ROOT, 'src/main/ssh/sessionManager.ts'), 'utf8')
    const wbSlice = smSrc.slice(smSrc.indexOf('writeBytes(sessionId: string'), smSrc.indexOf('private requireSerialTransport'))
    check('P2-11 SessionManager.writeBytes 返回 {ok:false, reason} 区分未连接与 trzsz 进行中',
      /会话未连接/.test(wbSlice) && /trzsz 传输进行中/.test(wbSlice) && /return \{ ok: true \}/.test(wbSlice),
      wbSlice.slice(0, 260))
  }

  /* ========== P2-12：confirm 带上 sessionId，后台标签 B 触发时弹窗显示 B 而非当前标签 A ========== */
  {
    const { lib } = loadRendererLib()
    let gotSessionId = null
    let gotDir = null
    lib.setZmodemConfirmHandler(async (sid, dir) => {
      gotSessionId = sid
      gotDir = dir
      return false
    })
    const res = await lib.requestZmodemConfirm('sess-B', 'receive')
    check('P2-12 requestZmodemConfirm(sessionId, direction) 把 sessionId 透传给 ConfirmHandler',
      res === false && gotSessionId === 'sess-B' && gotDir === 'receive',
      `sid=${gotSessionId} dir=${gotDir}`)
    lib.setZmodemConfirmHandler(null)

    const overlaySrc = fs.readFileSync(
      path.join(ROOT, 'src/renderer/src/components/terminal/ZmodemOverlay.tsx'),
      'utf8'
    )
    const tvSrc = fs.readFileSync(
      path.join(ROOT, 'src/renderer/src/components/terminal/TerminalView.tsx'),
      'utf8'
    )
    check('P2-12 TerminalView 调用 requestZmodemConfirm(sessionId, direction)',
      /requestZmodemConfirm\(sessionId,\s*direction\)/.test(tvSrc))
    check('P2-12 ZmodemOverlay 按传入 sessionId 查 sessions 填充 sessionName 并优先展示',
      /setZmodemConfirmHandler\(\s*\(sessionId,\s*direction\)/.test(overlaySrc) &&
        /pending\.sessionName/.test(overlaySrc))
  }

  /* ========== P2-13：attachZmodem 二次调用刷新 hooks 且 Sentry 闭包生效 ========== */
  {
    const { lib } = loadRendererLib()
    const sid = 'p2-13'
    const out1 = []
    const out2 = []
    lib.attachZmodem(sid, { write: (t) => out1.push(t), send: () => {}, confirm: async () => false })
    lib.attachZmodem(sid, { write: (t) => out2.push(t), send: () => {}, confirm: async () => false })
    const msg = Buffer.from('hello-new-hook')
    lib.feedZmodem(sid, msg.toString('base64'), msg.toString('latin1'))
    check('P2-13 二次 attachZmodem 刷新 hooks，后续输出路由到新闭包',
      out1.length === 0 && out2.join('') === 'hello-new-hook',
      `out1=${JSON.stringify(out1)} out2=${JSON.stringify(out2)}`)
    lib.detachZmodem(sid)
  }

  /* ========== P3-15：isPeerRetransmit 正则不含冗余重复分支 ========== */
  {
    const zmSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/src/lib/zmodem.ts'), 'utf8')
    check('P3-15 isPeerRetransmit 去除冗余 |Unhandled header:\\s*ZRQINIT 分支',
      !/ZR\?Q\?INIT\|Unhandled header:\\s*ZRQINIT/.test(zmSrc) &&
        /Unhandled header:\\s\*ZR\?Q\?INIT\/i/.test(zmSrc))
  }

  /* ================================================================== *
   *  第二轮审计（docs/fix-prompt.md）：缺陷 A ~ J 剩余项
   * ================================================================== */

  /* ========== 缺陷 A：看门狗超时放弃后唤醒 handleOffer，落盘已收字节并调用 saveFinish ========== */
  {
    const { lib, st } = loadRendererLib()
    lib.receiveWatchdog.idleMs = 35
    const sid = 'fix-A'
    const events = []
    lib.watchZmodem(sid, (p) => events.push(p))
    lib.ensureZmodem(sid, { write: () => {}, send: () => {}, confirm: async () => true })
    const feed = (buf) => lib.feedZmodem(sid, buf.toString('base64'), buf.toString('latin1'))

    feed(hex('ZRQINIT', [0, 0, 0, 0]))
    for (let i = 0; i < 20; i++) await tick()
    feed(Buffer.concat([hex('ZFILE', [0]), sub16(fileInfo('stall.bin', 2000), 'end_ack')]))
    for (let i = 0; i < 20; i++) await tick()
    // 只发 600B（< 256KB 未自动 flush），然后静默直至 3 轮续传耗尽
    feed(Buffer.concat([hex('ZDATA', [0]), sub16(Buffer.alloc(600, 0x42), 'no_end_no_ack')]))
    await wait(450)

    const errs = events.filter((e) => e.phase === 'error')
    const saved = st.files.get('save-1')
    check('缺陷A 看门狗放弃后释放 handleOffer 并调用 saveFinish 刷盘 600B',
      st.saveFinishCalls === 1 && !!saved && saved.length === 600,
      `finish=${st.saveFinishCalls} saved=${saved?.length}`)
    check('缺陷A 看门狗放弃仅发一条 error 且含保留字节数',
      errs.length === 1 && /已保留前 600 字节/.test(errs[0].message || ''),
      `errs=${JSON.stringify(errs.map((e) => e.message))}`)
    lib.receiveWatchdog.idleMs = 15000
    lib.detachZmodem(sid)
  }

  /* ========== 缺陷 B：detachZmodem 期间有活跃传输时必须释放 handleOffer 并调用 saveFinish ========== */
  {
    const { lib, st } = loadRendererLib()
    const sid = 'fix-B'
    lib.ensureZmodem(sid, { write: () => {}, send: () => {}, confirm: async () => true })
    const feed = (buf) => lib.feedZmodem(sid, buf.toString('base64'), buf.toString('latin1'))

    feed(hex('ZRQINIT', [0, 0, 0, 0]))
    for (let i = 0; i < 20; i++) await tick()
    feed(Buffer.concat([hex('ZFILE', [0]), sub16(fileInfo('midclose.bin', 2000), 'end_ack')]))
    for (let i = 0; i < 20; i++) await tick()
    feed(Buffer.concat([hex('ZDATA', [0]), sub16(Buffer.alloc(200, 0x43), 'no_end_no_ack')]))
    for (let i = 0; i < 10; i++) await tick()

    lib.detachZmodem(sid)
    await wait(30)
    check('缺陷B detachZmodem 中止活跃接收并触发 saveFinish 清理句柄',
      st.saveFinishCalls === 1,
      `saveFinishCalls=${st.saveFinishCalls}`)
  }

  /* ========== 缺陷 C：canceled 分支调用 saveFinish({canceled:true})，主进程删 0B 临时文件并释放句柄 ========== */
  {
    const { lib, st } = loadRendererLib()
    const sid = 'fix-C'
    lib.ensureZmodem(sid, { write: () => {}, send: () => {}, confirm: async () => true })
    const feed = (buf) => lib.feedZmodem(sid, buf.toString('base64'), buf.toString('latin1'))

    feed(hex('ZRQINIT', [0, 0, 0, 0]))
    for (let i = 0; i < 20; i++) await tick()
    feed(Buffer.concat([hex('ZFILE', [0]), sub16(fileInfo('cancel.bin', 1000), 'end_ack')]))
    for (let i = 0; i < 20; i++) await tick()
    lib.abortZmodem(sid)
    await wait(30)
    check('缺陷C 渲染层 canceled 分支调用 saveFinish(saveId, {canceled:true})',
      st.saveFinishCalls === 1 && st.lastFinishOpts?.canceled === true,
      `finish=${st.saveFinishCalls} opts=${JSON.stringify(st.lastFinishOpts)}`)
    lib.detachZmodem(sid)

    // 主进程侧：canceled:true 且 0 字节时删除临时空文件、移除 zmReceives 并释放 claimedPaths
    const { handlers } = loadMainIpc()
    const tmpDir = fs.mkdtempSync(path.join(OUT_DIR, 'cancel-'))
    globalThis.__zmMockDialog = async () => ({ canceled: false, filePaths: [tmpDir] })
    const pick = await handlers.get('zm:pick-dir')()
    const b0 = await handlers.get('zm:save-begin')(pick.data.token, 'cancel0.bin')
    const p0 = b0.data.path
    const fin0 = await handlers.get('zm:save-finish')(b0.data.saveId, { canceled: true })
    const afterAppend = await handlers.get('zm:save-append')(b0.data.saveId, Buffer.from('x').toString('base64'))
    const bRe = await handlers.get('zm:save-begin')(pick.data.token, 'cancel0.bin')
    if (bRe.ok) await handlers.get('zm:save-finish')(bRe.data.saveId, { canceled: true })
    check('缺陷C 主进程 canceled=true 删除 0B 空文件并释放 zmReceives/claimedPaths',
      fin0.ok && !fs.existsSync(p0) && afterAppend.ok === false && bRe.ok && bRe.data.path === p0,
      `exists=${fs.existsSync(p0)} afterAppend=${afterAppend.ok} rePath=${bRe.data?.path}`)
  }

  /* ========== 缺陷 D：未知大小（total===0）保持 bytesTotal===0 且不绕过 60ms 节流 ========== */
  {
    const { lib } = loadRendererLib()
    const sid = 'fix-D'
    const events = []
    lib.watchZmodem(sid, (p) => events.push(p))
    lib.ensureZmodem(sid, { write: () => {}, send: () => {}, confirm: async () => true })
    const feed = (buf) => lib.feedZmodem(sid, buf.toString('base64'), buf.toString('latin1'))

    feed(hex('ZRQINIT', [0, 0, 0, 0]))
    for (let i = 0; i < 20; i++) await tick()
    feed(Buffer.concat([hex('ZFILE', [0]), sub16(fileInfo('stream.log', 0), 'end_ack')]))
    for (let i = 0; i < 20; i++) await tick()
    await wait(70)
    events.length = 0

    // 同一毫秒内连发 10 个 100B 子包（首包立刻送出，后 9 包被 60ms 节流合并）
    feed(hex('ZDATA', [0]))
    for (let i = 0; i < 10; i++) {
      feed(sub16(Buffer.alloc(100, 0x44), 'no_end_no_ack'))
    }
    const burst = events.filter((e) => e.phase === 'active' && e.bytesDone > 0)
    check('缺陷D 未知大小文件 active 事件保持 bytesTotal===0（不再恒显 100%）',
      burst.length >= 1 && burst.every((e) => e.bytesTotal === 0),
      JSON.stringify(burst.map((e) => ({ d: e.bytesDone, t: e.bytesTotal }))))
    check('缺陷D 未知大小文件不绕过 60ms 节流（10 连包同步仅推送 < 10 次）',
      burst.length < 5,
      `burstCount=${burst.length}`)
    lib.detachZmodem(sid)
  }

  /* ========== 缺陷 E：节流器尾部刷新（trailing flush）+ 终态不倒流 ========== */
  {
    const { lib } = loadRendererLib()
    const sid = 'fix-E'
    const events = []
    lib.watchZmodem(sid, (p) => events.push(p))
    lib.ensureZmodem(sid, { write: () => {}, send: () => {}, confirm: async () => true })
    const feed = (buf) => lib.feedZmodem(sid, buf.toString('base64'), buf.toString('latin1'))

    feed(hex('ZRQINIT', [0, 0, 0, 0]))
    for (let i = 0; i < 20; i++) await tick()
    feed(Buffer.concat([hex('ZFILE', [0]), sub16(fileInfo('trail.bin', 2000), 'end_ack')]))
    for (let i = 0; i < 20; i++) await tick()

    // 先等过 60ms 确保下一包立刻发出，再紧跟着发第 2 包落入节流窗内
    await wait(70)
    events.length = 0
    feed(Buffer.concat([hex('ZDATA', [0]), sub16(Buffer.alloc(200, 0x45), 'no_end_no_ack')]))
    feed(sub16(Buffer.alloc(300, 0x45), 'no_end_no_ack'))
    const immediateLast = events[events.length - 1]?.bytesDone
    // 等节流窗口到期，确认尾部刷新送达 500B
    await wait(90)
    const trailedLast = events[events.length - 1]?.bytesDone
    check('缺陷E 节流窗口内的最后一帧在窗口到期后经 trailing flush 补发（200 -> 500）',
      immediateLast === 200 && trailedLast === 500,
      `immediate=${immediateLast} trailed=${trailedLast}`)

    // 再发一次落入节流窗后立刻 ZEOF -> done，确认 done 之后不会冒出迟到的 active
    feed(sub16(Buffer.alloc(1000, 0x45), 'no_end_no_ack'))
    feed(sub16(Buffer.alloc(500, 0x45), 'end_no_ack'))
    feed(hex('ZEOF', [2000]))
    await wait(120)
    const doneIdx = events.findIndex((e) => e.phase === 'done')
    const afterDone = doneIdx >= 0 ? events.slice(doneIdx + 1) : []
    check('缺陷E 终态 done 清除尾部定时器，之后不出现过期 active 事件',
      doneIdx >= 0 && afterDone.length === 0,
      `doneIdx=${doneIdx} afterDone=${JSON.stringify(afterDone.map((e) => e.phase))}`)
    lib.detachZmodem(sid)
  }

  /* ========== 缺陷 F：resyncReceive 限流分支校验 _swb_rearm_in_file 返回值并计入上限 ========== */
  {
    // F-1：文件间（_accepted_offer===false）且在 150ms 限流窗内撞坏帧，rearm 失败必须返回 false 并报错
    const { lib } = loadRendererLib()
    const sid = 'fix-F1'
    const events = []
    lib.watchZmodem(sid, (p) => events.push(p))
    lib.ensureZmodem(sid, { write: () => {}, send: () => {}, confirm: async () => true })
    const feed = (buf) => lib.feedZmodem(sid, buf.toString('base64'), buf.toString('latin1'))

    feed(hex('ZRQINIT', [0, 0, 0, 0]))
    for (let i = 0; i < 20; i++) await tick()
    feed(Buffer.concat([hex('ZFILE', [0]), sub16(fileInfo('f1.bin', 600), 'end_ack')]))
    for (let i = 0; i < 20; i++) await tick()
    feed(Buffer.concat([hex('ZDATA', [0]), sub16(Buffer.alloc(300, 0x46), 'no_end_no_ack')]))
    // 触发一次 resync 记下 lastResyncAt
    feed(Buffer.concat([hex('ZDATA', [0]), sub16(Buffer.alloc(300, 0x46), 'no_end_no_ack')]))
    // 立刻续完并 ZEOF（此时 _accepted_offer=false，但仍在 150ms 限流窗内）
    feed(Buffer.concat([hex('ZDATA', [300]), sub16(Buffer.alloc(300, 0x46), 'end_no_ack')]))
    feed(hex('ZEOF', [600]))
    for (let i = 0; i < 10; i++) await tick()
    // 文件间隙内收到非法 ZDATA：_swb_rearm_in_file 返回 false，绝不能静默吞掉
    feed(hex('ZDATA', [0]))
    for (let i = 0; i < 20; i++) await tick()
    check('缺陷F(1) _accepted_offer=false 时限流分支不得返回 true 吞错（应报错中止）',
      events.some((e) => e.phase === 'error') && !lib.isZmodemActive(sid),
      `phases=${events.map((e) => e.phase).join(',')} active=${lib.isZmodemActive(sid)}`)
    lib.detachZmodem(sid)

    // F-2：150ms 限流窗内连续 70 个坏帧必须计入 resyncAttempts 并在 64 次上限触发报错
    const { lib: lib2 } = loadRendererLib()
    const sid2 = 'fix-F2'
    const ev2 = []
    lib2.watchZmodem(sid2, (p) => ev2.push(p))
    lib2.ensureZmodem(sid2, { write: () => {}, send: () => {}, confirm: async () => true })
    const feed2 = (buf) => lib2.feedZmodem(sid2, buf.toString('base64'), buf.toString('latin1'))
    feed2(hex('ZRQINIT', [0, 0, 0, 0]))
    for (let i = 0; i < 20; i++) await tick()
    feed2(Buffer.concat([hex('ZFILE', [0]), sub16(fileInfo('f2.bin', 2000), 'end_ack')]))
    for (let i = 0; i < 20; i++) await tick()
    feed2(Buffer.concat([hex('ZDATA', [0]), sub16(Buffer.alloc(200, 0x46), 'no_end_no_ack')]))
    for (let i = 0; i < 70; i++) {
      if (!lib2.isZmodemActive(sid2)) break
      // 先喂一个小重传包清 resyncFrom，再喂错误偏移触发限流分支
      feed2(Buffer.concat([hex('ZDATA', [0]), sub16(Buffer.alloc(100, 0x46), 'no_end_no_ack')]))
      feed2(hex('ZDATA', [1900]))
    }
    await wait(30)
    check('缺陷F(2) 150ms 限流分支计入 resyncAttempts 上限，不会无限吞错',
      ev2.some((e) => e.phase === 'error') && !lib2.isZmodemActive(sid2),
      `errs=${ev2.filter((e) => e.phase === 'error').length} active=${lib2.isZmodemActive(sid2)}`)
    lib2.detachZmodem(sid2)
  }

  /* ========== 缺陷 G：传输进行中调用 chooseZmodemSaveDir 并取消不得标为 error ========== */
  {
    const { lib, st } = loadRendererLib()
    const sid = 'fix-G'
    const events = []
    lib.watchZmodem(sid, (p) => events.push(p))
    lib.ensureZmodem(sid, { write: () => {}, send: () => {}, confirm: async () => true })
    const feed = (buf) => lib.feedZmodem(sid, buf.toString('base64'), buf.toString('latin1'))

    feed(hex('ZRQINIT', [0, 0, 0, 0]))
    for (let i = 0; i < 20; i++) await tick()
    feed(Buffer.concat([hex('ZFILE', [0]), sub16(fileInfo('active.bin', 2000), 'end_ack')]))
    for (let i = 0; i < 20; i++) await tick()
    feed(Buffer.concat([hex('ZDATA', [0]), sub16(Buffer.alloc(200, 0x47), 'no_end_no_ack')]))

    st.pickDirCanceled = true
    const ok = await lib.chooseZmodemSaveDir(sid)
    check('缺陷G 传输进行中取消选择文件夹不触发 error 且不破坏活跃会话',
      ok === false && !events.some((e) => e.phase === 'error') && lib.isZmodemActive(sid) === true,
      `ok=${ok} errs=${JSON.stringify(events.filter((e) => e.phase === 'error'))} active=${lib.isZmodemActive(sid)}`)
    const overlaySrc = fs.readFileSync(
      path.join(ROOT, 'src/renderer/src/components/terminal/ZmodemOverlay.tsx'),
      'utf8'
    )
    const btnBlockStart = overlaySrc.indexOf('border-t border-edge-soft pt-2')
    const btnBlock = btnBlockStart >= 0 ? overlaySrc.slice(btnBlockStart, btnBlockStart + 500) : ''
    check('缺陷G ZmodemOverlay 仅在 detected 阶段显示「选择文件夹」按钮',
      /progress\.phase === 'detected' && receiving/.test(btnBlock) && !/\{receiving && \(/.test(btnBlock),
      btnBlock.slice(0, 180))
    lib.detachZmodem(sid)
  }

  /* ========== 缺陷 H：前向空洞立即发 ZRPOS 补包且 on_input 防护分支不静默吞包 ========== */
  {
    const { lib } = loadRendererLib()
    const sid = 'fix-H'
    const sent = []
    lib.ensureZmodem(sid, {
      write: () => {},
      send: (b) => sent.push(Buffer.from(b)),
      confirm: async () => true
    })
    const feed = (buf) => lib.feedZmodem(sid, buf.toString('base64'), buf.toString('latin1'))

    feed(hex('ZRQINIT', [0, 0, 0, 0]))
    for (let i = 0; i < 20; i++) await tick()
    feed(Buffer.concat([hex('ZFILE', [0]), sub16(fileInfo('gap.bin', 2000), 'end_ack')]))
    for (let i = 0; i < 20; i++) await tick()
    feed(Buffer.concat([hex('ZDATA', [0]), sub16(Buffer.alloc(400, 0x48), 'end_no_ack')]))
    for (let i = 0; i < 10; i++) await tick()
    const beforeZrpos = sent.filter((b) => {
      try { return Zmodem.Header.parse_hex(Array.from(b)).NAME === 'ZRPOS' } catch { return false }
    }).length
    // 远端跳过中间 800B，直接发 ZDATA(1200)
    feed(Buffer.concat([hex('ZDATA', [1200]), sub16(Buffer.alloc(200, 0x48), 'no_end_no_ack')]))
    for (let i = 0; i < 10; i++) await tick()
    const zrposList = sent
      .map((b) => { try { return Zmodem.Header.parse_hex(Array.from(b)) } catch { return null } })
      .filter((h) => h && h.NAME === 'ZRPOS')
    const lastOffset = zrposList[zrposList.length - 1]?.get_offset()
    check('缺陷H 远端前向跳洞 ZDATA(1200) 立即触发 ZRPOS(400) 补包',
      zrposList.length > beforeZrpos && lastOffset === 400,
      `before=${beforeZrpos} after=${zrposList.length} lastOffset=${lastOffset}`)

    // 同时核对 on_input 中 start > cursor 守卫带限流地调用 resumeFromOffset（而非纯 return）
    const zmSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/src/lib/zmodem.ts'), 'utf8')
    const gapIdx = zmSrc.indexOf('if (start > cursor)')
    const gapSlice = gapIdx >= 0 ? zmSrc.slice(gapIdx, gapIdx + 500) : ''
    check('缺陷H on_input 的 start > cursor 分支带限流调用 resumeFromOffset（不再静默丢弃）',
      /resumeFromOffset\(/.test(gapSlice) && /gapResyncOffset/.test(gapSlice),
      gapSlice.slice(0, 180))
    lib.detachZmodem(sid)
  }

  /* ========== 缺陷 I-4(\x7f) & I-6(dialogParent 为 null 时不传 null 参数) ========== */
  {
    const { mod, handlers } = loadMainIpc()
    const delCleaned = mod.safeFileName('test\x7fname.txt')
    check('缺陷I-4 safeFileName 清洗 0x7F 控制字符',
      !delCleaned.includes('\x7f') && delCleaned === 'test_name.txt',
      JSON.stringify(delCleaned))

    const seenArgs = []
    globalThis.__zmMockDialog = async (...args) => {
      seenArgs.push(args)
      return { canceled: true, filePaths: [] }
    }
    await handlers.get('zm:pick-files')()
    await handlers.get('zm:pick-dir')()
    check('缺陷I-6 dialogParent() 返回 null 时 showOpenDialog 只传 options（不传 null）',
      seenArgs.length === 2 &&
        seenArgs[0].length === 1 &&
        seenArgs[1].length === 1 &&
        seenArgs[0][0] !== null &&
        seenArgs[1][0] !== null,
      JSON.stringify(seenArgs.map((a) => a.length)))
  }

  /* ========== 缺陷 J：TransferTab 每行仅订阅一次 watchZmodem（不在 LiveAmount/LiveProgressBar 重复订阅） ========== */
  {
    const tabSrc = fs.readFileSync(
      path.join(ROOT, 'src/renderer/src/components/files/TransferTab.tsx'),
      'utf8'
    )
    const liveAmountIdx = tabSrc.indexOf('function LiveAmount(')
    const liveBarIdx = tabSrc.indexOf('function LiveProgressBar(')
    const remoteLocIdx = tabSrc.indexOf('function RemoteLocate(')
    const liveAmountBody = liveAmountIdx >= 0 && liveBarIdx > liveAmountIdx ? tabSrc.slice(liveAmountIdx, liveBarIdx) : ''
    const liveBarBody = liveBarIdx >= 0 && remoteLocIdx > liveBarIdx ? tabSrc.slice(liveBarIdx, remoteLocIdx) : ''
    const tabRowBody = tabSrc.slice(tabSrc.indexOf('function TabRow('), tabSrc.indexOf('function StatusDot('))
    check('缺陷J TransferTab 将 useZmodemLive 提升到 TabRow，LiveAmount 与 LiveProgressBar 不再重复订阅',
      /useZmodemLive\(/.test(tabRowBody) &&
        !/useZmodemLive\(/.test(liveAmountBody) &&
        !/useZmodemLive\(/.test(liveBarBody),
      `row=${/useZmodemLive\(/.test(tabRowBody)} amt=${/useZmodemLive\(/.test(liveAmountBody)} bar=${/useZmodemLive\(/.test(liveBarBody)}`)
  }

  /* ========== 实测回归：点中断发 10×CAN+10×BS 防 lrzsz 锁死 + 拦 raw 模式日志正文 + 补发兜底 ========== */
  {
    const { lib } = loadRendererLib()
    const sid = 'fix-abort-lrzsz'
    const term = []
    const sent = []
    lib.ensureZmodem(sid, {
      write: (t) => term.push(t),
      send: (b) => sent.push(Buffer.from(b)),
      confirm: async () => true
    })
    const feed = (buf) => lib.feedZmodem(sid, buf.toString('base64'), buf.toString('latin1'))

    feed(hex('ZRQINIT', [0, 0, 0, 0]))
    for (let i = 0; i < 20; i++) await tick()
    feed(Buffer.concat([hex('ZFILE', [0]), sub16(fileInfo('robotTestDebug.log', 4000), 'end_ack')]))
    for (let i = 0; i < 20; i++) await tick()
    feed(Buffer.concat([hex('ZDATA', [0]), sub16(Buffer.alloc(400, 0x41), 'no_end_no_ack')]))
    for (let i = 0; i < 10; i++) await tick()

    sent.length = 0
    term.length = 0
    lib.abortZmodem(sid)
    for (let i = 0; i < 10; i++) await tick()

    const hasTenCan = (buf) => {
      let maxCan = 0
      let cur = 0
      let bsAfter = 0
      for (const byte of buf) {
        if (byte === 0x18) {
          cur++
          if (cur > maxCan) maxCan = cur
        } else {
          if (maxCan >= 8 && byte === 0x08) bsAfter++
          cur = 0
        }
      }
      return maxCan >= 8 && bsAfter >= 8
    }
    const abortBufs = sent.filter(hasTenCan)
    check('实测中断(1) abortZmodem 发送 >=8 连续 CAN + >=8 BS（防 lrzsz zsendfdata 吃 1 个后卡死）',
      abortBufs.length === 1,
      `sentLens=${sent.map((b) => [...b].join(',')).join(' | ')}`)

    // 紧接着模拟 213ms RTT 下仍在途的纯文本 .log 数据（含 raw 模式裸 \n）以及超长单行分片
    const rawLog = Buffer.from(
      '(Successful)\n        [26/11/22-19:32:49 118][CRT][Px03eb][Tx8d7f9f70] WIDE ANGLE CAMERA\n        [26/11/22-19:32:49 339][CRT][Px03eb][Tx'
    )
    const longSingleLine = Buffer.from('A'.repeat(400))
    feed(rawLog)
    feed(longSingleLine)
    // 随后远端退出回到 cooked 模式 bash 提示符（\r\n + 短行）必须正常显示
    feed(Buffer.from('\r\nroot@IFLY:/data/log/logSys# '))
    for (let i = 0; i < 10; i++) await tick()

    const out = term.join('')
    check('实测中断(2) 静默窗拦截在途 raw 模式日志正文与超长分片，同时放行 cooked 模式 bash 提示符',
      !out.includes('WIDE ANGLE') &&
        !out.includes('AAAA') &&
        out.includes('root@IFLY:/data/log/logSys# '),
      JSON.stringify(out))

    // 370ms 后若远端仍在吐 raw 模式数据（如首轮 CAN 被 purgeline 吞掉），自动补发一次 10×CAN+10×BS
    await wait(370)
    feed(Buffer.from('still-streaming\nline2'))
    for (let i = 0; i < 10; i++) await tick()
    const abortAfter = sent.filter(hasTenCan).length
    check('实测中断(3) 350ms 后远端仍在吐 raw 数据时自动补发 10×CAN+10×BS 兜底退出',
      abortAfter === 2,
      `abortAfter=${abortAfter}`)
    lib.detachZmodem(sid)
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
