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
}

function makeHandle(ch: ClientChannel): ChannelHandle {
  return {
    write: (buf: Buffer): boolean => {
      try {
        return ch.write(buf)
      } catch {
        return false
      }
    },
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
        let done = false
        const finish = (): void => {
          if (done) return
          done = true
          clearTimeout(timer)
          resolve()
        }
        const timer = setTimeout(finish, DRAIN_TIMEOUT_MS)
        timer.unref?.()
        ch.once('drain', finish)
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
  if (/^\d{4}$/.test(third)) {
    year = Number(third)
  } else if (SHORT_TIME_RE.test(third)) {
    const p = third.split(':')
    hh = Number(p[0])
    mi = Number(p[1])
  } else {
    return null
  }
  return { mtime: Date.UTC(year, month, day, hh, mi, 0), next: idx + 3 }
}

function parseLsLine(line: string, dir: string): RemoteFile | null {
  const tokens = line.trim().split(/\s+/)
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

  let name = tokens.slice(stamp.next).join(' ')
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
  const command =
    'LC_ALL=C ls -la --full-time -- ' +
    shQuote(target) +
    ' 2>/dev/null || LC_ALL=C ls -la -- ' +
    shQuote(target)
  const r = await execChannel(client, command, { timeoutMs: LIST_TIMEOUT_MS })
  if (r.code !== 0) {
    throw new Error('列目录失败：' + (r.stderr || 'exit ' + String(r.code)))
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
    const { dirs: listed } = await shellListMany(
      client,
      frontier.map((f) => f.dir)
    )
    const next: Array<{ dir: string; rel: string }> = []
    const entryDepth = depth + 1
    for (const item of frontier) {
      const entries = listed[item.dir]
      if (!entries) continue
      for (const e of entries) {
        if (out.length >= fileCap) break
        if (entryDepth > depthCap) continue
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
  if (buf.includes(0)) {
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
        if (hooks.isPaused()) await hooks.waitIfPaused()
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
    onStdin: (h) => {
      hooks.registerStream?.({
        pause: () => h.pause(),
        resume: () => h.resume(),
        abort: () => h.close()
      })
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
    throw new Error('上传失败：' + feedState.error)
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

  try {
    const result = await execChannel(client, 'cat -- ' + shQuote(remotePath), {
      timeoutMs: TRANSFER_TIMEOUT_MS,
      onStdout: (chunk: Buffer) => {
        if (cancelled) return
        writeSync(fd, chunk)
        written += chunk.length
        hooks.onProgress(written, total)
        if (hooks.isCancelled()) cancelled = true
      },
      onStdin: (h) => {
        hooks.registerStream?.({
          pause: () => h.pause(),
          resume: () => h.resume(),
          abort: () => h.close()
        })
      }
    })

    if (cancelled) {
      droppedPart(partPath, fd)
      throw new Error(CANCEL_MESSAGE + '：' + remotePath)
    }
    if (result.code !== 0) {
      droppedPart(partPath, fd)
      throw new Error('下载失败：' + (result.stderr || 'exit ' + String(result.code)))
    }

    closeSync(fd)
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
    try {
      closeSync(fd)
    } catch {
      /* 已关闭 */
    }
    try {
      unlinkSync(partPath)
    } catch {
      /* 可能已删除 */
    }
    throw e
  }
}

/** 关闭句柄并删掉半截 .part，供下载失败/取消路径使用。 */
function droppedPart(partPath: string, fd: number): void {
  try {
    closeSync(fd)
  } catch {
    /* 已关闭 */
  }
  try {
    unlinkSync(partPath)
  } catch {
    /* 忽略 */
  }
}
