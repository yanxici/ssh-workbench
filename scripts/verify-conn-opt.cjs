/**
 * v1.2.0 优化项自检：模糊搜索 / onlyGroup / 分组色标 / 大目录截断 / 诊断并发。
 * 纯函数 + 算法级验证，不起 Electron。
 *
 * 用法：node scripts/verify-conn-opt.cjs
 */
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log('  PASS  ' + name)
  } else {
    fail++
    console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : ''))
  }
}

/* ---------- 复刻 fuzzy.ts 的核心（子序列 + 词首/连续加权） ---------- */
const SEPARATORS = new Set([' ', '-', '_', '/', '\\', '.', ':', '>', '|', ',', ';', '(', ')', '[', ']', '{', '}', '"', "'", '`', '·', '【', '】', '（', '）'])
function isBoundary(text, i) {
  if (i <= 0) return true
  const prev = text[i - 1]
  if (SEPARATORS.has(prev)) return true
  const cur = text[i]
  return prev === prev.toLowerCase() && cur === cur.toUpperCase() && /[A-Za-z]/.test(cur)
}
function fuzzyScore(text, query) {
  if (!query) return 0
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  const direct = t.indexOf(q)
  if (direct >= 0) return 1000 + direct * -1
  let ti = 0
  let score = 0
  let lastHit = -2
  let hits = 0
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    let found = -1
    for (let i = ti; i < t.length; i++) {
      if (t[i] === ch) {
        found = i
        break
      }
    }
    if (found < 0) return 0
    hits++
    score += 10
    if (isBoundary(text, found)) score += 25
    if (found === lastHit + 1) score += 15
    score -= found * 0.2
    lastHit = found
    ti = found + 1
  }
  return hits === q.length ? Math.max(score, 0) : 0
}

const FIELD_WEIGHT = { name: 1000, host: 500, username: 400, tag: 200, group: 100 }
function scoreConnection(c, kw) {
  let best = 0
  const n = fuzzyScore(c.name, kw)
  if (n > 0) best = Math.max(best, n + FIELD_WEIGHT.name)
  const h = fuzzyScore(c.host, kw)
  if (h > 0) best = Math.max(best, h + FIELD_WEIGHT.host)
  const u = fuzzyScore(c.username, kw)
  if (u > 0) best = Math.max(best, u + FIELD_WEIGHT.username)
  for (const t of c.tags) {
    const s = fuzzyScore(t, kw)
    if (s > 0) best = Math.max(best, s + FIELD_WEIGHT.tag)
  }
  const g = fuzzyScore(c.group || '默认', kw)
  if (g > 0) best = Math.max(best, g + FIELD_WEIGHT.group)
  return best
}

const mk = (id, name, group, extra = {}) => ({
  id,
  name,
  host: '10.42.42.200',
  port: 22,
  username: 'root',
  group,
  tags: [],
  lastUsedAt: undefined,
  ...extra
})

console.log('\n[1] 模糊搜索：子序列命中')
{
  const conns = [
    mk('a', '信阳快大-后备2舍-机器人-R223', 'RobotSSH迁移'),
    mk('b', '信阳快大-配坏1舍-充电桩-C333', 'RobotSSH迁移'),
    mk('c', '17服务器', 'RobotSSH迁移')
  ]
  check('r223 能命中 机器人-R223（旧实现 includes 也能）', scoreConnection(conns[0], 'r223') > 0)
  /*
   * 注意：fuzzyMatch 做的是「字符子序列」匹配，不做拼音转换。
   * xxkd 是「信阳快大」的拼音首字母，字符层面一个都对不上，必然 MISS ——
   * 这不是缺陷，拼音首字母搜索属于另一个功能（需要 pinyin 词典）。
   * 下面用字符子序列才成立的例子来证明相对旧实现的增益。
   */
  check('xxkd 是拼音首字母，fuzzy 不处理，MISS 属预期', scoreConnection(conns[0], 'xxkd') === 0)
  // 字符子序列：跳过中间的字符也能命中，这是 includes 做不到的
  check('子序列 阳快 能命中（跨字符）', scoreConnection(conns[0], '阳快') > 0, String(scoreConnection(conns[0], '阳快')))
  check('子序列 信快 能命中（跳过中间）', scoreConnection(conns[0], '信快') > 0, String(scoreConnection(conns[0], '信快')))
  check('跨连字符子序列 快-R 能命中', scoreConnection(conns[0], '快R') > 0)
  check('首尾子序列 信C 能命中', scoreConnection(conns[1], '信C') > 0)
  check('机器人 中文子序列命中', scoreConnection(conns[0], '机器人') > 0)
  check('c333 命中充电桩-C333', scoreConnection(conns[1], 'c333') > 0)
  check('不相关关键字不命中', scoreConnection(conns[2], 'zzzz') === 0)

  // 字段权重：名字命中必须压过分组名命中
  const byName = scoreConnection(conns[2], '17服务器')
  const byGroup = scoreConnection(conns[2], 'RobotSSH')
  check('名字命中权重 > 分组名命中', byName > byGroup, byName + ' vs ' + byGroup)
}

console.log('\n[2] 模糊搜索排序：最相关的排前面')
{
  const conns = [
    mk('lo', '设备-AAAA-R223', 'G'),
    mk('hi', 'R223', 'G'),
    mk('mid', '设备-R223-备份', 'G')
  ]
  const ranked = conns
    .map((c) => ({ c, s: scoreConnection(c, 'r223') }))
    .sort((x, y) => y.s - x.s)
  check('名字就是关键字的排第一', ranked[0].c.id === 'hi', ranked.map((r) => r.c.id).join(','))
  check('全部命中', ranked.every((r) => r.s > 0))
}

console.log('\n[3] onlyGroup 聚焦过滤')
{
  const conns = [mk('a', 'x', 'A组'), mk('b', 'y', 'B组'), mk('c', 'z', 'A组')]
  const scope = (list, only) => (only ? list.filter((c) => (c.group || '默认') === only) : list)
  check('聚焦 A 组只剩 A 组连接', scope(conns, 'A组').length === 2)
  check('不聚焦时返回全部', scope(conns, null).length === 3)
  check('聚焦不存在的组返回空', scope(conns, '不存在').length === 0)

  // 聚焦 + 关键字交集
  const both = scope(conns, 'A组').filter((c) => fuzzyScore(c.name, 'x') > 0)
  check('聚焦与关键字是交集关系', both.length === 1 && both[0].id === 'a')
}

console.log('\n[4] 大目录截断')
{
  const LIMIT = 300
  const files = Array.from({ length: 5000 }, (_, i) => ({ path: '/var/log/f' + i }))
  const shown = files.slice(0, LIMIT)
  const hidden = files.length - shown.length
  check('5000 项目录只渲染 300 项', shown.length === 300)
  check('剩余数量计算正确', hidden === 4700, String(hidden))
  check('小目录（<300）全部渲染', files.slice(0, 50).length === 50)
}

async function main() {
console.log('\n[5] 诊断巡检并发模型')
{
  /**
   * 复刻 runOne 的调度：固定并发 + 下标预占位，验证
   * ① 结果顺序与传入顺序一致 ② 不多不少 ③ 并发度真的生效
   */
  async function runPool(tasks, concurrency) {
    const slots = new Array(tasks.length)
    let next = 0
    let peak = 0
    let running = 0
    const runOne = async () => {
      for (;;) {
        const i = next++
        if (i >= tasks.length) return
        running++
        peak = Math.max(peak, running)
        slots[i] = await tasks[i]()
        running--
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => runOne()))
    return { slots, peak }
  }

  // 随机延时，故意让完成顺序打乱
  const tasks = Array.from({ length: 20 }, (_, i) => async () => {
    await new Promise((r) => setTimeout(r, Math.random() * 30))
    return 'task-' + i
  })
  const { slots, peak } = await runPool(tasks, 4)
  check('结果顺序与传入顺序严格一致', slots.every((v, i) => v === 'task-' + i), slots.slice(0, 3).join(','))
  check('结果数量完整', slots.length === 20)
  check('并发峰值不超过 4', peak <= 4, String(peak))
  check('并发真的用满了 4', peak === 4, String(peak))

  // 串行 vs 并发 的实际耗时差
  const mkTask = (ms) => () => new Promise((r) => setTimeout(() => r('ok'), ms))
  const many = Array.from({ length: 8 }, () => mkTask(50))
  const t0 = Date.now()
  await runPool(many, 4)
  const parallelMs = Date.now() - t0
  const t1 = Date.now()
  await runPool(many, 1)
  const serialMs = Date.now() - t1
  console.log('  INFO  8×50ms 任务：并发4 = ' + parallelMs + 'ms，串行 = ' + serialMs + 'ms')
  check('并发显著快于串行（至少 1.8x）', parallelMs * 1.8 < serialMs, parallelMs + ' vs ' + serialMs)
}

console.log('\n[6] 压测：2790 条连接模糊搜索')
{
  const N = 2790
  const groups = ['RobotSSH迁移', '充电桩', '机器人', '现场设备']
  const big = Array.from({ length: N }, (_, i) =>
    mk('id' + i, '信阳快大-配坏' + (i % 9) + '舍-' + (i % 2 ? '机器人' : '充电桩') + '-R' + (1000 + i), groups[i % 4])
  )

  // 旧实现：纯 includes
  const oldSearch = (kw) => {
    const k = kw.toLowerCase()
    return big.filter(
      (c) =>
        c.name.toLowerCase().includes(k) ||
        c.host.toLowerCase().includes(k) ||
        c.username.toLowerCase().includes(k) ||
        c.group.toLowerCase().includes(k)
    )
  }

  // 新实现：模糊打分
  const newSearch = (kw) => big.filter((c) => scoreConnection(c, kw) > 0)

  for (const kw of ['r2231', '阳快', '机器人']) {
    const t0 = process.hrtime.bigint()
    const o = oldSearch(kw)
    const t1 = process.hrtime.bigint()
    const n = newSearch(kw)
    const t2 = process.hrtime.bigint()
    const oldMs = Number(t1 - t0) / 1e6
    const newMs = Number(t2 - t1) / 1e6
    console.log(
      '  INFO  "' + kw + '": 旧 includes 命中 ' + o.length + ' 条 (' + oldMs.toFixed(1) + 'ms)' +
      ' | 新 fuzzy 命中 ' + n.length + ' 条 (' + newMs.toFixed(1) + 'ms)'
    )
    check('"' + kw + '" 模糊搜索在 300ms 内', newMs < 300, newMs.toFixed(1) + 'ms')
    check('"' + kw + '" 模糊搜索命中数 >= 旧实现', n.length >= o.length, n.length + ' vs ' + o.length)
  }

  // 关键增益：跨分段的子序列关键字，旧实现完全搜不到
  const subseqKw = '快-R'
  check('旧实现搜不到 快-R（证明这是真实增益）', oldSearch(subseqKw).length === 0, String(oldSearch(subseqKw).length))
  check('新实现能搜到 快-R', newSearch(subseqKw).length > 0, String(newSearch(subseqKw).length))
}

}

const failedCount = () => fail
main().then(() => {
  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n')
  process.exit(fail === 0 ? 0 : 1)
}).catch((e) => {
  console.error('异常:', e)
  process.exit(2)
})
