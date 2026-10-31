/**
 * 本地文件操作路径守卫自检：直接驱动主进程真实的 store/localFs 代码。
 *
 * 背景（Volt 报的 P1）：
 *   localDelete / localRename 对渲染层传入的路径零校验，`fs.rm(p, { recursive: true, force: true })`
 *   直接吃值；同项目 store/sessionLogs.ts:22-30 有完整的 assertInside 守卫，两套标准。
 *   渲染层被 XSS 控制时 `local:delete` 就是 rm -rf 任意路径。
 *
 * 本脚本分两态：
 *   - 修复前（当前）：穿越路径不会抛错（目标不存在时静默成功）→ 守卫断言失败，脚本红。
 *     这是有意的红：锁定缺口，等 pathGuard 落地后转绿。
 *   - 修复后：穿越路径抛错，正常路径不受影响 → 全绿。
 *
 * 安全设计：所有「正常路径」用例只在 os.tmpdir() 下的自建目录里操作，
 * 穿越用例全部指向不存在的路径（fs.rm force:true 对不存在路径不产生副作用），
 * 绝不触碰用户真实数据。
 *
 * 用法：node scripts/verify-local-fs-guard.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.tsc-verify')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-lfs-'))
process.env.SW_TEST_USERDATA = userData

/* ---------- 打包被测代码（electron 用桩替换，与 verify-batch-exec 同款） ---------- */
fs.mkdirSync(OUT_DIR, { recursive: true })
const stub = path.join(OUT_DIR, 'electron-stub-lfs.cjs')
fs.writeFileSync(
  stub,
  `module.exports = {
  app: {
    getPath: () => process.env.SW_TEST_USERDATA,
    getVersion: () => '0.0.0-test',
    getName: () => 'ssh-workbench-test',
    isPackaged: false
  },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() }
}`
)
const bundle = path.join(OUT_DIR, 'localfs-bundle.cjs')
esbuild.buildSync({
  stdin: {
    contents: `export * from './src/main/store/localFs'`,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle,
  external: ['ssh2'],
  logLevel: 'error',
  alias: {
    electron: stub,
    '@shared': path.join(ROOT, 'src/shared')
  }
})
const M = require(bundle)

/* ---------- 测试框架 ---------- */
let pass = 0
let fail = 0
const fails = []
function check(name, ok, detail = '') {
  if (ok) pass++
  else {
    fail++
    fails.push(`${name} ${detail}`)
  }
}

/** 期望抛错：守卫应拒绝。当前无守卫时静默成功 → 红。 */
async function expectThrow(name, fn) {
  try {
    await fn()
    check(name, false, '（未抛错：守卫缺失，修复后应拒绝）')
  } catch (e) {
    check(name, true)
  }
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-lfs-work-'))
  const subDir = path.join(work, 'sub')
  fs.mkdirSync(subDir)
  const fileA = path.join(work, 'a.txt')
  fs.writeFileSync(fileA, 'a')

  /* ================= 1. 正常路径不受影响（修复后也不能误伤） ================= */
  await M.localDelete([fileA])
  check('正常删除 tmp 内文件成功', !fs.existsSync(fileA))
  const fileB = path.join(work, 'b.txt')
  fs.writeFileSync(fileB, 'b')
  await M.localRename(fileB, path.join(work, 'b2.txt'))
  check('正常重命名 tmp 内文件成功', fs.existsSync(path.join(work, 'b2.txt')) && !fs.existsSync(fileB))
  await M.localMkdir(work, 'newdir')
  check('正常建目录成功', fs.existsSync(path.join(work, 'newdir')))
  const listing = await M.localList(work)
  check('正常列目录成功', Array.isArray(listing) && listing.length >= 2, String(listing.length))

  /* ================= 2. 穿越路径必须被拒绝 ================= */
  /*
   * 注意：不能用 path.resolve(work, '..', '..', 'x') 造用例 ——
   * resolve 会把 `..` 折叠掉，传进 localDelete 的字符串里根本没有 `..`，
   * 落点变成 os.tmpdir() 下的另一个合法路径，守卫**正确地**放行了它。
   * 断言那种路径会抛错是写错了期望。
   *
   * 所以要直接构造带 `..` 字面量的字符串（模拟渲染层恶意传入），
   * 并直接测守卫函数本身。
   */
  const rawTraversal = work + path.sep + '..' + path.sep + '..' + path.sep + 'no-such-guard-test'
  await expectThrow('localDelete 拒绝含 .. 字面量的路径', () => M.localDelete([rawTraversal]))

  // 相对路径：含义取决于主进程 cwd，与用户看到的目录无关，必须拒绝
  await expectThrow('localDelete 拒绝相对路径', () => M.localDelete(['relative/path.txt']))

  // 空列表 / 空字符串
  await expectThrow('localDelete 拒绝空列表', () => M.localDelete([]))
  await expectThrow('localDelete 拒绝空字符串路径', () => M.localDelete(['']))

  /*
   * rename 的 to 端：同样用字面量 `..`，且判据是「抛错且不是 fs 的 ENOENT」——
   * 若只靠 fs，不存在的目标父目录自己就抛 ENOENT，会假绿。
   */
  const rawRenameTo = work + path.sep + '..' + path.sep + 'no-such-guard-test' + path.sep + 'y'
  try {
    await M.localRename(path.join(work, 'b2.txt'), rawRenameTo)
    check('localRename 拒绝 to 端穿越', false, '（未抛错：守卫缺失）')
  } catch (e) {
    const isFsEnoent = e && e.code === 'ENOENT'
    check('localRename 拒绝 to 端穿越（且不是 fs ENOENT 假象）', !isFsEnoent,
      isFsEnoent ? '（抛的是 fs ENOENT，不是守卫）' : '')
  }
  // 源端也要校验
  await expectThrow('localRename 拒绝 from 端穿越',
    () => M.localRename(rawTraversal, path.join(work, 'z.txt')))

  /* ================= 3. localMkdir / localList 也必须过守卫 ================= */
  /*
   * Volt 实测的缺口：localMkdir 原来直接 `fs.mkdir(join(dir, name))`，
   * 而 join 会先把 `..` 折叠掉（join('/home/u','../../etc/evil') → '\etc\evil'），
   * 守卫的 `..` 正则在折叠后的字符串里什么都看不到。
   * 用户在「新建文件夹」输入框填 `..\..\Windows\Temp\evil` 就能在系统目录建目录。
   */
  const beforeMkdir = fs.readdirSync(path.dirname(work)).length
  await expectThrow('localMkdir 拒绝含路径分隔符的名字',
    () => M.localMkdir(work, '..' + path.sep + 'outside'))
  await expectThrow('localMkdir 拒绝含 / 的名字', () => M.localMkdir(work, 'a/b'))
  await expectThrow('localMkdir 拒绝 .. 作为名字', () => M.localMkdir(work, '..'))
  await expectThrow('localMkdir 拒绝空名字', () => M.localMkdir(work, '   '))
  await expectThrow('localMkdir 拒绝 Windows 保留字符', () => M.localMkdir(work, 'a<b'))
  await expectThrow('localMkdir 拒绝保留设备名', () => M.localMkdir(work, 'CON'))
  check('被拒绝的 mkdir 没有在上级目录留下痕迹',
    fs.readdirSync(path.dirname(work)).length === beforeMkdir,
    `${beforeMkdir} -> ${fs.readdirSync(path.dirname(work)).length}`)

  // 正常名字必须能建
  await M.localMkdir(work, '新建文件夹-正常')
  check('正常名字仍可新建', fs.existsSync(path.join(work, '新建文件夹-正常')))
  // 中文、空格、点号、连字符都应放行
  await M.localMkdir(work, '带 空格.和-连字符')
  check('含空格/点/连字符的名字可建', fs.existsSync(path.join(work, '带 空格.和-连字符')))

  /* localList：只拦形状，不拦位置（文件管理器必须能列盘符根） */
  await expectThrow('localList 拒绝相对路径', () => M.localList('relative/dir'))
  await expectThrow('localList 拒绝 .. 穿越',
    () => M.localList(work + path.sep + '..' + path.sep + '..'))
  const rootList = await M.localList(path.parse(work).root)
  check('localList 允许列盘符根（不误拦正常浏览）', Array.isArray(rootList),
    Array.isArray(rootList) ? String(rootList.length) : typeof rootList)

  // Windows 系统关键目录（不存在于任何正常访问场景的伪路径，但形态是系统目录）
  const sysPath = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'no-such-guard-test')
    : '/no-such-guard-test'
  await expectThrow('localDelete 拒绝系统目录下非授权子路径', () => M.localDelete([sysPath]))

  /* ---------- 清理 ---------- */
  fs.rmSync(work, { recursive: true, force: true })
  fs.rmSync(userData, { recursive: true, force: true })

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fails.length) {
    console.log('失败项（修复前预期红——守卫缺失）：')
    for (const f of fails) console.log('  - ' + f)
  }
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('自检异常:', e)
  process.exit(2)
})
