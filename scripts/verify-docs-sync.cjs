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
 *   6. release-notes-v<ver>.md 存在（发版日志，与 verify-release-notes 口径一致）
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
/** 单条更新的正文长度下限：只写「- **v1.9.0**」这种占位符要判红 */
const MIN_ENTRY_CHARS = 60

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

// ── 4/5. 两份 README 的「最近更新」第一条就是本版，且不是占位符 ──────
function assertFirstEntry(rel, anchorRe) {
  const lines = readLines(rel)
  const start = lines.findIndex((l) => anchorRe.test(l))
  assert(start >= 0, `${rel} 找不到「最近更新」锚点行`)
  // 锚点后第一个以 "- " 开头的列表项
  let i = start + 1
  while (i < lines.length && !/^-\s/.test(lines[i])) {
    // 遇到下一个二级标题说明列表根本没开始
    assert(!/^##\s/.test(lines[i]), `${rel}:${start + 1} 的「最近更新」下面没有任何条目`)
    i++
  }
  assert(i < lines.length, `${rel}:${start + 1} 的「最近更新」下面没有任何条目`)
  const first = lines[i]
  assert(
    first.includes(`v${VER}`),
    `${rel}:${i + 1} 最近更新第一条不是 v${VER}，实际是：${first.slice(0, 60)}`
  )
  assert(
    first.length >= MIN_ENTRY_CHARS,
    `${rel}:${i + 1} 本版条目只有 ${first.length} 字符（下限 ${MIN_ENTRY_CHARS}），疑似占位符`
  )
  return `${rel}:${i + 1} 首条 v${VER}，${first.length} 字符`
}

check(`README.md 最近更新首条 = v${VER} 且有正文`, () =>
  assertFirstEntry('README.md', /^Recent updates:\s*$/)
)
check(`README.zh-CN.md 最近更新首条 = v${VER} 且有正文`, () =>
  assertFirstEntry('README.zh-CN.md', /^最近更新：\s*$/)
)

// ── 6. 发版日志文件存在 ──────────────────────────────────────────────
check(`release-notes-v${VER}.md 存在`, () => {
  const rel = `release-notes-v${VER}.md`
  assert(fs.existsSync(path.join(ROOT, rel)), `缺少 ${rel}（发版日志没有出口）`)
  const chars = fs.readFileSync(path.join(ROOT, rel), 'utf8').length
  assert(chars >= 200, `${rel} 只有 ${chars} 字符，疑似占位符`)
  return `${rel} ${chars} 字符`
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
