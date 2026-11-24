/**
 * 多行粘贴护栏的纯逻辑（渲染层）。
 *
 * 为什么需要：终端里粘一段多行文本，远端 shell 会逐行执行 —— 粘错的代价是
 * 一串没人审过的命令直接在服务器上跑。这里只做「要不要拦一下」的判定，
 * 弹窗与写入口在组件层，纯函数便于 scripts/verify-paste-guard.cjs 直接回归。
 *
 * 判定顺序刻意如此：
 *   1. 单行、无末尾回车、无危险词 → 零弹窗零延迟（最常见的 paste 路径）；
 *   2. 多行 → 弹（用户要确认这不是一整段误粘）；
 *   3. 单行但有末尾回车且命中危险词 → 弹（回车会立刻执行，这是唯一兜底）。
 */

/** analyzePaste 的结果；行数等字段给弹窗直接用，避免组件里再算一遍 */
export interface PasteAnalysis {
  /** 是否要先弹确认框 */
  shouldConfirm: boolean
  /** 归一化 CRLF 之后的行数；末尾回车不额外算一行 */
  lineCount: number
  /** 结尾是不是换行（回车会立刻执行） */
  hasTrailingNewline: boolean
  /** 整体是否被一对 ``` 围栏包住 */
  hasCodeFence: boolean
  /** 命中的危险词，顺序同 dangerPatterns */
  matchedDangers: string[]
}

/** 首行围栏：```bash / ```sh / ``` / ```ps1 都算 */
const OPEN_FENCE = /^```[\w-]*\s*$/
/** 末行围栏：允许尾随空白 */
const CLOSE_FENCE = /^```\s*$/

/** 把 \r\n 与孤立 \r 统一成 \n —— Windows 剪贴板里混进来的 \r 会把行数算成两倍 */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * 分析一段待粘贴文本。
 *
 * @param text 原始剪贴板内容（未做任何清洗）
 * @param dangerPatterns 设置里的危险词，按声明顺序回填 matchedDangers
 * @param confirmMultiline 设置开关；关掉后一律不弹
 */
export function analyzePaste(
  text: string,
  dangerPatterns: string[],
  confirmMultiline: boolean
): PasteAnalysis {
  const normalized = normalizeNewlines(text)
  const hasTrailingNewline = normalized.endsWith('\n')

  /*
   * 末尾回车不计入行数：'rm -rf /tmp/x\n' 在用户眼里就是一行。
   * 若算成两行，lineCount >= 2 会先命中，下面「危险词 + 回车」这条分支
   * 就永远跑不到，单行危险命令的兜底等于没有。
   */
  const body = hasTrailingNewline ? normalized.slice(0, -1) : normalized
  const lineCount = body === '' ? 0 : body.split('\n').length

  const lines = body.split('\n')
  const hasCodeFence =
    lines.length >= 2 && OPEN_FENCE.test(lines[0]) && CLOSE_FENCE.test(lines[lines.length - 1])

  const lower = normalized.toLowerCase()
  const matchedDangers = dangerPatterns.filter((p) => p && lower.includes(p.toLowerCase()))

  const shouldConfirm =
    confirmMultiline && (lineCount >= 2 || (hasTrailingNewline && matchedDangers.length > 0))

  return { shouldConfirm, lineCount, hasTrailingNewline, hasCodeFence, matchedDangers }
}

/**
 * 剥掉最外层的 Markdown 代码围栏，并清掉首尾空行。
 *
 * 从文档里粘命令几乎总是带围栏；直接执行会把 ``` 当成命令报错，
 * 所以弹窗给一个「去代码围栏」按钮。非围栏文本原样返回 —— 特别注意
 * 行内反引号（`date`）不是围栏。
 */
export function stripMarkdownFence(text: string): string {
  const normalized = normalizeNewlines(text)
  const lines = normalized.split('\n')
  if (lines.length < 2) return text
  const first = lines[0]
  const last = lines[lines.length - 1]
  if (!OPEN_FENCE.test(first) || !CLOSE_FENCE.test(last)) return text
  const inner = lines.slice(1, -1)
  while (inner.length > 0 && inner[0].trim() === '') inner.shift()
  while (inner.length > 0 && inner[inner.length - 1].trim() === '') inner.pop()
  return inner.join('\n')
}
