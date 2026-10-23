/**
 * 栏尺寸自检：clampPane / resolveLayout / applyDrag / nudgePane / isDefaultPane
 * 用法：node scripts/verify-layout.cjs
 *
 * 外壳现在有两个可拖区域：左侧边栏（sign=1，向右拖变宽）与右侧常驻命令栏
 * （sign=-1，向左拖变宽）。两条链路的边界数值都要守住 —— 它是持久化数据
 * 被手改坏时的最后一道防线；同时 sign 弄反是这套代码最容易犯的错，
 * 所以左右两侧都要各测一遍「拖出去到底是变宽还是变窄」。
 */
const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const out = path.join(ROOT, '.tsc-verify', 'layout.cjs')
fs.mkdirSync(path.dirname(out), { recursive: true })
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'src/renderer/src/lib/layout.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error'
})
const {
  PANE_SPECS,
  DEFAULT_LAYOUT,
  KEYS,
  PANE_LABEL,
  clampPane,
  resolveLayout,
  applyDrag,
  nudgePane,
  isDefaultPane
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

/* ---------- 规格表自身 ---------- */
eq('两个可拖区域', KEYS, ['sidebar', 'commandRail'])
eq('区域有中文名', PANE_LABEL, { sidebar: '侧边栏', commandRail: '命令栏' })
eq('默认尺寸快照', DEFAULT_LAYOUT, { sidebar: 280, commandRail: 380 })
eq(
  '侧栏三键：default 280 / min 220 / max 520',
  [PANE_SPECS.sidebar.default, PANE_SPECS.sidebar.min, PANE_SPECS.sidebar.max],
  [280, 220, 520]
)
eq(
  '命令栏三键：default 380 / min 340 / max 600',
  [PANE_SPECS.commandRail.default, PANE_SPECS.commandRail.min, PANE_SPECS.commandRail.max],
  [380, 340, 600]
)
// 命令栏下限不是随手写的：三列卡片每列要放得下「图标 20 + 间隔 6 + 内边距 16」
// 再给中文名留 4~5 个字，低于 340 全是省略号。
ok('命令栏下限不低于 340（三列放得下）', PANE_SPECS.commandRail.min >= 340)
ok('命令栏上限不超过 600（再宽不如收起）', PANE_SPECS.commandRail.max <= 600)
for (const key of KEYS) {
  const sp = PANE_SPECS[key]
  ok(`${key}: default 落在 [min, max] 内`, sp.min <= sp.default && sp.default <= sp.max)
  ok(`${key}: min < max`, sp.min < sp.max)
  eq(`${key}: 横向拖拽轴`, sp.axis, 'x')
}
eq('侧栏在左，向右拖变宽', PANE_SPECS.sidebar.sign, 1)
eq('命令栏在右，向左拖变宽', PANE_SPECS.commandRail.sign, -1)

/* ---------- clampPane ---------- */
for (const key of KEYS) {
  const sp = PANE_SPECS[key]
  eq(`${key}: 合法值取整`, clampPane(key, sp.default + 20.4), sp.default + 20)
  eq(`${key}: 低于下限取下限`, clampPane(key, 10), sp.min)
  eq(`${key}: 高于上限取上限`, clampPane(key, 9999), sp.max)
  eq(
    `${key}: 恰好等于上下限`,
    [clampPane(key, sp.min), clampPane(key, sp.max)],
    [sp.min, sp.max]
  )
  eq(`${key}: undefined 回退默认`, clampPane(key, undefined), sp.default)
  eq(`${key}: null 回退默认`, clampPane(key, null), sp.default)
  eq(`${key}: NaN 回退默认`, clampPane(key, NaN), sp.default)
  eq(`${key}: Infinity 回退默认`, clampPane(key, Infinity), sp.default)
  eq(`${key}: -Infinity 回退默认`, clampPane(key, -Infinity), sp.default)
  eq(`${key}: 空字符串回退默认`, clampPane(key, ''), sp.default)
  eq(`${key}: 布尔值回退默认`, clampPane(key, true), sp.default)
}

/* ---------- resolveLayout ---------- */
eq('空配置全默认', resolveLayout(undefined), DEFAULT_LAYOUT)
eq('只给 sidebar 时另一栏取默认', resolveLayout({ sidebar: 320 }), {
  sidebar: 320,
  commandRail: 380
})
eq('只给 commandRail 时另一栏取默认', resolveLayout({ commandRail: 500 }), {
  sidebar: 280,
  commandRail: 500
})
eq('两栏都越界时各自夹回', resolveLayout({ sidebar: -5, commandRail: 9999 }), {
  sidebar: 220,
  commandRail: 600
})
eq(
  '老配置里的多余键被忽略（升级兼容）',
  resolveLayout({ sidebar: 300, fileTree: 999, commandPanel: 999, commandPanelHeight: 999 }),
  { sidebar: 300, commandRail: 380 }
)
eq('老配置只留 fileTree 时全取默认', resolveLayout({ fileTree: 400 }), DEFAULT_LAYOUT)

/* ---------- applyDrag：符号决定拖动方向 ---------- */
eq('侧栏向右拖变宽', applyDrag('sidebar', 280, 60), 340)
eq('侧栏向左拖变窄', applyDrag('sidebar', 280, -60), 220)
eq('侧栏拖过头夹到下限', applyDrag('sidebar', 280, -999), 220)
eq('侧栏拖过头夹到上限', applyDrag('sidebar', 280, 999), 520)
eq('侧栏位移为 0 不变', applyDrag('sidebar', 300, 0), 300)
eq('侧栏小数位移取整', applyDrag('sidebar', 280, 30.6), 311)
eq('命令栏向左拖变宽', applyDrag('commandRail', 380, -60), 440)
eq('命令栏向右拖变窄并夹到下限', applyDrag('commandRail', 380, 60), 340)
eq('命令栏拖过头夹到下限', applyDrag('commandRail', 380, 999), 340)
eq('命令栏拖过头夹到上限', applyDrag('commandRail', 380, -999), 600)
eq('命令栏位移为 0 不变', applyDrag('commandRail', 420, 0), 420)
eq('命令栏小数位移取整', applyDrag('commandRail', 380, -30.6), 411)

/* ---------- nudgePane：键盘步进，方向语义同鼠标 ---------- */
eq('侧栏方向键右 = 变宽', nudgePane('sidebar', 280, 1), 296)
eq('侧栏方向键左 = 变窄', nudgePane('sidebar', 280, -1), 264)
eq('侧栏自定义步长', nudgePane('sidebar', 280, 1, 40), 320)
eq('侧栏步进仍受下限约束', nudgePane('sidebar', 220, -1), 220)
eq('侧栏步进受上限约束', nudgePane('sidebar', 520, 1), 520)
// 命令栏在右边：分隔条往左挪（direction=-1 表示向左）才是变宽
eq('命令栏方向键左 = 变宽', nudgePane('commandRail', 380, -1), 396)
eq('命令栏方向键右 = 变窄', nudgePane('commandRail', 380, 1), 364)
eq('命令栏自定义步长', nudgePane('commandRail', 380, -1, 40), 420)
eq('命令栏步进受下限约束', nudgePane('commandRail', 340, 1), 340)
eq('命令栏步进受上限约束', nudgePane('commandRail', 600, -1), 600)

/* ---------- isDefaultPane ---------- */
ok('侧栏默认值算默认', isDefaultPane('sidebar', 280))
ok('侧栏改过就不算默认', !isDefaultPane('sidebar', 281))
ok('命令栏默认值算默认', isDefaultPane('commandRail', 380))
ok('命令栏改过就不算默认', !isDefaultPane('commandRail', 379))
// 一栏的默认值不能误判到另一栏身上（曾经 side/rail 共用常量的写法埋过这个坑）
ok('把 280 用在命令栏上不算默认', !isDefaultPane('commandRail', 280))
ok('把 380 用在侧栏上不算默认', !isDefaultPane('sidebar', 380))

/* ---------- 往返一致性：拖动后写入再读出不变 ---------- */
let layout = resolveLayout(undefined)
layout = { ...layout, sidebar: applyDrag('sidebar', layout.sidebar, 33.7) }
eq('侧栏拖动结果可往返', resolveLayout(layout), layout)
layout = { ...layout, commandRail: applyDrag('commandRail', layout.commandRail, -41.2) }
eq('命令栏拖动结果可往返', resolveLayout(layout), layout)
const roundTrip = { ...layout, sidebar: nudgePane('sidebar', layout.sidebar, -1, 24) }
eq('键盘调整结果可往返', resolveLayout(roundTrip), roundTrip)

/* ---------- 随机压测：任何拖动序列后尺寸始终在范围内 ---------- */
let broken = 0
let curSide = 280
let curRail = 380
for (let i = 0; i < 20000; i++) {
  curSide =
    i % 2 === 0
      ? applyDrag('sidebar', curSide, (Math.random() - 0.5) * 600)
      : nudgePane('sidebar', curSide, Math.random() < 0.5 ? -1 : 1, Math.random() * 40)
  curRail =
    i % 2 === 0
      ? applyDrag('commandRail', curRail, (Math.random() - 0.5) * 600)
      : nudgePane('commandRail', curRail, Math.random() < 0.5 ? -1 : 1, Math.random() * 40)
  const ss = PANE_SPECS.sidebar
  const rs = PANE_SPECS.commandRail
  if (!Number.isFinite(curSide) || curSide < ss.min || curSide > ss.max) broken++
  if (!Number.isFinite(curRail) || curRail < rs.min || curRail > rs.max) broken++
}
eq('20000 次随机拖动侧栏始终在 [220, 520] 且命令栏在 [340, 600]', broken, 0)

/* ---------- 两栏合计不能挤死终端 ---------- */
ok(
  '两栏都用默认值时主区仍有足够宽度（1280 窗口）',
  1280 - 48 - DEFAULT_LAYOUT.sidebar - DEFAULT_LAYOUT.commandRail >= 560
)
ok(
  '两栏都取上限时主区仍为正（1280 窗口）',
  1280 - PANE_SPECS.sidebar.max - PANE_SPECS.commandRail.max - 48 > 0
)

fs.rmSync(out, { force: true })
console.log(`通过 ${pass}  失败 ${fail}`)
process.exit(fail ? 1 : 0)
