import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
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

    client.connect(sock ? { ...cfg, sock } : cfg)
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
export async function probeHostFingerprint(
  host: string,
  port: number,
  timeoutMs = 10000
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
    // 只等握手：主机密钥交换完成即可拿到指纹，随后（多半是认证被拒）立刻收工。
    client
      .on('handshake', () => {
        if (fingerprint) done(null)
      })
      .connect(cfg)
  })
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
