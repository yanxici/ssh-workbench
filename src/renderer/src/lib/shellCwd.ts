/**
 * 终端「当前目录」推断：输入行追踪 + `cd` 解析 + OSC 7 解析。
 *
 * 这是「cd 之后让侧栏跟过去」的第一层。为什么要自己解析命令行：
 *
 *   SSH 协议本身不告诉你交互 shell 的 cwd。能拿到 cwd 的正规途径只有三条：
 *   1) shell 自己上报（OSC 7，需要远端配了 PROMPT_COMMAND/vte.sh）；
 *   2) 反查远端进程的 /proc/<pid>/cwd（要先认出哪个 pid 是我们的 shell，
 *      busybox / macOS 上直接没有 /proc）；
 *   3) 往 pty 里注入一段 hook（会在终端里留下一行可见的回显，改用户环境）。
 *
 *   三条都不够干净。而用户说的场景其实非常具体 ——「**我 cd 的时候**侧栏跟过去」，
 *   也就是 cwd 的变化来自他自己敲的那一行命令。那这一行我们本来就看得见：
 *   xterm 的 onData 里流过去的正是用户键入的字节，回车时把它解析出来就行，
 *   零往返、零侵入、不改远端环境。
 *
 *   于是策略是「快而可能略糙」：本地解析 cd 立即跟随（本文件），OSC 7 到了再
 *   用权威值覆盖（见 parseOsc7），两者互补。
 *
 * 本文件保持**零依赖纯逻辑**：不 import 任何 store / IPC，
 * 这样 scripts/verify-shellcwd.cjs 能用 esbuild 直接把它打成 CJS 做单测。
 */

/** 单行缓冲上限：超过就判定这行不可信（粘贴大段文本时不必再猜） */
const MAX_LINE = 4096

/** bracketed paste 的起止标记（xterm 在 paste 模式下发出来的是这两个） */
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'

export interface InputTracker {
  /** 送入一段用户输入（xterm onData 的原始字节）；返回整行命令，或 null */
  feed(data: string): string | null
  /** 当前尚未回车的缓冲（诊断 / 测试用） */
  readonly line: string
}

/**
 * 输入行追踪器。
 *
 * 只做一件事：把用户敲的字节还原成「回车前的那一整行」。
 *
 * 两类输入要区别对待：
 *
 * - **按键流**（逐字符）：方向键翻历史、Tab 补全会改变行内容而我们看不到结果 ——
 *   这类整行标记为不可信，宁可这一行不跟随，也不要跟到一个错的目录。
 * - **粘贴**（bracketed paste，`\x1b[200~ … \x1b[201~`）：内容原样进入行缓冲，
 *   我们看得见，所以照常累积 —— `cd /very/long/path` 复制粘贴是最常见的用法，
 *   把它当成「不可信」等于让跟随功能在最需要它的场景下失效。
 */
export function createInputTracker(): InputTracker {
  let buf = ''
  let unknown = false
  /** ESC 序列的累积缓冲：序列可能被拆到两次 feed 里（终端一次只给几个字节） */
  let esc = ''
  /** 是否处于 bracketed paste 中 */
  let paste = false

  return {
    get line(): string {
      return buf
    },

    feed(data: string): string | null {
      let completed: string | null = null
      const text = esc + data
      esc = ''

      for (let i = 0; i < text.length; i++) {
        const ch = text[i]

        /* ---------- 粘贴模式：内容原样进缓冲，只认结束标记 ---------- */
        if (paste) {
          if (ch === '\x1b') {
            const rest = text.slice(i)
            if (PASTE_END.startsWith(rest)) {
              // 结束标记还没收全：留到下次
              esc = rest
              break
            }
            if (rest.startsWith(PASTE_END)) {
              paste = false
              i += PASTE_END.length - 1
              continue
            }
            // 粘贴内容里出现别的转义序列（罕见）：按普通字符忽略掉 ESC
            continue
          }
          if (ch < ' ' && ch !== '\n' && ch !== '\r') continue
          /*
           * 粘贴块里的换行：readline 会把它塞进行缓冲、回车时逐行执行，
           * 「哪一行会真的跑」取决于在哪个光标位置 —— 模型太脆，直接作废。
           * 单行粘贴（最常见的 `cd /long/path`）不受影响。
           */
          if (ch === '\n' || ch === '\r') {
            unknown = true
            buf = ''
            continue
          }
          buf += ch
          if (buf.length > MAX_LINE) {
            unknown = true
            buf = ''
          }
          continue
        }

        /* ---------- ESC 序列 ---------- */
        if (ch === '\x1b') {
          const rest = text.slice(i)
          if (rest.length < PASTE_START.length && PASTE_START.startsWith(rest)) {
            // 可能是粘贴标记的开头，收全了再判断
            esc = rest
            break
          }
          if (rest.startsWith(PASTE_START)) {
            paste = true
            i += PASTE_START.length - 1
            continue
          }
          /*
           * 其它 ESC 序列：方向键（\x1b[A）、Home/End…… 都会改写缓冲区且结果不回传，
           * 整行作废；顺带把 CSI 序列本体吃掉，避免 '[A' 被当成普通字符塞进缓冲。
           */
          unknown = true
          if (text[i + 1] === '[' || text[i + 1] === 'O') {
            i += 2
            while (i < text.length && !/[A-Za-z~]/.test(text[i])) i++
          }
          continue
        }

        if (ch === '\r' || ch === '\n') {
          /* 空行（连敲回车）不该产生一次「命令」；不可信行直接丢弃 */
          if (!unknown && buf.trim()) completed = buf
          buf = ''
          unknown = false
          continue
        }
        if (ch === '\x7f' || ch === '\b') {
          buf = buf.slice(0, -1)
          continue
        }
        if (ch === '\x15') {
          // Ctrl-U：清空整行
          buf = ''
          unknown = false
          continue
        }
        if (ch === '\x03') {
          // Ctrl-C：放弃这一行
          buf = ''
          unknown = false
          continue
        }
        if (ch === '\x17') {
          // Ctrl-W：删掉最后一个词（保留它前面的空格，与 bash 的
          // backward-kill-word 一致：`cd /var/log` → `cd ` 而不是 `cd`）
          buf = buf.replace(/\S+$/, '')
          continue
        }
        if (ch === '\t') {
          // Tab 补全会把参数补成我们看不到的样子
          unknown = true
          continue
        }
        if (ch < ' ') continue

        buf += ch
        if (buf.length > MAX_LINE) {
          unknown = true
          buf = ''
        }
      }

      return completed
    }
  }
}

/** 归一化远端 POSIX 路径：折叠重复斜杠、消掉 `.` / `..`、去掉尾斜杠 */
export function normalizePosix(input: string): string {
  const out: string[] = []
  for (const seg of input.split('/')) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return '/' + out.join('/')
}

/** 把一条简单命令切成 argv；dynamic = 含 shell 展开（$ * ? ` 等），值不可预知 */
function tokenize(segment: string): { argv: string[]; dynamic: boolean } {
  const argv: string[] = []
  let cur = ''
  let has = false
  let dynamic = false
  let quote: '"' | "'" | null = null

  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]

    if (quote === "'") {
      if (ch === "'") quote = null
      else cur += ch
      continue
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null
      } else if (ch === '$' || ch === '`') {
        dynamic = true
        cur += ch
      } else {
        cur += ch
      }
      continue
    }

    if (ch === "'" || ch === '"') {
      quote = ch
      has = true
      continue
    }
    if (ch === '\\' && i + 1 < segment.length) {
      cur += segment[++i]
      has = true
      continue
    }
    if (ch === ' ' || ch === '\t') {
      if (has) {
        argv.push(cur)
        cur = ''
        has = false
      }
      continue
    }
    if (ch === '$' || ch === '`' || ch === '*' || ch === '?' || ch === '[') dynamic = true
    cur += ch
    has = true
  }
  if (has) argv.push(cur)
  if (quote !== null) dynamic = true // 引号没闭合：这行不完整
  return { argv, dynamic }
}

/** 按控制操作符把命令行切成简单命令（`;` `&&` `||` `|` 换行） */
function splitCommands(cmdline: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null

  for (let i = 0; i < cmdline.length; i++) {
    const ch = cmdline[i]
    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '\\' && i + 1 < cmdline.length) {
      cur += ch + cmdline[++i]
      continue
    }
    if (ch === ';' || ch === '\n') {
      out.push(cur)
      cur = ''
      continue
    }
    if (ch === '&' && cmdline[i + 1] === '&') {
      out.push(cur)
      i++
      cur = ''
      continue
    }
    if (ch === '|') {
      out.push(cur)
      if (cmdline[i + 1] === '|') i++
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/**
 * cd 的位置参数（跳过 `-L` / `-P` / `--` 这类选项）。
 *
 * - 返回 `string`：唯一的位置参数
 * - 返回 `null`：没有位置参数（裸 `cd`，回 home）
 * - 返回 `undefined`：位置参数多于一个 —— bash 会报 "too many arguments" 并**不动**目录，
 *   所以这一行不能跟随
 */
function cdArg(argv: string[]): string | null | undefined {
  let found: string | null = null
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') continue
    if (/^-[LPe@]+$/.test(a)) continue
    if (found !== null) return undefined
    found = a
  }
  return found
}

/** 把一个 cd 参数解析成绝对路径；不可判定时返回 null */
function resolveArg(arg: string, base: string, home: string): string | null {
  if (!arg || arg === '-') return null

  let p = arg
  if (p === '~') p = home
  else if (p.startsWith('~/')) p = home + p.slice(1)
  else if (p.startsWith('~')) return null // ~user：查不到别人的 home
  if (!p) return null

  if (!p.startsWith('/')) {
    // 相对路径必须有一个已知基准，否则宁可不动
    if (!base || !base.startsWith('/')) return null
    p = base.replace(/\/+$/, '') + '/' + p
  }
  return normalizePosix(p)
}

/**
 * 从一整行命令里推断 cd 之后的目录。
 *
 * @param cmdline 回车前那一行（已通过 InputTracker 的可信性检查）
 * @param base    当前已知的远端目录（相对路径的基准）
 * @param home    远端 home（`cd` / `cd ~` 的目标）
 * @returns 绝对路径；这一行没有 cd、或含变量/通配符等不可预知内容时返回 null
 *
 * 只认 `cd`：`pushd`/`z`/`j` 之类虽然也换目录，但语义依赖外部工具，猜错比不跟更糟。
 * 一行里的多个 cd（`cd /a && cd b`）取最后一个 —— 与 shell 的最终 cwd 一致。
 */
export function resolveCdPath(cmdline: string, base: string, home: string): string | null {
  const line = (cmdline ?? '').trim()
  if (!line) return null

  let result: string | null = null
  for (const segment of splitCommands(line)) {
    const { argv, dynamic } = tokenize(segment)
    if (argv.length === 0) continue

    // `builtin cd` / `command cd` 等价于 cd
    let head = argv[0]
    let from = 1
    if (head === 'builtin' || head === 'command') {
      if (argv.length < 2) continue
      head = argv[1]
      from = 2
    }
    if (head !== 'cd') continue
    if (dynamic) return null

    const arg = cdArg([head, ...argv.slice(from)])
    // undefined = 多个位置参数，shell 会报错且不换目录
    if (arg === undefined) return null
    if (arg === null) {
      // 裸 `cd` = 回 home
      if (home && home.startsWith('/')) result = normalizePosix(home)
      else return null
      continue
    }
    const next = resolveArg(arg, base, home)
    if (!next) return null
    result = next
  }
  return result
}

/**
 * 快速预筛：这一行里到底有没有 `cd`。
 *
 * 目的纯粹是省事 —— 绝大多数敲进去的行（`ls`、`tail -f`、`vim x`）里没有 cd，
 * 不必走完整的分词/解析，更不必为了补 home 去发一次 IPC。
 * 用词边界匹配而不是 `includes('cd')`：`abcd` / `cdrom` 不该命中。
 */
export function containsCdCommand(cmdline: string): boolean {
  return /(^|[\s;&|(`])cd($|[\s;&|)])/.test(cmdline)
}

/**
 * 解析 OSC 7（`file://host/path`）载荷 —— shell 配了 shell-integration 时
 * 会主动上报 cwd，这是**权威值**，用来校正本地解析。
 *
 * @param payload `registerOscHandler(7, …)` 回调拿到的字符串（不含 `7;`）
 */
export function parseOsc7(payload: string): string | null {
  if (!payload) return null
  // \u0007 = BEL：OSC 序列的终结符，路径里不该出现，用它截断是必要的
  // eslint-disable-next-line no-control-regex -- 见上：协议终结符必须写进正则
  const m = /^\s*file:\/\/([^/]*)(\/[^\u0007]*)/.exec(payload)
  if (!m) return null
  let path = m[2]
  try {
    path = decodeURIComponent(path)
  } catch {
    /* 非法百分号编码：按原样用 */
  }
  if (!path.startsWith('/')) return null
  return normalizePosix(path)
}
