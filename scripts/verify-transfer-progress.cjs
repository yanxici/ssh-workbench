/**
 * 传输引擎回归测试：直接驱动主进程 SftpManager 的真实传输代码。
 *
 * 假 SFTP 通道实现了 open/read/write/fstat/close（分块引擎用到的那部分），
 * 远端"磁盘"是内存里的 Buffer，本地一侧用真实的临时文件，因此可以断言：
 * - 进度事件形状：pending → running(unit=bytes) → done，进度单调
 * - 结束时 transferred === total，本地文件字节数与远端一致
 * - 暂停：状态变为 paused，且暂停期间进度不再变化
 * - 继续：恢复后能跑到 done
 * - 终止：状态变为 canceled，不产生 done，且清理本地半截文件
 * - 失败：带 error 原因，同样清理半截文件
 * - 目录传输：unit=files，按文件数计数
 *
 * 用法：node scripts/verify-transfer-progress.cjs
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
// 用独立子目录：本脚本开头和结尾都会整目录清理，不能波及 .tsc-verify 下其他脚本的产物
const OUT_DIR = path.join(ROOT, '.tsc-verify', 'transfer-progress')
fs.rmSync(OUT_DIR, { recursive: true, force: true })
fs.mkdirSync(OUT_DIR, { recursive: true })
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-verify-'))
const DL = path.join(TMP, 'dl')
fs.mkdirSync(DL, { recursive: true })

let failed = 0
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`)
  }
}

const stub = path.join(OUT_DIR, 'sftp-session-stub.cjs')
fs.writeFileSync(
  stub,
  `exports.sessionManager = {
    waitUntilReady: async () => {},
    getClient: () => ({ sftp: (cb) => cb(null, globalThis.__FAKE_SFTP__) })
  }`
)

const bundle = path.join(OUT_DIR, 'sftp-progress-bundle.cjs')
const buildOptions = {
  stdin: {
    contents: `export { SftpManager } from './src/main/ssh/sftpManager'`,
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
      setup(build) {
        build.onResolve({ filter: /sessionManager$/ }, (args) => {
          if (args.importer.endsWith('sftpManager.ts')) return { path: stub }
          return null
        })
      }
    }
  ]
}

let SftpManager

/**
 * 假 SFTP 通道。
 * @param {object} opts
 * @param {Map<string, Buffer>} opts.files  远端文件内容
 * @param {Map<string, string[]>} opts.dirs 远端目录 → 文件名列表
 * @param {number} opts.delayMs             每次 read/write 的模拟延迟
 * @param {string|null} opts.fstatError     fstat 失败（模拟拿不到大小）
 * @param {string|null} opts.readError      read 失败（模拟连接中断）
 */
function makeSftp(opts) {
  const {
    files = new Map(),
    dirs = new Map(),
    delayMs = 2,
    fstatError = null,
    readError = null
  } = opts || {}

  const handles = new Map()
  let nextHandle = 1
  const statsOf = (size, isDir) => ({
    isFile: () => !isDir,
    isDirectory: () => isDir,
    size,
    mode: isDir ? 0o040755 : 0o100644,
    mtime: 0,
    uid: 0,
    gid: 0
  })

  const wrapper = {
    on() {},
    end() {},
    unlink(p, cb) {
      files.delete(p)
      cb && cb(null)
    },
    mkdir(_p, cb) {
      cb && cb(null)
    },
    stat(p, cb) {
      if (files.has(p)) return cb(null, statsOf(files.get(p).length, false))
      if (dirs.has(p)) return cb(null, statsOf(0, true))
      cb(new Error(`no such file: ${p}`))
    },
    readdir(p, cb) {
      const names = dirs.get(p)
      if (!names) return cb(new Error(`no such dir: ${p}`))
      cb(
        null,
        names.map((n) => ({
          filename: n,
          attrs: files.has(`${p}/${n}`)
            ? statsOf(files.get(`${p}/${n}`).length, false)
            : statsOf(0, true)
        }))
      )
    },
    open(p, mode, cb) {
      const isWrite = String(mode).startsWith('w')
      if (!isWrite && !files.has(p)) return cb(new Error(`no such file: ${p}`))
      const id = nextHandle++
      if (isWrite) files.set(p, Buffer.alloc(0))
      handles.set(id, { path: p, write: isWrite })
      // ssh2 的 handle 本身就是个 Buffer，这里保持一致
      cb(null, Buffer.from(`h${id}`))
    },
    fstat(handle, cb) {
      if (fstatError) return cb(new Error(fstatError))
      const h = handles.get(Number(handle.toString().slice(1)))
      if (!h) return cb(new Error('bad handle'))
      cb(null, statsOf((files.get(h.path) || Buffer.alloc(0)).length, false))
    },
    close(handle, cb) {
      const id = Number(handle.toString().slice(1))
      handles.delete(id)
      cb && cb(null)
    },
    read(handle, buffer, offset, length, position, cb) {
      const h = handles.get(Number(handle.toString().slice(1)))
      if (!h) return cb(new Error('bad handle'))
      setTimeout(() => {
        if (readError) return cb(new Error(readError))
        const src = files.get(h.path) || Buffer.alloc(0)
        const slice = src.subarray(position, position + length)
        slice.copy(buffer, offset)
        cb(null, slice.length, buffer, position)
      }, delayMs)
    },
    write(handle, buffer, offset, length, position, cb) {
      const h = handles.get(Number(handle.toString().slice(1)))
      if (!h) return cb(new Error('bad handle'))
      setTimeout(() => {
        const cur = files.get(h.path) || Buffer.alloc(0)
        const end = position + length
        const next = cur.length >= end ? Buffer.from(cur) : Buffer.concat([cur, Buffer.alloc(end - cur.length)])
        buffer.copy(next, position, offset, offset + length)
        files.set(h.path, next)
        cb(null)
      }, delayMs)
    }
  }
  return { wrapper, handles }
}

function collect(mgr) {
  const events = []
  mgr.setProgressHandler((e) => events.push(e))
  return events
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 生成确定性内容的测试数据 */
function payload(size) {
  const buf = Buffer.alloc(size)
  for (let i = 0; i < size; i += 1) buf[i] = (i * 31 + 7) & 0xff
  return buf
}

async function caseDownloadLarge() {
  console.log('\ndownload: 大文件分块下载')
  const size = 3 * 1024 * 1024 + 12345
  const body = payload(size)
  const files = new Map([['/remote/big.bin', body]])
  const { wrapper } = makeSftp({ files, delayMs: 1 })
  globalThis.__FAKE_SFTP__ = wrapper
  const mgr = new SftpManager()
  const events = collect(mgr)
  const ids = mgr.download('s1', ['/remote/big.bin'], path.join(TMP, 'dl-large'))
  await sleep(1500)

  const pending = events.find((e) => e.status === 'pending')
  const running = events.filter((e) => e.status === 'running')
  const done = events.find((e) => e.status === 'done')
  const local = path.join(TMP, 'dl-large', 'big.bin')
  const written = fs.existsSync(local) ? fs.readFileSync(local) : Buffer.alloc(0)

  check('返回 taskId', ids.length === 1)
  check('先发 pending', !!pending, events.map((e) => e.status))
  check('running 带已知总量', running.length > 0 && running[0].total === size, running[0])
  check('单位是 bytes', running.length > 0 && running.every((e) => e.unit === 'bytes'))
  check(
    '进度单调递增',
    running.every((e, i) => i === 0 || e.transferred >= running[i - 1].transferred)
  )
  check('done 已传满总量', !!done && done.transferred === size && done.total === size, done)
  check('写完的本地文件大小正确', written.length === size, written.length)
  check('本地内容与远端一致', written.length === size && written.equals(body))
}

async function caseUpload() {
  console.log('\nupload: 分块上传后远端内容一致')
  const size = 1024 * 1024 + 777
  const local = path.join(TMP, 'up.bin')
  const body = payload(size)
  fs.writeFileSync(local, body)
  const files = new Map()
  const { wrapper } = makeSftp({ files, delayMs: 1 })
  globalThis.__FAKE_SFTP__ = wrapper
  const mgr = new SftpManager()
  const events = collect(mgr)
  mgr.upload('s1', [local], '/remote/in')
  await sleep(1200)

  const done = events.find((e) => e.status === 'done')
  const remote = files.get('/remote/in/up.bin')
  check('done 已传满总量', !!done && done.transferred === size && done.total === size, done)
  check('远端文件已写入', !!remote && remote.length === size, remote && remote.length)
  check('远端内容与本地一致', !!remote && remote.length === size && remote.equals(body))
}

async function casePauseResume() {
  console.log('\npause/resume: 暂停期间进度冻结，继续后跑到完成')
  const size = 16 * 1024 * 1024 + 4321
  const files = new Map([['/remote/pause.bin', payload(size)]])
  // 每次 read 40ms、一批 6 块并行：整包要跑 ~0.7s，足够在中途暂停
  const { wrapper } = makeSftp({ files, delayMs: 40 })
  globalThis.__FAKE_SFTP__ = wrapper
  const mgr = new SftpManager()
  const events = collect(mgr)
  const [taskId] = mgr.download('s1', ['/remote/pause.bin'], path.join(TMP, 'dl-pause'))

  // 进度上报按 150ms 节流，首帧是强制发出的 0 字节帧，所以等过节流窗口再看
  await sleep(320)
  const seen = events.filter((e) => e.status === 'running').map((e) => e.transferred)
  const beforePause = Math.max(0, ...seen)
  check('暂停前已有进度', beforePause > 0, seen)
  const okPause = mgr.pauseTransfer(taskId)
  check('pauseTransfer 返回 true', okPause === true)
  await sleep(250)
  check('发出 paused 事件', events.some((e) => e.status === 'paused'), events.map((e) => e.status))

  const frozen1 = events.filter((e) => e.status === 'running').pop()
  await sleep(400)
  const frozen2 = events.filter((e) => e.status === 'running').pop()
  check(
    '暂停期间进度不再变化',
    (frozen1 && frozen1.transferred) === (frozen2 && frozen2.transferred),
    [frozen1 && frozen1.transferred, frozen2 && frozen2.transferred]
  )
  check('暂停期间没有 done', !events.some((e) => e.status === 'done'))

  const okResume = mgr.resumeTransfer(taskId)
  check('resumeTransfer 返回 true', okResume === true)
  await sleep(3000)
  const done = events.find((e) => e.status === 'done')
  check('继续后跑到完成', !!done && done.transferred === size, done)
  const local = path.join(TMP, 'dl-pause', 'pause.bin')
  const bytes = fs.existsSync(local) ? fs.readFileSync(local) : Buffer.alloc(0)
  check('本地文件完整', bytes.length === size, bytes.length)
}

async function caseCancel() {
  console.log('\ncancel: 终止后不产生 done，并清理半截文件')
  const size = 16 * 1024 * 1024 + 4321
  const files = new Map([['/remote/cancel.bin', payload(size)]])
  const { wrapper } = makeSftp({ files, delayMs: 40 })
  globalThis.__FAKE_SFTP__ = wrapper
  const mgr = new SftpManager()
  const events = collect(mgr)
  const dir = path.join(TMP, 'dl-cancel')
  const [taskId] = mgr.download('s1', ['/remote/cancel.bin'], dir)

  await sleep(320)
  const seen = events.filter((e) => e.status === 'running').map((e) => e.transferred)
  const before = Math.max(0, ...seen)
  check('终止前已有进度', before > 0, seen)
  const okCancel = mgr.cancelTransfer(taskId)
  check('cancelTransfer 返回 true', okCancel === true)
  await sleep(600)

  const canceled = events.find((e) => e.status === 'canceled')
  check('发出 canceled 事件', !!canceled, events.map((e) => e.status))
  check('没有 done 事件', !events.some((e) => e.status === 'done'))
  check('没有 error 事件', !events.some((e) => e.status === 'error'), events.filter((e) => e.error))
  const local = path.join(dir, 'cancel.bin')
  check('半截文件已清理', !fs.existsSync(local))
  check('任务已从队列移除', mgr.hasActiveTransfers() === false)
}

async function caseError() {
  console.log('\nerror: 读取失败时带原因并清理半截文件')
  const size = 2 * 1024 * 1024
  const files = new Map([['/remote/err.bin', payload(size)]])
  const { wrapper } = makeSftp({ files, delayMs: 2, readError: 'connection lost' })
  globalThis.__FAKE_SFTP__ = wrapper
  const mgr = new SftpManager()
  const events = collect(mgr)
  const dir = path.join(TMP, 'dl-err')
  mgr.download('s1', ['/remote/err.bin'], dir)
  await sleep(600)

  const error = events.find((e) => e.status === 'error')
  check('发出 error 事件', !!error, events.map((e) => e.status))
  check('error 带原因', !!error && error.error === 'connection lost', error && error.error)
  check('没有 done 事件', !events.some((e) => e.status === 'done'))
  check('半截文件已清理', !fs.existsSync(path.join(dir, 'err.bin')))
}

async function caseDirectory() {
  console.log('\ndirectory: 单位标记为 files，按文件数计数')
  const files = new Map([
    ['/remote/dir/a.bin', payload(4096)],
    ['/remote/dir/b.bin', payload(4096)],
    ['/remote/dir/c.bin', payload(4096)]
  ])
  const dirs = new Map([['/remote/dir', ['a.bin', 'b.bin', 'c.bin']]])
  const { wrapper } = makeSftp({ files, dirs, delayMs: 1 })
  globalThis.__FAKE_SFTP__ = wrapper
  const mgr = new SftpManager()
  const events = collect(mgr)
  mgr.download('s1', ['/remote/dir'], path.join(TMP, 'dl-dir'))
  await sleep(1200)

  const progress = events.filter((e) => e.status === 'running')
  const done = events.find((e) => e.status === 'done')
  check('running 单位为 files', progress.length > 0 && progress.every((e) => e.unit === 'files'))
  check('文件总数 = 3', progress.some((e) => e.total === 3), progress.map((e) => [e.transferred, e.total]))
  check('done 计数满 3', !!done && done.transferred === 3 && done.total === 3, done)
  const outDir = path.join(TMP, 'dl-dir', 'dir')
  const count = fs.existsSync(outDir) ? fs.readdirSync(outDir).length : 0
  check('目录内文件已落地', count === 3, count)
}

async function caseUnknownTotal() {
  console.log('\nunknown total: fstat 失败时靠读到 EOF 收尾，done 仍有准确总量')
  const size = 1024 * 1024 + 999
  const files = new Map([['/remote/unknown.bin', payload(size)]])
  const { wrapper } = makeSftp({ files, delayMs: 1, fstatError: 'permission denied' })
  globalThis.__FAKE_SFTP__ = wrapper
  const mgr = new SftpManager()
  const events = collect(mgr)
  const dir = path.join(TMP, 'dl-unknown')
  mgr.download('s1', ['/remote/unknown.bin'], dir)
  await sleep(1200)

  const progress = events.filter((e) => e.status === 'running')
  const done = events.find((e) => e.status === 'done')
  check('仍能进入 running', progress.length > 0)
  check('done 总量准确', !!done && done.total === size && done.transferred === size, done)
  const local = path.join(dir, 'unknown.bin')
  const bytes = fs.existsSync(local) ? fs.readFileSync(local) : Buffer.alloc(0)
  check('本地文件完整', bytes.length === size, bytes.length)
}

async function main() {
  await esbuild.build(buildOptions)
  ;({ SftpManager } = require(bundle))
  await caseDownloadLarge()
  await caseUpload()
  await casePauseResume()
  await caseCancel()
  await caseError()
  await caseDirectory()
  await caseUnknownTotal()
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.rmSync(OUT_DIR, { recursive: true, force: true })
  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
