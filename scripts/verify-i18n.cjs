/**
 * 中文硬编码基线：让「UI 文案迁移」这件事有刻度，而不是靠感觉。
 *
 * 背景：src/renderer 里原本有约 9000 处中文字符，全部是 JSX 里写死的文案。
 * 一次性搬进词典是不可能的（那是 6 个面板、几十个组件、几千行 diff，
 * 评审时没人看得完）。所以策略是**基座 + 只减不增**：
 *
 *   1. src/renderer/src/i18n/index.ts 提供词表与 useI18n()，
 *      设置面板已全部迁移，切换语言即时生效；
 *   2. 本脚本记录当前还剩多少行含中文的**非注释**行；
 *   3. 基线只允许变小。有人新增中文硬编码时脚本变红 —— 那一刻的替代方案
 *      要么是加词表键，要么是明确知道自己在欠债。
 *
 * 判据的粗糙之处（刻意接受）：按「行内是否含汉字」计数，不做 AST 解析。
 * 它会把「中文出现在正则里」「中文只在字符串模板里拼出来」都算进去 ——
 * 但走向是单调的：只要数字在降，真实硬编码就在降。上 AST 的收益是
 * 首位数之后的精度，成本是一个 parser 依赖。
 *
 * 用法：
 *   node scripts/verify-i18n.cjs            # 与基线比对
 *   node scripts/verify-i18n.cjs --update   # 重新生成基线（迁移完成一块之后）
 */
'use strict'
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const RENDERER = path.join(ROOT, 'src', 'renderer', 'src')
const BASELINE = path.join(__dirname, 'i18n-baseline.json')
const HAN = /[\u4e00-\u9fff]/

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue
      walk(p, out)
    } else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(p)
    }
  }
  return out
}

/** 注释行不算硬编码文案：它不面向用户 */
function isCommentLine(line) {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

const counts = {}
let total = 0
/*
 * 词表本身不参与计数：它是中文的**去处**，不是硬编码。
 * 把它算进来，每新增一个词表键都会让「硬编码」这个数字变大 —— 恰好惩罚了
 * 正确做法。判据的其余部分保持不变：组件里新增的中文照样会被抓。
 */
const DICT_DIR = path.join(RENDERER, 'i18n') + path.sep
for (const file of walk(RENDERER, [])) {
  if (file.startsWith(DICT_DIR)) continue
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  let n = 0
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!HAN.test(line) || isCommentLine(line)) continue
    n++
  }
  if (n > 0) {
    counts[rel] = n
    total += n
  }
}

const top = Object.entries(counts)
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .map(([f, n]) => `    ${String(n).padStart(4)}  ${f}`)
  .join('\n')

const update = process.argv.includes('--update')
if (update || !fs.existsSync(BASELINE)) {
  const snapshot = { generatedAt: new Date().toISOString().slice(0, 10), total, files: counts }
  fs.writeFileSync(BASELINE, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
  console.log(`已写入基线 ${path.relative(ROOT, BASELINE)}：${total} 行含中文`)
  if (top) console.log('中文最多的文件：\n' + top)
  process.exit(0)
}

const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
console.log(`中文硬编码：${total} 行（基线 ${baseline.total} 行，${baseline.generatedAt}）`)
if (top) console.log('中文最多的文件：\n' + top)

if (total > baseline.total) {
  console.error(
    `\n✗ 比基线多了 ${total - baseline.total} 行：新增文案请走 src/renderer/src/i18n/index.ts 的词表；` +
      '确认是合理欠债就 node scripts/verify-i18n.cjs --update，并在 PR 里说明原因。'
  )
  process.exitCode = 1
} else {
  console.log(`\n✓ 未超过基线${total < baseline.total ? `（已减少 ${baseline.total - total} 行，记得 --update）` : ''}`)
}
