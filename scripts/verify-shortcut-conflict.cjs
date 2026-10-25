/**
 * 快捷键冲突检测自检：detectShortcutConflicts / checkSingleConflict
 * （src/renderer/src/lib/shortcutConflict.ts）
 * 重点防御：
 *   1. 默认键位本身不能互相冲突
 *   2. 大小写 / 修饰键顺序 / control·option 别名必须归一化后再比较
 *   3. checkSingleConflict 编辑自身时不能把自己报成冲突
 *   4. 自定义成与别人相同的键位必须被发现
 * 用法：node scripts/verify-shortcut-conflict.cjs
 */
const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const out = path.join(ROOT, '.tsc-verify', 'shortcut-conflict.cjs')
fs.mkdirSync(path.dirname(out), { recursive: true })
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'src/renderer/src/lib/shortcutConflict.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error',
  alias: { '@shared': path.join(ROOT, 'src/shared') }
})
const { detectShortcutConflicts, checkSingleConflict } = require(out)

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) pass++
  else {
    fail++
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`)
  }
}
const ids = (list) => list.map((a) => a.id).sort()

/* ---------- 1. 默认键位无冲突 ---------- */
ok('默认键位无冲突（undefined）', detectShortcutConflicts(undefined).length === 0)
ok('默认键位无冲突（空对象）', detectShortcutConflicts({}).length === 0)

/* ---------- 2. 自定义冲突被发现 ---------- */
{
  const c = detectShortcutConflicts({ settings: 'Ctrl+K' })
  ok('settings 改成 Ctrl+K 与命令中心冲突', c.length === 1, JSON.stringify(c))
  ok('冲突组合键归一化为 Ctrl+K', c[0] && c[0].combo === 'Ctrl+K', c[0] && c[0].combo)
  ok(
    '冲突涉及 commandCenter 与 settings',
    c[0] && JSON.stringify(ids(c[0].actions)) === JSON.stringify(['commandCenter', 'settings'])
  )
}
{
  const c = detectShortcutConflicts({ settings: 'Ctrl+K', newConnection: 'Ctrl+K' })
  ok('三个动作抢同一键只算一组冲突', c.length === 1)
  ok('该组包含三个动作', c[0] && c[0].actions.length === 3)
}
{
  const c = detectShortcutConflicts({ settings: 'Ctrl+K', closeTab: 'Ctrl+B' })
  ok('两组独立冲突分别报出', c.length === 2, JSON.stringify(c.map((x) => x.combo)))
}

/* ---------- 3. 归一化 ---------- */
ok('小写 ctrl+k 视为冲突', detectShortcutConflicts({ settings: 'ctrl+k' }).length === 1)
ok('control 别名视为冲突', detectShortcutConflicts({ settings: 'Control+K' }).length === 1)
ok(
  '修饰键顺序不同视为同一键（Alt+Ctrl+B = Ctrl+Alt+B）',
  detectShortcutConflicts({ settings: 'Alt+Ctrl+B' }).length === 1
)
ok(
  'option 别名等同 Alt',
  detectShortcutConflicts({ settings: 'Ctrl+Option+B' }).length === 1
)
ok('多了 Shift 不算冲突', detectShortcutConflicts({ settings: 'Ctrl+Shift+K' }).length === 0)
ok('少了 Alt 但撞上 Ctrl+B 算冲突', detectShortcutConflicts({ toggleCommandRail: 'Ctrl+B' }).length === 1)

/* ---------- 4. checkSingleConflict ---------- */
ok('录制自身当前键不报冲突', checkSingleConflict('Ctrl+K', 'commandCenter', undefined) === null)
{
  const hit = checkSingleConflict('Ctrl+K', 'settings', undefined)
  ok('录制别人的键报出对方', hit && hit.id === 'commandCenter', JSON.stringify(hit))
}
ok('未占用的键无冲突', checkSingleConflict('Ctrl+Alt+J', 'settings', undefined) === null)
ok('无法解析的组合返回 null', checkSingleConflict('Ctrl+', 'settings', undefined) === null)
{
  // 对方已改走 Ctrl+K，原默认键 Ctrl+, 应当空出来
  const map = { settings: 'Ctrl+Alt+S' }
  ok('对方改键后其原默认键空出', checkSingleConflict('Ctrl+,', 'newConnection', map) === null)
  const hit = checkSingleConflict('ctrl+alt+s', 'newConnection', map)
  ok('对方新键被识别（大小写不敏感）', hit && hit.id === 'settings', JSON.stringify(hit))
}

/* ---------- 5. 随机压测：结果自洽 ---------- */
const KEYS = ['K', 'N', 'B', ',', 'F', 'W', 'Tab']
const MODS = ['Ctrl', 'Ctrl+Shift', 'Ctrl+Alt', 'Alt']
const ACTIONS = [
  'commandCenter',
  'newConnection',
  'settings',
  'togglePanel',
  'toggleCommandRail',
  'nextTab',
  'closeTab',
  'terminalSearch',
  'terminalCopy',
  'terminalPaste'
]
let rndFail = 0
for (let i = 0; i < 2000; i++) {
  const map = {}
  for (const a of ACTIONS) {
    if (Math.random() < 0.4) {
      map[a] = `${MODS[Math.floor(Math.random() * MODS.length)]}+${KEYS[Math.floor(Math.random() * KEYS.length)]}`
    }
  }
  const conflicts = detectShortcutConflicts(map)
  const inConflict = new Set(conflicts.flatMap((c) => c.actions.map((a) => a.id)))
  for (const a of ACTIONS) {
    const combo = map[a]
    if (!combo) continue
    const hit = checkSingleConflict(combo, a, map)
    // 两个函数必须给出一致结论：单项检测有冲突 <=> 全量检测里出现过该动作
    if (Boolean(hit) !== inConflict.has(a)) rndFail++
  }
}
ok('随机 2000 轮：单项检测与全量检测结论一致', rndFail === 0, `不一致 ${rndFail} 次`)

console.log(`\n快捷键冲突检测自检：通过 ${pass}  失败 ${fail}`)
process.exit(fail ? 1 : 0)
