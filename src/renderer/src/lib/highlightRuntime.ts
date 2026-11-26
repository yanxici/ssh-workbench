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

/**
 * 释放一条装饰 —— 连它底下的 marker 一起。
 *
 * IDecoration.dispose() 只把 DOM 装饰从终端摘掉，**不动** registerMarker
 * 创建的那个 marker：marker 会留在终端内部数组里，一直等到它所在的行被
 * 回滚区裁掉才消失。一次裁剪上千条就攒下上千个死 marker，
 * 断连重染再翻一遍，长期开着的工作台会越用越卡。
 */
function disposeDecoration(d: IDecoration): void {
  try {
    d.dispose()
  } catch {
    /* 终端已销毁 */
  }
  try {
    d.marker.dispose()
  } catch {
    /* marker 已随终端/裁剪消失 */
  }
}

/** 丢掉超量的旧装饰（从最老的开始） */
function trim(s: SessionHighlight): void {
  while (s.decorations.length > MAX_DECORATIONS) {
    const old = s.decorations.shift()
    if (old) disposeDecoration(old)
  }
}

/**
 * 给「这一批数据里命中的行」挂装饰。
 *
 * base 是「最后一条完整行相对光标的偏移」，由**分割器里是否还剩半行**决定：
 *   - 没有半行（chunk 以 \n 或 \r 收尾，光标落在新行/本行行首）→ -1；
 *   - 还有半行（光标正停在那截尾巴上）→ -2。
 * 之后每往前一行再 -1。
 *
 * 以前这里判的是「chunk 是否以 \n 结尾」，把「以 \r 结尾但不换行」也算成
 * -2，于是报错行和紧跟其后的 shell 提示符挤在同一个包里时（`ERROR\r\n` +
 * `root@host:~# `），高亮整体上移一行画到报错行的上一行去。
 */
function decorate(
  term: Terminal,
  s: SessionHighlight,
  hits: HitLine[],
  pendingCols: number
): void {
  if (hits.length === 0) return
  /*
   * base 是「最后一条完整行」相对光标的偏移。
   *
   * 光标此刻停在**最后那条完整行的尾部**（它没有跟着换行 —— 整包数据在写完
   * 最后一行后没有换行符，xterm 就把光标留在这一行末尾）。所以最后一条完整行
   * 永远是 -1，不再因为「还有半行」变成 -2：那半行是写在光标当前行上的，
   * 并没有多占一行。原来的 -2 让整块高亮统一上移一行 —— 也就是报告里那个
   * 「高亮画到报错行上一行」的老 bug。
   *
   * 唯一需要补偿的是折行：半行太长被折成 extraRows 行时，光标被推到折行的
   * 末行，最后一条完整行相对它就又远了 extraRows 行。
   */
  const extraRows = pendingCols > 0 ? Math.floor((pendingCols - 1) / Math.max(1, term.cols)) : 0
  const base = 1 + extraRows
  for (const hit of hits) {
    const back = base + hit.fromEnd
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

  /*
   * 半行长度必须在这里同步快照。
   *
   * term.write 的回调是异步队列里出来的，那时下一包数据可能已经 feed 过，
   * s.splitter.pending 装的是**别人的**尾巴：包 1（"ERROR\n"）+ 包 2
   * （提示符）连着到时，包 1 的回调会看到包 2 的 pending 而多算一行。
   */
  const pendingCols = s.splitter.pending.length
  const hits: HitLine[] = []
  for (let i = 0; i < lines.length; i++) {
    const rule = matchRule(compiled, lines[i])
    if (rule) hits.push({ rule, fromEnd: lines.length - 1 - i })
  }
  if (hits.length === 0) {
    term.write(data)
    return
  }

  /*
   * write 的回调在数据真正解析完之后触发。这里不 await（App 的数据回调是同步的，
   * 也不该为染色拖慢输出）；回调只做注册，不做解析。
   */
  term.write(data, () => {
    decorate(term, s, hits, pendingCols)
  })
}

/** 断开连接 / 重连前清掉该会话的染色：半透明遮罩下的染色行看起来像「断了还在报错」 */
export function clearSession(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  for (const d of s.decorations) disposeDecoration(d)
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
