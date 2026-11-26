import { randomUUID } from 'node:crypto'
import { promises as fs, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import type {
  AuthType,
  ConnImportMode,
  Connection,
  ExternalImportPreview,
  ExternalImportResult,
  ExternalImportSource
} from '@shared/types'
import { bulkUpsertConnections, listConnections } from './repo/connections'

/**
 * 外部 SSH 客户端配置导入。
 *
 * 支持五种来源：OpenSSH 的 ~/.ssh/config、MobaXterm、Xshell、SecureCRT、FinalShell。
 *
 * 三条硬约束：
 * 1. 绝不解析加密密码。这些客户端的密码要么用各自的算法加密（SecureCRT 的 Blowfish、
 *    Xshell 的会话密钥），要么绑在用户自己的凭据库里 —— 逆向它们既不合规也不可靠。
 *    导入只搬「连到哪、用什么身份」，密码留给用户第一次连接时自己填。
 * 2. 一切输入都是别人机器上的文件：字段长度、端口范围、协议类型都要校验，
 *    不能直接摊进 connections.json。
 * 3. 路径只来自主进程对话框（见 ipc/connections.ts 的 allowlist），
 *    这里只负责按路径读盘，不做任何路径拼接的用户输入展开。
 */

/** 单个解析结果 —— 与 Connection 的差别：jumpNames 是名字而不是 id（入库时才解析） */
export interface ParsedExternalConnection {
  name: string
  host: string
  port: number
  username: string
  group: string
  authType: AuthType
  privateKeyPath?: string
  /** ProxyJump 里的跳板机名字，入库时换成本机连接 id */
  jumpNames: string[]
}

export interface ParsedExternalBatch {
  connections: ParsedExternalConnection[]
  /** 协议不是 SSH 而被跳过的会话数（RDP / VNC / Telnet ...） */
  skippedNonSsh: number
  /** 字段缺失或格式坏掉、无法成条的会话数 */
  invalid: number
}

const GROUP_SSH_CONFIG = 'SSH Config'
const GROUP_MOBA = 'MobaXterm'
const GROUP_XSHELL = 'Xshell'
const GROUP_SECURECRT = 'SecureCRT'
const GROUP_FINALSHELL = 'FinalShell'

/** 目录递归扫描上限：真实客户端目录几千个会话，超过这个量级说明选错了根目录 */
const MAX_SCAN_FILES = 2000
const MAX_SCAN_DEPTH = 8

/** 各来源认识的文件扩展名（ssh_config 是单文件，无扩展名） */
const EXTENSIONS: Record<ExternalImportSource, string[]> = {
  'ssh-config': [],
  mobaxterm: ['.mxtsessions', '.ini'],
  xshell: ['.xsh'],
  securecrt: ['.ini'],
  finalshell: ['.json']
}

const DEFAULT_GROUP: Record<ExternalImportSource, string> = {
  'ssh-config': GROUP_SSH_CONFIG,
  mobaxterm: GROUP_MOBA,
  xshell: GROUP_XSHELL,
  securecrt: GROUP_SECURECRT,
  finalshell: GROUP_FINALSHELL
}

/* ------------------------------------------------------------------ *
 *  文本解码
 * ------------------------------------------------------------------ */

/**
 * 按 BOM 自动解码。
 *
 * Xshell 的 .xsh 是 UTF-16LE + BOM，按 UTF-8 读出来每个汉字都是替换字符；
 * 而 ssh_config / SecureCRT ini 基本是 UTF-8。BOM 是唯一可靠的判据 ——
 * 猜编码在这种小文件上准确率还不如看前三字节。
 */
export function decodeTextAuto(buf: Buffer): string {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.subarray(3).toString('utf8')
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return buf.subarray(2).toString('utf16le')
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    // swap16 要求偶数字节；末尾落单的字节直接丢掉（UTF-16 本就不该有半个码元）
    const body = buf.length % 2 === 0 ? buf.subarray(2) : buf.subarray(2, buf.length - 1)
    return Buffer.from(body).swap16().toString('utf16le')
  }
  return buf.toString('utf8')
}

/* ------------------------------------------------------------------ *
 *  公用小工具
 * ------------------------------------------------------------------ */

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

function isWildcard(alias: string): boolean {
  return alias.includes('*') || alias.includes('?')
}

/** 端口合法性：外部文件里 0 / 负数 / NaN 都出现过，一律回落到 22 */
function normalizePort(value: number): number {
  return Number.isFinite(value) && value >= 1 && value <= 65535 ? Math.trunc(value) : 22
}

/**
 * ssh_config 的值可以加双引号（`HostName "my host"`、`IdentityFile "~/a b"`）。
 *
 * 不去引号的话，主机名会带着引号去解析 DNS，私钥路径也会带着引号 stat。
 * 只处理成对的双引号：单个引号是用户的笔误，原样留着比猜更安全。
 */
function dequote(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1)
  return v
}

/**
 * 去重键 —— 必须与 store/connTransfer.ts 的 dupKey 完全一致。
 *
 * 两处导入用不同的键，会导致「从 swconn 导入过的连接，再从 Xshell 导入同一台机器时
 * 又新增一条」，用户看到两条一模一样的记录却查不出原因。
 */
function dupKey(c: { name: string; host: string; port: number; username: string }): string {
  return c.name + '\u0000' + c.host + '\u0000' + c.port + '\u0000' + c.username
}

/* ------------------------------------------------------------------ *
 *  ~/.ssh/config
 * ------------------------------------------------------------------ */

interface SshConfigBlock {
  aliases: string[]
  /** 该块只有 `!host` 负向模式：合法但导入不出连接，也不算无效 */
  negativeOnly?: boolean
  hostName?: string
  user?: string
  port?: number
  identityFile?: string
  proxyJump?: string
}

/** 拆 Key value 与 Key=value 两种写法（ssh_config 两种都接受） */
function splitOption(line: string): { key: string; value: string } | null {
  const eq = /^([A-Za-z][A-Za-z0-9]*)\s*=\s*(.*)$/.exec(line)
  if (eq) return { key: eq[1].toLowerCase(), value: eq[2].trim() }
  const sp = /^([A-Za-z][A-Za-z0-9]*)\s+(.*)$/.exec(line)
  if (sp) return { key: sp[1].toLowerCase(), value: sp[2].trim() }
  return null
}

/**
 * 按空白拆分的同时尊重双引号。
 *
 * `Host "my server" web` 是两个别名，不是三个 —— 直接 split(/\s+/) 会得到
 * '"my'、'server"' 这种碎块，导入后多出两条连不上的连接。
 */
function splitPatterns(value: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  for (const ch of value) {
    if (ch === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && /\s/.test(ch)) {
      if (cur.length > 0) out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.length > 0) out.push(cur)
  return out
}

/** ProxyJump 可以是 a,b、"user@a:22"；只留主机名，用户/端口在导入侧丢掉 */
function parseJumpNames(value?: string): string[] {
  if (!value) return []
  return value
    .split(',')
    // 每一跳都可能被引号包着（ProxyJump "bastion 1"），不逐个去引号会带着引号去查连接
    .map((s) => dequote(s))
    .filter(Boolean)
    .map((s) => {
      const noUser = s.includes('@') ? s.slice(s.lastIndexOf('@') + 1) : s
      return noUser.replace(/:\d+$/, '')
    })
    .filter((s) => s.length > 0 && !isWildcard(s))
}

/**
 * 解析 OpenSSH 客户端配置。
 *
 * Host a1 a2 是「一个块多个别名」，必须拆成两条连接（用户的意图是两个入口）；
 * 而 Host * / Host *.prod 是通配默认值块，导入它等于凭空造一条名叫 * 的连接，
 * 必须整块丢掉 —— 这是 Review Focus 里点名的一条。
 */
export function parseSshConfig(content: string): ParsedExternalBatch {
  const blocks: SshConfigBlock[] = []
  let cur: SshConfigBlock | null = null

  for (const raw of content.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    const opt = splitOption(line)
    if (!opt) continue
    if (opt.key === 'host' || opt.key === 'match') {
      if (cur) blocks.push(cur)
      // '!host' 是 ssh_config 的负向模式（"除这台以外都匹配"），不是连接名
      if (opt.key === 'host') {
        const patterns = splitPatterns(opt.value)
        const positive = patterns.filter((s) => !s.startsWith('!'))
        cur = {
          aliases: positive,
          /*
           * `Host !prod` 是「除 prod 外都匹配」的负向模式，本身不产生连接。
           * 只写负向模式的块属于合法的 Defaults 写法，不能算无效块 ——
           * 原来它被当成「Host 后面没写名字」，直接计进 invalid 吓人。
           */
          negativeOnly: positive.length === 0 && patterns.length > 0
        }
      } else {
        cur = null
      }
      continue
    }
    if (!cur) continue
    if (opt.key === 'hostname') cur.hostName = dequote(opt.value)
    else if (opt.key === 'user') cur.user = dequote(opt.value)
    else if (opt.key === 'port') cur.port = Number.parseInt(dequote(opt.value), 10)
    else if (opt.key === 'identityfile') cur.identityFile = dequote(opt.value)
    else if (opt.key === 'proxyjump') cur.proxyJump = opt.value
  }
  if (cur) blocks.push(cur)

  const connections: ParsedExternalConnection[] = []
  let invalid = 0

  for (const block of blocks) {
    if (block.aliases.length === 0) {
      if (!block.negativeOnly) invalid++
      continue
    }
    if (block.aliases.some(isWildcard)) continue
    for (const alias of block.aliases) {
      const host = (block.hostName ?? alias).trim()
      if (host.length === 0) {
        invalid++
        continue
      }
      connections.push({
        name: alias,
        host,
        port: normalizePort(block.port ?? 22),
        username: (block.user ?? '').trim(),
        group: GROUP_SSH_CONFIG,
        authType: block.identityFile ? 'privateKey' : 'password',
        privateKeyPath: block.identityFile ? expandHome(block.identityFile) : undefined,
        jumpNames: parseJumpNames(block.proxyJump)
      })
    }
  }

  return { connections, skippedNonSsh: 0, invalid }
}

/** 默认配置路径（探测不到时由 IPC 层弹选择框） */
export function defaultSshConfigPath(): string {
  return join(homedir(), '.ssh', 'config')
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p)
    return st.isFile()
  } catch {
    return false
  }
}

/* ------------------------------------------------------------------ *
 *  MobaXterm (.mxtsessions)
 * ------------------------------------------------------------------ */

/**
 * MobaXterm 的会话行是 <名字>=#<图标号>#<会话类型>%host%port%user%...
 *
 * 注意第一个 # 段是**用户可自由更换的图标编号**（109 只是默认 SSH 图标），
 * 第二个 # 段才是会话类型。旧实现按 #1 判协议，于是把图标改成 120 的 SSH
 * 全跳过了，而图标留在 109 的 RDP/VNC 反而被当成 SSH 导入（R-H25）。
 */
const MOBA_SESSION_SSH = '0'
/**
 * 7 = SFTP。走同一套主机/端口/账号，导入成 SSH 连接一样能用；
 * 不认它会把它们算进「跳过 N 条非 SSH」，用户看着像丢了东西。
 */
const MOBA_SESSION_SFTP = '7'
/** 远古单 # 格式没有类型段，那时第一段直接就是 109 图标 */
const MOBA_LEGACY_SSH_ICON = '109'

/** 书签名恰好是协议名时（很常见）用主机名兜底，避免一堆叫 SSH 的连接 */
const MOBA_PROTOCOL_TOKENS = new Set([
  'ssh',
  'rdp',
  'vnc',
  'telnet',
  'rlogin',
  'xdmcp',
  'ftp',
  'sftp',
  'serial',
  'shell'
])

function mobaGroupPath(value: string): string {
  const p = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  return p.length > 0 ? p : GROUP_MOBA
}

interface MobaEntry {
  /** 是否会话类型为 SSH 系（SSH / SFTP） */
  ssh: boolean
  host: string
  port: number
  username: string
}

function parseMobaEntry(value: string): MobaEntry | null {
  const parts = value.split('%')
  if (parts.length < 3) return null
  const head = parts[0].trim()
  if (!head.startsWith('#')) return null
  const hashParts = head.split('#')
  /*
   * hashParts[0] 是 '#' 前的空串，[1] 图标号，[2] 会话类型。
   * 类型段为空（老文件）才回退看图标号 —— 那时两者恰好是同一件事。
   */
  const sessionType = (hashParts[2] ?? '').trim()
  const ssh =
    sessionType.length > 0
      ? sessionType === MOBA_SESSION_SSH || sessionType === MOBA_SESSION_SFTP
      : (hashParts[1] ?? '').trim() === MOBA_LEGACY_SSH_ICON
  const host = (parts[1] ?? '').trim()
  if (host.length === 0) return null
  return {
    ssh,
    host,
    port: normalizePort(Number.parseInt((parts[2] ?? '').trim(), 10)),
    username: (parts[3] ?? '').trim()
  }
}

/**
 * 解析 MobaXterm 书签文件。
 *
 * 分组来自 SubRep=，层级用反斜杠分隔（如 客户A\\网关），
 * 这里换成我们自己的 / 分隔符，跟连接分组的习惯保持一致。
 */
export function parseMobaXterm(content: string): ParsedExternalBatch {
  const connections: ParsedExternalConnection[] = []
  let group = GROUP_MOBA
  let skippedNonSsh = 0
  const invalid = 0

  for (const raw of content.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('[')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key === 'SubRep') {
      group = mobaGroupPath(value)
      continue
    }
    if (key === 'ImgNum' || key === 'SubRepColor') continue
    const entry = parseMobaEntry(value)
    if (!entry) continue
    if (!entry.ssh) {
      // RDP / VNC / Telnet 我们连不了，但要如实计数告诉用户「跳过了多少」
      skippedNonSsh++
      continue
    }
    const name = MOBA_PROTOCOL_TOKENS.has(key.toLowerCase()) ? entry.host : key
    connections.push({
      name,
      host: entry.host,
      port: entry.port,
      username: entry.username,
      group,
      authType: 'password',
      jumpNames: []
    })
  }

  return { connections, skippedNonSsh, invalid }
}

/* ------------------------------------------------------------------ *
 *  Xshell (.xsh)
 * ------------------------------------------------------------------ */

/** 读 INI 风格 Key=Value，同名键首次出现优先（Xshell 会分节重复写 SessionName） */
function readKeyValues(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (line.length === 0 || line.startsWith('[') || line.startsWith(';') || line.startsWith('#')) {
      continue
    }
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim().toLowerCase()
    if (!map.has(key)) map.set(key, line.slice(eq + 1).trim())
  }
  return map
}

/**
 * 解析单个 Xshell 会话文件。
 *
 * 文件名不是可靠的会话名（Xshell 用随机目录 + 数字目录存 .xsh），
 * 真名在 [SESSION] SessionName= 里 —— 也是唯一能保住中文的字段。
 */
export function parseXshellFile(name: string, buf: Buffer, group?: string): ParsedExternalBatch {
  const props = readKeyValues(decodeTextAuto(buf))
  const protocol = (props.get('protocol') ?? 'SSH').toUpperCase()
  if (protocol !== 'SSH' && protocol !== 'SSH2') {
    return { connections: [], skippedNonSsh: 1, invalid: 0 }
  }
  const host = (props.get('host') ?? '').trim()
  if (host.length === 0) return { connections: [], skippedNonSsh: 0, invalid: 1 }

  const sessionName = (props.get('sessionname') ?? '').trim()
  return {
    connections: [
      {
        name: sessionName.length > 0 ? sessionName : basename(name, extname(name)),
        host,
        port: normalizePort(Number.parseInt(props.get('port') ?? '', 10)),
        username: (props.get('username') ?? props.get('user') ?? '').trim(),
        group: group ?? GROUP_XSHELL,
        authType: 'password',
        jumpNames: []
      }
    ],
    skippedNonSsh: 0,
    invalid: 0
  }
}

/* ------------------------------------------------------------------ *
 *  SecureCRT (.ini)
 * ------------------------------------------------------------------ */

/**
 * SecureCRT 的端口是 8 位十六进制 DWORD（D:"[SSH2] Port"=000008ae 即 2222）。
 *
 * 按十进制 parseInt 会得到 8 或者 NaN —— 这正是 Review Focus 点名的坑。
 * 只在「纯十六进制字符 且 长度 >= 6」时按 16 进制读，否则按十进制，
 * 免得把某些版本写成十进制的 22 当成 0x22 = 34。
 */
function parseSecureCrtPort(raw: string): number {
  const v = raw.trim()
  if (v.length === 0) return 22
  if (/^[0-9a-fA-F]{1,8}$/.test(v) && v.length >= 6) {
    return normalizePort(Number.parseInt(v, 16))
  }
  return normalizePort(Number.parseInt(v, 10))
}

/** 解析单个 SecureCRT 会话 ini（文件名是 _<hash>.ini，会话名在 S:"Session Name"） */
export function parseSecureCrtFile(name: string, buf: Buffer, group?: string): ParsedExternalBatch {
  const props = new Map<string, string>()
  for (const raw of decodeTextAuto(buf).replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^\s*[SD]:"([^"]+)"=(.*)$/.exec(raw)
    if (!m) continue
    const key = m[1].trim().toLowerCase()
    if (!props.has(key)) props.set(key, m[2].trim())
  }

  const protocol = (props.get('protocol name') ?? '').toUpperCase()
  if (!protocol.startsWith('SSH')) return { connections: [], skippedNonSsh: 1, invalid: 0 }

  const host = (props.get('hostname') ?? '').trim()
  if (host.length === 0) return { connections: [], skippedNonSsh: 0, invalid: 1 }

  const sessionName = (props.get('session name') ?? '').trim()
  return {
    connections: [
      {
        name:
          sessionName.length > 0 ? sessionName : basename(name, extname(name)).replace(/^_+/, ''),
        host,
        port: parseSecureCrtPort(props.get('[ssh2] port') ?? props.get('port') ?? ''),
        username: (props.get('username') ?? '').trim(),
        group: group ?? GROUP_SECURECRT,
        authType: 'password',
        jumpNames: []
      }
    ],
    skippedNonSsh: 0,
    invalid: 0
  }
}

/* ------------------------------------------------------------------ *
 *  FinalShell (conn_*.json)
 * ------------------------------------------------------------------ */

function strField(source: Record<string, unknown>, keys: string[]): string {
  for (const k of keys) {
    const v = source[k]
    if (typeof v === 'string' && v.trim().length > 0) return v.trim()
  }
  return ''
}

/** 解析单个 FinalShell 连接文件：字段是 name / host / port / user_name */
export function parseFinalShellFile(name: string, buf: Buffer, group?: string): ParsedExternalBatch {
  let raw: unknown
  try {
    raw = JSON.parse(decodeTextAuto(buf))
  } catch {
    return { connections: [], skippedNonSsh: 0, invalid: 1 }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { connections: [], skippedNonSsh: 0, invalid: 1 }
  }
  const obj = raw as Record<string, unknown>

  const protocol = strField(obj, ['protocol', 'connect_type', 'type']).toLowerCase()
  if (protocol.length > 0 && !protocol.includes('ssh')) {
    return { connections: [], skippedNonSsh: 1, invalid: 0 }
  }

  const host = strField(obj, ['host'])
  if (host.length === 0) return { connections: [], skippedNonSsh: 0, invalid: 1 }

  const portRaw = obj.port
  /*
   * FinalShell 把端口写成数字，但手工改过的配置文件里也见过字符串。
   * 这里只接受这两种形态，其余一律走 normalizePort 的默认端口 —— 不能直接
   * 把任意对象丢给 String()（会拿到 '[object Object]'，parseInt 得 NaN）。
   */
  const portValue =
    typeof portRaw === 'number'
      ? portRaw
      : typeof portRaw === 'string'
        ? Number.parseInt(portRaw, 10)
        : Number.NaN
  const port = normalizePort(portValue)

  const sessionName = strField(obj, ['name', 'description'])
  return {
    connections: [
      {
        name: sessionName.length > 0 ? sessionName : basename(name, extname(name)),
        host,
        port,
        username: strField(obj, ['user_name', 'username', 'user']),
        group: group ?? GROUP_FINALSHELL,
        authType: 'password',
        jumpNames: []
      }
    ],
    skippedNonSsh: 0,
    invalid: 0
  }
}

/* ------------------------------------------------------------------ *
 *  目录扫描
 * ------------------------------------------------------------------ */

/**
 * 递归找某个来源的会话文件。
 *
 * 深度上限 8、总量上限 2000：用户大概率直接选 %APPDATA% 或整个用户目录，
 * 没有上限就会顺着依赖缓存之类的一路读下去。
 * 文件的深度按相对根目录的路径层数算（根下的直接子文件是 1 层）。
 */
export function scanConfigFiles(root: string, source: ExternalImportSource): string[] {
  const exts = EXTENSIONS[source]
  if (exts.length === 0) return []
  const out: string[] = []

  const walk = (dir: string, depth: number): void => {
    if (depth >= MAX_SCAN_DEPTH || out.length >= MAX_SCAN_FILES) return
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    entries.sort()
    for (const entry of entries) {
      if (out.length >= MAX_SCAN_FILES) return
      const full = join(dir, entry)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!st.isFile()) continue
      const lower = entry.toLowerCase()
      if (!exts.some((e) => lower.endsWith(e))) continue
      // FinalShell 的连接文件一律叫 conn_*.json，别的 json 是配置/缓存
      if (source === 'finalshell' && !lower.startsWith('conn_')) continue
      out.push(full)
    }
  }

  walk(root, 0)
  return out
}

/* ------------------------------------------------------------------ *
 *  读取 / 解析一批路径
 * ------------------------------------------------------------------ */

interface CollectedBatch extends ParsedExternalBatch {
  /** 实际读了多少个文件（预览里要告诉用户「扫了几个文件才找到 N 条」） */
  files: number
}

async function expandPaths(source: ExternalImportSource, paths: string[]): Promise<string[]> {
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of paths) {
    let isDir = false
    try {
      isDir = (await fs.stat(p)).isDirectory()
    } catch {
      continue
    }
    const files = isDir ? scanConfigFiles(p, source) : [p]
    for (const f of files) {
      if (seen.has(f)) continue
      seen.add(f)
      out.push(f)
    }
  }
  return out
}

async function parseFile(
  source: ExternalImportSource,
  file: string
): Promise<ParsedExternalBatch> {
  let buf: Buffer
  try {
    buf = await fs.readFile(file)
  } catch {
    return { connections: [], skippedNonSsh: 0, invalid: 1 }
  }
  const group = DEFAULT_GROUP[source]
  switch (source) {
    case 'ssh-config':
      return parseSshConfig(decodeTextAuto(buf))
    case 'mobaxterm':
      return parseMobaXterm(decodeTextAuto(buf))
    case 'xshell':
      return parseXshellFile(file, buf, group)
    case 'securecrt':
      return parseSecureCrtFile(file, buf, group)
    case 'finalshell':
      return parseFinalShellFile(file, buf, group)
    default:
      return { connections: [], skippedNonSsh: 0, invalid: 1 }
  }
}

async function collectBatch(
  source: ExternalImportSource,
  paths: string[]
): Promise<CollectedBatch> {
  const files = await expandPaths(source, paths)
  const connections: ParsedExternalConnection[] = []
  const seen = new Set<string>()
  let skippedNonSsh = 0
  let invalid = 0
  for (const file of files) {
    const batch = await parseFile(source, file)
    for (const c of batch.connections) {
      /*
       * 批内去重。同一个 Host 块里的多个别名、或者被扫到的两个文件里写了同一条，
       * 都会在同一个批次里产生重复键 —— 预览里显示 N 条、入库也只该是 N 条，
       * 否则「导入了 12 条」实际库里只有 8 条，用户只会以为工具坏了。
       */
      const key = dupKey(c)
      if (seen.has(key)) continue
      seen.add(key)
      connections.push(c)
    }
    skippedNonSsh += batch.skippedNonSsh
    invalid += batch.invalid
  }
  return { connections, skippedNonSsh, invalid, files: files.length }
}

/* ------------------------------------------------------------------ *
 *  预览 / 入库
 * ------------------------------------------------------------------ */

export async function previewExternalImport(
  source: ExternalImportSource,
  paths: string[]
): Promise<ExternalImportPreview> {
  const batch = await collectBatch(source, paths)
  const existing = new Set((await listConnections()).map(dupKey))

  const groupCount = new Map<string, number>()
  let duplicates = 0
  for (const c of batch.connections) {
    groupCount.set(c.group, (groupCount.get(c.group) ?? 0) + 1)
    if (existing.has(dupKey(c))) duplicates++
  }

  return {
    source,
    count: batch.connections.length,
    groups: [...groupCount.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
    duplicates,
    skippedNonSsh: batch.skippedNonSsh,
    invalid: batch.invalid,
    // 外部客户端的密码都是加密的，导入侧一律不带凭据 —— 如实告诉用户
    withoutPasswordCount: batch.connections.length,
    sampleNames: batch.connections.slice(0, 8).map((c) => c.name),
    files: batch.files
  }
}

export async function applyExternalImport(
  source: ExternalImportSource,
  paths: string[],
  mode: ConnImportMode
): Promise<ExternalImportResult> {
  if (mode !== 'skip' && mode !== 'overwrite') throw new Error('导入模式无效')

  const batch = await collectBatch(source, paths)
  const existing = await listConnections()
  const byKey = new Map(existing.map((c) => [dupKey(c), c]))
  const nameToId = new Map(existing.map((c) => [c.name, c.id]))
  const now = Date.now()

  const plans: Array<{ parsed: ParsedExternalConnection; id: string; hit?: Connection }> = []
  let added = 0
  let updated = 0
  let skipped = 0

  for (const parsed of batch.connections) {
    const hit = byKey.get(dupKey(parsed))
    if (hit) {
      nameToId.set(parsed.name, hit.id)
      if (mode === 'skip') {
        skipped++
        continue
      }
      updated++
      plans.push({ parsed, id: hit.id, hit })
      continue
    }
    const id = randomUUID()
    nameToId.set(parsed.name, id)
    added++
    plans.push({ parsed, id })
  }

  /*
   * 跳板解析放在「所有 id 都分配完」之后。
   * ProxyJump 可以指向配置文件里排在后面的块（bastion 常常写在最后），
   * 边解析边绑定会漏掉这种前向引用；指向库里已有连接也要能连上。
   */
  const resolveJumps = (
    parsed: ParsedExternalConnection,
    selfId: string
  ): string[] | undefined => {
    const ids = parsed.jumpNames
      .map((n) => nameToId.get(n))
      // 自引用（ProxyJump 写成了自己）会变成「自己跳自己」，连不出去且删不掉
      .filter((id): id is string => Boolean(id) && id !== selfId)
    return ids.length > 0 ? ids : undefined
  }

  const writes: Connection[] = []
  for (const plan of plans) {
    const p = plan.parsed
    const base: Connection = {
      id: plan.id,
      kind: 'ssh',
      name: p.name,
      host: p.host,
      port: p.port,
      username: p.username,
      authType: p.authType,
      privateKeyPath: p.privateKeyPath,
      group: p.group,
      tags: [],
      createdAt: now,
      updatedAt: now,
      proxyJump: resolveJumps(p, plan.id)
    }
    if (plan.hit) {
      /*
       * 覆盖导入只更新「从外部读到的」字段：
       * 标签、颜色、备注、代理、老算法兼容开关都是用户在本机加的，
       * 外部文件里没有对应概念，照抄过去等于每次导入都把本地设置洗掉。
       */
      const hit = plan.hit
      writes.push({
        ...hit,
        ...base,
        createdAt: hit.createdAt,
        tags: hit.tags,
        color: hit.color,
        remark: hit.remark,
        proxy: hit.proxy,
        legacyAlgorithms: hit.legacyAlgorithms,
        proxyJump: resolveJumps(p, plan.id)
      })
      continue
    }
    writes.push(base)
  }

  await bulkUpsertConnections(writes)

  return {
    added,
    updated,
    skipped,
    invalid: batch.invalid,
    skippedNonSsh: batch.skippedNonSsh,
    files: batch.files
  }
}
