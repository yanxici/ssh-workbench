import {
  Client,
  type CipherAlgorithm,
  type ClientChannel,
  type ConnectConfig,
  type KexAlgorithm,
  type MacAlgorithm,
  type ServerHostKeyAlgorithm
} from 'ssh2'
import { createHash, getCiphers, getDiffieHellman, getHashes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import type { AppSettings, AuthType, ProxyConfig } from '@shared/types'
import { getKnownHost, upsertKnownHost } from '../store/repository'
import type { PlainSecret } from '../store/vault'
import { openProxySocket } from '../util/proxySockets'

/**
 * 连接配置构建与建连原语 —— 会话管理（sessionManager）与「测试连接」共用。
 */

export const READY_TIMEOUT_MS = 15000

export interface ConnectTarget {
  host: string
  port: number
  username: string
  authType: AuthType
  privateKeyPath?: string
  /** 老设备兼容算法开关（旧固件只支持 group1-sha1 / ssh-dss / 3des-cbc 等） */
  legacyAlgorithms?: boolean
}

/**
 * 老设备兼容算法包（Spec §5.1）。
 *
 * 顺序即优先级：当前运行时的 `ssh2` 现代默认集合排在最前，老算法追加在末尾 ——
 * 这样即使打开了开关，只要对端支持现代算法，仍然优先协商现代算法，不会降级。
 *
 * 为什么不能静态写死算法名：
 * 1. Electron 45 内置 BoringSSL 不含 OpenSSL 的 `chacha20` cipher，静态塞入
 *    `chacha20-poly1305@openssh.com` 会令 `client.connect()` 同步抛出
 *    `Unsupported algorithm`；
 * 2. 不同机器是否编出 `sshcrypto.node` 原生绑定会改变 `DEFAULT_CIPHER` 顺序。
 *
 * 因此在模块加载时通过 `createRequire` 读取 `ssh2` 当前运行时的 `DEFAULT_*` 与
 * `SUPPORTED_*`（按精选老算法白名单过滤，不放行 `arcfour` 等极弱算法），若未来
 * `ssh2` 调整内部路径，则回退到按 `node:crypto` 实测能力过滤的静态集合。
 */
function supportsModp2(): boolean {
  try {
    getDiffieHellman('modp2')
    return true
  } catch {
    return false
  }
}

const LEGACY_KEX_EXTRA: KexAlgorithm[] = [
  'diffie-hellman-group-exchange-sha1',
  'diffie-hellman-group14-sha1',
  ...(supportsModp2() ? (['diffie-hellman-group1-sha1'] as KexAlgorithm[]) : [])
]
const LEGACY_HOSTKEY_EXTRA: ServerHostKeyAlgorithm[] = ['ssh-dss']
const LEGACY_CIPHER_EXTRA: CipherAlgorithm[] = [
  'aes256-cbc',
  'aes192-cbc',
  'aes128-cbc',
  '3des-cbc',
  'aes128-gcm',
  'aes256-gcm'
]
const LEGACY_HMAC_EXTRA: MacAlgorithm[] = [
  'hmac-md5',
  'hmac-sha2-256-96',
  'hmac-sha2-512-96',
  'hmac-ripemd160',
  'hmac-sha1-96',
  'hmac-md5-96'
]

interface Ssh2ProtocolConstants {
  DEFAULT_KEX: KexAlgorithm[]
  SUPPORTED_KEX: KexAlgorithm[]
  DEFAULT_SERVER_HOST_KEY: ServerHostKeyAlgorithm[]
  SUPPORTED_SERVER_HOST_KEY: ServerHostKeyAlgorithm[]
  DEFAULT_CIPHER: CipherAlgorithm[]
  SUPPORTED_CIPHER: CipherAlgorithm[]
  DEFAULT_MAC: MacAlgorithm[]
  SUPPORTED_MAC: MacAlgorithm[]
}

function mergeWithLegacy<T extends string>(defaults: readonly T[], supported: readonly T[], extra: readonly T[]): T[] {
  const sup = new Set<T>(supported)
  const out: T[] = [...defaults]
  const seen = new Set<T>(out)
  for (const algo of extra) {
    if (sup.has(algo) && !seen.has(algo)) {
      out.push(algo)
      seen.add(algo)
    }
  }
  return out
}

function buildFallbackLegacyAlgorithms(): {
  kex: KexAlgorithm[]
  serverHostKey: ServerHostKeyAlgorithm[]
  cipher: CipherAlgorithm[]
  hmac: MacAlgorithm[]
} {
  const ciphers = new Set(getCiphers())
  const hashes = new Set(getHashes())
  const cipherSsl: Record<string, string> = {
    'aes128-gcm@openssh.com': 'aes-128-gcm',
    'aes256-gcm@openssh.com': 'aes-256-gcm',
    'aes128-ctr': 'aes-128-ctr',
    'aes192-ctr': 'aes-192-ctr',
    'aes256-ctr': 'aes-256-ctr',
    'chacha20-poly1305@openssh.com': 'chacha20',
    'aes256-cbc': 'aes-256-cbc',
    'aes192-cbc': 'aes-192-cbc',
    'aes128-cbc': 'aes-128-cbc',
    '3des-cbc': 'des-ede3-cbc',
    'aes128-gcm': 'aes-128-gcm',
    'aes256-gcm': 'aes-256-gcm'
  }
  const macSsl: Record<string, string> = {
    'hmac-sha2-256-etm@openssh.com': 'sha256',
    'hmac-sha2-512-etm@openssh.com': 'sha512',
    'hmac-sha1-etm@openssh.com': 'sha1',
    'hmac-sha2-256': 'sha256',
    'hmac-sha2-512': 'sha512',
    'hmac-sha1': 'sha1',
    'hmac-md5': 'md5',
    'hmac-sha2-256-96': 'sha256',
    'hmac-sha2-512-96': 'sha512',
    'hmac-ripemd160': 'ripemd160',
    'hmac-sha1-96': 'sha1',
    'hmac-md5-96': 'md5'
  }
  return {
    kex: [
      'curve25519-sha256@libssh.org',
      'curve25519-sha256',
      'ecdh-sha2-nistp256',
      'ecdh-sha2-nistp384',
      'ecdh-sha2-nistp521',
      'diffie-hellman-group-exchange-sha256',
      'diffie-hellman-group14-sha256',
      'diffie-hellman-group15-sha512',
      'diffie-hellman-group16-sha512',
      'diffie-hellman-group17-sha512',
      'diffie-hellman-group18-sha512',
      ...LEGACY_KEX_EXTRA
    ],
    serverHostKey: [
      'ssh-ed25519',
      'ecdsa-sha2-nistp256',
      'ecdsa-sha2-nistp384',
      'ecdsa-sha2-nistp521',
      'rsa-sha2-512',
      'rsa-sha2-256',
      'ssh-rsa',
      ...LEGACY_HOSTKEY_EXTRA
    ],
    cipher: (
      [
        'aes128-gcm@openssh.com',
        'aes256-gcm@openssh.com',
        'aes128-ctr',
        'aes192-ctr',
        'aes256-ctr',
        'chacha20-poly1305@openssh.com',
        ...LEGACY_CIPHER_EXTRA
      ] as CipherAlgorithm[]
    ).filter((name) => ciphers.has(cipherSsl[name] ?? '')),
    hmac: (
      [
        'hmac-sha2-256-etm@openssh.com',
        'hmac-sha2-512-etm@openssh.com',
        'hmac-sha1-etm@openssh.com',
        'hmac-sha2-256',
        'hmac-sha2-512',
        'hmac-sha1',
        ...LEGACY_HMAC_EXTRA
      ] as MacAlgorithm[]
    ).filter((name) => hashes.has(macSsl[name] ?? ''))
  }
}

function buildLegacyAlgorithms(): {
  kex: KexAlgorithm[]
  serverHostKey: ServerHostKeyAlgorithm[]
  cipher: CipherAlgorithm[]
  hmac: MacAlgorithm[]
} {
  try {
    const req = createRequire(__filename)
    const c = req('ssh2/lib/protocol/constants') as Partial<Ssh2ProtocolConstants>
    if (
      Array.isArray(c.DEFAULT_KEX) &&
      Array.isArray(c.SUPPORTED_KEX) &&
      Array.isArray(c.DEFAULT_SERVER_HOST_KEY) &&
      Array.isArray(c.SUPPORTED_SERVER_HOST_KEY) &&
      Array.isArray(c.DEFAULT_CIPHER) &&
      Array.isArray(c.SUPPORTED_CIPHER) &&
      Array.isArray(c.DEFAULT_MAC) &&
      Array.isArray(c.SUPPORTED_MAC)
    ) {
      return {
        kex: mergeWithLegacy(c.DEFAULT_KEX, c.SUPPORTED_KEX, LEGACY_KEX_EXTRA),
        serverHostKey: mergeWithLegacy(c.DEFAULT_SERVER_HOST_KEY, c.SUPPORTED_SERVER_HOST_KEY, LEGACY_HOSTKEY_EXTRA),
        cipher: mergeWithLegacy(c.DEFAULT_CIPHER, c.SUPPORTED_CIPHER, LEGACY_CIPHER_EXTRA),
        hmac: mergeWithLegacy(c.DEFAULT_MAC, c.SUPPORTED_MAC, LEGACY_HMAC_EXTRA)
      }
    }
  } catch {
    /* 若未来 ssh2 调整内部路径，退回按 node:crypto 过滤的静态表 */
  }
  return buildFallbackLegacyAlgorithms()
}

export const LEGACY_ALGORITHMS: {
  kex: KexAlgorithm[]
  serverHostKey: ServerHostKeyAlgorithm[]
  cipher: CipherAlgorithm[]
  hmac: MacAlgorithm[]
} = buildLegacyAlgorithms()

/**
 * 判断一条建连报错是否是「算法协商失败」。
 *
 * 只有这种失败值得用老算法重试一次：口令错误、端口不通、主机不可达再试
 * 一遍也是白试，反而会把真正的错误信息盖掉。
 */
export function isNegotiationError(msg: string): boolean {
  return /no matching|Unable to negotiate/i.test(msg)
}

/** 展开路径中的 ~ */
export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2))
  return p
}

/**
 * 建立一条 SSH 连接并等待 ready。
 * @param sock 跳板链隧道流；直连时省略
 * @param onBanner 收到远端 banner 时回调（测试连接展示用）
 */
export function connectClient(
  cfg: ConnectConfig,
  sock?: Duplex,
  onBanner?: (banner: string) => void
): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let settled = false

    const fail = (err: Error): void => {
      if (settled) return
      settled = true
      client.removeAllListeners()
      try {
        client.end()
      } catch {
        /* ignore */
      }
      reject(err)
    }

    const timer = setTimeout(() => fail(new Error(`连接超时（${READY_TIMEOUT_MS / 1000}s）`)), READY_TIMEOUT_MS)

    if (onBanner) client.on('banner', (msg: string) => onBanner(msg.trim()))

    client.once('ready', () => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      client.removeListener('error', fail)
      resolve(client)
    })
    client.once('error', (err: Error) => {
      clearTimeout(timer)
      fail(err)
    })

    // 兼容走 keyboard-interactive 的设备（dropbear / 部分嵌入式 SSH）
    if (cfg.password) {
      client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
        finish(prompts.map(() => cfg.password as string))
      })
    }

    try {
      client.connect(sock ? { ...cfg, sock } : cfg)
    } catch (err) {
      clearTimeout(timer)
      fail(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

/**
 * 组装 ssh2 连接配置：认证方式 + 主机指纹校验。
 * @param onFingerprint 指纹计算后回调（无论是否已有记录）
 */
/**
 * 最近一次主机指纹冲突（host:port → 实际指纹 / 已知指纹）。
 *
 * 不能靠「在 hostVerifier 里 throw」把冲突抛给上层：那个回调是在 ssh2 的
 * 密钥交换流程里被同步调用的，抛异常会打断协议状态机，错误信息也变成
 * 一句含糊的 "Host denied"。所以校验器只负责记录事实并返回 false，
 * 连接随后以标准方式失败，上层再到这里取真正的旧/新指纹。
 */
export const hostKeyMismatches = new Map<
  string,
  { host: string; port: number; actual: string; known: string | null; at: number }
>()

/** 取某 host:port 的指纹冲突记录（成功后不会自动清除，按时间判断新鲜度） */
export function takeHostKeyMismatch(
  host: string,
  port: number,
  maxAgeMs = 60_000
): { actual: string; known: string | null } | null {
  const key = `${host}:${port}`
  const hit = hostKeyMismatches.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > maxAgeMs) {
    hostKeyMismatches.delete(key)
    return null
  }
  return { actual: hit.actual, known: hit.known }
}

/**
 * 把原始主机公钥算成 OpenSSH 风格的指纹：`SHA256:<base64(sha256(key))>`。
 *
 * 必须是「先 sha256、再 base64」——直接 base64 原始公钥会得到一个看起来很像、
 * 但与 `ssh-keygen -lf` 完全对不上的值，排查时极具误导性。
 */
export function hostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`
}

/**
 * 旧版本的错误格式指纹（SHA256 十六进制）。
 *
 * 历史实现给 ssh2 设了 `hostHash = 'sha256'`，ssh2 会把摘要转成 hex 字符串
 * 再交给校验函数，代码又对它做了一次 base64 —— 存下来的是 `SHA256:<hex>`。
 * 这是非标准格式，但老用户的数据里全是它；升级后如果只认新格式，
 * 每台设备都会「指纹不匹配」而连不上。所以校验时两种都认，
 * 命中旧格式就顺手把记录迁移成标准格式。
 */
export function legacyHostKeyFingerprint(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('hex')}`
}

/** 记录里的指纹是否是旧版本写下的错误格式 */
export function isLegacyFingerprint(fingerprint: string): boolean {
  return /^SHA256:[0-9a-f]{64}$/.test(fingerprint)
}

/**
 * 计算某个 host:port 当前的主机指纹（独立握手一次再断开）。
 *
 * 「更新指纹」需要先知道设备现在的指纹是什么，才能向用户展示「旧 → 新」的对比；
 * 而真正的连接流程一旦发现不匹配就会拒绝握手，拿不到这个值。
 * 所以这里用 hostVerifier 只做记录、不做拦截，握手成功后立刻断开。
 */
function probeOnce(
  host: string,
  port: number,
  timeoutMs: number,
  legacy: boolean
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const client = new Client()
    let fingerprint: string | null = null
    let settled = false
    const done = (err: Error | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        client.end()
      } catch {
        /* ignore */
      }
      if (err) reject(err)
      else if (fingerprint) resolve(fingerprint)
      else reject(new Error('未能获取主机密钥指纹'))
    }
    const timer = setTimeout(
      () => done(new Error(`获取主机指纹超时（${Math.round(timeoutMs / 1000)}s）`)),
      timeoutMs
    )
    client.on('error', (err: Error) => {
      // 认证失败一定发生在主机密钥之后：这时指纹已经拿到了，别把成功当失败
      if (fingerprint) done(null)
      else done(err)
    })
    client.once('ready', () => done(null))
    const cfg: ConnectConfig = {
      host,
      port,
      username: 'fingerprint-probe',
      hostVerifier: (key: Buffer): boolean => {
        fingerprint = hostKeyFingerprint(key)
        return true
      },
      readyTimeout: timeoutMs
    }
    if (legacy) cfg.algorithms = LEGACY_ALGORITHMS
    // 只等握手：主机密钥交换完成即可拿到指纹，随后（多半是认证被拒）立刻收工。
    client
      .on('handshake', () => {
        if (fingerprint) done(null)
      })
      .connect(cfg)
  })
}

/**
 * 探测某个 host:port 当前的主机指纹（独立握手一次再断开）。
 *
 * 先用默认算法握手；如果设备太老、算法根本谈不拢（no matching / Unable to
 * negotiate），自动换 LEGACY_ALGORITHMS 再试一次。探测只取公钥指纹，既不认证
 * 也不免密登录，所以这一层自动回退不改变安全模型 —— 它只是让「设置 → 已知
 * 主机」这种没有连接配置可依的入口也能探到老设备。
 */
export async function probeHostFingerprint(
  host: string,
  port: number,
  timeoutMs = 10000
): Promise<string> {
  try {
    return await probeOnce(host, port, timeoutMs, false)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (!isNegotiationError(msg)) throw err
    return probeOnce(host, port, timeoutMs, true)
  }
}

export async function buildConnectConfig(
  target: ConnectTarget,
  secret: PlainSecret,
  settings: AppSettings,
  onFingerprint?: (fingerprint: string) => void,
  /** 用户已确认「更新指纹」：本次直接放行并把新指纹写回记录 */
  options: { trustNewHostKey?: boolean } = {}
): Promise<ConnectConfig> {
  const cfg: ConnectConfig = {
    host: target.host,
    port: target.port,
    username: target.username,
    readyTimeout: READY_TIMEOUT_MS,
    keepaliveInterval: 15000,
    keepaliveCountMax: 3,
    tryKeyboard: true
  }

  // 老设备兼容：仅在连接显式开启时挂载，且直接复用同一个常量对象
  if (target.legacyAlgorithms === true) cfg.algorithms = LEGACY_ALGORITHMS

  if (target.authType === 'password') {
    if (!secret.password) throw new Error('该连接未保存密码，请编辑连接补全凭据')
    cfg.password = secret.password
  } else if (target.authType === 'privateKey') {
    if (!target.privateKeyPath) throw new Error('该连接未指定私钥路径')
    const keyPath = expandHome(target.privateKeyPath)
    try {
      cfg.privateKey = await fs.readFile(keyPath)
    } catch {
      throw new Error(`私钥文件无法读取：${keyPath}`)
    }
    if (secret.passphrase) cfg.passphrase = secret.passphrase
  } else {
    // SSH Agent：优先环境变量；Windows 上 OpenSSH agent 为命名管道
    const agent =
      process.env.SSH_AUTH_SOCK ||
      (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined)
    if (!agent) throw new Error('未检测到 SSH Agent（SSH_AUTH_SOCK 未设置）')
    cfg.agent = agent
  }

  if (settings.strictHostKey) {
    const known = await getKnownHost(target.host, target.port)
    // 注意：这里刻意不设 cfg.hostHash。
    // ssh2 在设了 hostHash 时会把摘要转成 hex 再交给校验函数 —— 那时我们拿到的是
    // 「sha256 的 hex」，却拼了一个 "SHA256:" 前缀存起来，指纹永远是错的；
    // 现在统一用 hostKeyFingerprint(rawKey) 算，格式与 OpenSSH 的 SHA256:base64 一致。
    cfg.hostVerifier = (key: Buffer): boolean => {
      const fp = hostKeyFingerprint(key)
      onFingerprint?.(fp)
      if (!known) {
        void upsertKnownHost({
          host: target.host,
          port: target.port,
          fingerprint: fp,
          addedAt: Date.now()
        })
        return true
      }
      const legacy = isLegacyFingerprint(known.fingerprint)
        ? legacyHostKeyFingerprint(key)
        : null
      if (known.fingerprint === fp || (legacy !== null && known.fingerprint === legacy)) {
        // 旧格式记录：校验通过后静默迁移成 OpenSSH 风格，免得一直背着历史包袱
        if (known.fingerprint !== fp) {
          void upsertKnownHost({
            host: target.host,
            port: target.port,
            fingerprint: fp,
            addedAt: known.addedAt
          })
        }
        hostKeyMismatches.delete(`${target.host}:${target.port}`)
        return true
      }

      // 用户点了「更新指纹」：接受并把这个记录改写为新值
      if (options.trustNewHostKey) {
        void upsertKnownHost({
          host: target.host,
          port: target.port,
          fingerprint: fp,
          addedAt: Date.now()
        })
        return true
      }
      // 记录冲突事实供上层展示「旧 → 新」，然后按标准方式拒绝握手
      hostKeyMismatches.set(`${target.host}:${target.port}`, {
        host: target.host,
        port: target.port,
        actual: fp,
        known: known.fingerprint,
        at: Date.now()
      })
      return false
    }
  }

  return cfg
}

/**
 * 直连（或经代理）建立 SSH 连接。
 * 配置了 SOCKS5 / HTTP 代理时，先完成代理握手拿到隧道 socket，再交给 ssh2 承载 SSH 协议。
 */
export async function connectWithOptionalProxy(
  cfg: ConnectConfig,
  params: {
    host: string
    port: number
    proxy?: ProxyConfig
    /** 代理密码（来自凭据保险箱；proxy.password 为空时使用） */
    proxyPassword?: string
    onBanner?: (banner: string) => void
  }
): Promise<Client> {
  const proxy = params.proxy
  if (proxy && (proxy.type === 'socks5' || proxy.type === 'http') && proxy.host) {
    let sock: Duplex
    try {
      sock = await openProxySocket(proxy, params.proxyPassword, params.host, params.port)
    } catch (err) {
      throw new Error(`代理连接失败：${err instanceof Error ? err.message : String(err)}`)
    }
    return connectClient(cfg, sock, params.onBanner)
  }
  return connectClient(cfg, undefined, params.onBanner)
}

/** 经由已建立连接，向目标 host:port 打通一条直连隧道流（ProxyJump 跳板链用） */
export function forwardThrough(prev: Client, host: string, port: number): Promise<ClientChannel> {
  return new Promise((resolve, reject) => {
    prev.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
      if (err) reject(err)
      else resolve(stream)
    })
  })
}

/** 把 ssh2 的原始错误翻译成人话 */
export function humanizeConnectError(raw: string): string {
  if (/authentication|All configured authentication methods failed/i.test(raw)) {
    return '认证失败：用户名或密码/密钥不正确'
  }
  if (/ECONNREFUSED/i.test(raw)) return '连接被拒绝：目标端口未监听 SSH 服务'
  if (/ETIMEDOUT|timeout/i.test(raw)) return '连接超时：网络不可达或端口被拦截'
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) return '主机名无法解析'
  if (/EHOSTUNREACH|ENETUNREACH/i.test(raw)) return '主机不可达：请检查设备是否在线、网段是否连通'
  if (/no matching|Unable to negotiate/i.test(raw)) return '算法协商失败：设备 SSH 版本过旧或配置受限'
  return raw
}
