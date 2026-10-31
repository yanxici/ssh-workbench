/**
 * 上传文件夹（本地目录 → 远端）回归测试：直接驱动主进程 SftpManager 的真实代码。
 *
 * 重点验证两件事：
 * 1. keepRoot=false（历史拖拽语义）：本地目录的**内容**铺进目标目录；
 * 2. keepRoot=true （「上传文件夹」）  ：远端保留同名目录，目标目录/<本地目录名>/...
 *    并且空目录也会被建出来（否则「上传一个空文件夹」看起来毫无反应）。
 *
 * 假 SFTP 通道把远端「磁盘」放在内存里（files + dirs 两个 Map），
 * mkdir 会真的登记目录，因此可以直接断言远端目录结构。
 *
 * 用法：node scripts/verify-upload-folder.cjs
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.tsc-verify')
fs.mkdirSync(OUT_DIR, { recursive: true })
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sftp-folder-'))

let failed = 0
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failed++
    console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`)
  }
}

const stub = path.join(OUT_DIR, 'sftp-session-stub-folder.cjs')
fs.writeFileSync(
  stub,
  `exports.sessionManager = {
    waitUntilReady: async () => {},
    getClient: () => ({ sftp: (cb) => cb(null, globalThis.__FAKE_SFTP__) })
  }`
)

const electronStub = path.join(OUT_DIR, 'electron-stub-folder.cjs')
fs.writeFileSync(
  electronStub,
  'module.exports = { app: { getPath: () => require("node:os").tmpdir() } }' + String.fromCharCode(10)
)

const bundle = path.join(OUT_DIR, 'sftp-folder-bundle.cjs')
async function buildBundle() {
  await esbuild.build({
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
        build.onResolve({ filter: /sessionManager$/ }, (args) =>
          args.importer.endsWith('sftpManager.ts') ? { path: stub } : null
        )
      }
    },
    {
      /* sftpManager 经 errorLog 间接依赖 electron：只需 app.getPath 的最小 stub */
      name: 'stub-electron',
      setup(build) {
        build.onResolve({ filter: /^electron$/ }, () => ({ path: electronStub }))
      }
    }
  ]
  })
}

let SftpManager

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 内存版 SFTP：open/read/write/fstat/close/stat/readdir/mkdir 全套 */
function makeSftp() {
  const files = new Map()
  const dirs = new Set(['/'])
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
    mkdir(p, cb) {
      if (dirs.has(p)) return cb && cb(new Error('exists'))
      dirs.add(p)
      cb && cb(null)
    },
    stat(p, cb) {
      if (files.has(p)) return cb(null, statsOf(files.get(p).length, false))
      if (dirs.has(p)) return cb(null, statsOf(0, true))
      cb(new Error(`no such file: ${p}`))
    },
    readdir(p, cb) {
      if (!dirs.has(p)) return cb(new Error(`no such dir: ${p}`))
      const kids = []
      for (const d of dirs) {
        if (d !== p && path.posix.dirname(d) === p) kids.push({ filename: path.posix.basename(d), attrs: statsOf(0, true) })
      }
      for (const f of files.keys()) {
        if (path.posix.dirname(f) === p) kids.push({ filename: path.posix.basename(f), attrs: statsOf(files.get(f).length, false) })
      }
      cb(null, kids)
    },
    open(p, mode, cb) {
      const isWrite = String(mode).startsWith('w')
      if (!isWrite && !files.has(p)) return cb(new Error(`no such file: ${p}`))
      const id = nextHandle++
      if (isWrite) files.set(p, Buffer.alloc(0))
      handles.set(id, { path: p })
      cb(null, Buffer.from('h' + id))
    },
    fstat(handle, cb) {
      const h = handles.get(Number(handle.toString().slice(1)))
      if (!h) return cb(new Error('bad handle'))
      cb(null, statsOf((files.get(h.path) || Buffer.alloc(0)).length, false))
    },
    close(handle, cb) {
      handles.delete(Number(handle.toString().slice(1)))
      cb && cb(null)
    },
    read(handle, buffer, offset, length, position, cb) {
      const h = handles.get(Number(handle.toString().slice(1)))
      if (!h) return cb(new Error('bad handle'))
      const src = files.get(h.path) || Buffer.alloc(0)
      const slice = src.subarray(position, position + length)
      slice.copy(buffer, offset)
      cb(null, slice.length, buffer, position)
    },
    write(handle, buffer, offset, length, position, cb) {
      const h = handles.get(Number(handle.toString().slice(1)))
      if (!h) return cb(new Error('bad handle'))
      const cur = files.get(h.path) || Buffer.alloc(0)
      const end = position + length
      const next = cur.length >= end ? Buffer.from(cur) : Buffer.concat([cur, Buffer.alloc(end - cur.length)])
      buffer.copy(next, position, offset, offset + length)
      files.set(h.path, next)
      cb(null)
    }
  }
  return { wrapper, files, dirs }
}

/** 造一棵本地目录：root/<name>/... */
function makeLocalTree(name, entries) {
  const base = path.join(TMP, `case-${name}-${Date.now()}`)
  const top = path.join(base, name)
  for (const [rel, body] of entries) {
    const full = path.join(top, ...rel.split('/'))
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, body)
  }
  return { top, base }
}

async function caseKeepRoot() {
  console.log('\nkeepRoot=true：远端保留本地目录名')
  const { wrapper, files, dirs } = makeSftp()
  globalThis.__FAKE_SFTP__ = wrapper
  const { top } = makeLocalTree('assets', [
    ['a.txt', 'AAA'],
    ['sub/b.txt', 'BBB']
  ])
  const mgr = new SftpManager()
  const done = []
  mgr.setProgressHandler((e) => {
    if (e.status === 'done') done.push(e)
  })
  mgr.upload('s1', [top], '/remote/dest', { keepRoot: true })
  await sleep(600)

  check('任务完成', done.length === 1, done.map((e) => e.status))
  check('文件落到 /remote/dest/assets/a.txt', files.has('/remote/dest/assets/a.txt'))
  check(
    '子目录文件落到 /remote/dest/assets/sub/b.txt',
    files.has('/remote/dest/assets/sub/b.txt')
  )
  check(
    '内容正确',
    files.get('/remote/dest/assets/a.txt')?.toString() === 'AAA',
    files.get('/remote/dest/assets/a.txt')?.toString()
  )
  check('没有把内容铺平到目标目录根部', !files.has('/remote/dest/a.txt'))
  check('目录本身被创建', dirs.has('/remote/dest/assets'))
}

async function caseFlattenLegacy() {
  console.log('\nkeepRoot=false：历史语义，内容铺进目标目录')
  const { wrapper, files } = makeSftp()
  globalThis.__FAKE_SFTP__ = wrapper
  const { top } = makeLocalTree('assets', [
    ['a.txt', 'AAA'],
    ['sub/b.txt', 'BBB']
  ])
  const mgr = new SftpManager()
  const done = []
  mgr.setProgressHandler((e) => {
    if (e.status === 'done') done.push(e)
  })
  mgr.upload('s1', [top], '/remote/dest')
  await sleep(600)

  check('任务完成', done.length === 1, done.map((e) => e.status))
  check('内容铺平：/remote/dest/a.txt', files.has('/remote/dest/a.txt'))
  check('子目录内容铺平：/remote/dest/sub/b.txt', files.has('/remote/dest/sub/b.txt'))
  check('没有多出一层目录名', !files.has('/remote/dest/assets/a.txt'))
}

async function caseEmptyFolder() {
  console.log('\nkeepRoot=true：空目录也要建出来')
  const { wrapper, dirs } = makeSftp()
  globalThis.__FAKE_SFTP__ = wrapper
  const base = path.join(TMP, `empty-${Date.now()}`)
  const top = path.join(base, 'hollow')
  fs.mkdirSync(top, { recursive: true })
  const mgr = new SftpManager()
  mgr.upload('s1', [top], '/remote/dest', { keepRoot: true })
  await sleep(400)
  check('远端出现了同名空目录', dirs.has('/remote/dest/hollow'), [...dirs])
}

async function caseScanFolders() {
  console.log('\nscanFolders：上传前统计文件数与总字节数')
  const { top, base } = makeLocalTree('scan', [
    ['x.bin', Buffer.alloc(10)],
    ['y.bin', Buffer.alloc(25)],
    ['deep/z.bin', Buffer.alloc(5)]
  ])
  const single = path.join(base, 'single.txt')
  fs.writeFileSync(single, Buffer.alloc(7))
  const mgr = new SftpManager()
  const res = await mgr.scanFolders([top, single])
  check('总文件数 = 4', res.totalFiles === 4, res.totalFiles)
  check('总字节数 = 47', res.totalBytes === 47, res.totalBytes)
  const dirItem = res.items.find((i) => i.isDir)
  const fileItem = res.items.find((i) => !i.isDir)
  check('目录项名字正确', dirItem && dirItem.name === 'scan', dirItem)
  check('目录项含 3 个文件', dirItem && dirItem.files === 3, dirItem)
  check('文件项计 1 个文件', fileItem && fileItem.files === 1, fileItem)
  check('未触发截断标记', dirItem && dirItem.truncated !== true, dirItem)
}

async function caseFileUploadUnchanged() {
  console.log('\n单文件上传不受 keepRoot 影响')
  const { wrapper, files } = makeSftp()
  globalThis.__FAKE_SFTP__ = wrapper
  const base = path.join(TMP, `single-${Date.now()}`)
  fs.mkdirSync(base, { recursive: true })
  const local = path.join(base, 'fw.bin')
  fs.writeFileSync(local, Buffer.from('firmware'))
  const mgr = new SftpManager()
  mgr.upload('s1', [local], '/remote/dest', { keepRoot: true })
  await sleep(400)
  check('文件落到目标目录', files.has('/remote/dest/fw.bin'))
  check('内容一致', files.get('/remote/dest/fw.bin')?.toString() === 'firmware')
}

async function main() {
  await buildBundle()
  SftpManager = require(bundle).SftpManager
  await caseKeepRoot()
  await caseFlattenLegacy()
  await caseEmptyFolder()
  await caseScanFolders()
  await caseFileUploadUnchanged()
  fs.rmSync(TMP, { recursive: true, force: true })
  console.log('')
  if (failed > 0) {
    console.log(`上传文件夹自检失败：${failed} 项\n`)
    process.exit(1)
  }
  console.log('上传文件夹自检全部通过\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
