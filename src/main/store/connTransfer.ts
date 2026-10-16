import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  scrypt
} from 'node:crypto'
import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type {
  AuthType,
  ConnExportOptions,
  ConnExportResult,
  ConnImportMode,
  ConnImportPreview,
  ConnImportResult,
  Connection,
  ProxyConfig
} from '@shared/types'
import { dataDir } from './jsonStore'
import { bulkUpsertConnections, listConnections } from './repository'
import { getSecret, setSecretsBulk, type PlainSecret } from './vault'

/**
 * 连接导出 / 导入：把连接发给同事，对方导入后直接可用。
 *
 * 为什么不能直接拷数据目录：密码用 safeStorage（Windows DPAPI）加密，只有本机本账户能解开；
 * 私钥记录的是本机绝对路径。所以导出时把密码解密、私钥内容一起打包；
 * 导入时在对方机器上用对方账户重新加密，私钥写进对方数据目录并改写路径。
 *
 * 文件格式（JSON）：
 *   不加口令：{ format, version, encrypted: false, payload }
 *   加口令：  { format, version, encrypted: true, kdf, cipher, iv, tag, data }（scrypt + AES-256-GCM）
 * 不加口令时文件里是明文密码和私钥，拿到文件就能登录，注意保管。
 */

export const TRANSFER_FORMAT = 'ssh-workbench-connections'
const VERSION = 1
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_KEY_BYTES = 64 * 1024
const MIN_PASSPHRASE = 4
const AUTH_TYPES: AuthType[] = ['password', 'privateKey', 'agent']
const SCRYPT = { N: 1 << 15, r: 8, p: 1 }

interface ExportedConn {
  /** 导出方的连接 id，仅用于还原跳板机引用 */
  ref: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  group: string
  tags: string[]
  color?: string
  remark?: string
  /** 导出凭据时含代理密码 */
  proxy?: ProxyConfig
  /** 跳板机链，元素为其他导出项的 ref */
  proxyJump?: string[]
  /** 私钥引用（keys 表的键） */
  keyRef?: string
  password?: string
  passphrase?: string
}

interface Payload {
  exportedAt: number
  connections: ExportedConn[]
  /** ref -> { 文件名, base64 内容 }：上千台共用一把私钥时只存一份 */
  keys: Record<string, { name: string; data: string }>
}

interface CleanPayload {
  exportedAt?: number
  connections: ExportedConn[]
  keys: Map<string, { name: string; data: Buffer }>
  /** 字段不合法被丢弃的连接数 */
  invalid: number
}

type Envelope = Record<string, unknown>

/* ------------------------------------------------------------------ *
 *  导出
 * ------------------------------------------------------------------ */

export async function exportConnectionsToFile(
  file: string,
  opts: ConnExportOptions
): Promise<Omit<ConnExportResult, 'canceled'>> {
  if (opts.passphrase !== undefined && opts.passphrase.length < MIN_PASSPHRASE) {
    throw new Error(`口令至少 ${MIN_PASSPHRASE} 位`)
  }
  const { payload, stats } = await buildPayload(opts)
  if (stats.count === 0) throw new Error('所选范围内没有连接')

  const envelope = opts.passphrase
    ? await seal(payload, opts.passphrase)
    : { format: TRANSFER_FORMAT, version: VERSION, encrypted: false, payload }

  // 先写临时文件再改名：中途失败不留半个文件
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(envelope), { encoding: 'utf8', mode: 0o600 })
  await fs.rename(tmp, file)
  return { path: file, ...stats }
}

async function buildPayload(opts: ConnExportOptions): Promise<{
  payload: Payload
  stats: Omit<ConnExportResult, 'canceled' | 'path'>
}> {
  const all = await listConnections()
  const wanted = opts.groups ? new Set(opts.groups) : null
  const picked = wanted ? all.filter((c) => wanted.has(c.group || '默认')) : all
  const pickedIds = new Set(picked.map((c) => c.id))

  const keys: Payload['keys'] = {}
  /** 私钥路径 -> 引用；同一文件只读一次 */
  const keyByPath = new Map<string, string | null>()
  let noPassword = 0
  let missingKeys = 0
  let droppedJumps = 0
  const connections: ExportedConn[] = []

  for (const c of picked) {
    const secret: PlainSecret = opts.includeSecrets ? await getSecret(c.id) : {}

    let keyRef: string | undefined
    if (opts.includeSecrets && c.authType === 'privateKey' && c.privateKeyPath) {
      if (!keyByPath.has(c.privateKeyPath)) {
        keyByPath.set(c.privateKeyPath, await readKeyInto(c.privateKeyPath, keys))
      }
      keyRef = keyByPath.get(c.privateKeyPath) ?? undefined
      if (!keyRef) missingKeys++
    }
    if (opts.includeSecrets && c.authType === 'password' && !secret.password) noPassword++

    // 跳板机只保留导出范围内的；范围外的在对方机器上不存在
    const jumps = (c.proxyJump ?? []).filter((id) => pickedIds.has(id))
    droppedJumps += (c.proxyJump?.length ?? 0) - jumps.length

    connections.push({
      ref: c.id,
      name: c.name,
      host: c.host,
      port: c.port,
      username: c.username,
      authType: c.authType,
      group: c.group || '默认',
      tags: c.tags ?? [],
      color: c.color,
      remark: c.remark,
      proxy: c.proxy
        ? { ...c.proxy, password: opts.includeSecrets ? secret.proxyPassword : undefined }
        : undefined,
      proxyJump: jumps.length > 0 ? jumps : undefined,
      keyRef,
      password: secret.password,
      passphrase: secret.passphrase
    })
  }

  return {
    payload: { exportedAt: Date.now(), connections, keys },
    stats: {
      count: connections.length,
      keyCount: Object.keys(keys).length,
      noPassword,
      missingKeys,
      droppedJumps
    }
  }
}

/** 读私钥文件放进 keys 表，返回引用；文件不存在 / 为空 / 过大返回 null */
async function readKeyInto(p: string, keys: Payload['keys']): Promise<string | null> {
  try {
    const path = expandHome(p)
    const st = await fs.stat(path)
    if (!st.isFile() || st.size === 0 || st.size > MAX_KEY_BYTES) return null
    const data = await fs.readFile(path)
    const ref = sha16(data)
    keys[ref] = { name: basename(path), data: data.toString('base64') }
    return ref
  } catch {
    return null
  }
}

async function seal(payload: Payload, passphrase: string): Promise<Envelope> {
  const salt = randomBytes(16)
  const iv = randomBytes(12)
  const key = await deriveKey(passphrase, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()])
  return {
    format: TRANSFER_FORMAT,
    version: VERSION,
    encrypted: true,
    kdf: { name: 'scrypt', ...SCRYPT, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64')
  }
}

/* ------------------------------------------------------------------ *
 *  导入
 * ------------------------------------------------------------------ */

/** 只读文件头：校验格式，返回是否加密 */
export async function inspectImportFile(file: string): Promise<{ encrypted: boolean }> {
  const env = await readEnvelope(file)
  return { encrypted: env.encrypted === true }
}

export async function previewImport(file: string, passphrase?: string): Promise<ConnImportPreview> {
  const env = await readEnvelope(file)
  const p = await openEnvelope(env, passphrase)
  const existing = new Set((await listConnections()).map(dupKey))

  const groupCount = new Map<string, number>()
  for (const c of p.connections) groupCount.set(c.group, (groupCount.get(c.group) ?? 0) + 1)

  return {
    path: file,
    encrypted: env.encrypted === true,
    exportedAt: p.exportedAt,
    count: p.connections.length,
    groups: [...groupCount.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
      .map(([name, count]) => ({ name, count })),
    duplicates: p.connections.filter((c) => existing.has(dupKey(c))).length,
    keyCount: p.keys.size,
    withSecrets: p.connections.filter(
      (c) =>
        Boolean(c.password || c.passphrase || c.proxy?.password) ||
        Boolean(c.keyRef && p.keys.has(c.keyRef))
    ).length,
    invalid: p.invalid
  }
}

/**
 * 导入。名称+地址+端口+用户名相同视为重复：
 * skip = 跳过重复项；overwrite = 用文件内容覆盖（文件里没有的凭据保留原值）。
 * 同一文件内的重复项只导入第一条。
 */
export async function applyImport(
  file: string,
  passphrase: string | undefined,
  mode: ConnImportMode
): Promise<ConnImportResult> {
  const p = await openEnvelope(await readEnvelope(file), passphrase)
  const now = Date.now()

  // 私钥按需写入本机数据目录（被跳过的连接用到的私钥不写），同内容只存一份
  const keysDir = join(dataDir(), 'keys')
  const keyPath = new Map<string, string>()
  let keysWritten = 0
  const ensureKey = async (ref: string | undefined): Promise<string | undefined> => {
    if (!ref) return undefined
    const cached = keyPath.get(ref)
    if (cached) return cached
    const k = p.keys.get(ref)
    if (!k) return undefined
    await fs.mkdir(keysDir, { recursive: true })
    const dest = join(keysDir, `imp-${sha16(k.data)}-${k.name}`)
    const same = await fs.readFile(dest).then((b) => b.equals(k.data), () => false)
    if (!same) {
      await fs.writeFile(dest, k.data, { mode: 0o600 })
      keysWritten++
    }
    keyPath.set(ref, dest)
    return dest
  }

  const byKey = new Map((await listConnections()).map((c) => [dupKey(c), c]))
  const refToId = new Map<string, string>()
  const pending = new Map<string, Connection>()
  const secrets = new Map<string, PlainSecret>()
  const plans: Array<{ src: ExportedConn; id: string }> = []
  let added = 0
  let updated = 0
  let skipped = 0

  for (const src of p.connections) {
    const k = dupKey(src)
    const hit = byKey.get(k)
    // 文件内重复 或 skip 模式下与现有重复：跳过，但跳板引用仍指向那条连接
    if (hit && (pending.has(hit.id) || mode === 'skip')) {
      refToId.set(src.ref, hit.id)
      skipped++
      continue
    }

    const id = hit?.id ?? randomUUID()
    refToId.set(src.ref, id)
    const conn: Connection = {
      id,
      name: src.name,
      host: src.host,
      port: src.port,
      username: src.username,
      authType: src.authType,
      privateKeyPath:
        src.authType === 'privateKey'
          ? ((await ensureKey(src.keyRef)) ?? hit?.privateKeyPath)
          : undefined,
      group: src.group,
      tags: src.tags,
      color: src.color,
      remark: src.remark,
      proxy: src.proxy ? { ...src.proxy, password: undefined } : undefined,
      lastUsedAt: hit?.lastUsedAt,
      createdAt: hit?.createdAt ?? now,
      updatedAt: now
    }
    pending.set(id, conn)
    plans.push({ src, id })
    byKey.set(k, conn)
    if (hit) updated++
    else added++

    const cur: PlainSecret = hit ? await getSecret(id) : {}
    secrets.set(id, {
      password: src.password ?? cur.password,
      passphrase: src.passphrase ?? cur.passphrase,
      proxyPassword: src.proxy ? (src.proxy.password ?? cur.proxyPassword) : undefined
    })
  }

  // 跳板机引用从导出方 id 映射到本机 id
  for (const { src, id } of plans) {
    const jumps = (src.proxyJump ?? [])
      .map((r) => refToId.get(r))
      .filter((x): x is string => Boolean(x) && x !== id)
    const conn = pending.get(id)
    if (conn) conn.proxyJump = jumps.length > 0 ? jumps : undefined
  }

  await bulkUpsertConnections([...pending.values()])
  await setSecretsBulk([...secrets.entries()])
  return { added, updated, skipped, keysWritten, invalid: p.invalid }
}

async function readEnvelope(file: string): Promise<Envelope> {
  const st = await fs.stat(file)
  if (st.size > MAX_FILE_BYTES) throw new Error('文件过大，不是连接导出文件')
  let env: unknown
  try {
    env = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^﻿/, ''))
  } catch {
    throw new Error('不是有效的连接导出文件（无法解析）')
  }
  const e = env as Envelope | null
  if (!e || typeof e !== 'object' || e.format !== TRANSFER_FORMAT) {
    throw new Error('不是 SSH Workbench 导出的连接文件')
  }
  if (typeof e.version !== 'number' || e.version > VERSION) {
    throw new Error('文件版本较新，请升级 SSH Workbench 后再导入')
  }
  return e
}

async function openEnvelope(env: Envelope, passphrase?: string): Promise<CleanPayload> {
  if (env.encrypted !== true) return cleanPayload(env.payload)
  if (!passphrase) throw new Error('该文件已加密，请输入导出时设置的口令')

  const kdf = (env.kdf ?? {}) as Record<string, unknown>
  const salt = b64(kdf.salt)
  const iv = b64(env.iv)
  const tag = b64(env.tag)
  const data = b64(env.data)
  const N = Number(kdf.N)
  const r = Number(kdf.r)
  const pp = Number(kdf.p)
  // 参数来自文件，限制范围，防止被构造成耗尽内存 / CPU
  const validKdf =
    kdf.name === 'scrypt' &&
    Number.isInteger(N) && N >= 1 << 14 && N <= 1 << 17 && (N & (N - 1)) === 0 &&
    r === 8 && Number.isInteger(pp) && pp >= 1 && pp <= 4
  if (!validKdf || env.cipher !== 'aes-256-gcm' || !salt || salt.length < 16 ||
      iv?.length !== 12 || tag?.length !== 16 || !data) {
    throw new Error('加密文件格式不正确或已损坏')
  }

  const key = await deriveKey(passphrase, salt, N, r, pp)
  let plain: string
  try {
    const d = createDecipheriv('aes-256-gcm', key, iv)
    d.setAuthTag(tag)
    plain = Buffer.concat([d.update(data), d.final()]).toString('utf8')
  } catch {
    throw new Error('口令错误，或文件已损坏')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(plain)
  } catch {
    throw new Error('文件内容已损坏')
  }
  return cleanPayload(parsed)
}

/** 逐条校验文件内容：不合法的连接丢弃并计数，字段统一截断长度 */
function cleanPayload(raw: unknown): CleanPayload {
  const r = raw as Partial<Payload> | null
  if (!r || typeof r !== 'object' || !Array.isArray(r.connections)) {
    throw new Error('文件内容不完整')
  }

  const keys = new Map<string, { name: string; data: Buffer }>()
  if (r.keys && typeof r.keys === 'object') {
    for (const [ref, k] of Object.entries(r.keys)) {
      const name = str(k?.name, 128)
      const data = b64(k?.data)
      if (!name || !data || data.length === 0 || data.length > MAX_KEY_BYTES) continue
      keys.set(ref, { name: name.replace(/[^\w.-]/g, '_') || 'key', data })
    }
  }

  const connections: ExportedConn[] = []
  let invalid = 0
  for (const item of r.connections as unknown[]) {
    const c = item as Partial<ExportedConn> | null
    const name = str(c?.name)?.trim()
    const host = str(c?.host, 255)?.trim()
    const username = str(c?.username, 255)?.trim()
    const port = Number(c?.port)
    const authType = c?.authType
    if (
      !c || !name || !host || !username ||
      !Number.isInteger(port) || port < 1 || port > 65535 ||
      !AUTH_TYPES.includes(authType as AuthType)
    ) {
      invalid++
      continue
    }
    const keyRef = str(c.keyRef, 64)
    connections.push({
      ref: str(c.ref, 64) ?? randomUUID(),
      name,
      host,
      port,
      username,
      authType: authType as AuthType,
      group: str(c.group, 255)?.trim() || '默认',
      tags: Array.isArray(c.tags)
        ? c.tags.filter((t): t is string => typeof t === 'string').slice(0, 50).map((t) => t.slice(0, 64))
        : [],
      color: str(c.color, 32),
      remark: str(c.remark, 2000),
      proxy: cleanProxy(c.proxy),
      proxyJump: Array.isArray(c.proxyJump)
        ? c.proxyJump.filter((x): x is string => typeof x === 'string').slice(0, 10)
        : undefined,
      keyRef: keyRef && keys.has(keyRef) ? keyRef : undefined,
      password: str(c.password, 1024),
      passphrase: str(c.passphrase, 1024)
    })
  }
  return {
    exportedAt: typeof r.exportedAt === 'number' ? r.exportedAt : undefined,
    connections,
    keys,
    invalid
  }
}

function cleanProxy(v: unknown): ProxyConfig | undefined {
  const p = v as Partial<ProxyConfig> | null
  if (!p || (p.type !== 'socks5' && p.type !== 'http')) return undefined
  const host = str(p.host, 255)?.trim()
  const port = Number(p.port)
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return {
    type: p.type,
    host,
    port,
    username: str(p.username, 255),
    password: str(p.password, 1024)
  }
}

/* ------------------------------------------------------------------ *
 *  工具
 * ------------------------------------------------------------------ */

function dupKey(c: { name: string; host: string; port: number; username: string }): string {
  return `${c.name}\u0000${c.host}\u0000${c.port}\u0000${c.username}`
}

function str(v: unknown, max = 512): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v.slice(0, max) : undefined
}

function b64(v: unknown): Buffer | undefined {
  return typeof v === 'string' ? Buffer.from(v, 'base64') : undefined
}

function sha16(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex').slice(0, 16)
}

function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

function deriveKey(pass: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(pass, salt, 32, { N, r, p, maxmem: 256 * N * r }, (err, key) =>
      err ? reject(err) : resolve(key)
    )
  })
}
