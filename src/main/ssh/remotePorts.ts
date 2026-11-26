import type { RemoteListeningPort } from '@shared/types'
import { execCollect } from './exec'
import { sessionManager } from './sessionManager'

/**
 * 远端监听端口探测（P0-3）
 *
 * 嵌入式设备的现实：一半没有 sftp-server，更多没有 ss。/proc/net/tcp 几乎总是存在，
 * 但 BusyBox 裁剪过的镜像可能连 netstat 都换成精简版（无 PID/程序名列）。
 * 因此按 ss → netstat → /proc 三级降级，每级带一段 `__SRC:*__` 标记，
 * 让解析器知道后面的行属于哪种格式 —— 否则 BusyBox 的 netstat 输出和 GNU 的
 * 长得像却列数不同，只能靠猜。
 *
 * 整条命令必须是单行：execCollect 走 SSH exec 通道，多行要额外的 shell 包装，
 * 而某些嵌入式设备的默认 shell 对多行续行符支持不稳。
 */
export const REMOTE_PORTS_CMD = [
  'if command -v ss >/dev/null 2>&1; then echo __SRC:SS__; ss -tlnp 2>/dev/null || ss -tln 2>/dev/null;',
  'elif command -v netstat >/dev/null 2>&1; then echo __SRC:NETSTAT__; netstat -tlnp 2>/dev/null || netstat -tln 2>/dev/null;',
  'else echo __SRC:PROC__; cat /proc/net/tcp 2>/dev/null; echo __SRC:PROC6__; cat /proc/net/tcp6 2>/dev/null; fi'
].join(' ')

type Section = 'ss' | 'netstat' | 'proc' | 'proc6' | null

/** 解析过程中的中间态：保留原始族别与类别，供两阶段归一化使用 */
interface Candidate {
  proto: 'tcp' | 'tcp6'
  /** 原始监听地址（未归一化） */
  address: string
  port: number
  pid?: number
  process?: string
  /** 原始地址形态：通配 / 回环 / 具体地址 */
  kind: 'wildcard' | 'loopback' | 'specific'
  /** 只有「纯 v6 回环」需要在第二阶段判断是否折叠到 IPv4 */
  v6OnlyLoopback: boolean
}

const WILDCARD_HOSTS = new Set(['', '*', '0.0.0.0', '::', '0:0:0:0:0:0:0:0'])

/** 去掉 IPv6 的方括号、网卡区号（`127.0.0.53%lo`）并统一小写 */
function bareHost(raw: string): string {
  let host = raw.trim()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  /*
   * ss -tlnp 在接口作用域地址后带 %网卡名（127.0.0.53%lo、fe80::1%eth0）。
   * 不剥掉的话这个字符串既不是回环也不是通配，被归成 specific，
   * 于是 5353/6379 这类只监听回环的服务会漏判。
   */
  const zone = host.indexOf('%')
  if (zone > 0) host = host.slice(0, zone)
  return host.toLowerCase()
}

/** 拆 host:port。IPv6 必须带方括号，否则最后一个冒号才是分隔符 */
function splitHostPort(text: string): { host: string; port: number } | null {
  const raw = text.trim()
  if (!raw) return null
  let hostRaw = ''
  let portRaw = ''
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']')
    if (close < 0) return null
    hostRaw = raw.slice(0, close + 1)
    const rest = raw.slice(close + 1)
    if (!rest.startsWith(':')) return null
    portRaw = rest.slice(1)
  } else {
    const idx = raw.lastIndexOf(':')
    if (idx < 0) return null
    hostRaw = raw.slice(0, idx)
    portRaw = raw.slice(idx + 1)
  }
  if (!/^\d+$/.test(portRaw)) return null
  const port = Number(portRaw)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  return { host: bareHost(hostRaw), port: port }
}

/** `::ffff:127.0.0.1` → `127.0.0.1`；不是映射地址返回 null */
function ipv4Mapped(host: string): string | null {
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host)
  return m ? m[1] : null
}

function isLoopbackV4(host: string): boolean {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
}

/** 32 位十六进制（每 8 位为一组小端）转 IPv6 文本，按 RFC 5952 压缩 */
function hexToIpv6(hex: string): string | null {
  if (!/^[0-9a-fA-F]{32}$/.test(hex)) return null
  const bytes: number[] = []
  for (let g = 0; g < 4; g++) {
    const group = hex.slice(g * 8, g * 8 + 8)
    for (let b = 3; b >= 0; b--) bytes.push(parseInt(group.slice(b * 2, b * 2 + 2), 16))
  }
  // ::ffff:a.b.c.d 保持点分形式，方便与 ss/netstat 的输出对齐
  let firstTenZero = true
  for (let i = 0; i < 10; i++) {
    if (bytes[i] !== 0) {
      firstTenZero = false
      break
    }
  }
  if (firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff) {
    return '::ffff:' + bytes.slice(12).join('.')
  }
  const groups: number[] = []
  for (let i = 0; i < 16; i += 2) groups.push((bytes[i] << 8) | bytes[i + 1])
  // 找最长的一段连续 0 组（长度 >= 2 才压缩）
  let bestStart = -1
  let bestLen = 0
  let runStart = -1
  for (let i = 0; i <= groups.length; i++) {
    const zero = i < groups.length && groups[i] === 0
    if (zero && runStart < 0) runStart = i
    if (!zero && runStart >= 0) {
      const len = i - runStart
      if (len > bestLen) {
        bestLen = len
        bestStart = runStart
      }
      runStart = -1
    }
  }
  if (bestLen < 2) return groups.map((g) => g.toString(16)).join(':')
  const head = groups.slice(0, bestStart).map((g) => g.toString(16)).join(':')
  const tail = groups.slice(bestStart + bestLen).map((g) => g.toString(16)).join(':')
  return head + '::' + tail
}

/** /proc/net/tcp 的小端 8 位十六进制转点分 IPv4 */
function hexToIpv4(hex: string): string | null {
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) return null
  const bytes: number[] = []
  for (let b = 3; b >= 0; b--) bytes.push(parseInt(hex.slice(b * 2, b * 2 + 2), 16))
  return bytes.join('.')
}

/** 按原始地址判定形态，顺序不能换：通配 → 映射 → 回环 → 具体 */
function classifyRaw(
  host: string,
  proto: 'tcp' | 'tcp6'
): { kind: 'wildcard' | 'loopback' | 'specific'; normalized: string; v6OnlyLoopback: boolean } {
  if (WILDCARD_HOSTS.has(host)) {
    return { kind: 'wildcard', normalized: '127.0.0.1', v6OnlyLoopback: false }
  }
  const mapped = ipv4Mapped(host)
  if (mapped) {
    return {
      kind: isLoopbackV4(mapped) ? 'loopback' : 'specific',
      normalized: mapped,
      v6OnlyLoopback: false
    }
  }
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') {
    // 纯 v6 回环：先按原样记下，第二阶段看同端口有没有 IPv4 监听再决定折叠
    return { kind: 'loopback', normalized: '::1', v6OnlyLoopback: proto === 'tcp6' }
  }
  if (isLoopbackV4(host)) {
    return { kind: 'loopback', normalized: host, v6OnlyLoopback: false }
  }
  return { kind: 'specific', normalized: host, v6OnlyLoopback: false }
}

/** 从 ss 的 `users:(("uhttpd",pid=412,fd=6))` 里抠进程名与 pid */
function parseSsProcess(rest: string): { pid?: number; process?: string } {
  const m = /users:\(\("([^"]+)",pid=(\d+)/.exec(rest)
  if (m) return { process: m[1], pid: Number(m[2]) }
  const nameOnly = /users:\(\("([^"]+)"/.exec(rest)
  if (nameOnly) return { process: nameOnly[1] }
  return {}
}

/** netstat 的 `412/uhttpd` 列；BusyBox 的精简 netstat 没有这一列 */
function parseNetstatProgram(token: string | undefined): { pid?: number; process?: string } {
  if (!token) return {}
  const m = /^(\d+)\/(\S+)$/.exec(token)
  if (m) return { pid: Number(m[1]), process: m[2] }
  const nameOnly = /^([A-Za-z0-9_.-]+)$/.exec(token)
  if (nameOnly) return { process: nameOnly[1] }
  return {}
}

/** ss -tln 的一行；不是 LISTEN 行返回 null */
function parseSsLine(line: string): Candidate | null {
  const tokens = line.trim().split(/\s+/)
  if (tokens.length < 5) return null
  if (tokens[0] !== 'LISTEN') return null
  const local = splitHostPort(tokens[3])
  if (!local) return null
  const proto: 'tcp' | 'tcp6' = local.host.includes(':') ? 'tcp6' : 'tcp'
  const cls = classifyRaw(local.host, proto)
  const proc = parseSsProcess(tokens.slice(5).join(' '))
  return {
    proto: proto,
    address: cls.normalized,
    port: local.port,
    pid: proc.pid,
    process: proc.process,
    kind: cls.kind,
    v6OnlyLoopback: cls.v6OnlyLoopback
  }
}

/** GNU / BusyBox netstat -tln[p] 的一行 */
function parseNetstatLine(line: string): Candidate | null {
  const tokens = line.trim().split(/\s+/)
  if (tokens.length < 5) return null
  const protoToken = tokens[0]
  if (protoToken !== 'tcp' && protoToken !== 'tcp6') return null
  const stateIdx = tokens.indexOf('LISTEN')
  if (stateIdx < 4) return null
  const local = splitHostPort(tokens[3])
  if (!local) return null
  const proto: 'tcp' | 'tcp6' = protoToken === 'tcp6' ? 'tcp6' : local.host.includes(':') ? 'tcp6' : 'tcp'
  const cls = classifyRaw(local.host, proto)
  const proc = parseNetstatProgram(tokens[stateIdx + 1])
  return {
    proto: proto,
    address: cls.normalized,
    port: local.port,
    pid: proc.pid,
    process: proc.process,
    kind: cls.kind,
    v6OnlyLoopback: cls.v6OnlyLoopback
  }
}

/** /proc/net/tcp(6) 的一行；只认状态 0A（TCP_LISTEN） */
function parseProcLine(line: string, isV6: boolean): Candidate | null {
  const tokens = line.trim().split(/\s+/)
  if (tokens.length < 4) return null
  if (!/^\d+:$/.test(tokens[0])) return null
  if (tokens[3] !== '0A') return null
  const parts = tokens[1].split(':')
  if (parts.length !== 2) return null
  const port = parseInt(parts[1], 16)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  const host = isV6 ? hexToIpv6(parts[0]) : hexToIpv4(parts[0])
  if (!host) return null
  const proto: 'tcp' | 'tcp6' = isV6 ? 'tcp6' : 'tcp'
  const cls = classifyRaw(host, proto)
  return {
    proto: proto,
    address: cls.normalized,
    port: port,
    kind: cls.kind,
    v6OnlyLoopback: cls.v6OnlyLoopback
  }
}

/** 同分段的候选 → 已归一化的监听项（含两阶段去重与排序） */
function finalize(candidates: Candidate[]): RemoteListeningPort[] {
  // 阶段一：纯 v6 回环折叠 —— 同端口若已有非 ::1 的 127.0.0.1 目标，说明对端监听在
  // 同一端口上同时覆盖了 IPv4，此时给用户看 ::1 只会让「打开」按钮点到不可达地址。
  const v4ByPort = new Map<number, boolean>()
  for (const c of candidates) {
    if (c.address === '127.0.0.1' && !c.v6OnlyLoopback) v4ByPort.set(c.port, true)
  }
  const normalized: Candidate[] = candidates.map((c) => {
    if (!c.v6OnlyLoopback) return c
    if (v4ByPort.get(c.port) === true) return { ...c, address: '127.0.0.1', v6OnlyLoopback: false }
    return c
  })

  // 阶段二：按 (targetHost, port) 去重。有进程名的那条信息更全，保留它；
  // 同等信息量时 IPv4 优先 —— 隧道目标走 IPv4 的兼容性更好。
  const byKey = new Map<string, Candidate>()
  for (const c of normalized) {
    const key = c.address + '\u0000' + String(c.port)
    const prev = byKey.get(key)
    if (!prev) {
      byKey.set(key, c)
      continue
    }
    const prevHasName = prev.process !== undefined
    const nextHasName = c.process !== undefined
    if (nextHasName && !prevHasName) {
      byKey.set(key, c)
      continue
    }
    if (nextHasName === prevHasName && prev.proto === 'tcp6' && c.proto === 'tcp') {
      byKey.set(key, c)
    }
  }

  const out: RemoteListeningPort[] = []
  for (const c of byKey.values()) {
    if (!Number.isInteger(c.port) || c.port <= 0) continue
    out.push({
      proto: c.proto,
      address: c.address,
      port: c.port,
      targetHost: c.address,
      pid: c.pid,
      process: c.process,
      isLoopback: c.kind === 'loopback'
    })
  }
  out.sort((a, b) => a.port - b.port || a.targetHost.localeCompare(b.targetHost))
  return out
}

/**
 * 解析三级降级命令的输出。
 *
 * 不依赖分段标记也能工作：按每行的形态认（ss 首列 LISTEN / netstat 首列 tcp(6) /
 * /proc 首列 `0:`），标记只用来判断 /proc 段是 v4 还是 v6。
 */
export function parseRemotePorts(stdout: string): RemoteListeningPort[] {
  const text = typeof stdout === 'string' ? stdout : ''
  if (!text) return []
  const candidates: Candidate[] = []
  let section: Section = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('__SRC:')) {
      const tag = line.slice(6)
      if (tag.startsWith('SS')) section = 'ss'
      else if (tag.startsWith('NETSTAT')) section = 'netstat'
      else if (tag.startsWith('PROC6')) section = 'proc6'
      else if (tag.startsWith('PROC')) section = 'proc'
      continue
    }
    let cand: Candidate | null = null
    if (section === 'proc' || section === 'proc6') {
      cand = parseProcLine(line, section === 'proc6')
    } else if (section === 'netstat') {
      cand = parseNetstatLine(line)
    } else if (section === 'ss') {
      cand = parseSsLine(line)
    } else {
      // 没有标记（用户手动粘贴 / 裁剪过的输出）：三种形态依次试
      cand = parseSsLine(line) ?? parseNetstatLine(line) ?? parseProcLine(line, false)
    }
    if (cand) candidates.push(cand)
  }
  return finalize(candidates)
}

/**
 * 探测指定会话的远端监听端口。
 *
 * 串口会话在这里被 sessionManager 明确挡掉（它给的错误文案区分「会话不存在」和
 * 「该功能仅支持 SSH 会话」），不要自己再包一层笼统的错误。
 */
export async function discoverRemotePorts(sessionId: string): Promise<RemoteListeningPort[]> {
  const client = sessionManager.requireSshClient(sessionId)
  const outcome = await execCollect(client, REMOTE_PORTS_CMD, 10000, undefined, 256 * 1024)
  if (outcome.status === 'timeout') throw new Error('探测远端监听端口超时，请稍后重试')
  if (outcome.status === 'cancelled') throw new Error('探测远端监听端口已取消')
  if (outcome.status === 'error') {
    throw new Error('探测远端监听端口失败：' + (outcome.error ?? '通道异常'))
  }
  return parseRemotePorts(outcome.stdout)
}
