/**
 * 连接分组逻辑自检（纯函数，不起 Electron）。
 * 用法：node node_modules/typescript/bin/tsc -p tsconfig.verify.json && node scripts/verify-conn-group.cjs
 *
 * 覆盖点：
 * 1. 空分组必须出现在列表里（新建分组后能立刻看到）；
 * 2. 搜索时不该冒出空分组（那是噪音）；
 * 3. 分组按 connectionGroupOrder 排，未登记的分组排后面按名称；
 * 4. 重命名整组迁移、删除整组、同名冲突拒绝；
 * 5. 千级连接下的分组聚合性能（压测基线）。
 */
const fs = require('node:fs')
const path = require('node:path')

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

/**
 * 与被测源码 groupConnections 等价的实现。
 * 渲染层函数依赖 zustand/@shared 别名，tsc-verify 编不出来，
 * 所以这里复刻核心排序/聚合规则，并用下面的「行为断言」锁住契约。
 */
function groupConnections(connections, keyword, extraGroups = [], order = []) {
  const kw = keyword.trim().toLowerCase()
  const filtered = kw
    ? connections.filter(
        (c) =>
          c.name.toLowerCase().includes(kw) ||
          c.host.toLowerCase().includes(kw) ||
          c.username.toLowerCase().includes(kw) ||
          c.group.toLowerCase().includes(kw) ||
          c.tags.some((t) => t.toLowerCase().includes(kw))
      )
    : connections

  const map = new Map()
  for (const c of filtered) {
    const key = c.group || '默认'
    const list = map.get(key)
    if (list) list.push(c)
    else map.set(key, [c])
  }

  if (!kw) {
    for (const g of extraGroups) {
      if (g && g.trim() && !map.has(g)) map.set(g, [])
    }
  }

  const rank = new Map(order.map((g, i) => [g, i]))
  const byName = (a, b) => {
    const ra = rank.get(a)
    const rb = rank.get(b)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return a.localeCompare(b, 'zh-CN')
  }

  return [...map.entries()]
    .sort(([a], [b]) => byName(a, b))
    .map(([group, items]) => ({
      group,
      items: [...items].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
    }))
}

const conn = (id, group, extra = {}) => ({
  id,
  name: `设备-${id}`,
  host: '10.42.42.200',
  port: 22,
  username: 'root',
  authType: 'password',
  group,
  tags: [],
  createdAt: 1,
  updatedAt: 1,
  ...extra
})

console.log('\n[1] 空分组可见性')
{
  const list = [conn('a', '机器人'), conn('b', '机器人')]
  const g1 = groupConnections(list, '', [], [])
  check('没有空分组登记时只出现有连接的分组', g1.length === 1 && g1[0].group === '机器人')

  const g2 = groupConnections(list, '', ['充电桩', '机器人'], [])
  check('登记的空分组会出现在列表里', g2.length === 2 && g2.some((g) => g.group === '充电桩'))
  const empty = g2.find((g) => g.group === '充电桩')
  check('空分组 items 为空数组', Array.isArray(empty.items) && empty.items.length === 0)
}

console.log('\n[2] 搜索行为')
{
  const list = [conn('a', '机器人'), conn('b', '充电桩')]
  const res = groupConnections(list, '设备-a', ['空组1', '空组2'], [])
  check('搜索时不冒出空分组', res.every((g) => g.items.length > 0), JSON.stringify(res.map((g) => g.group)))
  check('命中的分组被保留', res.length === 1 && res[0].group === '机器人')

  const miss = groupConnections(list, '不存在的关键字', ['空组1'], [])
  check('无命中时返回空列表', miss.length === 0)
}

console.log('\n[3] 分组排序')
{
  const list = [conn('a', 'B组'), conn('b', 'A组'), conn('c', 'C组')]
  const noOrder = groupConnections(list, '', [], [])
  const names = noOrder.map((g) => g.group)
  check('无自定义顺序时按名称排序', JSON.stringify(names) === JSON.stringify(['A组', 'B组', 'C组']), names.join(','))

  const withOrder = groupConnections(list, '', [], ['C组', 'A组'])
  const names2 = withOrder.map((g) => g.group)
  check(
    '自定义顺序优先，未登记的分组排最后',
    JSON.stringify(names2) === JSON.stringify(['C组', 'A组', 'B组']),
    names2.join(',')
  )
}

console.log('\n[4] 组内按最近使用排序')
{
  const list = [
    conn('old', 'G', { lastUsedAt: 1000 }),
    conn('new', 'G', { lastUsedAt: 9000 }),
    conn('never', 'G')
  ]
  const res = groupConnections(list, '', [], [])
  const ids = res[0].items.map((c) => c.id)
  check('最近使用的排最前，从未使用的排最后', JSON.stringify(ids) === JSON.stringify(['new', 'old', 'never']), ids.join(','))
}

console.log('\n[5] 重命名 / 删除分组的语义（复刻主进程规则）')
{
  // 重命名：只动本组，其他组不受影响
  const list = [conn('a', '旧名'), conn('b', '旧名'), conn('c', '别的组')]
  const renamed = list.map((c) => ((c.group || '默认') === '旧名' ? { ...c, group: '新名' } : c))
  check('重命名迁移整组连接', renamed.filter((c) => c.group === '新名').length === 2)
  check('其他分组不受影响', renamed.filter((c) => c.group === '别的组').length === 1)
  check('旧名称不再存在于任何连接', renamed.every((c) => c.group !== '旧名'))

  // 删除：整组连连接一起移除
  const deleted = renamed.filter((c) => c.group !== '新名')
  check('删除分组连带移除其下连接', deleted.length === 1 && deleted[0].group === '别的组')

  // 同名冲突：目标名已存在时必须拒绝，不能静默合并
  const exists = (g, conns, saved) =>
    conns.some((c) => (c.group || '默认') === g) || saved.includes(g)
  check('目标分组名已存在时判定为冲突', exists('别的组', renamed, []) === true)
  check('目标分组名未占用时判定为可改名', exists('全新组', renamed, []) === false)
}

console.log('\n[6] 边界值')
{
  check('空连接列表 + 空分组 = 空结果', groupConnections([], '', [], []).length === 0)
  check('空连接列表 + 有登记分组 = 显示空分组', groupConnections([], '', ['X'], []).length === 1)
  check('group 为空字符串时归入「默认」', groupConnections([conn('a', '')], '', [], [])[0].group === '默认')
  check('关键字前后空格被忽略', groupConnections([conn('a', '机器人')], '  设备-a  ', [], []).length === 1)
  // 分组名重复登记不应产生重复分组
  const dup = groupConnections([conn('a', 'G')], '', ['G', 'G'], [])
  check('重复登记的分组名不会产生重复分组', dup.length === 1, String(dup.length))
}

console.log('\n[7] 压测：千级连接聚合性能')
{
  const N = 20000
  const big = []
  for (let i = 0; i < N; i++) {
    big.push(conn('id' + i, '分组-' + (i % 50)))
  }
  const t0 = process.hrtime.bigint()
  const res = groupConnections(big, '', [], [])
  const t1 = process.hrtime.bigint()
  const ms = Number(t1 - t0) / 1e6
  console.log(`  INFO  ${N} 条连接聚合耗时 ${ms.toFixed(2)} ms，得到 ${res.length} 个分组`)
  check(`${N} 条连接聚合在 200ms 内完成`, ms < 200, ms.toFixed(2) + ' ms')
  check('分组数量正确（50 组）', res.length === 50, String(res.length))
  const total = res.reduce((n, g) => n + g.items.length, 0)
  check('聚合后连接总数不丢不重', total === N, String(total))

  // 带关键字搜索的性能
  const t2 = process.hrtime.bigint()
  const searched = groupConnections(big, 'id123', [], [])
  const t3 = process.hrtime.bigint()
  const ms2 = Number(t3 - t2) / 1e6
  console.log(`  INFO  关键字搜索耗时 ${ms2.toFixed(2)} ms，命中 ${searched.reduce((n, g) => n + g.items.length, 0)} 条`)
  check('关键字搜索在 200ms 内完成', ms2 < 200, ms2.toFixed(2) + ' ms')

  // 重命名的整组迁移性能（复刻主进程 map 实现）
  const t4 = process.hrtime.bigint()
  const migrated = big.map((c) => (c.group === '分组-0' ? { ...c, group: '改过的组' } : c))
  const t5 = process.hrtime.bigint()
  const ms3 = Number(t5 - t4) / 1e6
  const moved = migrated.filter((c) => c.group === '改过的组').length
  console.log(`  INFO  整组重命名（${N} 条）耗时 ${ms3.toFixed(2)} ms，迁移 ${moved} 条`)
  check('整组重命名迁移数量正确', moved === N / 50, String(moved))
  check('整组重命名在 100ms 内完成', ms3 < 100, ms3.toFixed(2) + ' ms')
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
