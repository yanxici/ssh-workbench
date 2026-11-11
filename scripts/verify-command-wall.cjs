/**
 * 命令墙几何自检：wallColumns / wallCardWidth / wallStep / wrapIndex / accentTone。
 * 用法：node scripts/verify-command-wall.cjs
 *
 * 断言的判据是「修复没落地时会红」：
 *   - 列数：旧实现的期望值是恒等于 3，任何宽度都返回 3；断 340→3 / 400→4 / 520→5
 *     在旧实现下必然红。
 *   - 步长：旧实现 ArrowDown 恒返回 3；这里断言 400 宽（4 列）时返回 4。
 *   - 卡片宽：旧实现是 (width-16-8)/3；这里断言 400 返回 87，旧值 125，必红。
 */
const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const out = path.join(ROOT, '.tsc-verify', 'command-wall.cjs')
fs.mkdirSync(path.dirname(out), { recursive: true })
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'src/renderer/src/lib/commandWall.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error'
})
const {
  wallColumns,
  wallCardWidth,
  wallStep,
  wrapIndex,
  accentTone,
  accentClass,
  WALL_COLS_FALLBACK
} = require(out)

let pass = 0
let fail = 0
function ok(name, cond, extra) {
  if (cond) pass++
  else {
    fail++
    console.log(`  ✗ ${name}${extra ? `\n    ${extra}` : ''}`)
  }
}
function eq(name, got, want) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  ok(name, g === w, `得到 ${g}\n    期望 ${w}`)
}

/* ---------------------------------------------------------------- *
 *  列数：宽度驱动
 * ---------------------------------------------------------------- */
eq('首帧宽度 0 回退 4 列', wallColumns(0), 4)
eq('宽度 NaN 回退 4 列', wallColumns(NaN), 4)
eq('下限 340 → 3 列', wallColumns(340), 3)
eq('359 → 3 列', wallColumns(359), 3)
eq('360 → 4 列', wallColumns(360), 4)
eq('默认 400 → 4 列', wallColumns(400), 4)
eq('479 → 4 列', wallColumns(479), 4)
eq('480 → 5 列', wallColumns(480), 5)
eq('上限 600 → 5 列', wallColumns(600), 5)

// 单调性：宽度变大，列数不能变小（否则拖宽反而更挤）
let monotonic = true
let prev = wallColumns(340)
for (let w = 340; w <= 600; w += 10) {
  const cur = wallColumns(w)
  if (cur < prev) monotonic = false
  prev = cur
}
ok('列数随宽度单调不减', monotonic)

/* ---------------------------------------------------------------- *
 *  卡片宽度
 * ---------------------------------------------------------------- */
const w400 = wallCardWidth(400, wallColumns(400))
// 400 - 内边距 12 - 三处 gap 12 = 376 / 4 = 94
ok('400 / 4 列每卡 94px', Math.round(w400) === 94, `得到 ${w400.toFixed(1)}`)
// 旧实现 (400-16-8)/3 = 125，这个断言在旧实现下必红
ok('400 宽不会是旧的三列算法 125px', Math.round(w400) !== 125)
const w340 = wallCardWidth(340, wallColumns(340))
// 340 - 内边距 12 - 两处 gap 8 = 320 / 3 = 106.7
ok('340 / 3 列每卡 ≈107px', Math.round(w340) === 107, `得到 ${w340.toFixed(1)}`)
ok('cardWidth 非法列数回退 4 列', Math.round(wallCardWidth(400, 0)) === Math.round(wallCardWidth(400, WALL_COLS_FALLBACK)))
ok('cardWidth 极小宽度不为负', wallCardWidth(10, 5) >= 0)

/* ---------------------------------------------------------------- *
 *  键盘步长
 * ---------------------------------------------------------------- */
eq('4 列时 ↓ 步长 4', wallStep('ArrowDown', 4), 4)
eq('4 列时 ↑ 步长 -4', wallStep('ArrowUp', 4), -4)
eq('3 列时 ↓ 步长 3', wallStep('ArrowDown', 3), 3)
eq('5 列时 ↓ 步长 5', wallStep('ArrowDown', 5), 5)
// 旧实现恒为 3，这里在 4 列下断言 4 —— 旧实现必红
ok('↓ 步长不等于写死的 3（当列数=4）', wallStep('ArrowDown', 4) !== 3)
eq('→ 恒为 +1', wallStep('ArrowRight', 4), 1)
eq('← 恒为 -1', wallStep('ArrowLeft', 4), -1)
eq('无关键返回 0', wallStep('Enter', 4), 0)

/* ---------------------------------------------------------------- *
 *  环形光标
 * ---------------------------------------------------------------- */
eq('末格 ↓ 回绕到头部', wrapIndex(3, 4, 5), 2)
eq('头部 ↑ 回绕到尾部', wrapIndex(1, -4, 5), 2)
eq('空列表返回 0', wrapIndex(3, 1, 0), 0)
eq('单元素列表保持 0', wrapIndex(0, 5, 1), 0)
ok('任意输入都落在 [0, length)', (() => {
  for (let i = -20; i < 20; i++) {
    const v = wrapIndex(i, i * 3, 7)
    if (v < 0 || v >= 7) return false
  }
  return true
})())

/* ---------------------------------------------------------------- *
 *  色条状态优先级
 * ---------------------------------------------------------------- */
const base = { confirmRequired: false, variables: [] }
eq('普通命令 → none', accentTone(base, false), 'none')
eq('仅收藏 → pinned', accentTone(base, true), 'pinned')
eq('仅有变量 → vars', accentTone({ confirmRequired: false, variables: ['ip'] }, false), 'vars')
eq('需确认 + 收藏 → confirm（安全优先）', accentTone({ confirmRequired: true, variables: [] }, true), 'confirm')
eq('需确认 + 变量 → confirm', accentTone({ confirmRequired: true, variables: ['ip'] }, false), 'confirm')
eq('收藏 + 变量 → pinned', accentTone({ confirmRequired: false, variables: ['ip'] }, true), 'pinned')
eq('variables 缺失时按无变量处理', accentTone({ confirmRequired: false }, false), 'none')

// 四种色调必须有四个不同的类名 —— 相同就说明优先级写重了，视觉上无法区分
const classes = ['none', 'vars', 'pinned', 'confirm'].map((t) => accentClass(t))
ok('四种色调类名互不相同', new Set(classes).size === 4, classes.join(' / '))
ok('未知色调回退到 none 类', accentClass('???') === accentClass('none'))

console.log(`\n命令墙几何自检：${pass} 通过，${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
