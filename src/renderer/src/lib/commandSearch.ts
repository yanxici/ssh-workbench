/**
 * 命令检索核心（纯函数，便于单测）。
 *
 * 解决的老问题：旧实现只有「关键字小写 includes」，于是
 *   ① 命令一多就必须靠搜索，搜索框还默认收起；
 *   ② 输 `lsblk` 能中，输 `lbk` / `查看磁盘` 的中途字就没了；
 *   ③ 结果永远按分组 + sortOrder 排，常用命令沉在下面。
 *
 * 现在的检索分三层：
 *   范围（scope）→ 打分（模糊匹配 + 字段权重 + 使用热度）→ 排序
 *
 * scope 是虚拟分组，与真实分组（命令的 group 字段）并列出现在左侧索引里：
 *   all / recent（最近用过）/ frequent（最常用）/ pinned（置顶收藏）/ 具体分组名
 */

import type { Command } from '@shared/types'
import { fuzzyMatch } from './fuzzy'

export type ScopeKind = 'all' | 'recent' | 'frequent' | 'pinned' | 'group'

export interface Scope {
  kind: ScopeKind
  /** kind = 'group' 时的分组名 */
  group?: string
}

export type SortMode = 'smart' | 'name' | 'recent' | 'frequent'

export interface RankedCommand {
  command: Command
  score: number
  /** 命令名高亮区间 */
  nameIndices: number[]
  /** 命令文本高亮区间 */
  cmdIndices: number[]
  /** 命中来源，用于列表上的「为什么它在结果里」提示 */
  hit: 'name' | 'command' | 'description' | 'group' | 'usage'
  /** 命中的是中英别名时，记录是哪个别名（UI 显示「≈磁盘」） */
  via?: string
}

/** 最近使用的时间窗口：30 天内用过的才算「最近」 */
const RECENT_WINDOW = 30 * 24 * 3600 * 1000
/** 「最常用」门槛：至少用过 1 次 */
const FREQUENT_MIN = 1

export function inScope(
  c: Command,
  scope: Scope,
  opts: { pinnedIds?: string[]; now?: number } = {}
): boolean {
  const now = opts.now ?? Date.now()
  switch (scope.kind) {
    case 'all':
      return true
    case 'recent':
      return !!c.lastUsedAt && now - c.lastUsedAt < RECENT_WINDOW
    case 'frequent':
      return c.useCount >= FREQUENT_MIN
    case 'pinned':
      return (opts.pinnedIds ?? []).includes(c.id)
    case 'group':
      return (c.group || '默认') === scope.group
  }
}

/**
 * 热度分：使用次数取对数（避免一条用得极多的命令永远霸榜），
 * 最近使用给一次衰减加分（用过的旧命令会重新浮上来）。
 */
export function usageScore(c: Command, now = Date.now()): number {
  const count = Math.log2(1 + Math.max(0, c.useCount)) * 26
  if (!c.lastUsedAt) return count
  const ageDays = (now - c.lastUsedAt) / 86_400_000
  const recency = 40 * Math.exp(-ageDays / 7)
  return count + recency
}

/**
 * 主检索入口。
 * @returns 已排序的结果；query 为空时就是「按 scope + 排序模式」的浏览列表
 */
export function searchCommands({
  commands,
  query,
  scope,
  sort = 'smart',
  pinnedIds,
  now = Date.now()
}: {
  commands: Command[]
  query: string
  scope: Scope
  sort?: SortMode
  /** 收藏置顶的命令 id（历史记录「收藏为命令」入口会写进来） */
  pinnedIds?: string[]
  now?: number
}): RankedCommand[] {
  const pinned = new Set(pinnedIds ?? [])
  const q = query.trim()
  /** 同义扩展只在「直接查询没命中」时兜底，权重打八折，不会盖过真实命中 */
  const aliases = q ? synonymsOf(q) : []
  const out: RankedCommand[] = []

  for (const c of commands) {
    if (!inScope(c, scope, { pinnedIds, now })) continue

    if (!q) {
      out.push({
        command: c,
        // 浏览模式下「收藏置顶」是硬规则：收藏项整体压在使用热度至上，
        // 收藏项内部仍按热度排；搜索模式下收藏只作为轻量加分（见下方 +60）。
        score: usageScore(c, now) + (pinned.has(c.id) ? 1000 : 0),
        nameIndices: [],
        cmdIndices: [],
        hit: 'usage'
      })
      continue
    }

    /**
     * 对单个查询词打分：返回四个字段里最好的那个候选。
     * demandDirect = true 用于别名兜底 —— 别名表里的词很短（df / ss / ip / ls），
     * 走子序列会给「错误关键字汇总」(f…d) 这类噪声开门，只认子串命中。
     */
    const scoreOne = (
      term: string,
      demandDirect: boolean
    ): { score: number; nameIndices: number[]; cmdIndices: number[]; hit: RankedCommand['hit'] } | null => {
      const pick = (m: ReturnType<typeof fuzzyMatch>): ReturnType<typeof fuzzyMatch> =>
        m && (!demandDirect || m.direct) ? m : null

      const nameM = pick(fuzzyMatch(c.name, term))
      const cmdM = pick(fuzzyMatch(c.command, term))
      const descM = pick(fuzzyMatch(c.description ?? '', term))
      const groupM = pick(fuzzyMatch(c.group || '默认', term))

      // 字段权重：名字 > 命令原文 > 分组 > 描述
      const candidates: Array<{
        score: number
        nameIndices: number[]
        cmdIndices: number[]
        hit: RankedCommand['hit']
      }> = []

      if (nameM) {
        candidates.push({
          score: nameM.score * 3,
          nameIndices: nameM.indices,
          cmdIndices: [],
          hit: 'name'
        })
      }
      if (cmdM) {
        candidates.push({
          score: cmdM.score * 2,
          nameIndices: [],
          cmdIndices: cmdM.indices,
          hit: 'command'
        })
      }
      if (groupM) {
        candidates.push({ score: groupM.score, nameIndices: [], cmdIndices: [], hit: 'group' })
      }
      if (descM) {
        candidates.push({
          score: descM.score * 0.6,
          nameIndices: [],
          cmdIndices: [],
          hit: 'description'
        })
      }
      if (candidates.length === 0) return null
      return candidates.reduce((a, b) => (b.score > a.score ? b : a))
    }

    let best = scoreOne(q, false)
    let via: string | undefined
    if (!best) {
      for (const alias of aliases) {
        const m = scoreOne(alias, true)
        if (!m) continue
        const discounted = m.score * 0.8
        if (!best || discounted > best.score) {
          best = { ...m, score: discounted }
          via = alias
        }
      }
    }
    if (!best) continue

    out.push({
      command: c,
      score: best.score + usageScore(c, now) * 0.5 + (pinned.has(c.id) ? 60 : 0),
      nameIndices: best.nameIndices,
      cmdIndices: best.cmdIndices,
      hit: best.hit,
      via
    })
  }

  const byName = (a: RankedCommand, b: RankedCommand): number =>
    a.command.name.localeCompare(b.command.name, 'zh-CN')

  out.sort((a, b) => {
    if (sort === 'name') return byName(a, b)
    if (sort === 'recent') {
      const d = (b.command.lastUsedAt ?? 0) - (a.command.lastUsedAt ?? 0)
      return d !== 0 ? d : byName(a, b)
    }
    if (sort === 'frequent') {
      const d = b.command.useCount - a.command.useCount
      return d !== 0 ? d : byName(a, b)
    }
    // smart：分数优先，同分按名称稳定排列
    if (Math.abs(a.score - b.score) > 0.5) return b.score - a.score
    return byName(a, b)
  })

  return out
}

/** 左侧索引项：虚拟范围 + 真实分组（带条目数），可折叠层级分组用 '/' 前缀树 */
export interface ScopeEntry {
  scope: Scope
  label: string
  count: number
  /** 层级深度（group 中含 '/' 时用于缩进） */
  depth: number
}

/**
 * 生成左侧范围索引。
 * 真实分组按 groupOrder 排序，`a/b` 这种带斜杠的分组会按层级展示（缩进）。
 */
export function buildScopes(
  commands: Command[],
  {
    groupOrder = [],
    extraGroups = [],
    pinnedIds,
    now = Date.now()
  }: { groupOrder?: string[]; extraGroups?: string[]; pinnedIds?: string[]; now?: number }
): ScopeEntry[] {
  const pinned = new Set(pinnedIds ?? [])
  const counts = new Map<string, number>()
  for (const c of commands) {
    const key = c.group || '默认'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  for (const g of extraGroups) if (g && !counts.has(g)) counts.set(g, 0)

  const recent = commands.filter((c) => inScope(c, { kind: 'recent' }, { now })).length
  const frequent = commands.filter((c) => inScope(c, { kind: 'frequent' }, { now })).length
  const pinCount = commands.filter((c) => pinned.has(c.id)).length

  const entries: ScopeEntry[] = [
    { scope: { kind: 'all' }, label: '全部命令', count: commands.length, depth: 0 },
    { scope: { kind: 'recent' }, label: '最近使用', count: recent, depth: 0 },
    { scope: { kind: 'frequent' }, label: '最常用', count: frequent, depth: 0 },
    { scope: { kind: 'pinned' }, label: '已收藏', count: pinCount, depth: 0 }
  ]

  const orderRank = new Map(groupOrder.map((g, i) => [g, i]))
  const groups = [...counts.keys()].sort((a, b) => {
    const ra = orderRank.get(a)
    const rb = orderRank.get(b)
    if (ra !== undefined && rb !== undefined) return ra - rb
    if (ra !== undefined) return -1
    if (rb !== undefined) return 1
    return a.localeCompare(b, 'zh-CN')
  })

  for (const g of groups) {
    entries.push({
      scope: { kind: 'group', group: g },
      label: g,
      count: counts.get(g) ?? 0,
      depth: Math.max(0, g.split('/').length - 1)
    })
  }

  return entries
}

/** 判断两个 scope 是否等价（用于选中态比较） */
export function sameScope(a: Scope, b: Scope): boolean {
  return a.kind === b.kind && (a.kind !== 'group' || a.group === b.group)
}

/* ------------------------------------------------------------------ *
 *  中英别名：命令名基本是中文（「查看磁盘占用」），命令文本是英文（df -h）。
 *  用户却常按英文想事 —— 敲 disk 找不到「磁盘占用」，敲 内存 找不到 free -m。
 *
 *  收词原则：只收「有辨识度」的词。dev / ip / config / current / image / unit
 *  这类在任意 shell 文本里都能撞上的通用词一律不收 —— 收进来就等于
 *  敲一次 串口 把 /dev/xxx 相关全捞一遍。宁可少扩展，也不要脏结果。
 *  短词（df / ps / ss）由用户直接输入就能命中，不需要当别名。
 * ------------------------------------------------------------------ */

const SYNONYMS: Array<{ zh: string[]; en: string[] }> = [
  { zh: ['磁盘', '硬盘', '空间'], en: ['disk', 'df', 'partition', 'storage'] },
  { zh: ['挂载', '挂载点'], en: ['mount', 'fstab'] },
  { zh: ['内存'], en: ['mem', 'memory', 'free', 'ram'] },
  { zh: ['进程'], en: ['process', 'proc', 'pid'] },
  { zh: ['负载', '压力'], en: ['load', 'loadavg', 'uptime'] },
  { zh: ['网络', '网卡', '网口'], en: ['network', 'iface', 'interface', 'nic'] },
  { zh: ['端口', '监听'], en: ['port', 'listen', 'netstat'] },
  { zh: ['连通', '探测', '延迟'], en: ['ping', 'latency', 'probe'] },
  { zh: ['日志', '报错'], en: ['log', 'journal', 'dmesg', 'syslog'] },
  { zh: ['温度', '散热'], en: ['temp', 'thermal', 'sensor'] },
  { zh: ['电源', '电压'], en: ['power', 'voltage', 'supply'] },
  { zh: ['串口'], en: ['tty', 'serial', 'usb'] },
  { zh: ['系统', '版本', '内核'], en: ['system', 'version', 'kernel', 'uname', 'release'] },
  { zh: ['服务', '重启'], en: ['service', 'systemctl', 'restart'] },
  { zh: ['文件', '目录'], en: ['file', 'dir', 'find'] },
  { zh: ['权限', '所有者'], en: ['chmod', 'chown'] },
  { zh: ['用户', '账号'], en: ['user', 'passwd', 'account'] },
  { zh: ['定时', '计划', '任务'], en: ['cron', 'timer', 'schedule'] },
  { zh: ['防火墙'], en: ['firewall', 'iptables'] },
  { zh: ['容器'], en: ['docker', 'container'] },
  { zh: ['固件', '升级'], en: ['firmware', 'flash', 'upgrade'] },
  { zh: ['备份'], en: ['backup'] }
]

/** 把查询词扩展为「同义的另一半」：返回额外用于匹配的词（不含原词） */
export function synonymsOf(query: string): string[] {
  const q = query.trim().toLowerCase()
  // 单字符扩展开销大且噪声高，直接不扩展
  if (q.length < 2) return []
  const out = new Set<string>()
  for (const pair of SYNONYMS) {
    const inZh = pair.zh.some((z) => z.includes(q) || q.includes(z))
    // 英文只认「前缀」或「被包含」，避免 a / i 这类短字母把整张表拉进来
    const inEn = pair.en.some((e) => e.startsWith(q) || (q.length >= 3 && q.includes(e)))
    if (!inZh && !inEn) continue
    for (const w of pair.zh) if (w !== q) out.add(w)
    for (const w of pair.en) if (w !== q) out.add(w)
  }
  return [...out]
}
