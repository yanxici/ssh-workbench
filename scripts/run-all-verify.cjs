/**
 * 一次性跑完 scripts/ 下所有 verify-*.cjs，并给出汇总。
 *
 * 用法：
 *   node scripts/run-all-verify.cjs              # 跑全部
 *   node scripts/run-all-verify.cjs --only=ipc   # 只跑文件名含 ipc 的
 *   node scripts/run-all-verify.cjs --list       # 只列清单
 *
 * 设计要点：
 *   1. 每个脚本独立子进程，互不污染环境（多个脚本会自己起 ssh2 server / 临时 userData）。
 *   2. 已知历史失败（verify-cdsync / verify-theme / verify-zmodem）默认跳过，
 *      --include-known-fail 可纳入。基线是用 git stash 对比过的，不是「跑不过就排除」。
 *   3. 需要 Electron 的脚本自动用 node_modules/electron 的二进制跑（app 对象只在 Electron 里存在）；
 *      verify-zip 需要先把 .tsc-verify 编译出来，这里自动补一步。
 *   4. 退出码：有任一条失败即 1，供 CI 直接使用。
 */
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..')
const SCRIPTS = path.join(ROOT, 'scripts')

/** 已知在改动前就失败的脚本（见 AGENTS.md 2.5），默认不纳入门禁 */
const KNOWN_FAIL = new Set(['verify-cdsync.cjs', 'verify-theme.cjs', 'verify-zmodem.cjs'])

/** 必须在 Electron 里跑的脚本（用到 app / BrowserWindow / ipcMain） */
const NEEDS_ELECTRON = new Set(['verify-ipc-registration.cjs', 'verify-zmodem-e2e.cjs', 'verify-zmodem-renderer.cjs'])

/** 需要先生成 .tsc-verify 编译产物 */
const NEEDS_TSC = new Set(['verify-zip.cjs'])

const argv = process.argv.slice(2)
const onlyArg = argv.find((a) => a.startsWith('--only='))
const ONLY = onlyArg ? onlyArg.slice('--only='.length) : null
const LIST_ONLY = argv.includes('--list')
const INCLUDE_KNOWN = argv.includes('--include-known-fail')

/**
 * 必须在最先跑的脚本。
 * verify-synonyms.cjs:154 会 rmSync 整个 .tsc-verify 目录，而 verify-zip.cjs
 * 依赖 .tsc-verify/main/util/zip.js —— 按字母序 synonyms 在 zip 之前，
 * 会把 zip 的编译产物顺手删掉，表现为 MODULE_NOT_FOUND。
 * 显式把依赖 tsc 产物的脚本排到最前面，不依赖字母序的巧合。
 */
const RUN_FIRST = ['verify-zip.cjs']

let files = fs
  .readdirSync(SCRIPTS)
  .filter((f) => /^verify-.*\.cjs$/.test(f))
  .sort()

files = [...files.filter((f) => RUN_FIRST.includes(f)), ...files.filter((f) => !RUN_FIRST.includes(f))]

if (ONLY) files = files.filter((f) => f.includes(ONLY))

const skipped = files.filter((f) => !INCLUDE_KNOWN && KNOWN_FAIL.has(f))
const target = files.filter((f) => INCLUDE_KNOWN || !KNOWN_FAIL.has(f))

if (LIST_ONLY) {
  console.log('已知历史失败（默认跳过）：')
  for (const f of skipped) console.log('  SKIP  ' + f)
  console.log('\n待跑：')
  for (const f of target) {
    const tag = NEEDS_ELECTRON.has(f) ? ' [electron]' : NEEDS_TSC.has(f) ? ' [tsc]' : ''
    console.log('  RUN   ' + f + tag)
  }
  console.log(`\n共 ${target.length} 个，跳过 ${skipped.length} 个`)
  process.exit(0)
}

/** 找 Electron 可执行文件（Linux/Windows 命名不同） */
function electronBin() {
  const base = path.join(ROOT, 'node_modules', 'electron', 'dist')
  const candidates =
    process.platform === 'win32'
      ? [path.join(base, 'electron.exe')]
      : process.platform === 'darwin'
        ? [path.join(base, 'Electron.app', 'Contents', 'MacOS', 'Electron')]
        : [path.join(base, 'electron')]
  return candidates.find((p) => fs.existsSync(p)) || null
}

function runTscOnce() {
  if (!target.some((f) => NEEDS_TSC.has(f))) return true
  console.log('\n[准备] 编译 tsconfig.verify.json（verify-zip 依赖 .tsc-verify）')
  const tsc = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  const r = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.verify.json'], {
    cwd: ROOT,
    stdio: 'inherit'
  })
  return r.status === 0
}

if (skipped.length) {
  console.log(`跳过 ${skipped.length} 个已知历史失败：${skipped.join(', ')}`)
  console.log('（用 --include-known-fail 可纳入）\n')
}

if (!runTscOnce()) {
  console.error('tsc 编译失败，verify-zip 无法运行')
  process.exit(1)
}

const el = electronBin()
const results = []

for (const f of target) {
  const needsEl = NEEDS_ELECTRON.has(f)
  if (needsEl && !el) {
    console.log(`  SKIP  ${f}  （找不到 Electron 二进制）`)
    results.push({ file: f, ok: false, skipped: true, ms: 0 })
    continue
  }
  const t0 = Date.now()
  // ELECTRON_RUN_AS_NODE 会让 electron 退化成纯 Node（app 变 undefined），必须显式清掉
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const r = needsEl
    ? spawnSync(el, [path.join('scripts', f)], { cwd: ROOT, env, stdio: 'pipe', encoding: 'utf8' })
    : spawnSync(process.execPath, [path.join('scripts', f)], { cwd: ROOT, env, stdio: 'pipe', encoding: 'utf8' })

  const ms = Date.now() - t0
  const ok = r.status === 0
  results.push({ file: f, ok, ms, out: (r.stdout || '') + (r.stderr || '') })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${f}  ${ms}ms`)
  if (!ok) {
    const text = ((r.stdout || '') + (r.stderr || '')).trim().split('\n')
    for (const line of text.slice(-12)) console.log('        ' + line)
  }
}

const failed = results.filter((r) => !r.ok && !r.skipped)
const passed = results.filter((r) => r.ok)

console.log(`\n=== 汇总：${passed.length} 通过 / ${failed.length} 失败 / ${results.filter((r) => r.skipped).length} 跳过 ===`)
if (failed.length) {
  console.log('失败清单：')
  for (const f of failed) console.log('  - ' + f.file)
}
process.exit(failed.length === 0 ? 0 : 1)
