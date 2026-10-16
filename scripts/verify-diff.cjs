/**
 * 行级 diff 自检（无需构建环境）。
 * 用法：node node_modules/typescript/bin/tsc -p tsconfig.verify.json && node scripts/verify-diff.cjs
 */
const { lineDiff, diffStats } = require('../.tsc-verify/main/util/lineDiff.js')

let pass = 0
let fail = 0

function check(name, condition, detail) {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}${detail !== undefined ? `  -> ${detail}` : ''}`)
  }
}

const render = (lines) => lines.map((l) => (l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ') + l.text).join('\n')

console.log('== 基础场景 ==')
{
  const same = lineDiff('a\nb\nc', 'a\nb\nc')
  check('完全相同 → 全部 same', same.every((l) => l.type === 'same') && same.length === 3)

  const add = lineDiff('a\nc', 'a\nb\nc')
  check('中间插入一行', render(add) === ' a\n+b\n c', render(add))
  check('统计：+1/-0', JSON.stringify(diffStats(add)) === '{"added":1,"removed":0}')

  const del = lineDiff('a\nb\nc', 'a\nc')
  check('中间删除一行', render(del) === ' a\n-b\n c', render(del))

  const mod = lineDiff('host=192.168.1.1\nport=22\n', 'host=192.168.1.99\nport=22\n')
  check('修改一行', render(mod).includes('-host=192.168.1.1') && render(mod).includes('+host=192.168.1.99'))
  const stats = diffStats(mod)
  check('修改 = 一增一删', stats.added === 1 && stats.removed === 1, JSON.stringify(stats))
}

console.log('== 前后缀裁剪与位置 ==')
{
  const big = Array.from({ length: 200 }, (_, i) => `line${i}`)
  const bigChanged = [...big]
  bigChanged[100] = 'line100-changed'
  const d = lineDiff(big.join('\n'), bigChanged.join('\n'))
  check('200 行中改 1 行：只产出 3 条差异记录', d.length === 201, String(d.length))
  check('差异位置正确', d.filter((l) => l.type !== 'same').map((l) => l.text).sort().join('|') === 'line100|line100-changed')

  const head = lineDiff('x\na\nb', 'y\na\nb')
  check('首行修改', render(head) === '-x\n+y\n a\n b', render(head))

  const tail = lineDiff('a\nb\nx', 'a\nb\ny')
  check('尾行修改', render(tail) === ' a\n b\n-x\n+y', render(tail))

  const emptyOld = lineDiff('', 'a\nb')
  check('旧为空 → 全部新增', render(emptyOld).startsWith('+a'))

  const emptyNew = lineDiff('a\nb', '')
  check('新为空 → 全部删除', render(emptyNew).includes('-a'))
}

console.log('== 真实配置场景（网络配置改动）==')
{
  const oldConf = [
    'config interface lan',
    "\toption ifname 'eth0'",
    "\toption proto 'static'",
    "\toption ipaddr '192.168.1.10'",
    "\toption netmask '255.255.255.0'",
    ''
  ].join('\n')
  const newConf = [
    'config interface lan',
    "\toption ifname 'eth0'",
    "\toption proto 'static'",
    "\toption ipaddr '192.168.1.20'",
    "\toption netmask '255.255.255.0'",
    "\toption gateway '192.168.1.1'",
    ''
  ].join('\n')
  const d = lineDiff(oldConf, newConf)
  const stats = diffStats(d)
  check('IP 修改 + 网关新增 = +2/-1', stats.added === 2 && stats.removed === 1, JSON.stringify(stats))
  const text = render(d)
  check('差异内容正确', text.includes("-	option ipaddr '192.168.1.10'") && text.includes("+	option ipaddr '192.168.1.20'") && text.includes("+	option gateway '192.168.1.1'"))
}

console.log('== 大文件退化路径（不会卡死）==')
{
  const a = Array.from({ length: 3000 }, (_, i) => `old-${i}`).join('\n')
  const b = Array.from({ length: 3000 }, (_, i) => `new-${i}`).join('\n')
  const t0 = Date.now()
  const d = lineDiff(a, b)
  const cost = Date.now() - t0
  check(`完全不同的 3000 行：快速返回（${cost}ms < 3000ms）`, cost < 3000)
  const stats = diffStats(d)
  check('退化路径：整段替换', stats.added === 3000 && stats.removed === 3000, JSON.stringify(stats))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
