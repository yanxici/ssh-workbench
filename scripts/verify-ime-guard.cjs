/**
 * IME 组合态守卫回归：确认每个「消费 Enter 的键盘 handler」都有守卫。
 *
 * 为什么需要这个脚本：IME 的 bug 只在中日韩输入法下复现，开发者用英文输入法
 * 敲一辈子都撞不到。它不会在运行时暴露，只能靠静态断言把范围钉住 ——
 * 少一处守卫，就多一个「用户想选字，结果执行了半截命令」的入口。
 *
 * 判据（按 2.6 的规矩，必须能在修复未落地时红）：
 *
 *   1. 扫全仓 .tsx，找所有消费 Enter 的 handler：
 *      - 直接写在 JSX 属性里的 onKeyDown={(e) => ... if (e.key === 'Enter') ...}
 *      - 具名 handler（const onKeyDown = (e: React.KeyboardEvent) => ...）挂到 JSX 上
 *   2. 对每个 handler 判定它「需不需要守卫」：
 *      a. handler 挂在 <input>/<textarea> 上 → 需要（用户就在输入框里打字）
 *      b. handler 挂在容器元素上，且子树里含 <input>/<textarea> → 需要
 *         （事件从子输入框冒泡上来，容器 handler 照样执行）
 *      c. handler 挂在行级元素（tabIndex 的 div，子树无 input）→ 不需要，
 *         但要**打印出来供人工复核**，不能静默跳过
 *   3. 需要守卫的 handler，其函数体首部必须出现 `isImeComposing(e)`
 *
 * 为什么必须 grep `isImeComposing(e)` 而不是 `isComposing`：
 * 写成 `if (e.isComposing) return` 是**假绿**——React 合成事件没有这个字段，
 * 读它恒为 undefined，守卫永不生效，而静态检查照样绿。这正是 2.6 表格第三类
 * 「系统自己先抛错」的同构形态：断言看了终态，没看区分度。
 *
 * 为什么宿主判定要用字符级分词而不是「向上找最近的 <tag」：
 * 本项目 JSX 的属性跨多行（`<input` 在 :128，`onKeyDown` 在 :133），
 * 向上找最近的 `<tag` 会撞上相邻元素（把 `<option>`、`<span>` 当成宿主），
 * 结果 13 处里 11 处被误判成「不需要守卫」，脚本一片绿而实际漏修 ——
 * 这本身就是 2.6 表格第二类「判据看不出差异」。
 *
 * 为什么容器 handler 不能机械地全部加守卫（c 类要打印而不是静默跳过）：
 * ConnectionSidebar:485 的容器 handler 只处理 Escape，其子树里的搜索框在另一个
 * toolbar 分支下，Enter 不会冒泡到它。机械套用「容器一律加守卫」会写出无效代码；
 * 静默跳过则会让真正的漏项（CommandCenter 那种子树含 input 的容器）藏起来。
 * 所以 c 类必须逐条列出来给人看。
 *
 * 用法：node scripts/verify-ime-guard.cjs
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src', 'renderer', 'src')

let failed = 0
function check(name, cond, extra) {
  if (cond) {
    console.log('  PASS  ' + name + (extra ? '  —  ' + extra : ''))
  } else {
    console.log('  FAIL  ' + name + (extra ? '  —  ' + extra : ''))
    failed++
  }
}

function collect(dir, out = []) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    const st = fs.statSync(p)
    if (st.isDirectory()) collect(p, out)
    else if (f.endsWith('.tsx')) out.push(p)
  }
  return out
}

/** 字符偏移 → 行号（1 基） */
function lineIndex(src) {
  const map = new Uint32Array(src.length + 1)
  let line = 1
  for (let i = 0; i < src.length; i++) {
    map[i] = line
    if (src[i] === '\n') line++
  }
  map[src.length] = line
  return map
}

/**
 * 字符级 JSX 元素分词：返回所有元素 { name, openStartLine, openEndLine, closeLine, selfClosing }。
 *
 * 扫描 `<tag`，向前走找到该开标签真正的 `>`（跳过引号内、`{}` 表达式内的 `>`），
 * 再向后找匹配的 `</tag>`。自闭合（`/>`）没有 closeLine。
 */
function parseElements(src, lines) {
  const elements = []
  const n = src.length
  let i = 0
  while (i < n) {
    if (src[i] !== '<') {
      i++
      continue
    }
    // 只认小写原生标签；大写是组件或类型断言（<HTMLElement>），不是宿主
    const m = /^<([a-z][a-zA-Z0-9]*)([\s>/])/.exec(src.slice(i, i + 40))
    if (!m) {
      i++
      continue
    }
    const name = m[1]
    const start = i
    // 找开标签结束的 '>'
    let j = i + 1 + name.length
    let brace = 0
    let quote = null
    let end = -1
    for (; j < n; j++) {
      const c = src[j]
      if (quote) {
        if (c === quote && src[j - 1] !== '\\') quote = null
        continue
      }
      if (c === '"' || c === "'" || c === '`') {
        quote = c
        continue
      }
      if (c === '{') brace++
      else if (c === '}') brace--
      else if (c === '>' && brace === 0) {
        end = j
        break
      }
    }
    if (end < 0) break
    const selfClosing = src[end - 1] === '/'
    const openStartLine = lines[start]
    const openEndLine = lines[end]
    let closeLine = null
    if (!selfClosing) {
      /*
       * 必须按嵌套深度找匹配的闭标签，不能用 indexOf('</div>')：
       * 那会命中第一个内层 `</div>`，把容器子树截断成几十行，
       * 子树里明明有 input 却判成「不含 input」→ 漏报（假绿）。
       */
      let depth = 1
      let k = end + 1
      while (k < n && depth > 0) {
        const nextOpen = src.indexOf('<' + name, k)
        const nextClose = src.indexOf('</' + name + '>', k)
        if (nextClose < 0) break
        if (nextOpen >= 0 && nextOpen < nextClose) {
          // 跳过这个嵌套开标签的 `>`
          let q = nextOpen + 1 + name.length
          let br = 0
          let qt = null
          for (; q < n; q++) {
            const c2 = src[q]
            if (qt) {
              if (c2 === qt && src[q - 1] !== '\\') qt = null
              continue
            }
            if (c2 === '"' || c2 === "'" || c2 === '`') {
              qt = c2
              continue
            }
            if (c2 === '{') br++
            else if (c2 === '}') br--
            else if (c2 === '>' && br === 0) break
          }
          const selfNested = src[q - 1] === '/'
          if (!selfNested) depth++
          k = q + 1
          continue
        }
        depth--
        if (depth === 0) {
          closeLine = lines[nextClose]
          break
        }
        k = nextClose + 1
      }
    }
    elements.push({ name, start, end, openStartLine, openEndLine, closeLine, selfClosing })
    i = end + 1
  }
  return elements
}

/** 找覆盖该行的最内层元素（属性所在的行属于它的开标签区间） */
function hostAt(elements, line) {
  let best = null
  for (const el of elements) {
    const covers =
      (line >= el.openStartLine && line <= el.openEndLine) ||
      (el.closeLine && line > el.openEndLine && line <= el.closeLine)
    if (!covers) continue
    const span = (el.closeLine ?? el.openEndLine) - el.openStartLine
    if (!best || span < best.span) best = { el, span }
  }
  return best ? best.el : null
}

/** 取函数体前 4 个有效代码行 */
function headOf(lines, fromLine) {
  const body = []
  for (let i = fromLine; i < lines.length && body.length < 5; i++) {
    const t = lines[i].trim()
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue
    body.push(t)
  }
  return body.join(' ')
}

const files = collect(SRC)
const needGuard = []
const rows = []

for (const p of files) {
  const raw = fs.readFileSync(p, 'utf8')
  const src = raw.replace(/\r\n/g, '\n')
  const lines = src.split('\n')
  const lmap = lineIndex(src)
  const elements = parseElements(src, lmap)
  const rel = p.slice(ROOT.length + 1).replace(/\\/g, '/')

  for (let li = 0; li < lines.length; li++) {
    if (!/key === 'Enter'/.test(lines[li])) continue
    const lineNo = li + 1

    // 找这个 Enter 判断所属的 handler 起点
    let hLine = lineNo
    for (let j = li; j >= 0 && j > li - 60; j--) {
      if (/onKeyDown=/.test(lines[j]) || /const\s+onKeyDown\s*=/.test(lines[j])) {
        hLine = j + 1
        break
      }
    }

    // 具名 handler：找挂载点
    let anchorLine = hLine
    const named = (lines[hLine - 1] || '').match(/const\s+([a-zA-Z_$][\w$]*)\s*=/)
    if (named) {
      const re = new RegExp('onKeyDown=\\{' + named[1].replace(/\$/g, '\\$') + '\\}')
      for (let k = 0; k < lines.length; k++) {
        if (re.test(lines[k])) {
          anchorLine = k + 1
          break
        }
      }
    }

    const hostEl = hostAt(elements, anchorLine)
    const tag = hostEl ? hostEl.name : null

    let kind
    if (tag === 'input' || tag === 'textarea') kind = 'input'
    else if (hostEl) {
      // 容器：子树区间里有没有 input
      const from = hostEl.openStartLine - 1
      const to = hostEl.closeLine ?? hostEl.openEndLine
      const subtree = lines.slice(from, to).join('\n')
      kind = /<input|<textarea/.test(subtree) ? 'container-with-input' : 'row'
    } else kind = 'unknown'

    const head = headOf(lines, hLine - 1)
    const guarded = /isImeComposing\s*\(\s*e\s*\)/.test(head)
    const badGuard = /e\.isComposing/.test(head)

    const item = { rel, line: lineNo, hLine, tag, kind, guarded, badGuard }
    if (kind === 'input' || kind === 'container-with-input') needGuard.push(item)
    else rows.push(item)
  }
}

console.log('\n=== 需要守卫的 handler ===')
for (const it of needGuard) {
  console.log(
    `  ${it.rel}:${it.line}  host=${it.kind}<${it.tag}>  guarded=${it.guarded}`
  )
}
console.log('\n=== 行级 handler（不需要守卫，供人工复核）===')
for (const it of rows) {
  console.log(`  ${it.rel}:${it.line}  host=${it.kind}<${it.tag ?? '?'}>`)
}

console.log('\n=== 断言 ===')
check(
  '需要守卫的 handler 数 === 13（少一处就是漏修）',
  needGuard.length === 13,
  `实际 ${needGuard.length}`
)
check(
  '每一处需要守卫的 handler 都有 isImeComposing(e)',
  needGuard.every((it) => it.guarded),
  needGuard.filter((it) => !it.guarded).map((it) => `${it.rel}:${it.line}`).join(', ') || '全部有'
)
check(
  '没有一处写成 e.isComposing（React 合成事件无此字段，是假绿）',
  needGuard.every((it) => !it.badGuard) && !rows.some((it) => it.badGuard),
  needGuard.filter((it) => it.badGuard).map((it) => `${it.rel}:${it.line}`).join(', ') || '无'
)
check(
  '行级 handler 被列出而非静默跳过（静默跳过本身就是假绿形态）',
  rows.length > 0,
  `列出 ${rows.length} 处`
)
check(
  'isImeComposing 实现里读的是 nativeEvent.isComposing',
  /nativeEvent\??\.isComposing/.test(fs.readFileSync(path.join(SRC, 'lib', 'ime.ts'), 'utf8')),
  'lib/ime.ts'
)

console.log(`\n结果：${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
