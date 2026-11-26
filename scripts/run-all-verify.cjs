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

/**
 * 必须在 Electron 里跑的脚本（用到 app / BrowserWindow / ipcMain）。
 *
 * 只用 CDP 驱动、自己 spawn 应用的那些 e2e（xterm6 / theme-tw4 / design-tokens /
 * experimental-flags / panel-switch / conn-phase / webgl / highlight-e2e /
 * notify-e2e / split-e2e / trzsz-e2e）**不在此列**：它们不需要 electron 模块，
 * 只用全局 fetch + WebSocket 连 CDP，而本仓是 Electron 33（内置 Node 20），
 * 没有全局 WebSocket（Node 21+ 才有）——用 Electron 跑会直接
 * `ReferenceError: WebSocket is not defined`。交给裸 node（Node 24）跑。 */
const NEEDS_ELECTRON = new Set([
  'verify-ipc-registration.cjs',
  'verify-zmodem-e2e.cjs',
  'verify-zmodem-renderer.cjs',
  // clipboard 模块只在 Electron 里存在，脚本内部会自己重开一次
  'verify-clipboard.cjs',
  // 快捷键冲突的作用域感知（阶段 4）
  'verify-shortcut-scope.cjs',
  // 本地专用（.gitignore 忽略，只在有公司设备环境时存在），但运行器是按目录扫
  // 脚本的 —— 机器上有这个文件就会被收录。它 require('electron') 取 app.whenReady，
  // 用裸 node 跑会直接 `Cannot read properties of undefined (reading 'whenReady')`。
  'verify-xcmd-import.cjs'
])

/**
 * 需要先生成 .tsc-verify 编译产物。
 *
 * 旧名单只有 verify-zip，于是 --only=mdns 这类单跑会直接 MODULE_NOT_FOUND；
 * 名单要从「真的 require 了 .tsc-verify」的脚本里来，不能靠记忆维护。
 */
const NEEDS_TSC = new Set([
  'verify-zip.cjs',
  'verify-diff.cjs',
  'verify-mdns.cjs',
  'verify-metrics.cjs',
  'verify-net.cjs',
  'verify-parse.cjs',
  'verify-proxy.cjs',
  'verify-report.cjs',
  'verify-socks5.cjs'
])

const argv = process.argv.slice(2)
const onlyArg = argv.find((a) => a.startsWith('--only='))
const ONLY = onlyArg ? onlyArg.slice('--only='.length) : null
const LIST_ONLY = argv.includes('--list')
const INCLUDE_KNOWN = argv.includes('--include-known-fail')

/**
 * 必须在最先跑的脚本。
 *
 * verify-synonyms.cjs:154 会 rmSync 整个 .tsc-verify 目录，而所有依赖编译产物的
 * 脚本都 require .tsc-verify 下的文件 —— 按字母序 synonyms 排在多数脚本之前，
 * 跑完就把产物删了，后续表现一律是 MODULE_NOT_FOUND。
 * 名单直接从 NEEDS_TSC 派生：手写清单漏一个就复现一次这个坑。
 */
const RUN_FIRST = [...NEEDS_TSC]

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
    const failLines = text.filter((l) => /\bFAIL\b/.test(l))
    for (const line of failLines.slice(0, 15)) console.log('        [!] ' + line.trim())
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
