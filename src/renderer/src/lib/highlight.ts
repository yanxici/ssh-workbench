/**
 * 终端输出关键词高亮 —— 纯逻辑层（零依赖，可被 scripts/verify-*.cjs 直接打包单测）。
 *
 * 设计边界（都是踩过或预判过的坑）：
 *
 * 1. **只做行级染色，不做列级**。
 *    xterm 的 registerDecoration 支持 foregroundColor 做列级前景色，但那要求
 *    精确算出命中字符的起始列与宽度 —— 中文双宽、emoji、tab 展开、ANSI 序列、
 *    终端自身的 wide-char 合并全都要各算一遍，算错就是把颜色染到隔壁字上。
 *    行级（整行底色 + 左侧色条 + overview ruler 刻度）已经能让「错误一眼扫到」，
 *    代价是零误染。列级等真的有人抱怨再做。
 *
 * 2. **规则是「用户自己写的正则」，必须防住渲染进程被卡死**。
 *    JS 正则不可中断，(a+)+$ 这种能在一次匹配里挂掉整个渲染进程。
 *    做法不是禁用（本地个人工具，拒绝保存比卡顿更让人火大），而是：
 *    - 条数上限、单条 pattern 长度上限；
 *    - 静态风险检查（嵌套量词 / .*.* / 重复可选组）给出警告但允许保存；
 *    - 设置页用当前屏幕样本跑一次试匹配并显示耗时。
 *
 * 3. **必须吃掉 ANSI 再匹配**。
 *    主进程下发的是带转义序列的文本（颜色、光标移动）。直接对原始文本跑
 *    error 会在 ESC[31merrorESC[0m 上命中，但 e ESC[1m r ESC[0m ror 这种
 *    被拆开的就不会 —— 那是同一条输出，只是分了两次着色。所以匹配前统一剥掉
 *    转义序列，得到纯文本再跑。
 *
 * 4. **行分割必须处理 \r**。
 *    进度条（curl、dd、我们的 trzsz）用 \r 回到行首重绘，一行里会有几十个 \r。
 *    把它当换行会产生几十条重复行、几十个 marker，滚动缓冲直接爆掉。
 *    这里的语义是：\r 丢弃当前缓冲（那一行还没结束），\n 结束一行。
 */

import { tNow } from '../i18n/core'

/** 单条规则的最大 pattern 长度：再长必然是机器生成的，不是人手写的 */
export const MAX_PATTERN_LENGTH = 512
/** 规则条数上限：50 条已经能染出一个「圣诞树」，再多只会拖慢每一行 */
export const MAX_RULES = 50

/** 允许的正则标志：g / y 是有状态的（lastIndex 会残留），在这里绝对不许出现 */
const ALLOWED_FLAGS = new Set(['i', 'm', 's', 'u'])

/** #RRGGBB —— xterm 的 backgroundColor / foregroundColor 只认这一种格式 */
const HEX6 = /^#[0-9a-fA-F]{6}$/

export interface HighlightRule {
  id: string
  name: string
  /** 正则源串（不含斜杠与 flags） */
  pattern: string
  /** 正则标志，只允许 imsu 的子集 */
  flags?: string
  enabled: boolean
  /** 整行背景色 #RRGGBB；缺省不染色 */
  background?: string
  /** 行内文字前景色 #RRGGBB；缺省不覆盖（保留终端原有配色） */
  foreground?: string
}

export interface OutputHighlightPrefs {
  enabled: boolean
  rules: HighlightRule[]
}

export interface CompiledRule extends HighlightRule {
  re: RegExp
  background?: string
  foreground?: string
}

export interface RuleError {
  id: string
  name: string
  message: string
}

/* ------------------------------------------------------------------ *
 *  默认规则
 * ------------------------------------------------------------------ */

/**
 * 内置规则：只开两条，且都只染「错的」。
 *
 * 为什么不一上来把 OK / success / done 也染绿：正常输出里这三个词的出现频率
 * 远高于错误，全染的结果是一屏花花绿绿，反而看不出哪一行真的有问题。
 * 想要的人自己加一条就够了（设置页有现成的颜色选择）。
 *
 * 颜色是暗底系的 #RRGGBB（xterm 不收 rgba）：底色压得比较暗，
 * 文字用同色相的高亮版本，这样在浅色主题下也不会糊成一块。
 */
export const DEFAULT_RULES: HighlightRule[] = [
  {
    id: 'builtin-error',
    get name() {
      return tNow('common.highlight.builtinError')
    },
    pattern: '\\b(error|fail(ed|ure)?|fatal|panic|exception|denied|refused)\\b',
    flags: 'i',
    enabled: true,
    background: '#4a1d1d',
    foreground: '#ffb4b4'
  },
  {
    id: 'builtin-warn',
    get name() {
      return tNow('common.highlight.builtinWarn')
    },
    pattern: '\\b(warn(ing)?|deprecated|timeout|timed out)\\b',
    flags: 'i',
    enabled: true,
    background: '#40320f',
    foreground: '#ffd88a'
  }
]

/* ------------------------------------------------------------------ *
 *  ANSI 剥离
 * ------------------------------------------------------------------ */

/**
 * 剥掉 ANSI 转义序列，只留可见文本。
 *
 * 覆盖范围按「终端里真会出现的」来定，不求完整实现 ECMA-48：
 *   CSI  ESC[...m / H / J / K ...      —— 颜色与光标
 *   OSC  ESC]...BEL 或 ESC]...ST       —— 标题、超链接（OSC 8）、OSC 7 的 cwd
 *   DCS / PM / APC                     —— 少见，但吃了不亏
 *   单字符 ESC 序列 ESC(0 / ESC= / ESC> —— 字符集切换
 *   其它 C0 控制字符（除 \t 外）        —— \r \b \x07 这些对匹配没意义
 *
 * 注意 \t 保留：tab 是可见的空白，规则里可能真有人写 \t 去匹配对齐的输出。
 */
export function stripAnsi(input: string, keepNewlines = false): string {
  let out = ''
  let i = 0
  const n = input.length
  while (i < n) {
    const ch = input.charCodeAt(i)
    if (ch === 0x1b) {
      const next = input.charCodeAt(i + 1)
      if (next === 0x5b) {
        // CSI: ESC [ params final(@..~)
        i += 2
        while (i < n) {
          const c = input.charCodeAt(i)
          i++
          if (c >= 0x40 && c <= 0x7e) break
        }
        continue
      }
      if (next === 0x5d || next === 0x50 || next === 0x5e || next === 0x5f) {
        // OSC / DCS / PM / APC：吃到 BEL 或 ST(ESC \) 为止
        i += 2
        while (i < n) {
          const c = input.charCodeAt(i)
          if (c === 0x07) {
            i++
            break
          }
          if (c === 0x1b && input.charCodeAt(i + 1) === 0x5c) {
            i += 2
            break
          }
          i++
        }
        continue
      }
      /*
       * 其余 ESC 序列：
       *    ESC 0x20..0x2F <final>  —— 带一个中间字节，共 3 字节（ESC ( 0 切字符集）
       *    ESC <final>             —— 2 字节（ESC = / ESC > / ESC 7 保存光标）
       * 两种都要整段吃掉。只跳 ESC 和中间字节会把 final 留成可见字符
       * —— 症状是 G0 字符集切过去后屏幕上多出一个 '0' 或 'B'。
       */
      if (next >= 0x20 && next <= 0x2f) {
        i += 3
      } else {
        i += 2
      }
      continue
    }
    if (ch === 0x09) {
      out += '\t'
      i++
      continue
    }
    if (ch < 0x20 || ch === 0x7f) {
      /*
       * \n / \r 在「只取可见文本」的语义下没有意义（调用方要的是纯文本），
       * 但行分割器必须先切行再匹配 —— 它拿到的必须是保换行的版本，
       * 否则整段输出会被粘成一行，这是本模块最容易踩的一处。
       */
      if (keepNewlines && (ch === 0x0a || ch === 0x0d)) {
        out += input[i]
        i++
        continue
      }
      // 其余控制字符直接丢弃
      i++
      continue
    }
    out += input[i]
    i++
  }
  return out
}

/* ------------------------------------------------------------------ *
 *  流式行分割
 * ------------------------------------------------------------------ */

export interface LineSplitter {
  /** 送入一段文本，返回其中已经结束的整行（已剥掉 ANSI，未做 trim） */
  feed(chunk: string): string[]
  /** 当前尚未结束的缓冲（切换规则 / 断线清理时用） */
  readonly pending: string
  reset(): void
}

/** 单行缓冲上限：超过就不再累积（巨型单行输出没有必要匹配，也不该吃内存） */
const MAX_LINE_BUFFER = 8192

/**
 * 行分割器。
 *
 * - \n 结束一行；\r\n 按 \n 处理（\r 被丢弃）；
 * - 单独的 \r（进度条重绘）丢弃当前缓冲，不产生新行；
 * - 超长行直接截断并丢弃剩余，避免一条 512KB 的 JSON 把内存吃满。
 */
export function createLineSplitter(): LineSplitter {
  let buf = ''
  let overflow = false
  /** 上一段 chunk 以 '' 结尾：可能是进度条重绘，也可能是被切开的 CRLF，下一段才知道 */
  let pendingCr = false

  return {
    get pending(): string {
      return buf
    },
    reset(): void {
      buf = ''
      overflow = false
      pendingCr = false
    },
    feed(chunk: string): string[] {
      const lines: string[] = []
      // 切行必须保留 \n / \r：剥干净的话整段输出会被粘成一行
      const text = stripAnsi(chunk, true)
      /*
       * 纯转义序列的分包（比如 \r 之后紧跟一个孤零零的 "\x1b[0m"）剥完是空串。
       * 空串必须原地返回：否则下面 pendingCr 分支会把它当成「\r 后面不是 \n」，
       * 于是作废缓冲、把真正的那一行（通常是命令提示符）丢掉。
       */
      if (!text) return lines
      let start = 0
      /*
       * 续上一段的落单 '\r'。
       * 网络分包完全可能把 \r\n 拆开：前一段以 \r 结尾、后一段以 \n 开头。
       * 原来遇到落单 \r 就直接清空缓冲，于是下一段的 \n 推出一条空行 ——
       * 那一行真正的内容（通常正是命令提示符那一行）在界面上凭空消失。
       */
      if (pendingCr) {
        pendingCr = false
        if (text[0] === '\n') {
          lines.push(buf)
          buf = ''
          overflow = false
          start = 1
        } else {
          // 不是 CRLF：真的是进度条重绘，作废当前行
          buf = ''
          overflow = false
        }
      }
      for (let i = start; i < text.length; i++) {
        const ch = text[i]
        if (ch === '\r' && text[i + 1] === '\n') {
          // CRLF：\r 只是行尾的一部分，不能先清空缓冲（否则整行内容丢失）
          lines.push(buf)
          buf = ''
          overflow = false
          i++
          continue
        }
        if (ch === '\n') {
          // 溢出过的行仍然要产出一条（截断到上限），否则那一行在界面上会凭空消失
          lines.push(buf)
          buf = ''
          overflow = false
          continue
        }
        if (ch === '\r') {
          if (i === text.length - 1) {
            // 落单的 \r 留在段尾：先别下结论，等下一段确认是 CRLF 还是重绘
            pendingCr = true
            continue
          }
          // 进度条重绘：这一行内容作废，等下一次重绘覆盖
          buf = ''
          overflow = false
          continue
        }
        if (overflow) continue
        if (buf.length >= MAX_LINE_BUFFER) {
          overflow = true
          continue
        }
        buf += ch
      }
      return lines
    }
  }
}

/* ------------------------------------------------------------------ *
 *  规则编译与匹配
 * ------------------------------------------------------------------ */

/** 把 flags 收敛成允许的集合（去重、去 g/y、去非法字符） */
export function sanitizeFlags(flags: string | undefined): string {
  if (!flags) return ''
  const set = new Set<string>()
  for (const ch of flags) {
    if (ALLOWED_FLAGS.has(ch)) set.add(ch)
  }
  return [...set].sort().join('')
}

/** 校验一个颜色值；不合法返回 undefined（宁可不染色，也不要把非法值喂给 xterm） */
export function sanitizeColor(color: string | undefined): string | undefined {
  if (!color) return undefined
  const t = color.trim()
  return HEX6.test(t) ? t : undefined
}

/**
 * 编译规则表。
 *
 * 返回值刻意分成两份：能用的 compiled、以及编译失败的 errors。
 * 调用方（设置页）把 errors 就地显示出来 —— 正则写错却静默不生效，
 * 用户只会以为「这个功能坏了」，然后反复改规则重试。
 */
export function compileRules(rules: HighlightRule[] | undefined): {
  compiled: CompiledRule[]
  errors: RuleError[]
} {
  const compiled: CompiledRule[] = []
  const errors: RuleError[] = []
  const list = Array.isArray(rules) ? rules.slice(0, MAX_RULES) : []

  for (const rule of list) {
    if (!rule || rule.enabled === false) continue
    const name = rule.name || rule.pattern || rule.id
    if (!rule.pattern) {
      errors.push({ id: rule.id, name, message: tNow('common.highlight.emptyPattern') })
      continue
    }
    if (rule.pattern.length > MAX_PATTERN_LENGTH) {
      errors.push({
        id: rule.id,
        name,
        message: tNow('common.highlight.patternTooLong', {
          len: rule.pattern.length,
          max: MAX_PATTERN_LENGTH
        })
      })
      continue
    }
    try {
      const re = new RegExp(rule.pattern, sanitizeFlags(rule.flags))
      compiled.push({
        ...rule,
        re,
        background: sanitizeColor(rule.background),
        foreground: sanitizeColor(rule.foreground)
      })
    } catch (err) {
      errors.push({
        id: rule.id,
        name,
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return { compiled, errors }
}

/** 逐条规则试匹配，返回第一条命中的（多条命中时以列表顺序为准，先定义先赢） */
export function matchRule(compiled: CompiledRule[], line: string): CompiledRule | null {
  if (!line) return null
  for (const rule of compiled) {
    // 有 g / y 的话 lastIndex 会残留，这里统一重置一次（sanitizeFlags 已去掉，
    // 但外部可能自己构造 CompiledRule，多一层保险）
    rule.re.lastIndex = 0
    if (rule.re.test(line)) return rule
  }
  return null
}

/* ------------------------------------------------------------------ *
 *  ReDoS 静态体检
 * ------------------------------------------------------------------ */

export interface PatternRisk {
  level: 'ok' | 'warn'
  reasons: string[]
}

/**
 * 正则回溯风险的静态体检（启发式，不求完备）。
 *
 * 只抓三类真会炸的形状：
 *   1. 分组内是量词 + 分组外又套量词：(a+)+ / (\w*)*
 *   2. 相邻的 .* / .+：.*.*
 *   3. 可选组重复：(a?)*
 *
 * 命中只警告不阻断 —— 这些形状在少数场景是真的必要（html 片段的简单匹配），
 * 用户自己写的规则，他自己能判断。但设置页会把这些标黄，并显示实测耗时。
 */
export function assessPattern(pattern: string): PatternRisk {
  const reasons: string[] = []
  if (!pattern) return { level: 'ok', reasons }
  if (/\([^()]*[+*][^()]*\)[+*]/.test(pattern))
    reasons.push(tNow('common.highlight.riskNestedQuantifier'))
  if (/\(\.[^()]*\*[^()]*\)[+*]/.test(pattern)) reasons.push(tNow('common.highlight.riskDotStarGroup'))
  if (/\.\*[^()]{0,20}\.\*/.test(pattern)) reasons.push(tNow('common.highlight.riskMultipleDotStar'))
  if (/\([^()]*\?[^()]*\)[+*]/.test(pattern))
    reasons.push(tNow('common.highlight.riskOptionalGroupRepeat'))
  return { level: reasons.length > 0 ? 'warn' : 'ok', reasons }
}

/* ------------------------------------------------------------------ *
 *  设置归一化
 * ------------------------------------------------------------------ */

/** 缺省偏好：开，两条内置规则（用户清空 rules 后不会被自动塞回来） */
export function defaultHighlightPrefs(): OutputHighlightPrefs {
  return { enabled: true, rules: DEFAULT_RULES.map((r) => ({ ...r })) }
}

/**
 * 归一化设置里的 outputHighlight。
 *
 * 三种输入要区分：
 *   - undefined（老配置 / 从没打开过）：给默认值；
 *   - { rules: [] }（用户手动删光了）：尊重，返回空表，不再塞默认规则；
 *   - 其它：按字段白名单清洗，防止手改 settings.json 塞进奇怪的东西。
 */
export function normalizeHighlight(input: OutputHighlightPrefs | undefined): OutputHighlightPrefs {
  if (!input) return defaultHighlightPrefs()
  const rules = Array.isArray(input.rules) ? input.rules : []
  return {
    enabled: input.enabled !== false,
    rules: rules
      .filter((r): r is HighlightRule => !!r && typeof r.pattern === 'string')
      .slice(0, MAX_RULES)
      .map((r, i) => ({
        id: typeof r.id === 'string' && r.id ? r.id : 'rule-' + i,
        name: typeof r.name === 'string' ? r.name : '',
        pattern: r.pattern,
        flags: sanitizeFlags(r.flags),
        enabled: r.enabled !== false,
        background: sanitizeColor(r.background),
        foreground: sanitizeColor(r.foreground)
      }))
  }
}
