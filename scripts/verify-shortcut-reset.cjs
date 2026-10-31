/**
 * 快捷键重置能力回归：确认「恢复默认」在 UI 上真的可达。
 *
 * 背景：P2-13 报的是「有冲突检测但缺重置单条，用户改坏了只能手翻文档查默认值」。
 * 核实后该条不成立 —— ShortcutSection 每一行都已带 RotateCcw 按钮
 * （settings/ShortcutSection.tsx:126-133），点击走 commit(action.id, undefined)，
 * 语义就是「删掉自定义值、回落到 SHORTCUT_ACTIONS 里的 default」。
 *
 * 真正缺的是另一件事：冲突提示区（:100-112）只列出「哪个键被谁占了」，
 * 没有「一键把冲突项全部恢复默认」。用户一次改坏三四个键、冲突提示列了四条时，
 * 得逐行去点小图标。这条才是可执行缺口。
 *
 * 判据（按 2.6：修复未落地必须红）：
 *   1. 每行有重置按钮（grep RotateCcw 的使用点在行渲染里）
 *   2. 重置走的是 commit(action.id, undefined)（删 key，不是写死字符串）
 *   3. 冲突提示区提供批量恢复（resetConflicts 之类的动作）
 *   4. 批量恢复只重置「涉及冲突的动作」，不误伤用户其它自定义键
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const FILE = path.join(ROOT, 'src/renderer/src/components/settings/ShortcutSection.tsx')
const LIB = path.join(ROOT, 'src/renderer/src/lib/shortcutConflict.ts')

let failed = 0
function check(name, cond, extra) {
  if (cond) console.log('  PASS  ' + name + (extra ? '  —  ' + extra : ''))
  else {
    console.log('  FAIL  ' + name + (extra ? '  —  ' + extra : ''))
    failed++
  }
}

const src = fs.readFileSync(FILE, 'utf8').replace(/\r\n/g, '\n')
const lib = fs.readFileSync(LIB, 'utf8').replace(/\r\n/g, '\n')

console.log('\n=== 断言 ===')
check(
  '每一行都有单条重置按钮（RotateCcw 在行渲染里被使用）',
  /<RotateCcw\b/.test(src) && /title=\{`恢复默认：\$\{action\.default\}`\}/.test(src),
  'ShortcutSection.tsx'
)
check(
  '单条重置走 commit(action.id, undefined)：删自定义值回落默认，而不是写死字符串',
  /onClick=\{\(\) => commit\(action\.id, undefined\)\}/.test(src),
  'commit(action.id, undefined)'
)
check(
  '重置按钮只对已自定义的项显示（用默认值时不显示冗余按钮）',
  /\{!isDefault && \(/.test(src),
  'isDefault 门控'
)
check(
  '冲突提示区提供「一键恢复冲突项」的入口',
  /resetConflicts/.test(src),
  /resetConflicts/.test(src) ? '已提供' : '缺失（本条修复前应为红）'
)
check(
  '批量恢复按 ConflictInfo.actions[].id 精确取集合，不误伤其它自定义键',
  // 用字面字符串而不是正则：正则里 ( ) . 都有语义，
  // `/for (const a of c.actions) ids.add(a.id)/` 会被解析成捕获组 + 通配符，
  // 永远匹配不到源码里的字面括号 —— 这类「判据自己写错」正是 2.6 要防的假绿。
  src.includes('ids.add(a.id)') && src.includes('for (const a of c.actions)'),
  '按冲突集合重置'
)
check(
  '冲突检测暴露了涉及的动作 id（供批量恢复定位）',
  /interface ConflictInfo/.test(lib) && /actions:\s*Array<\{[^}]*id:\s*string/.test(lib),
  'shortcutConflict.ts ConflictInfo.actions[].id'
)

console.log(`\n结果：${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
