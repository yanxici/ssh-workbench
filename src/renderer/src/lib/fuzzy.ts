/**
 * 轻量模糊匹配（子序列 + 位置/连续度加权），零依赖。
 *
 * 为什么不用现成库：命令中心每次输入只对几百条命令打分，
 * 自带 60 行实现即可，省掉一个依赖和一份打包体积。
 *
 * 打分模型（越高越相关）：
 *   1. 原文包含完整查询（子串命中）—— 最强信号，直接给 1000 分档；
 *   2. 否则做子序列匹配，每个命中字符按「是否词首 / 是否连续 / 位置靠前」加分，
 *      再按命中跨度做惩罚，避免 `dc` 把 `d…c` 隔了半行的命令排到前面。
 *
 * 中文也能用：子序列匹配在汉字序列上同样成立（「盘空」命中「查看磁盘空间」）。
 */

export interface FuzzyMatch {
  /** 相关度分数，恒 > 0 表示命中 */
  score: number
  /** 命中字符在原文中的下标，供高亮使用 */
  indices: number[]
  /** 是否为完整子串命中（而非子序列散落命中）；别名兜底时只认这种 */
  direct: boolean
}

/** 词边界字符：命中这些字符之后的首字母算「词首」，权重要高 */
const SEPARATORS = new Set([
  ' ',
  '-',
  '_',
  '/',
  '\\',
  '.',
  ':',
  '>',
  '|',
  ',',
  ';',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '"',
  "'",
  '`',
  '·',
  '【',
  '】',
  '（',
  '）'
])

/** 子序列命中的保底分：低于它就当作没命中（见下方说明） */
const SUBSEQUENCE_FLOOR = 118

function isBoundary(text: string, i: number): boolean {
  if (i <= 0) return true
  const prev = text[i - 1]
  if (SEPARATORS.has(prev)) return true
  // camelCase / PascalCase 边界：aB
  const cur = text[i]
  if (prev >= 'a' && prev <= 'z' && cur >= 'A' && cur <= 'Z') return true
  return false
}

/** 空查询视为命中（分数 0），便于调用方直接把全部条目按其它维度排序 */
export function fuzzyMatch(text: string, query: string): FuzzyMatch | null {
  if (!query.trim()) return { score: 0, indices: [], direct: false }

  const lowerText = text.toLowerCase()
  const lowerQuery = query.trim().toLowerCase()

  /* ---------- ① 完整子串命中 ---------- */
  const direct = lowerText.indexOf(lowerQuery)
  if (direct >= 0) {
    const indices: number[] = []
    for (let k = 0; k < lowerQuery.length; k++) indices.push(direct + k)
    let score = 1000
    if (direct === 0) score += 220
    else if (isBoundary(text, direct)) score += 130
    else score -= Math.min(direct, 40)
    // 越接近整体（原文没有被多余字符稀释）越相关
    score -= Math.min(text.length - lowerQuery.length, 60)
    return { score, indices, direct: true }
  }

  /* ---------- ② 子序列匹配 ---------- */
  const indices: number[] = []
  let cursor = 0
  for (let qi = 0; qi < lowerQuery.length; qi++) {
    const found = lowerText.indexOf(lowerQuery[qi], cursor)
    if (found < 0) return null
    indices.push(found)
    cursor = found + 1
  }

  let score = 100
  for (let k = 0; k < indices.length; k++) {
    const idx = indices[k]
    if (isBoundary(text, idx)) score += 18
    if (k > 0 && indices[k - 1] === idx - 1) score += 10
    score += Math.max(0, 12 - idx)
  }
  const span = indices[indices.length - 1] - indices[0] + 1
  score -= Math.max(0, span - indices.length) * 3

  // 命中字符散得太开就当作没命中：长 shell 命令里随手能凑出 d…i…s…k 这种子序列，
  // 留成 1 分的结果只会污染列表（敲 disk 冒出「GPIO 状态」就是这类）。
  if (score < SUBSEQUENCE_FLOOR) return null

  return { score, indices, direct: false }
}
