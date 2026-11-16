/**
 * 终端输出高亮 —— xterm 接入层。
 *
 * 只在**渲染层**工作：主进程下发的文本先过 lib/highlight.ts 的纯逻辑（剥 ANSI、
 * 切行、跑规则），命中行再用 xterm 的 marker + decoration 上色。
 *
 * ---- 为什么要 marker 而不是直接改文字 ----
 * 终端里的内容是字节流的最终产物，往上写颜色会污染会话数据（录制、搜索、
 * 复制出来的文本都会带上我们的记号）。marker 是绑在「缓冲区某一行」上的
 * 独立对象，文字内容一个字都不动，滚动、清屏、复制全都保持原样。
 *
 * ---- 为什么 marker 要在 write 之后注册 ----
 * marker 的坐标是「相对光标的行偏移」，而光标位置只有 write 真正把数据
 * 解析进缓冲区之后才成立。所以这里把「命中的行」先记成偏移量，等
 * write 的 callback 触发再注册 —— 直接同步注册会全都挂到旧行上。
 *
 * ---- 为什么是行级而不是列级 ----
 * 见 lib/highlight.ts 顶部注释：列级要重算中文双宽 / emoji / tab 展开，
 * 算错就是染到隔壁字。行级零误染。
 */

import type { IDecoration, IMarker, Terminal } from '@xterm/xterm'
import {
  createLineSplitter,
  compileRules,
  matchRule,
  normalizeHighlight,
  type CompiledRule,
  type HighlightRule,
  type LineSplitter,
  type OutputHighlightPrefs
} from './highlight'

/** 单个会话最多保留的装饰数：回滚缓冲 5000 行全命中时，也不至于堆出几万个 DOM 节点 */
const MAX_DECORATIONS = 2000

/** marker 偏移的下限：比这更远的行早已滚出可视区，注册了也看不到，纯浪费 */
const MAX_MARKER_BACK = 600

interface HitLine {
  rule: CompiledRule
  /** 相对 chunk 末尾的行数（0 = chunk 里最后一条完整行） */
  fromEnd: number
}

interface SessionHighlight {
  splitter: LineSplitter
  decorations: IDecoration[]
  /** 上次 write 时终端列数，用来给装饰定宽 */
  cols: number
}

const sessions = new Map<string, SessionHighlight>()

let compiled: CompiledRule[] = []
let enabled = true

/**
 * 应用设置。
 *
 * 编译失败不抛错：一条写错的正则不该让整个高亮功能停摆，也不能让
 * 用户在设置页改到一半就发现「其它规则全失效了」。坏规则单独跳过，
 * 设置页自己拿 compileRules 的 errors 去提示。
 */
export function applyHighlightPrefs(prefs: OutputHighlightPrefs | undefined): void {
  const normalized = normalizeHighlight(prefs)
  enabled = normalized.enabled
  compiled = compileRules(normalized.rules).compiled
  if (!enabled) disposeAll()
}

/** 当前生效的规则（设置页预览 / 调试用） */
export function currentRules(): HighlightRule[] {
  return compiled.slice()
}

function stateOf(sessionId: string): SessionHighlight {
  let s = sessions.get(sessionId)
  if (!s) {
    s = { splitter: createLineSplitter(), decorations: [], cols: 80 }
    sessions.set(sessionId, s)
  }
  return s
}

/** 丢掉超量的旧装饰（从最老的开始） */
function trim(s: SessionHighlight): void {
  while (s.decorations.length > MAX_DECORATIONS) {
    const old = s.decorations.shift()
    try {
      old?.dispose()
    } catch {
      /* 终端已销毁：marker 跟着没了，dispose 会抛，忽略 */
    }
  }
}

/**
 * 给「这一批数据里命中的行」挂装饰。
 *
 * base 是「最后一条完整行相对光标的偏移」：
 *   - chunk 以换行结尾 → 光标停在新的空行上，最后一条完整行在 -1；
 *   - chunk 带未完成的尾巴 → 光标停在尾巴上，最后一条完整行在 -2。
 * 之后每往前一行再 -1。
 */
function decorate(
  term: Terminal,
  s: SessionHighlight,
  hits: HitLine[],
  lineCount: number,
  endedWithNewline: boolean
): void {
  if (hits.length === 0) return
  for (const hit of hits) {
    const back = (endedWithNewline ? 1 : 2) + hit.fromEnd
    if (back > MAX_MARKER_BACK) continue
    let marker: IMarker | undefined
    try {
      marker = term.registerMarker(-back)
    } catch {
      continue
    }
    if (!marker) continue
    const deco = term.registerDecoration({
      marker,
      // 整行铺满：x 从 0 起，宽度取终端列数
      x: 0,
      width: s.cols,
      height: 1,
      backgroundColor: hit.rule.background,
      foregroundColor: hit.rule.foreground
    })
    if (!deco) {
      // alt buffer（vim / less / top）里 registerDecoration 返回 undefined —— 正常，跳过
      try {
        marker.dispose()
      } catch {
        /* ignore */
      }
      continue
    }
    s.decorations.push(deco)
    trim(s)
  }
  void lineCount
}

/**
 * 把一段会话数据写进终端，顺手给命中的行上色。
 *
 * 这是**唯一**的写入口：渲染层不该再直接调 term.write(data)。
 * 原因有两个：
 *   1. 写与染色必须共用同一次 write 的 callback —— 分开写会在中间插入
 *      别的事件（重连提示、ZMODEM 收尾），marker 偏移就会错行；
 *   2. 关掉高亮时仍然要走这里（内部退化成 term.write），否则
 *      「关掉高亮后终端不刷新」会成为下一个 bug。
 */
export function writeSessionData(sessionId: string, term: Terminal | undefined, data: string): void {
  if (!term) return
  if (!data) return
  if (!enabled || compiled.length === 0) {
    term.write(data)
    return
  }
  const s = stateOf(sessionId)
  s.cols = term.cols || s.cols

  const lines = s.splitter.feed(data)
  if (lines.length === 0) {
    // 没有任何完整行（半行 / 进度条重绘）：照样要写，否则界面上什么都不动
    term.write(data)
    return
  }

  const hits: HitLine[] = []
  for (let i = 0; i < lines.length; i++) {
    const rule = matchRule(compiled, lines[i])
    if (rule) hits.push({ rule, fromEnd: lines.length - 1 - i })
  }
  if (hits.length === 0) {
    term.write(data)
    return
  }

  const endedWithNewline = data.endsWith('\n')
  /*
   * write 的回调在数据真正解析完之后触发。这里不 await（App 的数据回调是同步的，
   * 也不该为染色拖慢输出）；回调只做注册，不做解析。
   */
  term.write(data, () => {
    decorate(term, s, hits, lines.length, endedWithNewline)
  })
}

/** 断开连接 / 重连前清掉该会话的染色：半透明遮罩下的染色行看起来像「断了还在报错」 */
export function clearSession(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  for (const d of s.decorations) {
    try {
      d.dispose()
    } catch {
      /* ignore */
    }
  }
  s.decorations = []
  s.splitter.reset()
}

/** 会话关闭时连状态一起丢掉（否则 id 复用会继承上一台机器的半行缓冲） */
export function forgetSession(sessionId: string): void {
  clearSession(sessionId)
  sessions.delete(sessionId)
}

function disposeAll(): void {
  for (const id of [...sessions.keys()]) clearSession(id)
}

/** 重染「当前可视屏」：改完规则后不用等新输出也看得到效果 */
export function repaintViewport(sessionId: string, term: Terminal | undefined): number {
  if (!enabled || !term) return 0
  const s = stateOf(sessionId)
  clearSession(sessionId)
  const buf = term.buffer.active
  const start = buf.viewportY
  const end = Math.min(buf.length - 1, start + term.rows - 1)
  let painted = 0

  for (let y = start; y <= end; y++) {
    const line = buf.getLine(y)
    if (!line) continue
    const text = line.translateToString(true)
    const rule = matchRule(compiled, text)
    if (!rule) continue
    // 视口行位于光标上方 n 行：光标在 baseY + cursorY
    const back = buf.baseY + buf.cursorY - y
    if (back > MAX_MARKER_BACK) continue
    let marker: IMarker | undefined
    try {
      marker = term.registerMarker(-back)
    } catch {
      continue
    }
    if (!marker) continue
    const deco = term.registerDecoration({
      marker,
      x: 0,
      width: s.cols,
      height: 1,
      backgroundColor: rule.background,
      foregroundColor: rule.foreground
    })
    if (!deco) {
      try {
        marker.dispose()
      } catch {
        /* ignore */
      }
      continue
    }
    s.decorations.push(deco)
    painted++
  }
  trim(s)
  return painted
}
