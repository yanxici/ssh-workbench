/**
 * 命令检索自检：fuzzyMatch / searchCommands / buildScopes / inScope
 * 用法：node scripts/verify-command-search.cjs
 */
const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const out = path.join(ROOT, '.tsc-verify', 'command-search.cjs')
fs.mkdirSync(path.dirname(out), { recursive: true })
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'src/renderer/src/lib/commandSearch.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error'
})
const { inScope, usageScore, searchCommands, buildScopes, sameScope } = require(out)

const fuzzyOut = path.join(ROOT, '.tsc-verify', 'fuzzy.cjs')
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'src/renderer/src/lib/fuzzy.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: fuzzyOut,
  logLevel: 'error'
})
const { fuzzyMatch } = require(fuzzyOut)

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

/* ------------------------------------------------------------------ *
 *  fuzzyMatch
 * ------------------------------------------------------------------ */
ok('空 query 恒命中', !!fuzzyMatch('随便什么', ''))
ok('子串命中 git status', !!fuzzyMatch('git status', 'stat'))
ok('子序列命中 gst -> git status', !!fuzzyMatch('git status', 'gst'))
ok('子序列命中 gss -> git status', !!fuzzyMatch('git status', 'gss'))
ok('大小写不敏感 GST', !!fuzzyMatch('git status', 'GST'))
ok('中文子串命中', !!fuzzyMatch('查看磁盘占用', '磁盘'))
ok('完全无关不命中', fuzzyMatch('git status', 'zzzq') === null)

const direct = fuzzyMatch('git status', 'git')
const subsequence = fuzzyMatch('git status', 'gst')
ok('子串分高于子序列分', direct.score > subsequence.score, `${direct.score} vs ${subsequence.score}`)

const head = fuzzyMatch('git status', 'git')
const mid = fuzzyMatch('git status', 'status')
ok('开头命中分高于中间命中', head.score > mid.score, `${head.score} vs ${mid.score}`)

eq('子串高亮连续区间', fuzzyMatch('git status', 'stat').indices, [4, 5, 6, 7])
// git status: 0=g 4=s 5=t —— 子序列允许跳字符，高亮区间因此可能不连续
eq('子序列高亮区间', fuzzyMatch('git status', 'gst').indices, [0, 4, 5])

/* ------------------------------------------------------------------ *
 *  fixtures
 * ------------------------------------------------------------------ */
const DAY = 86_400_000
const now = 1_800_000_000_000
let seq = 0
function cmd(over) {
  return {
    id: over.id ?? `id-${++seq}`,
    name: 'x',
    command: 'x',
    description: '',
    group: '默认',
    icon: 'Terminal',
    color: undefined,
    confirmRequired: false,
    variables: [],
    sortOrder: ++seq,
    useCount: 0,
    lastUsedAt: undefined,
    createdAt: now,
    updatedAt: now,
    ...over
  }
}

const commands = [
  cmd({ id: 'c-git-status', name: 'git status', command: 'git status', group: 'git', useCount: 40, lastUsedAt: now - 1 * DAY }),
  cmd({ id: 'c-git-log', name: 'git log', command: 'git log --oneline -20', group: 'git', useCount: 2, lastUsedAt: now - 20 * DAY }),
  cmd({ id: 'c-disk', name: '查看磁盘占用', command: 'df -h', group: '系统', description: '磁盘使用率', useCount: 12, lastUsedAt: now - 3 * DAY }),
  cmd({ id: 'c-mem', name: '查看内存', command: 'free -m', group: '系统', useCount: 0 }),
  cmd({ id: 'c-tail', name: '跟踪日志', command: 'tail -f /var/log/syslog', group: '日志', useCount: 5, lastUsedAt: now - 100 * DAY }),
  cmd({ id: 'c-net', name: '重启网卡', command: 'systemctl restart networking', group: '网络', confirmRequired: true, useCount: 0 })
]

/* ------------------------------------------------------------------ *
 *  inScope
 * ------------------------------------------------------------------ */
eq('scope all 全通过', commands.filter((c) => inScope(c, { kind: 'all' }, { now })).length, 6)
eq(
  'scope recent 30 天内',
  commands.filter((c) => inScope(c, { kind: 'recent' }, { now })).map((c) => c.id),
  ['c-git-status', 'c-git-log', 'c-disk']
)
eq(
  'scope frequent 用过至少一次',
  commands.filter((c) => inScope(c, { kind: 'frequent' }, { now })).map((c) => c.id),
  ['c-git-status', 'c-git-log', 'c-disk', 'c-tail']
)
eq(
  'scope pinned 依 pinnedIds 判定（不是 sortOrder<0）',
  commands
    .filter((c) => inScope(c, { kind: 'pinned' }, { pinnedIds: ['c-mem', 'c-net'], now }))
    .map((c) => c.id),
  ['c-mem', 'c-net']
)
eq(
  'scope group 精确匹配',
  commands.filter((c) => inScope(c, { kind: 'group', group: 'git' }, { now })).map((c) => c.id),
  ['c-git-status', 'c-git-log']
)

/* ------------------------------------------------------------------ *
 *  usageScore：次数对数 + 最近衰减
 * ------------------------------------------------------------------ */
ok('用得多的分高', usageScore(commands[0], now) > usageScore(commands[1], now))
ok('从没用过也有基础分（0）', usageScore(cmd({ useCount: 0 }), now) === 0)
const fresh = usageScore(cmd({ useCount: 1, lastUsedAt: now }), now)
const stale = usageScore(cmd({ useCount: 1, lastUsedAt: now - 60 * DAY }), now)
ok('刚用过的比很久以前用过的分高', fresh > stale, `${fresh} vs ${stale}`)
// 60 天前用过一次：只剩次数基础分，recency 衰减到几乎为 0
ok('衰减到仅剩次数分', stale >= 26 && stale < 26.01, String(stale))

/* ------------------------------------------------------------------ *
 *  searchCommands：模糊命中、字段权重、排序
 * ------------------------------------------------------------------ */
const gst = searchCommands({ commands, query: 'gst', scope: { kind: 'all' }, now })
// 'git log --oneline -20' 里没有 s，所以 gst 只会命中 git status
eq('gst 命中 git status', gst.map((r) => r.command.id), ['c-git-status'])
ok('gst 首位是 git status（热度高）', gst[0].command.id === 'c-git-status', gst.map((r) => r.command.id).join(','))

const named = searchCommands({ commands, query: '磁盘', scope: { kind: 'all' }, now })
eq('中文搜名字', named.map((r) => r.command.id), ['c-disk'])
eq('名字命中带高亮区间', named[0].nameIndices.length, 2)

const byGroup = searchCommands({ commands, query: 'git', scope: { kind: 'all' }, now })
ok('分组名命中也能出结果', byGroup.length >= 2, byGroup.map((r) => r.command.name).join(','))

const byDesc = searchCommands({ commands, query: '使用率', scope: { kind: 'all' }, now })
eq('描述命中', byDesc.map((r) => r.command.id), ['c-disk'])
eq('描述命中的 hit 标记', byDesc[0].hit, 'description')

const empty = searchCommands({ commands, query: '', scope: { kind: 'all' }, sort: 'smart', now })
eq('空 query 返回全部（浏览模式）', empty.length, 6)
ok('空 query 按热度降序', empty[0].command.id === 'c-git-status', empty.map((r) => r.command.id).join(','))

const pinnedFirst = searchCommands({
  commands,
  query: '',
  scope: { kind: 'all' },
  sort: 'smart',
  pinnedIds: ['c-mem'],
  now
})
eq('收藏项排在首位', pinnedFirst[0].command.id, 'c-mem')

const byRecent = searchCommands({ commands, query: '', scope: { kind: 'all' }, sort: 'recent', now })
eq('recent 排序：最新在前', byRecent.slice(0, 2).map((r) => r.command.id), ['c-git-status', 'c-disk'])
eq(
  'recent 排序：从未使用沉底',
  byRecent.slice(-2).map((r) => r.command.id).sort(),
  ['c-mem', 'c-net']
)

const byFrequent = searchCommands({ commands, query: '', scope: { kind: 'all' }, sort: 'frequent', now })
eq('frequent 排序', byFrequent[0].command.id, 'c-git-status')

const byName = searchCommands({ commands, query: '', scope: { kind: 'all' }, sort: 'name', now })
eq('name 排序按名称', byName.map((r) => r.command.name).length, 6)

const scoped = searchCommands({ commands, query: '', scope: { kind: 'group', group: '系统' }, now })
eq('scope 收窄结果集', scoped.length, 2)

/* ------------------------------------------------------------------ *
 *  buildScopes
 * ------------------------------------------------------------------ */
const scopes = buildScopes(commands, { groupOrder: ['系统', 'git'], extraGroups: ['空分组'], now })
eq('索引顺序：4 个虚拟范围在前', scopes.slice(0, 4).map((s) => s.scope.kind), ['all', 'recent', 'frequent', 'pinned'])
eq('全部命令计数', scopes[0].count, 6)
eq('最近计数（tail 已超 30 天窗口）', scopes[1].count, 3)
eq('收藏计数随 pinnedIds', buildScopes(commands, { pinnedIds: ['c-mem'], now })[3].count, 1)
eq(
  '分组按 groupOrder 排在前，其余按名称',
  scopes.slice(4).map((s) => s.label),
  ['系统', 'git', '空分组', '日志', '网络']
)
eq('空分组计数为 0', scopes.find((s) => s.label === '空分组').count, 0)
eq('无斜杠分组 depth 为 0', scopes[4].depth, 0)

const nested = buildScopes(
  [cmd({ name: 'a', command: 'a', group: 'k8s/pod' }), cmd({ name: 'b', command: 'b', group: 'k8s' })],
  { now }
)
eq('层级分组 depth', nested.filter((s) => s.scope.kind === 'group').map((s) => [s.label, s.depth]), [['k8s', 0], ['k8s/pod', 1]])

/* ------------------------------------------------------------------ *
 *  sameScope
 * ------------------------------------------------------------------ */
ok('同 kind 同 group 等价', sameScope({ kind: 'group', group: 'a' }, { kind: 'group', group: 'a' }))
ok('不同 group 不等价', !sameScope({ kind: 'group', group: 'a' }, { kind: 'group', group: 'b' }))
ok('虚拟范围按 kind 比较', sameScope({ kind: 'all' }, { kind: 'all' }))
ok('all 与 pinned 不等价', !sameScope({ kind: 'all' }, { kind: 'pinned' }))

/* ------------------------------------------------------------------ *
 *  与旧实现的行为对照（回归护栏）
 * ------------------------------------------------------------------ */
const oldWay = commands.filter((c) => c.name.toLowerCase().includes('gst'))
eq('旧实现搜 gst 一条都搜不到', oldWay.length, 0)
ok(
  '新实现搜 gst 有结果（这就是要修的问题）',
  searchCommands({ commands, query: 'gst', scope: { kind: 'all' }, now }).length > 0
)

fs.rmSync(out, { force: true })
fs.rmSync(fuzzyOut, { force: true })
console.log(`通过 ${pass}  失败 ${fail}`)
process.exit(fail ? 1 : 0)
