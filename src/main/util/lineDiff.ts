import type { DiffLine } from '@shared/types'

/**
 * 行级差异（LCS + 公共前后缀裁剪）—— 纯函数，可独立测试。
 *
 * 策略：先剥掉公共前缀/后缀，只在中段做 LCS 动态规划；
 * 中段规模超过 MAX_CELLS 时退化为「整段删除 + 整段新增」，
 * 保证不会因为两个大文件完全不同而卡死（配置文件差异通常很小，正常走精确路径）。
 */

const MAX_CELLS = 1_200_000

export function lineDiff(oldText: string, newText: string): DiffLine[] {
  // 空文件没有"行"：''.split('\n') 会得到 ['']（一条空行），语义上应归一为 0 行
  const a = oldText === '' ? [] : oldText.split('\n')
  const b = newText === '' ? [] : newText.split('\n')

  // 公共前缀
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1

  // 公共后缀
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1
    endB -= 1
  }

  const out: DiffLine[] = []
  for (let i = 0; i < start; i++) out.push({ type: 'same', text: a[i] })

  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)

  if (midA.length === 0) {
    for (const line of midB) out.push({ type: 'add', text: line })
  } else if (midB.length === 0) {
    for (const line of midA) out.push({ type: 'del', text: line })
  } else if (midA.length * midB.length > MAX_CELLS) {
    // 退化路径：无法精确对齐时，整段替换
    for (const line of midA) out.push({ type: 'del', text: line })
    for (const line of midB) out.push({ type: 'add', text: line })
  } else {
    out.push(...lcsDiff(midA, midB))
  }

  const suffixCount = a.length - endA
  for (let i = 0; i < suffixCount; i++) {
    out.push({ type: 'same', text: a[endA + i] })
  }
  return out
}

function lcsDiff(a: string[], b: string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  const width = m + 1

  // dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const dp = new Int32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * width + j] =
        a[i] === b[j]
          ? dp[(i + 1) * width + j + 1] + 1
          : Math.max(dp[(i + 1) * width + j], dp[i * width + j + 1])
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ type: 'same', text: a[i] })
      i += 1
      j += 1
    } else if (dp[(i + 1) * width + j] >= dp[i * width + j + 1]) {
      out.push({ type: 'del', text: a[i] })
      i += 1
    } else {
      out.push({ type: 'add', text: b[j] })
      j += 1
    }
  }
  while (i < n) {
    out.push({ type: 'del', text: a[i] })
    i += 1
  }
  while (j < m) {
    out.push({ type: 'add', text: b[j] })
    j += 1
  }
  return out
}

/** 统计增删行数 */
export function diffStats(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.type === 'add') added += 1
    else if (l.type === 'del') removed += 1
  }
  return { added, removed }
}
