/**
 * 传输进度回归测试：直接驱动主进程 SftpManager 的真实队列代码，
 * 用一个假的 SFTP 通道模拟 fastGet/fastPut 的 step 回调，断言渲染层能收到：
 * - 先 pending，再 running（total 已由 stat 预填，进度条第一帧就有总量）
 * - 进度单调递增，单位标记为 bytes
 * - 结束时 transferred === total（小文件/被节流吞掉的最后一次 step 也不会停在 0%）
 * - 目录传输单位为 files，按文件数计数
 * - 失败时带 error 且保留已传字节
 *
 * 用法：node scripts/verify-transfer-progress.cjs
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.tsc-verify')
fs.mkdirSync(OUT_DIR, { recursive: true })

let failed = 0
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${extra !== undefined ? ` -> ${JSON.stringify(extra)}` : ''}`)
  }
}

/** 假的 sessionManager：不连 SSH，直接给出带 SFTP 通道的 client */
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

/** 构造一个假 SFTP 通道；step 分块回调模拟 ssh2 的 fastGet/fastPut */
function makeSftp(opts) {
  const {
    size = 12 * 1024 * 1024,
    chunks = 6,
    statError = null,
    transferError = null,
    dirEntries = null,
    delayMs = 5
  } = opts || {}
  const state = { reads: 0 }
  const wrapper = {
    on() {},
    end() {},
    stat(p, cb) {
      if (statError) return cb(new Error(statError))
      cb(null, {
        isFile: () => !dirEntries,
        isDirectory: () => !!dirEntries,
        size,
        mode: 0o100644,
        mtime: 0,
        uid: 0,
        gid: 0
      })
    },
    readdir(p, cb) {
      cb(null, dirEntries || [])
    },
    fastGet(remote, local, options, cb) {
      if (typeof options === 'function') {
        cb = options
        options = null
      }
      const step = options && typeof options.step === 'function' ? options.step : null
      let i = 0
      const timer = setInterval(() => {
        i++
        state.reads++
        const bytes = Math.round((size * i) / chunks)
        if (step) step(bytes, size / chunks, size)
        if (i >= chunks) {
          clearInterval(timer)
          if (transferError) cb(new Error(transferError))
          else cb(null)
        }
      }, delayMs)
    },
    fastPut(local, remote, options, cb) {
      wrapper.fastGet(local, remote, options, cb)
    }
  }
  return { wrapper, state }
}

function collect(mgr) {
  const events = []
  mgr.setProgressHandler((e) => events.push(e))
  return events
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function caseDownload() {
  console.log('\ndownload: 已知大小的大文件')
  const { wrapper } = makeSftp({ size: 12 * 1024 * 1024, chunks: 6 })
  globalThis.__FAKE_SFTP__ = wrapper
  const mgr = new SftpManager()
  const events = collect(mgr)
  const ids = mgr.download('s1', ['/remote/big.bin'], path.join(os.tmpdir(), 'dl'))
  await sleep(300)

  const pending = events.find((e) => e.status === 'pending')
  const running = events.find((e) => e.status === 'running')
  const done = events.find((e) => e.status === 'done')
  const progress = events.filter((e) => e.status === 'running')

  check('返回 taskId', ids.length === 1)
  check('先发 pending', !!pending, events.map((e) => e.status))
  check('running 首帧带已知总量', !!running && running.total === 12 * 1024 * 1024, running)
  check('单位是 bytes', running && running.unit === 'bytes', running && running.unit)
  check('进度单调递增', progress.every((e, i) => i === 0 || e.transferred >= progress[i - 1].transferred))
  check('done 已传满总量', !!done && done.transferred === done.total && done.total === 12 * 1024 * 1024, done)
  check('done 单位是 bytes', done && done.unit === 'bytes')
}

async function caseSmallFile() {
  console.log('\nsmall file: 一次 step 都没有（被节流吞掉）也不能停在 0%')
  const { wrapper } = makeSftp({ size: 4096, chunks: 1 })
  globalThis.__FAKE_SFTP__ = wrapper
  const mgr = new SftpManager()
  const events = collect(mgr)
  mgr.upload('s1', [path.join(os.tmpdir(), 'tiny.txt')], '/remote')
  await sleep(120)
  const done = events.find((e) => e.status === 'done')
  check('done 总量 = stat 大小', !!done && done.total === 4096, done)
  check('done 已传 = 总量', !!done && done.transferred === 4096)
}

async function caseUnknownTotal() {
  console.log('\nunknown total: stat 失败时用 step 回调里的总量兜底')
  const { wrapper } = makeSftp({ size: 4 * 1024 * 1024, chunks: 4, statError: 'no such file' })
  globalThis.__FAKE_SFTP__ = wrapper
  const mgr = new SftpManager()
  const events = collect(mgr)
  mgr.download('s1', ['/remote/unknown.bin'], path.join(os.tmpdir(), 'dl'))
  await sleep(200)
  const progress = events.filter((e) => e.status === 'running')
  const done = events.find((e) => e.status === 'done')
  check('仍能进入 running', progress.length > 0)
  check('总量由 step 总量补齐', progress.some((e) => e.total > 0), progress.map((e) => e.total))
  check('done 有效', !!done && done.transferred === done.total && done.total > 0, done)
}

async function caseError() {
  console.log('\nerror: 失败事件保留已传字节与原因')
  const { wrapper } = makeSftp({ size: 8 * 1024 * 1024, chunks: 4, transferError: 'connection lost' })
  globalThis.__FAKE_SFTP__ = wrapper
  const mgr = new SftpManager()
  const events = collect(mgr)
  mgr.download('s1', ['/remote/big.bin'], path.join(os.tmpdir(), 'dl'))
  await sleep(250)
  const error = events.find((e) => e.status === 'error')
  check('发出 error 事件', !!error, events.map((e) => e.status))
  check('error 带原因', error && error.error === 'connection lost', error && error.error)
  check('error 保留已传字节', error && error.transferred > 0, error && error.transferred)
  check('error 有总量（进度条不跳回空）', error && error.total >= error.transferred, error)
}

async function caseDirectory() {
  console.log('\ndirectory: 单位标记为 files，按文件数计数')
  const dirEntries = [
    { filename: 'a.bin', attrs: { isDirectory: () => false, isFile: () => true, size: 10 } },
    { filename: 'b.bin', attrs: { isDirectory: () => false, isFile: () => true, size: 10 } },
    { filename: 'c.bin', attrs: { isDirectory: () => false, isFile: () => true, size: 10 } }
  ]
  const { wrapper } = makeSftp({ dirEntries })
  // 目录内的文件还需要 stat：按路径返回文件属性
  wrapper.stat = (p, cb) => {
    if (p.endsWith('dir') || p.endsWith('/dir')) {
      return cb(null, {
        isFile: () => false,
        isDirectory: () => true,
        size: 0,
        mode: 0o040755
      })
    }
    cb(null, { isFile: () => true, isDirectory: () => false, size: 10, mode: 0o100644 })
  }
  globalThis.__FAKE_SFTP__ = wrapper
  const mgr = new SftpManager()
  const events = collect(mgr)
  mgr.download('s1', ['/remote/dir'], path.join(os.tmpdir(), 'dl'))
  await sleep(900)
  const progress = events.filter((e) => e.status === 'running')
  const done = events.find((e) => e.status === 'done')
  check('running 单位为 files', progress.length > 0 && progress.every((e) => e.unit === 'files'))
  check('文件总数 = 3', progress.some((e) => e.total === 3), progress.map((e) => [e.transferred, e.total]))
  check(
    'done 计数满 3',
    !!done && done.transferred === 3 && done.total === 3,
    events.map((e) => ({ s: e.status, t: e.transferred, tot: e.total, u: e.unit, err: e.error }))
  )
}

async function main() {
  await esbuild.build(buildOptions)
  ;({ SftpManager } = require(bundle))
  await caseDownload()
  await caseSmallFile()
  await caseUnknownTotal()
  await caseError()
  await caseDirectory()
  console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
