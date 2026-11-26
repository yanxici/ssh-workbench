/**
 * P0-3 纯 Shell / POSIX 文件操作回退层（BusyBox / 嵌入式设备）。
 *
 * 有些嵌入式设备只跑 dropbear + BusyBox，没有 SFTP 子系统，但一定有一个 POSIX shell。
 * 当 SFTP 不可用时，这一层用最保守的命令集合（ls / cat / wc / cp / mv / rm / mkdir /
 * chmod / pwd）完成同样的文件操作，让文件浏览、编辑、上传下载在老旧设备上仍然可用。
 *
 * 设计约束（详见 docs/superpowers/specs/2026-11-24-p0-embedded-ssh-resilience-design.md）：
 *   - 所有进入 shell 的路径都必须过 shQuote，绝不依赖「路径看起来安全」；
 *   - 删除类操作先过 assertSafeRemovePath，校验失败时一条远端命令都不发；
 *   - 写入走「先备份、再写、写失败回滚」三段式，避免把配置文件写成半截；
 *   - 上传走 .swb-part + mv 的原子替换，下载走 .part + rename，避免留下残缺文件；
 *   - 不引入任何新依赖，只用 node 内置模块与 ssh2 的类型。
 */
import { closeSync, createReadStream, openSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import type { Client, ClientChannel } from 'ssh2'
import type { RemoteFile, RemoteText } from '@shared/types'

/* ------------------------------------------------------------------ */
/* 常量                                                                */
/* ------------------------------------------------------------------ */

/** 批量列目录的并发上限：嵌入式设备吃不消太多并发 shell。 */
export const SHELL_LIST_CONCURRENCY = 4

const LIST_TIMEOUT_MS = 20_000
const SMALL_OP_TIMEOUT_MS = 15_000
const TRANSFER_TIMEOUT_MS = 10 * 60_000
const MIN_EXEC_TIMEOUT_MS = 2_000
const MAX_EXEC_TIMEOUT_MS = 15 * 60_000
const MAX_STDOUT_BYTES = 8 * 1024 * 1024
const STDERR_KEEP_BYTES = 8192
const UPLOAD_CHUNK_BYTES = 64 * 1024
const DRAIN_TIMEOUT_MS = 5_000

/* ------------------------------------------------------------------ */
/* 路径与引号                                                          */
/* ------------------------------------------------------------------ */

/**
 * 把任意字符串包进 POSIX 单引号，内部单引号按 ''' 续接。
 *
 * Review Focus #2：远端路径来自用户输入与远端 ls 输出，任何没被引号包住的
 * 空格、分号、反引号、$( ) 都是注入面。这里不做「看起来安全就不加引号」的优化。
 */
export function shQuote(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/**
 * 删除路径硬校验：空串 / 根 / . / .. / 家目录缩写一律拒绝。
 *
 * 返回归一化后的路径（去尾部斜杠）。校验必须发生在 exec 之前，
 * 否则一次误判就是「rm -rf /」。
 */
export function assertSafeRemovePath(p: string): string {
  const raw = String(p ?? '').trim()
  if (!raw) throw new Error('拒绝删除：路径为空')
  if (raw.startsWith('~')) throw new Error('拒绝删除：不接受家目录缩写路径 ' + raw)
  const stripped = raw.replace(/\/+$/, '')
  if (!stripped) throw new Error('拒绝删除：不接受根目录')
  for (const seg of stripped.split('/')) {
    if (seg === '.' || seg === '..') {
      throw new Error('拒绝删除：路径里含相对段 ' + raw)
    }
  }
  return stripped
}

/** 展示用目录：折叠尾部斜杠，根目录保持 '/'。 */
function normalizeDisplayDir(dir: string): string {
  const t = String(dir ?? '').trim()
  if (!t) return '/'
  const collapsed = t.replace(/\/+$/, '')
  return collapsed === '' ? '/' : collapsed
}

/** 命令用目录：非根目录补一层尾部斜杠，避免软链目录只打印自身。 */
function commandDir(dir: string): string {
  const base = normalizeDisplayDir(dir)
  return base === '/' ? '/' : base + '/'
}


/**
 * 把远端相对路径拆成本地合法、且绝不会逃出下载根目录的路径段。
 *
 * P0：远端文件名是**攻击者可控输入**。Linux 允许文件名里带反斜杠，
 * 一个叫 `..\\..\\Startup\\evil.bat` 的远端文件经 walkRemote 变成 rel，
 * 再被 `join(localDir, ...rel.split('/'))` 拼开后，Windows 上反斜杠又是分隔符，
 * 于是 mkdir -p + rename 直接写到 localDir 外面去（下载目录 -> 启动项）。
 *
 * 所以这里按 / 与 \\ 双重切分，丢掉 . / .. / 空段，
 * 并把 Windows 非法字符、结尾点与空格、设备保留名一并归一化。
 */
export function safeRelativeSegments(rel: string): string[] {
  return String(rel ?? '')
    .split(/[\\/]+/)
    .map((seg) => {
      // 控制字符必须一起换掉：远端文件名里带 \n \t 会把 ls 输出行拼错
      // eslint-disable-next-line no-control-regex
      let s = seg.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '')
      if (!s || s === '.' || s === '..') s = '_'
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(s)) s = '_' + s
      return s
    })
    .filter(Boolean)
}

function joinRemote(dir: string, name: string): string {
  const base = normalizeDisplayDir(dir)
  return base === '/' ? '/' + name : base + '/' + name
}

/* ------------------------------------------------------------------ */
/* 远端命令执行                                                        */
/* ------------------------------------------------------------------ */

interface ExecResult {
  code: number | null
  stdout: Buffer
  stderr: string
}

/** 打开后的通道句柄：既能喂 stdin，也能控制通道（pause/resume/close）。 */
interface ChannelHandle {
  write: (buf: Buffer) => boolean
  end: () => void
  close: () => void
  pause: () => void
  resume: () => void
  waitDrain: () => Promise<void>
  /** 通道是否还能写（对端已 close/error 后为 false） */
  isOpen: () => boolean
}

function makeHandle(ch: ClientChannel): ChannelHandle {
  /*
   * 通道死掉必须能被感知。
   * 旧实现只写不查：远端命令报错关闭后 feed() 还在闷头读整个本地文件，
   * 每 64 KB 因为 write 返回 false 就去 waitDrain 干等 5 秒 —— 10 MB 文件
   * 变成「假死」13 分钟，界面上就是一个永远不动的进度条。
   */
  let alive = true
  const die = (): void => {
    alive = false
  }
  ch.on('close', die)
  ch.on('error', die)
  return {
    write: (buf: Buffer): boolean => {
      try {
        return ch.write(buf)
      } catch {
        alive = false
        return false
      }
    },
    isOpen: (): boolean => alive,
    end: (): void => {
      try {
        ch.end()
      } catch {
        /* 通道已关闭，忽略 */
      }
    },
    close: (): void => {
      try {
        ch.close()
      } catch {
        /* 通道已关闭，忽略 */
      }
    },
    pause: (): void => {
      try {
        ch.pause()
      } catch {
        /* 忽略 */
      }
    },
    resume: (): void => {
      try {
        ch.resume()
      } catch {
        /* 忽略 */
      }
    },
    waitDrain: (): Promise<void> =>
      new Promise<void>((resolve) => {
        if (!alive) {
          resolve()
          return
        }
        let done = false
        const finish = (): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          ch.removeListener('drain', finish)
          ch.removeListener('close', finish)
          ch.removeListener('error', finish)
          resolve()
        }
        const timer = setTimeout(finish, DRAIN_TIMEOUT_MS)
        timer.unref?.()
        ch.once('drain', finish)
        // 通道没了就不会再有 drain：立刻收工，别按 5 秒一块白等
        ch.once('close', finish)
        ch.once('error', finish)
      })
  }
}

/**
 * 执行一条远端命令，收集 stdout 原始字节。
 *
 * 与 exec.ts 的 execCollect 不同：这里收 Buffer（读文件、拉原始字节都不能先转字符串），
 * 并且可选地把通道句柄交给调用方去喂 stdin（上传 / 写入都靠它）。
 */
function execChannel(
  client: Client,
  command: string,
  opts: {
    timeoutMs?: number
    maxStdout?: number
    /**
     * 通道建好的**同步**回调。
     *
     * onStdin 是 setImmediate 才调的（要让写入端先就绪），但下载侧
     * onStdout 里的 ctrl.abort/pause 需要在这之前就可用 —— 首个 data 分块
     * 完全可能早于那个 setImmediate 到达，那时 ctrl 还是 null，
     * 用户点取消就只是置了个标志，远端 cat 照样把整份文件推完。
     */
    onChannel?: (h: ChannelHandle) => void
    onStdin?: (h: ChannelHandle) => void
    onStdout?: (chunk: Buffer) => void
  } = {}
): Promise<ExecResult> {
  const timeoutMs = Math.min(
    Math.max(opts.timeoutMs ?? LIST_TIMEOUT_MS, MIN_EXEC_TIMEOUT_MS),
    MAX_EXEC_TIMEOUT_MS
  )
  const maxStdout = opts.maxStdout ?? MAX_STDOUT_BYTES

  return new Promise<ExecResult>((resolve, reject) => {
    let settled = false
    let stream: ClientChannel | null = null
    const chunks: Buffer[] = []
    let bytes = 0
    let stderr = ''

    const settle = (code: number | null, err?: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err !== undefined) {
        reject(new Error(err))
        return
      }
      resolve({ code, stdout: Buffer.concat(chunks), stderr: stderr.trim() })
    }

    const timer = setTimeout(() => {
      try {
        stream?.close()
      } catch {
        /* 忽略 */
      }
      settle(null, '远端命令超时（' + String(timeoutMs) + 'ms）：' + command.slice(0, 96))
    }, timeoutMs)
    timer.unref?.()

    try {
      client.exec(command, (err, ch) => {
        if (err) {
          settle(null, '远端命令启动失败：' + err.message)
          return
        }
        stream = ch
        if (settled) {
          try {
            ch.close()
          } catch {
            /* 忽略 */
          }
          return
        }
        if (opts.onChannel) {
          try {
            opts.onChannel(makeHandle(ch))
          } catch {
            /* 回调自身出错不该影响传输 */
          }
        }
        ch.on('data', (chunk: Buffer) => {
          if (settled) return
          if (opts.onStdout) {
            opts.onStdout(chunk)
            return
          }
          bytes += chunk.length
          if (bytes > maxStdout) {
            try {
              ch.close()
            } catch {
              /* 忽略 */
            }
            settle(null, '远端输出超过上限（' + String(maxStdout) + ' 字节）')
            return
          }
          chunks.push(Buffer.from(chunk))
        })
        ch.stderr?.on('data', (chunk: Buffer) => {
          if (stderr.length >= STDERR_KEEP_BYTES) return
          stderr += chunk.toString('utf8')
        })
        ch.on('close', (code: number | null) => settle(code ?? null))
        ch.on('error', (e: Error) => settle(null, '远端命令出错：' + e.message))
        if (opts.onStdin) {
          // 推迟一拍再喂 stdin：部分环境（含测试桩）在 exec 回调返回后才把写入端准备好，
          // 同步写 + end 会落在「还不接受数据」的窗口里，通道永远等不到 close。
          const handle = makeHandle(ch)
          const feed = opts.onStdin
          setImmediate(() => {
            if (settled) return
            feed(handle)
          })
        }
      })
    } catch (e) {
      settle(null, e instanceof Error ? e.message : String(e))
    }
  })
}

/** 跑一条命令并要求退出码为 0，失败时把 stderr 原文带出来。 */
async function runOrThrow(
  client: Client,
  command: string,
  timeoutMs: number,
  what: string
): Promise<ExecResult> {
  const r = await execChannel(client, command, { timeoutMs })
  if (r.code !== 0) {
    throw new Error(what + '失败：' + (r.stderr || 'exit ' + String(r.code)))
  }
  return r
}

/** 尽力而为的清理，失败不影响主流程。 */
async function cleanupQuiet(client: Client, command: string): Promise<void> {
  try {
    await execChannel(client, command, { timeoutMs: SMALL_OP_TIMEOUT_MS })
  } catch {
    /* 清理失败不影响判定 */
  }
}

/* ------------------------------------------------------------------ */
/* ls 输出解析                                                         */
/* ------------------------------------------------------------------ */

const MONTH_INDEX: Record<string, number> = {
  Jan: 0,
  Feb: 1,
  Mar: 2,
  Apr: 3,
  May: 4,
  Jun: 5,
  Jul: 6,
  Aug: 7,
  Sep: 8,
  Oct: 9,
  Nov: 10,
  Dec: 11
}

const PERMS_RE = /^[-dlbcps?][-rwxsStT]{9}$/
const FULL_TIME_MS_RE = /^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/
const SHORT_TIME_RE = /^\d{1,2}:\d{2}$/

const LS_COLLATOR = new Intl.Collator('zh-CN')

function permToMode(perms: string): number {
  const bits = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001]
  let mode = 0
  for (let i = 0; i < 9; i++) {
    const c = perms[i + 1]
    if (c === 'r' || c === 'w' || c === 'x' || c === 's' || c === 't') mode |= bits[i]
  }
  if (perms[3] === 's' || perms[3] === 'S') mode |= 0o4000
  if (perms[6] === 's' || perms[6] === 'S') mode |= 0o2000
  if (perms[9] === 't' || perms[9] === 'T') mode |= 0o1000
  return mode
}

function gnuStampToMs(datePart: string, timePart: string, tz: string): number {
  const [y, mo, d] = datePart.split('-').map(Number)
  const parts = timePart.split(':')
  const hh = Number(parts[0])
  const mi = Number(parts[1] ?? 0)
  const ss = Math.floor(Number(parts[2] ?? 0))
  const sign = tz[0] === '-' ? -1 : 1
  const tzH = Number(tz.slice(1, 3))
  const tzM = Number(tz.slice(3, 5))
  const offset = sign * (tzH * 3600 + tzM * 60) * 1000
  return Date.UTC(y, mo - 1, d, hh, mi, ss) - offset
}

function readTimestamp(tokens: string[], idx: number): { mtime: number; next: number } | null {
  const head = tokens[idx]
  if (!head) return null

  // GNU coreutils --full-time：2024-11-24 01:02:03.000000000 +0800
  if (/^\d{4}-\d{2}-\d{2}$/.test(head)) {
    const timePart = tokens[idx + 1] ?? ''
    if (!FULL_TIME_MS_RE.test(timePart)) return null
    const tz = tokens[idx + 2] ?? ''
    if (/^[+-]\d{4}$/.test(tz)) {
      return { mtime: gnuStampToMs(head, timePart, tz), next: idx + 3 }
    }
    return { mtime: gnuStampToMs(head, timePart, '+0000'), next: idx + 2 }
  }

  // BusyBox / 老 coreutils：Nov 24 01:02 或 Nov 24  2024
  const month = MONTH_INDEX[head]
  if (month === undefined) return null
  const day = Number(tokens[idx + 1])
  if (!Number.isFinite(day)) return null
  const third = tokens[idx + 2] ?? ''
  let year = new Date().getFullYear()
  let hh = 0
  let mi = 0
  let hasYear = false
  if (/^\d{4}$/.test(third)) {
    year = Number(third)
    hasYear = true
  } else if (SHORT_TIME_RE.test(third)) {
    const p = third.split(':')
    hh = Number(p[0])
    mi = Number(p[1])
  } else {
    return null
  }
  let mtime = Date.UTC(year, month, day, hh, mi, 0)
  /*
   * 没有年份的条目（ls 对半年内的文件省略年份）默认取今年。
   * 12 月建的文件在 1 月看到时，算出来是「今年 12 月」= 11 个月后，
   * 排序和「最近修改」全乱。按 ls 的规则：算出未来就是去年。
   */
  if (!hasYear && mtime > Date.now() + 24 * 3600 * 1000) {
    mtime = Date.UTC(year - 1, month, day, hh, mi, 0)
  }
  return { mtime, next: idx + 3 }
}

/**
 * 按空白切词，但保留每个词在原始行里的起始下标。
 *
 * 只为了最后那个文件名：`ls` 会给含空格的文件名原样输出，用 split + join(' ')
 * 重拼会把连续空格压成一个 —— `my  file.txt` 变成 `my file.txt`，
 * 再拿它去拼路径就是另一个文件（下载/删除都会打空）。
 */
function splitWithOffsets(line: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = []
  const re = /\S+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) out.push({ text: m[0], start: m.index })
  return out
}

function parseLsLine(line: string, dir: string): RemoteFile | null {
  const raw = splitWithOffsets(line.replace(/\s+$/, ''))
  const tokens = raw.map((t) => t.text)
  if (tokens.length < 8) return null

  const permsRaw = tokens[0]
  // 带 ACL / SELinux 后缀的行（drwxr-xr-x+ / drwxr-xr-x. / drwxr-xr-x@）
  const perms = permsRaw.replace(/[.+@]$/, '')
  if (!PERMS_RE.test(perms)) return null

  let idx = 4
  let size = 0
  if (/^\d+,$/.test(tokens[idx] ?? '') && /^\d+$/.test(tokens[idx + 1] ?? '')) {
    // 设备节点：major, minor 占两列，逻辑大小按 0 处理
    idx += 2
  } else {
    const n = Number(tokens[idx])
    if (!Number.isFinite(n)) return null
    size = n
    idx += 1
  }

  const stamp = readTimestamp(tokens, idx)
  if (!stamp) return null

  // 名字取原行剩下的整段，别用 tokens 重拼（连续空格会被吃掉）
  let name = stamp.next < raw.length ? line.replace(/\s+$/, '').slice(raw[stamp.next].start) : ''
  if (!name) return null

  const kind = perms[0]
  const isLink = kind === 'l'
  if (isLink) {
    const arrow = name.indexOf(' -> ')
    if (arrow >= 0) name = name.slice(0, arrow)
  }
  if (name === '.' || name === '..') return null
  if (!name) return null

  const type: RemoteFile['type'] = kind === 'd' ? 'directory' : isLink ? 'symlink' : 'file'
  return {
    name,
    path: joinRemote(dir, name),
    type,
    size,
    mode: permToMode(perms),
    modeStr: perms,
    uid: 0,
    gid: 0,
    mtime: stamp.mtime,
    isLink
  }
}

function compareEntries(a: RemoteFile, b: RemoteFile): number {
  const aDir = a.type === 'directory' ? 0 : 1
  const bDir = b.type === 'directory' ? 0 : 1
  if (aDir !== bDir) return aDir - bDir
  return LS_COLLATOR.compare(a.name, b.name)
}

/**
 * 解析 `ls -la` 输出（同时兼容 GNU --full-time 与 BusyBox 经典格式）。
 *
 * 无法识别的行（ls 的错误文本、total 行、./..）直接跳过，不抛错 ——
 * 嵌入式设备的 ls 输出千奇百怪，宁可少一条也不要整目录失败。
 */
export function parseLsOutput(dir: string, stdout: string): RemoteFile[] {
  const base = normalizeDisplayDir(dir)
  const out: RemoteFile[] = []
  for (const rawLine of String(stdout ?? '').split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.trim()) continue
    if (/^total\s/.test(line)) continue
    const parsed = parseLsLine(line, base)
    if (parsed) out.push(parsed)
  }
  out.sort(compareEntries)
  return out
}

/* ------------------------------------------------------------------ */
/* 目录与路径                                                          */
/* ------------------------------------------------------------------ */

function homeCommand(): string {
  return 'pwd 2>/dev/null || printf \'%s\\n\' "$HOME"'
}

/** 取远端家目录；输出不是绝对路径时兜底为 '/'。 */
export async function shellHome(client: Client): Promise<string> {
  const r = await execChannel(client, homeCommand(), { timeoutMs: SMALL_OP_TIMEOUT_MS })
  const first = r.stdout.toString('utf8').split('\n')[0].trim()
  if (!first.startsWith('/')) return '/'
  return first.replace(/\/+$/, '') || '/'
}

/** 列一个目录（不可用时抛错，错误里带 stderr 原文）。 */
export async function shellList(client: Client, dir: string): Promise<RemoteFile[]> {
  const shown = normalizeDisplayDir(dir)
  const target = commandDir(dir)
  /*
   * 先试 --full-time，失败了再退回普通格式。
   *
   * 不能写成 `ls --full-time || ls`：第一条命令已经把能读的条目打到 stdout 了，
   * 退出码非 0（目录里有个别条目 stat 失败）时第二条会把同一批再打一遍，
   * 列表里每条都出现两次。所以先在变量里攒着，成功才用。
   */
  const command =
    'o=$(LC_ALL=C ls -la --full-time -- ' +
    shQuote(target) +
    ' 2>/dev/null); rc=$?; ' +
    'if [ $rc -ne 0 ]; then o=$(LC_ALL=C ls -la -- ' +
    shQuote(target) +
    ' 2>&1); rc=$?; fi; printf %s "$o"; exit $rc'
  const r = await execChannel(client, command, { timeoutMs: LIST_TIMEOUT_MS })
  if (r.code !== 0) {
    // 兜底那趟把 stderr 并进了 stdout，报错文案从那里取
    const noisy = (r.stderr.length > 0 ? r.stderr : r.stdout).toString('utf8').trim()
    throw new Error('列目录失败：' + (noisy || 'exit ' + String(r.code)))
  }
  return parseLsOutput(shown, r.stdout.toString('utf8'))
}

/** 批量列目录：固定 4 路并发，单目录失败进 errors，不拖垮其余。 */
export async function shellListMany(
  client: Client,
  dirs: string[]
): Promise<{ dirs: Record<string, RemoteFile[]>; errors: Record<string, string> }> {
  const list = (dirs ?? []).filter((d) => typeof d === 'string' && d.length > 0)
  const ok: Record<string, RemoteFile[]> = {}
  const errors: Record<string, string> = {}
  let cursor = 0
  const workerCount = Math.min(SHELL_LIST_CONCURRENCY, list.length)
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const idx = cursor
      cursor += 1
      if (idx >= list.length) return
      const dir = list[idx]
      try {
        ok[dir] = await shellList(client, dir)
      } catch (e) {
        errors[dir] = e instanceof Error ? e.message : String(e)
      }
    }
  })
  await Promise.all(workers)
  return { dirs: ok, errors }
}

export interface ShellWalkEntry {
  remotePath: string
  relPath: string
  size: number
  isDir: boolean
}

/** 错误文案是不是「这个路径本来就不存在」 */
function isMissingEntry(msg: string): boolean {
  return /no such file|not exist|不存在|NoSuchFile/i.test(msg)
}

/** 逐层递归遍历：maxDepth 限制层数，maxFiles 限制条目总数。 */
export async function shellWalkRemote(
  client: Client,
  rootDir: string,
  maxFiles: number,
  maxDepth: number
): Promise<ShellWalkEntry[]> {
  const out: ShellWalkEntry[] = []
  const fileCap = Math.max(0, Math.floor(maxFiles))
  const depthCap = Math.max(0, Math.floor(maxDepth))
  let frontier: Array<{ dir: string; rel: string }> = [{ dir: normalizeDisplayDir(rootDir), rel: '' }]
  let depth = 0

  while (frontier.length > 0 && out.length < fileCap && depth < depthCap) {
    const { dirs: listed, errors } = await shellListMany(
      client,
      frontier.map((f) => f.dir)
    )
    /*
     * 列目录失败不能静默跳过：旧实现会把它当成空目录，用户看到「下载完成」，
     * 实际上整棵子树一个文件都没下来。目标中途消失（并发删除）是正常情况，
     * 不算错；其余一律上抛，让上层报失败。
     */
    const failed = Object.entries(errors).filter(([, msg]) => !isMissingEntry(msg))
    if (failed.length > 0) {
      throw new Error(
        '列目录失败，下载已中止：' + failed[0][0] + '（' + failed[0][1] + '）'
      )
    }
    const next: Array<{ dir: string; rel: string }> = []
    const entryDepth = depth + 1
    for (const item of frontier) {
      const entries = listed[item.dir]
      if (!entries) continue
      for (const e of entries) {
        if (out.length >= fileCap) break
        if (entryDepth > depthCap) continue
        /*
         * 软链一律跳过，与 SFTP 侧 walkRemote 对称。
         * 顺着链接递归就是把 /dev/zero、外部挂载点一起拉进来 —— 磁盘直接被写满。
         */
        if (e.isLink || e.type === 'symlink') continue
        const relPath = item.rel ? item.rel + '/' + e.name : e.name
        const isDir = e.type === 'directory'
        out.push({ remotePath: e.path, relPath, size: e.size, isDir })
        if (isDir && entryDepth < depthCap) next.push({ dir: e.path, rel: relPath })
      }
    }
    frontier = next
    depth += 1
  }
  return out
}

/* ------------------------------------------------------------------ */
/* 元数据操作                                                          */
/* ------------------------------------------------------------------ */

export async function shellMkdir(
  client: Client,
  path: string,
  recursive = true
): Promise<void> {
  const command = (recursive ? 'mkdir -p -- ' : 'mkdir -- ') + shQuote(path)
  await runOrThrow(client, command, SMALL_OP_TIMEOUT_MS, '创建目录')
}

export async function shellRemove(client: Client, path: string): Promise<void> {
  const safe = assertSafeRemovePath(path)
  await runOrThrow(client, 'rm -rf -- ' + shQuote(safe), SMALL_OP_TIMEOUT_MS, '删除')
}

export async function shellRename(client: Client, from: string, to: string): Promise<void> {
  const command = 'mv -f -- ' + shQuote(from) + ' ' + shQuote(to)
  await runOrThrow(client, command, SMALL_OP_TIMEOUT_MS, '重命名')
}

export async function shellChmod(client: Client, path: string, mode: number): Promise<void> {
  if (!Number.isInteger(mode) || mode < 0 || mode > 0o7777) {
    throw new Error('非法权限值：' + String(mode))
  }
  const command = 'chmod ' + mode.toString(8) + ' -- ' + shQuote(path)
  await runOrThrow(client, command, SMALL_OP_TIMEOUT_MS, '修改权限')
}

/* ------------------------------------------------------------------ */
/* 文本读写                                                            */
/* ------------------------------------------------------------------ */

const REMOTE_EXISTS_TIMEOUT_MS = 10_000

async function remoteExists(client: Client, path: string): Promise<boolean> {
  const r = await execChannel(client, '[ -e ' + shQuote(path) + ' ]', {
    timeoutMs: REMOTE_EXISTS_TIMEOUT_MS
  })
  return r.code === 0
}

/**
 * 读远端文本：先取大小、再拉原始字节、最后交给调用方判定编码。
 *
 * 超过 maxBytes 或含 NUL 字节时直接拒绝 —— 远程编辑器不该尝试打开二进制或超大文件。
 */
export async function shellReadText(
  client: Client,
  path: string,
  detectEncoding: (buf: Buffer) => RemoteText,
  maxBytes: number
): Promise<RemoteText> {
  const sizeRes = await execChannel(client, 'wc -c < ' + shQuote(path), {
    timeoutMs: SMALL_OP_TIMEOUT_MS
  })
  if (sizeRes.code !== 0) {
    throw new Error('读取远端文件失败：' + (sizeRes.stderr || 'exit ' + String(sizeRes.code)))
  }
  const size = Number(sizeRes.stdout.toString('utf8').trim())
  const limit = Math.max(0, Math.floor(maxBytes))
  if (Number.isFinite(size) && size > limit) {
    throw new Error('文件过大（' + String(size) + ' 字节），超过上限 ' + String(limit) + ' 字节')
  }

  const readRes = await execChannel(client, 'cat -- ' + shQuote(path), {
    timeoutMs: TRANSFER_TIMEOUT_MS
  })
  if (readRes.code !== 0) {
    throw new Error('读取远端文件失败：' + (readRes.stderr || 'exit ' + String(readRes.code)))
  }
  const buf = readRes.stdout
  /*
   * 带 BOM 的 UTF-16 文本每个 ASCII 字符后面都跟一个 0x00，按「含 NUL 就是二进制」
   * 一刀切会把它们全部拒之门外。BOM 已经把这种情况标死了，先认 BOM 再判 NUL。
   */
  const hasBom =
    buf.length >= 2 &&
    ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
  if (!hasBom && buf.includes(0)) {
    throw new Error('文件看起来是二进制数据，已按文本方式打开时中止')
  }
  return detectEncoding(buf)
}

/**
 * 写远端文本：存在则先备份，写入失败用备份回滚。
 *
 * 备份命令必须发生在写入命令之前（cp -f 失败就不许再 cat >），
 * 否则设备掉电 / 磁盘满时会把配置文件写成半截。
 */
export async function shellWriteText(client: Client, path: string, content: Buffer): Promise<void> {
  const exists = await remoteExists(client, path)
  const bak = path + '.swb-bak'

  if (exists) {
    const r = await execChannel(client, 'cp -f -- ' + shQuote(path) + ' ' + shQuote(bak), {
      timeoutMs: SMALL_OP_TIMEOUT_MS
    })
    if (r.code !== 0) {
      throw new Error('备份远端文件失败：' + (r.stderr || 'exit ' + String(r.code)))
    }
  }

  const writeRes = await execChannel(client, 'cat > ' + shQuote(path), {
    timeoutMs: TRANSFER_TIMEOUT_MS,
    onStdin: (h) => {
      try {
        if (content.length > 0) h.write(content)
      } catch {
        /* 写失败交给 close 出来的退出码判定 */
      }
      h.end()
    }
  })

  if (writeRes.code !== 0) {
    if (exists) {
      await cleanupQuiet(client, 'cat ' + shQuote(bak) + ' > ' + shQuote(path))
    }
    throw new Error('写入远端文件失败：' + (writeRes.stderr || 'exit ' + String(writeRes.code)))
  }

  if (exists) {
    await cleanupQuiet(client, 'rm -f -- ' + shQuote(bak))
  }
}

/* ------------------------------------------------------------------ */
/* 流式传输                                                            */
/* ------------------------------------------------------------------ */

export interface ShellTransferHooks {
  isPaused: () => boolean
  isCancelled: () => boolean
  waitIfPaused: () => Promise<void>
  onProgress: (transferred: number, total: number) => void
  registerStream?: (ctrl: { pause: () => void; resume: () => void; abort: () => void }) => void
}

const CANCEL_MESSAGE = '传输已取消'

/**
 * 上传：cat > <part> && mv -f -- <part> <target>，边读边写并处理背压。
 *
 * 用 .swb-part 中转，保证远端永远看不到半截文件；取消走 rm -f 清理中转文件。
 */
export async function shellUploadFile(
  client: Client,
  localPath: string,
  remotePath: string,
  hooks: ShellTransferHooks
): Promise<void> {
  const stat = statSync(localPath)
  const total = stat.size
  const part = remotePath + '.swb-part'
  const command =
    'cat > ' + shQuote(part) + ' && mv -f -- ' + shQuote(part) + ' ' + shQuote(remotePath)

  let cancelled = false
  /*
   * 用「盒子」而不是裸 let：feedError 只在下面的闭包里被赋值，TS 在闭包外
   * 会把它一直收窄成 null，报错文案那行拼字符串时就被判成 never。
   * 属性访问不会被跨语句收窄，运行时语义完全一样。
   */
  const feedState: { error: string | null } = { error: null }

  const feed = async (h: ChannelHandle): Promise<void> => {
    const rs = createReadStream(localPath, { highWaterMark: UPLOAD_CHUNK_BYTES })
    let sent = 0
    try {
      for await (const chunk of rs) {
        if (hooks.isCancelled()) {
          cancelled = true
          break
        }
        if (!h.isOpen()) {
          feedState.error = '远端通道已关闭（对端命令已退出）'
          break
        }
        if (hooks.isPaused()) await hooks.waitIfPaused()
        // 暂停期间可能被取消：醒来必须重查，否则会接着把一个已取消的上传传完
        if (hooks.isCancelled()) {
          cancelled = true
          break
        }
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        const ok = h.write(buf)
        sent += buf.length
        hooks.onProgress(sent, total)
        if (!ok) await h.waitDrain()
        if (hooks.isCancelled()) {
          cancelled = true
          break
        }
      }
    } catch (e) {
      feedState.error = e instanceof Error ? e.message : String(e)
    } finally {
      rs.destroy()
    }

    // 先算成布尔再判断：在这里直接判 feedError !== null 会让 TS 把后续
    // 分支里的 feedError 收窄成 null，后面报错文案就读不到了。
    const aborted = cancelled || feedState.error !== null
    if (aborted) {
      h.close()
      return
    }
    hooks.onProgress(total, total)
    h.end()
  }

  let feedDone: Promise<void> = Promise.resolve()
  const result = await execChannel(client, command, {
    timeoutMs: TRANSFER_TIMEOUT_MS,
    // 同下载侧：控制块要在通道一建好就可用，不能等 onStdin 的 setImmediate
    onChannel: (h) => {
      hooks.registerStream?.({
        pause: () => h.pause(),
        resume: () => h.resume(),
        abort: () => h.close()
      })
    },
    onStdin: (h) => {
      feedDone = feed(h)
    }
  })
  await feedDone

  if (cancelled) {
    await cleanupQuiet(client, 'rm -f -- ' + shQuote(part))
    throw new Error(CANCEL_MESSAGE + '：' + remotePath)
  }
  if (feedState.error !== null) {
    await cleanupQuiet(client, 'rm -f -- ' + shQuote(part))
    /*
     * 通道被对端关掉时，真正的死因在 stderr 里（没有权限 / 磁盘满 / 目标目录不存在），
     * 而 feedState.error 只是一句「远端通道已关闭（对端命令已退出）」的通用文案。
     * 先报 stderr，用户才知道该改什么。
     */
    const detail = result.code !== 0 && result.stderr ? result.stderr : feedState.error
    throw new Error('上传失败：' + detail)
  }
  if (result.code !== 0) {
    await cleanupQuiet(client, 'rm -f -- ' + shQuote(part))
    throw new Error('上传失败：' + (result.stderr || 'exit ' + String(result.code)))
  }
}

/**
 * 下载：先 wc -c 取大小，再 cat 流式写 <local>.part，退出码 0 才 rename。
 *
 * 取消或失败一律 unlink .part，绝不留下残缺文件冒充成功。
 */
export async function shellDownloadFile(
  client: Client,
  remotePath: string,
  localPath: string,
  hooks: ShellTransferHooks
): Promise<void> {
  const sizeRes = await execChannel(client, 'wc -c < ' + shQuote(remotePath), {
    timeoutMs: SMALL_OP_TIMEOUT_MS
  })
  if (sizeRes.code !== 0) {
    throw new Error('读取远端文件大小失败：' + (sizeRes.stderr || 'exit ' + String(sizeRes.code)))
  }
  const parsedTotal = Number(sizeRes.stdout.toString('utf8').trim())
  const total = Number.isFinite(parsedTotal) ? parsedTotal : 0

  const partPath = localPath + '.part'
  const fd = openSync(partPath, 'w')
  let written = 0
  let cancelled = false
  /*
   * fd 只能关一次。
   * 旧实现 rename 失败后 catch 会对已经关过的整数 fd 再 closeSync 一遍 ——
   * 那时这个号可能已经被别的 open 复用，等于把别人刚打开的文件关掉。
   */
  let closed = false
  const closeFd = (): void => {
    if (closed) return
    closed = true
    try {
      closeSync(fd)
    } catch {
      /* 已关闭 */
    }
  }
  /*
   * 写盘失败（磁盘满最常见）：不能在 'data' 回调里抛，那会变成未捕获异常。
   * 用盒子装而不是裸 let —— 只在闭包里赋值，TS 会在检查处把它收窄成 never。
   */
  const failState: { write: string | null } = { write: null }
  let ctrl: { pause: () => void; resume: () => void; abort: () => void } | null = null
  let paused = false

  try {
    const result = await execChannel(client, 'cat -- ' + shQuote(remotePath), {
      timeoutMs: TRANSFER_TIMEOUT_MS,
      onStdout: (chunk: Buffer) => {
        if (cancelled || failState.write !== null) return
        // 先查取消再落盘：避免已取消后仍写入多余字节并向 UI 回发 running 进度
        if (hooks.isCancelled()) {
          cancelled = true
          ctrl?.abort()
          return
        }
        try {
          writeSync(fd, chunk)
        } catch (e) {
          failState.write = e instanceof Error ? e.message : String(e)
          cancelled = true
          ctrl?.abort()
          return
        }
        written += chunk.length
        hooks.onProgress(written, total)
        if (hooks.isCancelled()) {
          cancelled = true
          // 取消要真的把远端 cat 停掉，否则它会一直被背压卡着不返回
          ctrl?.abort()
          return
        }
        if (hooks.isPaused() && !paused) {
          paused = true
          ctrl?.pause()
          void hooks.waitIfPaused().then(() => {
            paused = false
            /*
             * 醒来后必须重查取消：用户完全可能「刚按暂停，又按了取消」。
             * 旧实现只看进入时那个 cancelled，于是继续把远端数据恢复下载 ——
             * 界面显示已取消，文件还在长。
             */
            if (cancelled || hooks.isCancelled()) {
              cancelled = true
              ctrl?.abort()
              return
            }
            ctrl?.resume()
          })
        }
      },
      // 同步拿到 ctrl：首个 data 分块可能比 onStdin 的 setImmediate 还早到
      onChannel: (h) => {
        ctrl = {
          pause: () => h.pause(),
          resume: () => h.resume(),
          abort: () => {
            cancelled = true
            h.close()
          }
        }
        hooks.registerStream?.(ctrl)
        if (hooks.isCancelled()) {
          ctrl.abort()
        }
      }
    })

    if (failState.write !== null) {
      droppedPart(partPath, closeFd)
      throw new Error('下载失败：写入本地文件出错（' + String(failState.write) + '）')
    }
    if (cancelled || hooks.isCancelled()) {
      droppedPart(partPath, closeFd)
      throw new Error(CANCEL_MESSAGE + '：' + remotePath)
    }
    if (result.code !== 0) {
      droppedPart(partPath, closeFd)
      throw new Error('下载失败：' + (result.stderr || 'exit ' + String(result.code)))
    }

    closeFd()
    hooks.onProgress(written, total)
    try {
      renameSync(partPath, localPath)
    } catch (e) {
      try {
        unlinkSync(partPath)
      } catch {
        /* 忽略 */
      }
      throw new Error(
        '下载失败：无法落盘到 ' + localPath + '（' + (e instanceof Error ? e.message : String(e)) + '）'
      )
    }
  } catch (e) {
    closeFd()
    try {
      unlinkSync(partPath)
    } catch {
      /* 可能已删除 */
    }
    throw e
  }
}

/** 关闭句柄并删掉半截 .part，供下载失败/取消路径使用。 */
function droppedPart(partPath: string, close: () => void): void {
  close()
  try {
    unlinkSync(partPath)
  } catch {
    /* 忽略 */
  }
}
