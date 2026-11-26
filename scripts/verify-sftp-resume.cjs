/**
 * 断线续传回归测试：直接驱动主进程 SftpManager 的真实代码。
 *
 * 为什么必须单独写这个脚本：
 * 旧的实现把「断线」当成「单文件失败」—— handle 抛错后 catch 里 unlink 掉远端
 * 半截文件，下一次重试又从 'w'（O_TRUNC）打开。也就是说：断一次网，之前传的
 * 几十 MB 全部作废。这不是性能问题，是数据丢失。所以断言必须能回答一件事：
 * **断线前后写的字节，是不是真的接上了，而不是从头再来一遍。**
 *
 * 假 SFTP 的关键设计：多个 wrapper 实例共享同一块内存「磁盘」。
 * 断线时把当前 wrapper 标记为 dead（后续所有请求都回 ECONNRESET），
 * 而 sessionManager stub 每次都发一个新 wrapper —— 这正是真实重连的模型：
 * 通道换了、远端文件还在。
 *
 * 用法：node scripts/verify-sftp-resume.cjs
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.tsc-verify')
fs.mkdirSync(OUT_DIR, { recursive: true })
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-resume-'))

let failed = 0
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name)
  else {
    failed++
    console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''))
  }
}

/*
 * sessionManager stub：statusOf 恒为 connected —— 真实环境下 recoverChannel
 * 会先轮询等重连完成，那部分由 verify-errors-reconnect 覆盖；这里的被测对象是
 * 「续传逻辑」，不该被重连退避拖慢。
 */
const stub = path.join(OUT_DIR, 'sftp-session-stub-resume.cjs')
fs.writeFileSync(
  stub,
  [
    'let n = 0',
    'exports.sessionManager = {',
    '  waitUntilReady: async () => {},',
    '  list: () => [],',
    "  statusOf: () => 'connected',",
    '  isReconnecting: () => false,',
    '  getClient: () => globalThis.__CLIENT__ || (globalThis.__CLIENT__ = { sftp: (cb) => { n += 1; cb(null, globalThis.__NEXT_SFTP__(n)) } }),',
    '}'
  ].join('\n')
)

const electronStub = path.join(OUT_DIR, 'electron-stub-resume.cjs')
fs.writeFileSync(
  electronStub,
  'module.exports = { app: { getPath: () => require("node:os").tmpdir() } }' + String.fromCharCode(10)
)

const bundle = path.join(OUT_DIR, 'sftp-resume-bundle.cjs')
async function buildBundle() {
  await esbuild.build({
    stdin: {
      contents: "export { SftpManager } from './src/main/ssh/sftpManager'",
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['ssh2'],
    logLevel: 'error',
    alias: { '@shared': path.join(ROOT, 'src/shared') },
    plugins: [
      {
        name: 'stub-session-manager',
        setup(b) {
          b.onResolve({ filter: /sessionManager$/ }, (args) =>
            args.importer.endsWith('sftpManager.ts') ? { path: stub } : null
          )
        }
      },
      {
        name: 'stub-electron',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: electronStub }))
        }
      }
    ]
  })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/**
 * 共享磁盘 + 可断线的通道工厂。
 *
 * @param opt.dropAt        累计多少字节后断链（0=不断）
 * @param opt.dropDir       'upload' | 'download'
 * @param opt.dropTimes     断几次
 * @param opt.corruptOnDrop 断链后、重连前把远端该文件尾部改坏（模拟「别人换掉了」）
 * @param opt.failWith      断链时返回的错误（默认 ECONNRESET，走 isRetryable）
 * @param opt.deadOnOpen    第 N 次 open 就失败（测不可重试错误）
 */
function makeChannel(opt) {
  const o = Object.assign(
    { dropAt: 0, dropDir: 'upload', dropTimes: 1, corruptOnDrop: false, failWith: null, deadOnOpen: 0, delayMs: 0 },
    opt || {}
  )
  const files = new Map()
  const dirs = new Set(['/'])
  const stats = { bytesUp: 0, bytesDown: 0, drops: 0, opens: 0, mounts: 0, partialAtRecover: [], remoteAtRecover: [] }
  let current = null
  let pendingCorrupt = null

  const err = () => {
    if (o.failWith) return o.failWith
    const e = new Error('read ECONNRESET')
    e.code = 'ECONNRESET'
    return e
  }

  const statsOf = (size, isDir) => ({
    isFile: () => !isDir,
    isDirectory: () => isDir,
    isSymbolicLink: () => false,
    size,
    mode: isDir ? 0o040755 : 0o100644,
    mtime: 0,
    uid: 0,
    gid: 0
  })

  function newWrapper(tag) {
    stats.mounts += 1
    const w = { dead: false, tag }
    if (pendingCorrupt) {
      // 断链到重连之间，远端内容被改动 —— 续传前的指纹校验必须拦住
      const { p, mut } = pendingCorrupt
      const cur = files.get(p) || Buffer.alloc(0)
      if (cur.length > 0) {
        const next = Buffer.from(cur)
        mut(next)
        files.set(p, next)
      }
      pendingCorrupt = null
    }
    current = w

    const guard = (cb) => {
      if (w.dead) {
        cb(err())
        return true
      }
      return false
    }
    const handles = new Map()
    let nextHandle = 1

    w.on = () => {}
    w.end = () => {
      w.dead = true
    }
    w.mkdir = (p, cb) => {
      if (guard(cb)) return
      dirs.add(p)
      cb && cb(null)
    }
    w.stat = (p, cb) => {
      if (guard(cb)) return
      if (files.has(p)) return cb(null, statsOf(files.get(p).length, false))
      if (dirs.has(p)) return cb(null, statsOf(0, true))
      const e = new Error('no such file: ' + p)
      e.code = 'ENOENT'
      cb(e)
    }
    w.readdir = (p, cb) => {
      if (guard(cb)) return
      if (!dirs.has(p) && !dirs.has(p.replace(/\/+$/, ''))) return cb(new Error('no such dir: ' + p))
      const kids = []
      for (const d of dirs) {
        if (d !== p && path.posix.dirname(d) === p) kids.push({ filename: path.posix.basename(d), attrs: statsOf(0, true) })
      }
      for (const f of files.keys()) {
        if (path.posix.dirname(f) === p) kids.push({ filename: path.posix.basename(f), attrs: statsOf(files.get(f).length, false) })
      }
      cb(null, kids)
    }
    w.unlink = (p, cb) => {
      if (guard(cb)) return
      files.delete(p)
      cb && cb(null)
    }
    w.rename = (a, b, cb) => {
      if (guard(cb)) return
      if (files.has(a)) {
        files.set(b, files.get(a))
        files.delete(a)
      }
      cb && cb(null)
    }
    w.open = (p, mode, cb) => {
      if (guard(cb)) return
      stats.opens += 1
      if (o.deadOnOpen && stats.opens >= o.deadOnOpen) return cb(err())
      const m = String(mode)
      if (m === 'w') files.set(p, Buffer.alloc(0))
      else if (m === 'r+' || m === 'w+' || m === 'a') {
        if (!files.has(p)) files.set(p, Buffer.alloc(0))
      } else if (!files.has(p)) {
        const e = new Error('no such file: ' + p)
        e.code = 'ENOENT'
        return cb(e)
      }
      const id = nextHandle++
      handles.set(id, { path: p })
      cb(null, Buffer.from('h' + id))
    }
    w.fstat = (h, cb) => {
      if (guard(cb)) return
      const cur = handles.get(Number(h.toString().slice(1)))
      if (!cur) return cb(new Error('bad handle'))
      cb(null, statsOf((files.get(cur.path) || Buffer.alloc(0)).length, false))
    }
    w.close = (h, cb) => {
      handles.delete(Number(h.toString().slice(1)))
      cb && cb(null)
    }
    w.read = (h, buffer, offset, length, position, cb) => {
      if (guard(cb)) return
      const cur = handles.get(Number(h.toString().slice(1)))
      if (!cur) return cb(new Error('bad handle'))
      if (o.dropDir === 'download' && o.dropAt > 0 && stats.drops < o.dropTimes) {
        if (stats.bytesDown + length > o.dropAt) {
          stats.drops += 1
          stats.partialAtRecover.push(
            (() => {
              // 下载改成先写 <名字>.part、完成才改名，所以断线瞬间半截内容在 .part 里
              for (const p of [`${globalThis.__RESUME_LOCAL__}.part`, globalThis.__RESUME_LOCAL__]) {
                try {
                  return fs.statSync(p).size
                } catch {
                  // 试下一个
                }
              }
              return -1
            })()
          )
          w.dead = true
          pendingCorrupt = o.corruptOnDrop ? { p: cur.path, mut: o.corruptOnDrop === true ? (b) => b.fill(0x5a) : o.corruptOnDrop } : null
          return cb(err())
        }
        stats.bytesDown += length
      }
      const src = files.get(cur.path) || Buffer.alloc(0)
      const slice = src.subarray(position, position + length)
      slice.copy(buffer, offset)
      cb(null, slice.length, buffer, position)
    }
    w.write = (h, buffer, offset, length, position, cb) => {
      if (guard(cb)) return
      const cur = handles.get(Number(h.toString().slice(1)))
      if (!cur) return cb(new Error('bad handle'))
      if (o.dropDir === 'upload' && o.dropAt > 0 && stats.drops < o.dropTimes) {
        if (stats.bytesUp + length > o.dropAt) {
          stats.drops += 1
          stats.remoteAtRecover.push((files.get(cur.path) || Buffer.alloc(0)).length)
          w.dead = true
          pendingCorrupt = o.corruptOnDrop ? { p: cur.path, mut: o.corruptOnDrop === true ? (b) => b.fill(0x5a) : o.corruptOnDrop } : null
          return cb(err())
        }
        stats.bytesUp += length
      }
      const commit = () => {
        const prev = files.get(cur.path) || Buffer.alloc(0)
        const end = position + length
        const next =
          prev.length >= end ? Buffer.from(prev) : Buffer.concat([prev, Buffer.alloc(end - prev.length)])
        buffer.copy(next, position, offset, offset + length)
        files.set(cur.path, next)
        cb(null)
      }
      // 真正落盘前先等一等：取消用例需要一段可被掐断的中途窗口
      if (o.delayMs > 0) setTimeout(commit, o.delayMs)
      else commit()
    }
    return w
  }

  globalThis.__NEXT_SFTP__ = (n) => newWrapper('w' + n)
  return { files, dirs, stats, err }
}

/** 造一个可复现的伪随机大文件 */
function makeLocalFile(name, size, seed) {
  const dir = path.join(TMP, 'in-' + name)
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, name)
  const buf = Buffer.alloc(size)
  let x = seed
  for (let i = 0; i < size; i++) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    buf[i] = x >> 16
  }
  fs.writeFileSync(p, buf)
  return { path: p, buf, sha: sha(buf) }
}

/** 起一个任务并等它落终态 */
function runTask(mgr, starter) {
  return new Promise((resolve) => {
    const events = []
    mgr.setProgressHandler((e) => {
      events.push(e)
      if (e.status === 'done' || e.status === 'error' || e.status === 'canceled') resolve({ state: e.status, events })
    })
    starter()
    setTimeout(() => resolve({ state: 'timeout', events }), 120000)
  })
}

async function caseUploadResume() {
  console.log('\nR1/R2 上传断线：远端半截文件保留、续传后内容与本地一致')
  const file = makeLocalFile('big.bin', 4 * 1024 * 1024, 7)
  const ch = makeChannel({ dropAt: 1024 * 1024, dropDir: 'upload' })
  const mgr = new SftpManager()
  const dir = path.join(TMP, 'out-r1')
  fs.mkdirSync(dir, { recursive: true })
  globalThis.__RESUME_LOCAL__ = file.path
  const res = await runTask(mgr, () => mgr.upload('s1', [file.path], '/r/dest'))

  const remote = ch.files.get('/r/dest/big.bin')
  check('任务最终成功（断线后自愈）', res.state === 'done', res.state)
  check('确实发生过一次断链', ch.stats.drops === 1, ch.stats.drops)
  check('断线时远端已有部分内容（没被删）', (ch.stats.remoteAtRecover[0] || 0) > 0, ch.stats.remoteAtRecover)
  check('远端内容与本地完全一致', remote && sha(remote) === file.sha, remote && remote.length)
  check(
    '没有从头重传（累计写入 < 1.5×文件大小）',
    ch.stats.bytesUp < 4 * 1024 * 1024 * 1.5,
    ch.stats.bytesUp
  )
  check('发生了真正的重连（挂了 2 个通道）', ch.stats.mounts >= 2, ch.stats.mounts)
  const note = res.events.find((e) => typeof e.note === 'string' && e.note.includes('重连后续传'))
  check('进度事件带「正在重连后续传」提示', !!note, res.events.filter((e) => e.note).map((e) => e.note))
}

async function caseUploadFingerprintGuard() {
  console.log('\nR3 断线期间远端被改坏：指纹不符必须从头重传，不能缝出坏文件')
  const file = makeLocalFile('guarded.bin', 3 * 1024 * 1024, 11)
  const ch = makeChannel({
    dropAt: 700 * 1024,
    dropDir: 'upload',
    // 把已写入部分的尾部整段改成 0x5a
    corruptOnDrop: (b) => b.fill(0x5a, Math.max(0, b.length - 200 * 1024))
  })
  const mgr = new SftpManager()
  const res = await runTask(mgr, () => mgr.upload('s1', [file.path], '/r/dest'))
  const remote = ch.files.get('/r/dest/guarded.bin')
  check('任务成功', res.state === 'done', res.state)
  check('被改坏的文件没有污染结果', remote && sha(remote) === file.sha, remote && remote.length)
}

async function caseDownloadResume() {
  console.log('\nR4/R5 下载断线：本地半截文件保留、续传后内容与远端一致')
  const file = makeLocalFile('dl.bin', 4 * 1024 * 1024, 23)
  // 断点放在 2MB 处：第一批量太小的话本地还没落任何字节，测不到「半截文件保留」
  const ch = makeChannel({ dropAt: 2 * 1024 * 1024, dropDir: 'download' })
  ch.files.set('/r/src/dl.bin', file.buf)
  const mgr = new SftpManager()
  const outDir = path.join(TMP, 'dl-out')
  fs.mkdirSync(outDir, { recursive: true })
  globalThis.__RESUME_LOCAL__ = path.join(outDir, 'dl.bin')
  const res = await runTask(mgr, () => mgr.download('s1', ['/r/src/dl.bin'], outDir))

  const local = fs.existsSync(globalThis.__RESUME_LOCAL__)
    ? fs.readFileSync(globalThis.__RESUME_LOCAL__)
    : null
  check('任务最终成功', res.state === 'done', res.state)
  check('确实断过一次', ch.stats.drops === 1, ch.stats.drops)
  check('断线时本地已有部分内容（没被删）', (ch.stats.partialAtRecover[0] || 0) > 0, ch.stats.partialAtRecover)
  check('本地内容与源文件完全一致', local && sha(local) === file.sha, local && local.length)
  check('没有从头重下（累计读取 < 1.5×文件大小）', ch.stats.bytesDown < 4 * 1024 * 1024 * 1.5, ch.stats.bytesDown)
}

async function caseNonRetryable() {
  console.log('\nR6 不可重试的错误（权限）不重试，直接失败并清理半截文件')
  const file = makeLocalFile('denied.bin', 512 * 1024, 31)
  const eacces = new Error('Permission denied')
  eacces.code = 'EACCES'
  const ch = makeChannel({ deadOnOpen: 1, failWith: eacces })
  const mgr = new SftpManager()
  const res = await runTask(mgr, () => mgr.upload('s1', [file.path], '/r/dest'))
  check('任务落 error', res.state === 'error', res.state)
  check('只尝试了一次（没有重试）', ch.stats.opens === 1, ch.stats.opens)
  check('远端没有留下半截文件', !ch.files.has('/r/dest/denied.bin'), [...ch.files.keys()])
  const err = res.events.find((e) => e.status === 'error')
  check('错误信息透出原因', !!err && /Permission denied/.test(err.error || ''), err && err.error)
}

async function caseRetryBudget() {
  console.log('\nR7 断链次数超过预算：放弃并清理，不会无限重试')
  const file = makeLocalFile('flaky.bin', 2 * 1024 * 1024, 41)
  const ch = makeChannel({ dropAt: 128 * 1024, dropDir: 'upload', dropTimes: 99 })
  const mgr = new SftpManager()
  const res = await runTask(mgr, () => mgr.upload('s1', [file.path], '/r/dest'))
  check('任务落 error', res.state === 'error', res.state)
  check('确实重试过（挂载了多个通道）', ch.stats.mounts > 2, ch.stats.mounts)
  check('最终清理了半截文件', !ch.files.has('/r/dest/flaky.bin'), [...ch.files.keys()])
}

async function caseCancelCleans() {
  console.log('\nR8 用户取消：半截文件被清理')
  const SIZE = 8 * 1024 * 1024
  const file = makeLocalFile('cancel.bin', SIZE, 53)
  /*
   * 每批 6 块并发写、每块延迟 25ms → 一批约 1.5MB/25ms。
   * 取消必须落在传输中途才对得上现场；太早（任务还没开始）或太晚（已经写完）
   * 都只会得到一条「看起来通过」的假绿 —— 写完的文件当然在，那是正常结果不是残留。
   */
  const ch = makeChannel({ dropAt: 0, delayMs: 25 })
  const mgr = new SftpManager()
  let taskId = null
  const p = runTask(mgr, () => {
    taskId = mgr.upload('s1', [file.path], '/r/dest')[0]
  })
  await sleep(60)
  if (taskId) mgr.cancelTransfer(taskId)
  const res = await p
  check('任务落 canceled', res.state === 'canceled', res.state)
  await sleep(400)
  // 判定「确实中途掐断」：累计写入必须显著小于文件大小，否则这条用例什么都没测到
  check('取消时确实只写了一部分', ch.stats.bytesUp < SIZE * 0.9, ch.stats.bytesUp + ' / ' + SIZE)
  check('远端没有残留', !ch.files.has('/r/dest/cancel.bin'), [...ch.files.keys()])
}

async function caseDirResume() {
  console.log('\nR9 目录上传中断线：可重试错误向上抛（不当成单文件失败），任务仍能完成')
  const base = path.join(TMP, 'dir-case')
  for (const n of ['a.bin', 'b.bin', 'c.bin']) {
    fs.mkdirSync(base, { recursive: true })
    fs.writeFileSync(path.join(base, n), Buffer.alloc(900 * 1024, n.charCodeAt(0)))
  }
  const ch = makeChannel({ dropAt: 1024 * 1024, dropDir: 'upload' })
  const mgr = new SftpManager()
  const res = await runTask(mgr, () => mgr.upload('s1', [base], '/r/tree', { keepRoot: true }))
  check('目录任务最终成功', res.state === 'done', res.state)
  check('三个文件都在远端', ['a', 'b', 'c'].every((n) => ch.files.has('/r/tree/dir-case/' + n + '.bin')), [...ch.files.keys()])
  check(
    '内容正确',
    ['a', 'b', 'c'].every((n) => ch.files.get('/r/tree/dir-case/' + n + '.bin').length === 900 * 1024),
    [...ch.files.entries()].map(([k, v]) => k + ':' + v.length)
  )
}

async function main() {
  await buildBundle()
  ;({ SftpManager } = require(bundle))
  await caseUploadResume()
  await caseUploadFingerprintGuard()
  await caseDownloadResume()
  await caseNonRetryable()
  await caseCancelCleans()
  await caseDirResume()
  await caseRetryBudget()
  console.log('\n' + (failed === 0 ? '全部通过' : failed + ' 条失败'))
  process.exit(failed === 0 ? 0 : 1)
}

let SftpManager
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
