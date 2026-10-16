/**
 * 分组排序逻辑自检：sortGroupNames / moveItem / placeRelative（src/renderer/src/lib/groupOrder.ts）
 * 含随机压测：任意次移动后分组集合不丢不重。
 * 用法：node scripts/verify-group-order.cjs
 */
const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const out = path.join(ROOT, '.tsc-verify', 'group-order.cjs')
fs.mkdirSync(path.dirname(out), { recursive: true })
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'src/renderer/src/lib/groupOrder.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error'
})
const { sortGroupNames, moveItem, placeRelative } = require(out)

let pass = 0
let fail = 0
function eq(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else {
    fail++
    console.log(`  ✗ ${name}\n    得到 ${JSON.stringify(got)}\n    期望 ${JSON.stringify(want)}`)
  }
}

// sortGroupNames
eq('无自定义顺序按名称', sortGroupNames(['b', 'a', 'c'], []), ['a', 'b', 'c'])
eq('按自定义顺序', sortGroupNames(['a', 'b', 'c'], ['c', 'a', 'b']), ['c', 'a', 'b'])
eq('未排序的排在后面并按名称', sortGroupNames(['新B', 'x', '新A', 'y'], ['y', 'x']), ['y', 'x', '新A', '新B'])
eq('顺序里有已删除分组不影响', sortGroupNames(['a', 'b'], ['gone', 'b', 'a']), ['b', 'a'])
eq('中文名称排序', sortGroupNames(['网络', '基础'], []), ['基础', '网络'])

// moveItem
eq('上移', moveItem(['a', 'b', 'c'], 1, 0), ['b', 'a', 'c'])
eq('下移', moveItem(['a', 'b', 'c'], 1, 2), ['a', 'c', 'b'])
eq('移到最后', moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a'])
eq('越界收拢', moveItem(['a', 'b', 'c'], 0, 99), ['b', 'c', 'a'])
eq('非法 from 不变', moveItem(['a', 'b'], 5, 0), ['a', 'b'])

// placeRelative
eq('拖到目标之前', placeRelative(['a', 'b', 'c', 'd'], 'd', 'b', false), ['a', 'd', 'b', 'c'])
eq('拖到目标之后', placeRelative(['a', 'b', 'c', 'd'], 'a', 'c', true), ['b', 'c', 'a', 'd'])
eq('拖到最后一个之后', placeRelative(['a', 'b', 'c'], 'a', 'c', true), ['b', 'c', 'a'])
eq('拖到第一个之前', placeRelative(['a', 'b', 'c'], 'c', 'a', false), ['c', 'a', 'b'])
eq('拖到自己不变', placeRelative(['a', 'b'], 'a', 'a', true), ['a', 'b'])
eq('未知分组不变', placeRelative(['a', 'b'], 'z', 'a', false), ['a', 'b'])

// 随机压测：10000 次随机移动 / 拖放，集合始终不丢不重
let names = Array.from({ length: 12 }, (_, i) => `G${i}`)
const set0 = [...names].sort().join()
let broken = 0
for (let i = 0; i < 10000; i++) {
  const n = names.length
  if (Math.random() < 0.5) names = moveItem(names, Math.floor(Math.random() * n), Math.floor(Math.random() * (n + 3)) - 1)
  else names = placeRelative(names, names[Math.floor(Math.random() * n)], names[Math.floor(Math.random() * n)], Math.random() < 0.5)
  if ([...names].sort().join() !== set0) broken++
}
eq('10000 次随机移动分组不丢不重', broken, 0)
// 排序结果再按自身顺序排序应保持不变（持久化后重新加载顺序一致）
eq('保存后重新加载顺序一致', sortGroupNames([...names].reverse(), names), names)

fs.rmSync(out, { force: true })
console.log(`通过 ${pass}  失败 ${fail}`)
process.exit(fail ? 1 : 0)
