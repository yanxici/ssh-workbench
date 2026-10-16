import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
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
export async function buildConnectConfig(
  target: ConnectTarget,
  secret: PlainSecret,
  settings: AppSettings,
  onFingerprint?: (fingerprint: string) => void
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
    cfg.hostHash = 'sha256'
    cfg.hostVerifier = (key: Buffer): boolean => {
      const fp = `SHA256:${key.toString('base64').replace(/=+$/, '')}`
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
      return known.fingerprint === fp
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
