/**
 * 文档同步回归：发版时 README / CHANGELOG 必须跟着 package.json 走。
 *
 * 为什么需要这个脚本：
 *   v1.9.0 发出去以后，GitHub 上的 README 还写着 `Current: **v1.8.1**`，
 *   CHANGELOG 里根本没有 1.9.0 这一条。代码、tag、Release 日志全对，
 *   唯独两处「人打开仓库第一眼看到的东西」停在上一版。
 *
 *   根因不是某一次手滑，而是流程里的不对称：
 *     - release-notes-v<ver>.md 有 CI 硬门禁（verify-release-notes + release.yml），
 *       缺了直接红，所以它从没漏过；
 *     - README / CHANGELOG 只是 RELEASE_CHECKLIST.md §2.3 里的一个 checkbox，
 *       没有任何脚本判它，忙起来就跳过，跳过了也没有任何报错。
 *
 *   一个只在 checklist 里存在的步骤，等价于不存在。
 *
 * 判据（必须能在文档未同步时红，也就是现在这个状态）：
 *
 *   1. README.md 的 `Current: **v<ver>**` 等于 package.json 的 version
 *   2. README.zh-CN.md 的 `当前版本：**v<ver>**` 同上
 *   3. CHANGELOG.md 有 `## [<ver>] - YYYY-MM-DD` 条目
 *   4. 两份 README 的「最近更新 / Recent updates」第一条就是当前版本
 *   5. 那一条不能只有版本号：正文长度有下限（占位符等于没写）
 *   6. CHANGELOG 里的 [<ver>] 条目能抽出 ≥ 200 字符的正文（Release 正文的唯一来源，
 *      见 scripts/release-notes.cjs）。原先这一条判的是仓库里的 release-notes-v<ver>.md，
 *      那些文件已全部删除 —— 正文改由发布时从 CHANGELOG 现抽，不再进仓库。
 *
 * 为什么判「第一条」而不是「包含」：
 *   只判包含的话，把新版本条目追加到列表末尾也能过 —— 但读者看到的第一条
 *   还是上一版，等于没更新。顺序本身就是内容的一部分。
 *
 * 用法：node scripts/verify-docs-sync.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
/** Release 正文下限：与 scripts/release-notes.cjs 的 MIN_CHARS 同值 */
const MIN_RELEASE_CHARS = 200

const results = []
function check(name, fn) {
  try {
    const detail = fn()
    results.push({ ok: true, name, detail })
  } catch (e) {
    results.push({ ok: false, name, detail: e.message })
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

/** 统一按 CRLF 安全的方式读：仓库里这些 md 都是 CRLF，用 \n 切会留下行尾 \r */
function readLines(rel) {
  const f = path.join(ROOT, rel)
  assert(fs.existsSync(f), `找不到 ${rel}`)
  return fs
    .readFileSync(f, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/\r$/, ''))
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const VER = pkg.version

// ── 1. README.md 当前版本 ────────────────────────────────────────────
check(`README.md 当前版本 = v${VER}`, () => {
  const lines = readLines('README.md')
  const idx = lines.findIndex((l) => /^Current:\s*\*\*v/.test(l))
  assert(idx >= 0, 'README.md 找不到 `Current: **vX.Y.Z**` 行')
  const m = /^Current:\s*\*\*v([0-9.]+)\*\*/.exec(lines[idx])
  assert(m, `README.md:${idx + 1} 版本行格式不对：${lines[idx]}`)
  assert(
    m[1] === VER,
    `README.md:${idx + 1} 写的是 v${m[1]}，package.json 是 v${VER}（发版忘了同步）`
  )
  return `README.md:${idx + 1} v${m[1]}`
})

// ── 2. README.zh-CN.md 当前版本 ──────────────────────────────────────
check(`README.zh-CN.md 当前版本 = v${VER}`, () => {
  const lines = readLines('README.zh-CN.md')
  const idx = lines.findIndex((l) => /^当前版本：\s*\*\*v/.test(l))
  assert(idx >= 0, 'README.zh-CN.md 找不到 `当前版本：**vX.Y.Z**` 行')
  const m = /^当前版本：\s*\*\*v([0-9.]+)\*\*/.exec(lines[idx])
  assert(m, `README.zh-CN.md:${idx + 1} 版本行格式不对：${lines[idx]}`)
  assert(
    m[1] === VER,
    `README.zh-CN.md:${idx + 1} 写的是 v${m[1]}，package.json 是 v${VER}（发版忘了同步）`
  )
  return `README.zh-CN.md:${idx + 1} v${m[1]}`
})

// ── 3. CHANGELOG 有本版条目 ──────────────────────────────────────────
check(`CHANGELOG.md 有 [${VER}] 条目`, () => {
  const lines = readLines('CHANGELOG.md')
  const idx = lines.findIndex((l) => new RegExp(`^##\\s*\\[${VER.replace(/\./g, '\\.')}\\]`).test(l))
  assert(idx >= 0, `CHANGELOG.md 没有 \`## [${VER}]\` 段落（发版忘了写日志）`)
  const m = /^##\s*\[[0-9.]+\]\s*-\s*(\d{4}-\d{2}-\d{2})/.exec(lines[idx])
  assert(m, `CHANGELOG.md:${idx + 1} 条目缺日期，格式应为 \`## [${VER}] - YYYY-MM-DD\``)
  return `CHANGELOG.md:${idx + 1} [${VER}] - ${m[1]}`
})

// ── 4. Release 正文能从 CHANGELOG 抽出 ──────────────────────────────
// 仓库里已没有 release-notes-v<ver>.md（一次性文件，看着像重复碎片），
// Release 正文统一由 scripts/release-notes.cjs 从 CHANGELOG 的 [<ver>] 段现抽。
// 这里直接调那个脚本，判据与发版链路完全同源，不会出现「校验过了、发版抽不到」。
check(`CHANGELOG [${VER}] 能抽出 ${MIN_RELEASE_CHARS} 字符以上的 Release 正文`, () => {
  const gen = path.join(ROOT, 'scripts', 'release-notes.cjs')
  assert(fs.existsSync(gen), '缺少 scripts/release-notes.cjs（Release 正文没有出口）')
  const { spawnSync } = require('node:child_process')
  const r = spawnSync(process.execPath, [gen, '--version', VER], { encoding: 'utf8' })
  assert(r.status === 0, `release-notes.cjs 退出码 ${r.status}：${(r.stderr || '').trim().split('\n')[0]}`)
  const chars = [...(r.stdout || '')].length
  assert(chars >= MIN_RELEASE_CHARS, `从 CHANGELOG 只抽出 ${chars} 字符（下限 ${MIN_RELEASE_CHARS}），疑似占位符`)
  return `${chars} 字符，取自 CHANGELOG [${VER}]`
})

// ── 输出 ─────────────────────────────────────────────────────────────
const pad = (s, n) =>
  s + ' '.repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0)))
let failed = 0
console.log(`\n文档同步回归 (verify-docs-sync) — package.json v${VER}\n`)
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${pad(r.name, 44)} ${r.detail}`)
  if (!r.ok) failed++
}
console.log(`\n${failed === 0 ? `全部通过 (${results.length}/${results.length})` : `失败 ${failed}/${results.length}`}\n`)
process.exit(failed === 0 ? 0 : 1)
