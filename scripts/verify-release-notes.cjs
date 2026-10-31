/**
 * 发布日志回归：确认发版链路不会发出「没有更新说明」的 Release。
 *
 * 为什么需要这个脚本：
 *   用户明确要求过「下次发版的时候 release 里别忘写日志了」。历史根因不是
 *   某一次手滑忘了写，而是 CI 里写死了一行占位符：
 *
 *       gh release create $tag ... --notes "Release $tag"
 *
 *   tag 一推，CI 自动建 Release，正文就是 `Release v1.8.0` 这一行。完整日志
 *   从来没有出口 —— 改多少次文档都没用，因为发版走的是工作流，不是文档。
 *
 * 判据（按 2.6 的规矩，必须能在修复未落地时红）：
 *
 *   1. `.github/workflows/release.yml` 的发布步骤里
 *      **不得再出现** `--notes "Release $tag"` 这类占位符写法
 *   2. 创建/更新 Release 时必须走 `--notes-file`，指向 `release-notes-<tag>.md`
 *   3. 工作流必须对日志文件缺失、或文件过短（占位符）显式失败
 *   4. 仓库里当前 package.json 版本必须有对应的 `release-notes-v<ver>.md`，
 *      且长度不低于阈值 —— 防止「工作流改好了，但这一版压根没写日志文件」
 *
 * 为什么第 4 条不能只判文件存在：
 *   存在一个只写了一行标题的文件，和没有文件在结果上是等价的 —— 用户打开
 *   Release 页面依然什么都看不到。所以判长度，不判存在性。
 *
 * 为什么第 1 条要判「不得出现」而不是「必须出现 --notes-file」：
 *   两处都留着才最危险：`--notes` 和 `--notes-file` 同时给时行为取决于 gh 版本，
 *   而且人读代码时看到 --notes 会以为日志就是那行。必须把它从文件里清掉。
 *
 * 用法：node scripts/verify-release-notes.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const WORKFLOW = path.join(ROOT, '.github', 'workflows', 'release.yml')
const MIN_NOTES_CHARS = 200

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

// ── 1. 工作流存在且可读 ────────────────────────────────────────────────
let yml = ''
check('工作流文件存在', () => {
  assert(fs.existsSync(WORKFLOW), `找不到 ${WORKFLOW}`)
  yml = fs.readFileSync(WORKFLOW, 'utf8')
  return `${WORKFLOW} ${yml.length} 字符`
})

// ── 2. 占位符写法必须已被清除（本条在修复未落地时必红）──────────────
check('不含 --notes "Release $tag" 占位符', () => {
  // 允许出现在注释里（解释历史根因），只禁真正的命令行参数。
  // 判据：行内出现 --notes 且后面不是 --notes-file。
  const offenders = []
  // 必须按 /\r?\n/ 切、并去掉行尾 \r：
  // 本仓库工作流是 CRLF，`#.*$` 里的 `.` 不匹配 \r，`$`（无 m 标志）又要求
  // 字符串结尾 —— 行尾那个 \r 让整条正则静默不匹配，注释剥不掉，
  // 于是「解释历史根因的注释」被当成违规代码判红。这和本轮 IME 批量替换
  // 踩的是同一个 CRLF 坑：判据在 LF 下成立，在 CRLF 下静默失效。
  yml.split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.replace(/\r$/, '')
    const code = line.replace(/#.*$/, '') // 去掉行尾注释再判
    if (/--notes\s+\S/.test(code) && !/--notes-file/.test(code)) {
      offenders.push(`release.yml:${i + 1} → ${line.trim()}`)
    }
  })
  assert(
    offenders.length === 0,
    `发布步骤仍用 --notes 直接写正文（日志会退化成一行占位符）：\n    ${offenders.join('\n    ')}`
  )
  return '无 --notes 占位符写法'
})

// ── 3. 必须走 --notes-file ────────────────────────────────────────────
check('创建 Release 时使用 --notes-file', () => {
  const creates = yml.split('\n').filter((l) => /gh release create/.test(l.replace(/#.*$/, '')))
  assert(creates.length > 0, '工作流里找不到 gh release create')
  const bad = creates.filter((l) => !/--notes-file/.test(l))
  assert(bad.length === 0, `gh release create 缺 --notes-file：\n    ${bad.join('\n    ')}`)
  return `${creates.length} 处 gh release create 全部带 --notes-file`
})

// ── 4. 已存在的 Release 也要补写日志 ──────────────────────────────────
check('Release 已存在时按占位符判定补写', () => {
  assert(/gh release edit/.test(yml), '没有 gh release edit：人工先建 Release 时日志无法补写')
  assert(
    /--notes-file/.test(yml.split('gh release edit')[1] || ''),
    'gh release edit 没有跟 --notes-file，补写时拿不到日志文件'
  )
  return '存在 gh release edit --notes-file 分支'
})

// ── 5. 日志缺失/过短必须显式失败 ──────────────────────────────────────
check('日志文件缺失或过短时工作流显式失败', () => {
  const hasMissingGuard = /Test-Path\s+\$notesFile/.test(yml) && /exit 1/.test(yml)
  assert(hasMissingGuard, '工作流没有对「日志文件不存在」显式 exit 1')
  assert(
    /-lt\s+\$?notesLen|notesLen.*-lt|MIN_NOTES/i.test(yml),
    '工作流没有对「日志文件过短（占位符）」做长度下限判定'
  )
  return '有 Test-Path 缺失判定 + 长度下限判定'
})

// ── 6. 当前版本必须有真实日志文件 ─────────────────────────────────────
check(`当前版本有 release-notes-v<ver>.md 且 ≥ ${MIN_NOTES_CHARS} 字符`, () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  const ver = pkg.version
  const f = path.join(ROOT, `release-notes-v${ver}.md`)
  assert(fs.existsSync(f), `v${ver} 没有发布日志文件 release-notes-v${ver}.md`)
  const text = fs.readFileSync(f, 'utf8')
  const chars = text.length
  assert(
    chars >= MIN_NOTES_CHARS,
    `release-notes-v${ver}.md 只有 ${chars} 字符（下限 ${MIN_NOTES_CHARS}），疑似占位符`
  )
  // 光有长度还不够：得确认它真的在讲这一版，而不是别的版本的旧文件改名
  const head = text.split('\n').slice(0, 3).join('\n')
  assert(head.includes(ver), `release-notes-v${ver}.md 开头没有版本号 ${ver}：${head.slice(0, 80)}`)
  return `release-notes-v${ver}.md ${chars} 字符，开头含版本号`
})

// ── 7. 历史版本日志完整性（只提示，不失败）────────────────────────────
const historical = (() => {
  const tags = []
  for (const f of fs.readdirSync(ROOT)) {
    const m = /^release-notes-v([0-9.]+)\.md$/.exec(f)
    if (m) tags.push(m[1])
  }
  return tags.sort()
})()

// ── 输出 ─────────────────────────────────────────────────────────────
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - [...s].reduce((a, c) => a + (c.charCodeAt(0) > 127 ? 2 : 1), 0)))
let failed = 0
console.log('\n发布日志回归 (verify-release-notes)\n')
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${pad(r.name, 46)} ${r.detail}`)
  if (!r.ok) failed++
}
console.log(`\n  仓库内历史日志版本：${historical.length ? historical.join(', ') : '(无)'}`)
console.log(`\n${failed === 0 ? `全部通过 (${results.length}/${results.length})` : `失败 ${failed}/${results.length}`}\n`)
process.exit(failed === 0 ? 0 : 1)
