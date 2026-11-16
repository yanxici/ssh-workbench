#!/usr/bin/env node
/**
 * 断线续传的「真网络」验证：真 SSH/SFTP 服务器 + 真 TCP 断链 + 真重连。
 *
 * verify-sftp-resume.cjs 用内存假通道证明逻辑分支正确；这一份回答另一个问题：
 * 把字节真的写进 socket、让 TCP 真的断掉、客户端真的重连之后，续传还成不成立。
 * 现场「设备网络波动几秒」就是这个形状 —— 假通道模拟不出半包、RST、句柄失效。
 *
 * 做法：
 *   1. 起 scripts/lab-sftp-server.cjs，用 LAB_DROP_AFTER_BYTES 让它在中途 client.end()
 *   2. 用真实 ssh2 Client 连上去，把它喂给 SftpManager（sessionManager 只做最小替身）
 *   3. 上传/下载大文件，断链后模拟「几秒后网络回来」，断言 sha256 一致且没有整份重传
 *
 * 用法：node scripts/verify-sftp-resume-e2e.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const net = require('node:net')
const esbuild = require('esbuild')

const ROOT = path.resolve(__dirname, '..')
const OUT = path.join(ROOT, '.tsc-verify')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-e2e-'))
const LAB_ROOT = path.join(TMP, 'lab')
const LAB_PORT = Number(process.env.E2E_LAB_PORT || 2322)
const DROP_AT = Number(process.env.E2E_DROP_AT || 6 * 1024 * 1024)
const BIG = Number(process.env.E2E_BIG || 24 * 1024 * 1024)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failed = 0
function check(name, ok, extra) {
  if (ok) console.log('  ok   ' + name)
  else {
    failed += 1
    console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''))
  }
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

/* ------------------------------ 服务器 ------------------------------ */

function startLab(env) {
  const p = spawn(process.execPath, [path.join(ROOT, 'scripts', 'lab-sftp-server.cjs')], {
    env: {
      ...process.env,
      SFTP_ROOT: LAB_ROOT,
      SFTP_PORT: String(LAB_PORT),
      SFTP_USER: 'lab',
      SFTP_PASS: 'labpass',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  p.stdout.on('data', (d) => process.env.E2E_VERBOSE && process.stdout.write('[lab] ' + d))
  p.stderr.on('data', (d) => process.stdout.write('[lab:err] ' + d))
  return p
}

async function waitPort(port, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const ok = await new Promise((res) => {
      const s = net.connect(port, '127.0.0.1')
      s.on('connect', () => (s.end(), res(true)))
      s.on('error', () => res(false))
    })
    if (ok) return true
    await sleep(150)
  }
  return false
}

/* ------------------------------ 替身 sessionManager ------------------------------ */

async function buildStub() {
  fs.mkdirSync(OUT, { recursive: true })
  const stub = path.join(OUT, 'resume-e2e-session-stub.cjs')
  const electronStub = path.join(OUT, 'resume-e2e-electron-stub.cjs')
  fs.writeFileSync(
    stub,
    `const { Client } = require('ssh2')
const state = { status: 'disconnected', client: null, reconnecting: false, connects: 0 }

async function connect() {
  state.connects += 1
  return new Promise((resolve, reject) => {
    const c = new Client()
    c.on('ready', () => {
      state.client = c
      state.status = 'connected'
      resolve(c)
    })
    c.on('error', () => {})
    c.on('close', () => {
      if (state.client === c) {
        state.client = null
        state.status = 'disconnected'
      }
    })
    c.connect({ host: '127.0.0.1', port: globalThis.__LAB_PORT__, username: 'lab', password: 'labpass', readyTimeout: 20000 })
  })
}

globalThis.__LAB__ = { state, connect }
exports.sessionManager = {
  waitUntilReady: async () => {},
  statusOf: () => {
    if (state.status === 'connected' && !state.client) state.status = 'disconnected'
    return state.status
  },
  isReconnecting: () => state.reconnecting,
  getClient: () => state.client
}
`
  )
  fs.writeFileSync(electronStub, 'module.exports = { app: { getPath: () => require("node:os").tmpdir() } }')
  const bundle = path.join(OUT, 'sftp-resume-e2e-bundle.cjs')
  await esbuild.build({
    stdin: { contents: "export { SftpManager } from './src/main/ssh/sftpManager'", resolveDir: ROOT, loader: 'ts' },
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
          b.onResolve({ filter: /sessionManager$/ }, (a) => (a.importer.endsWith('sftpManager.ts') ? { path: stub } : null))
        }
      },
      { name: 'stub-electron', setup(b) { b.onResolve({ filter: /^electron$/ }, () => ({ path: electronStub })) } }
    ]
  })
  return bundle
}

/* ------------------------------ 用例 ------------------------------ */

async function runTask(mgr, starter) {
  return new Promise((resolve) => {
    const events = []
    const t0 = Date.now()
    mgr.setProgressHandler((e) => {
      events.push(e)
      if (process.env.E2E_VERBOSE) {
        console.log('    [' + ((Date.now() - t0) / 1000).toFixed(1) + 's] ' + e.status + ' ' + e.transferred + '/' + e.total + ' ' + (e.note || '') + ' ' + (e.error || ''))
      }
      if (e.status === 'done' || e.status === 'error' || e.status === 'canceled') resolve({ state: e.status, events })
    })
    starter()
    setTimeout(() => resolve({ state: 'timeout', events }), 180000)
  })
}

/** 断链 → 模拟「网络波动几秒」→ 重连回来 */
function armReconnect(state, delayMs) {
  /*
   * 允许多次重连：真机的 sessionManager 会按退避重试 5 次；这里至少能撑到
   * 传输自己放弃（FILE_RETRY_MAX 次）为止，否则测的是「测试脚本没重连」，
   * 不是应用的续传逻辑。
   */
  let armed = 10
  const attach = () => {
    const c = state.client
    if (!c) return setTimeout(attach, 100)
    const onClose = async () => {
      if (armed <= 0) return
      armed -= 1
      state.status = 'disconnected'
      state.reconnecting = true
      /* 网络断了通常要几秒才恢复；这段窗口正是「不能续传」最容易暴露的地方 */
      await sleep(delayMs)
      try {
        await globalThis.__LAB__.connect()
      } finally {
        state.reconnecting = false
      }
      attach()
    }
    c.on('close', () => void onClose())
    c.on('end', () => void onClose())
  }
  attach()
}

function makeFile(name, size) {
  const p = path.join(TMP, name)
  const buf = Buffer.alloc(size)
  let x = 123456789
  for (let i = 0; i < size; i += 1) {
    x = (x * 1103515245 + 12345) & 0x7fffffff
    buf[i] = x >> 16
  }
  fs.writeFileSync(p, buf)
  return { path: p, sha: sha(buf), size }
}

async function main() {
  const bundle = await buildStub()
  fs.mkdirSync(LAB_ROOT, { recursive: true })
  const remoteDir = '/up'
  fs.mkdirSync(path.join(LAB_ROOT, 'up'), { recursive: true })

  const big = makeFile('big.bin', BIG)
  console.log(`\n真网络大文件：${(BIG / 1024 / 1024).toFixed(0)} MB，累计写 ${(DROP_AT / 1024 / 1024).toFixed(1)} MB 时 TCP 断开`)

  /* ---------- 上传 ---------- */
  let lab = startLab({ LAB_DROP_AFTER_BYTES: String(DROP_AT), LAB_DROP_TIMES: '1', LAB_DROP_DIR: 'upload' })
  if (!(await waitPort(LAB_PORT, 15000))) throw new Error('lab 没起来')
  globalThis.__LAB_PORT__ = LAB_PORT
  const { SftpManager } = require(bundle)
  let state = globalThis.__LAB__.state
  await globalThis.__LAB__.connect()
  armReconnect(state, 2000)

  const upMgr = new SftpManager()
  const upStart = Date.now()
  const up = await runTask(upMgr, () => {
    upMgr.upload('s1', [big.path], remoteDir)
  })
  const upSec = (Date.now() - upStart) / 1000
  check('上传最终成功', up.state === 'done', up.state + ' ' + (up.events.find((e) => e.error)?.error || ''))
  check('确实重连过（新连接被建起来）', state.connects >= 2, state.connects)
  const remotePath = path.join(LAB_ROOT, 'up', 'big.bin')
  const remoteBuf = fs.existsSync(remotePath) ? fs.readFileSync(remotePath) : Buffer.alloc(0)
  check('远端大小正确', remoteBuf.length === BIG, remoteBuf.length + ' / ' + BIG)
  check('远端内容与本地一致（sha256）', remoteBuf.length === BIG && sha(remoteBuf) === big.sha)
  check('上传耗时合理（没有整份重传）', upSec < (BIG / 1024 / 1024) * 0.5 + 25, upSec.toFixed(1) + 's')
  lab.kill()

  /* ---------- 下载 ---------- */
  await sleep(800)
  lab = startLab({ LAB_DROP_AFTER_BYTES: String(DROP_AT), LAB_DROP_TIMES: '1', LAB_DROP_DIR: 'download' })
  if (!(await waitPort(LAB_PORT, 15000))) throw new Error('lab 二次启动失败')
  state = globalThis.__LAB__.state
  await globalThis.__LAB__.connect()
  armReconnect(state, 2000)

  const dlDir = path.join(TMP, 'dl')
  fs.mkdirSync(dlDir, { recursive: true })
  const dlMgr = new SftpManager()
  const dlStart = Date.now()
  const dl = await runTask(dlMgr, () => {
    dlMgr.download('s1', [remoteDir + '/big.bin'], dlDir)
  })
  const dlSec = (Date.now() - dlStart) / 1000
  const localFile = path.join(dlDir, 'big.bin')
  const localBuf = fs.existsSync(localFile) ? fs.readFileSync(localFile) : Buffer.alloc(0)
  check('下载最终成功', dl.state === 'done', dl.state + ' ' + (dl.events.find((e) => e.error)?.error || ''))
  check('本地大小正确', localBuf.length === BIG, localBuf.length + ' / ' + BIG)
  check('本地内容与源一致（sha256）', localBuf.length === BIG && sha(localBuf) === big.sha)
  check('下载耗时合理（没有整份重下）', dlSec < (BIG / 1024 / 1024) * 0.5 + 25, dlSec.toFixed(1) + 's')
  check('过程中确实提示过重连续传', up.events.some((e) => /重连后续传/.test(e.note || '')) || dl.events.some((e) => /重连后续传/.test(e.note || '')), '')
  lab.kill()

  console.log(`\n上传 ${(BIG / 1024 / 1024 / upSec).toFixed(1)} MB/s，下载 ${(BIG / 1024 / 1024 / dlSec).toFixed(1)} MB/s`)
  console.log(failed === 0 ? '\n真网络续传验证全部通过' : `\n${failed} 条失败`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
