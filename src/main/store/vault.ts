import { safeStorage } from 'electron'
import { join } from 'node:path'
import { JsonStore, dataDir } from './jsonStore'

/**
 * 凭据保险箱：密码 / 私钥口令永远不以明文落盘。
 *
 * 加密由 Electron safeStorage 提供：
 * - Windows：DPAPI（绑定当前用户账户）
 * - macOS：Keychain
 * - Linux：libsecret / kwallet
 *
 * 若系统加密不可用（部分 Linux 环境），降级为「本进程内存态」——
 * 用户当次运行可正常连接，重启后需重新输入，且绝不落盘。
 */

interface StoredSecret {
  /** base64(safeStorage.encryptString(...)) */
  password?: string
  passphrase?: string
  /** SOCKS5 / HTTP 代理密码 */
  proxyPassword?: string
}

export interface PlainSecret {
  password?: string
  passphrase?: string
  proxyPassword?: string
}

const store = new JsonStore<Record<string, StoredSecret>>(
  join(dataDir(), 'secrets.json'),
  () => ({})
)

/** safeStorage 不可用时的内存降级 */
const memoryFallback = new Map<string, PlainSecret>()

function encrypt(plain: string): string {
  return safeStorage.encryptString(plain).toString('base64')
}

function decrypt(cipher: string): string | undefined {
  try {
    return safeStorage.decryptString(Buffer.from(cipher, 'base64'))
  } catch {
    // 换机器 / 换系统账户后无法解密：视为无该凭据
    return undefined
  }
}

/** 批量写入凭据：一次读改写（导入上千条时逐条写会产生上千次落盘） */
export async function setSecretsBulk(entries: Array<[string, PlainSecret]>): Promise<void> {
  if (entries.length === 0) return
  const cleaned = entries.map(([id, s]): [string, PlainSecret] => [
    id,
    {
      password: s.password || undefined,
      passphrase: s.passphrase || undefined,
      proxyPassword: s.proxyPassword || undefined
    }
  ])

  if (!safeStorage.isEncryptionAvailable()) {
    for (const [id, s] of cleaned) {
      if (s.password || s.passphrase || s.proxyPassword) memoryFallback.set(id, s)
      else memoryFallback.delete(id)
    }
    return
  }

  await store.update((all) => {
    const next = { ...all }
    for (const [id, s] of cleaned) {
      const entry: StoredSecret = {}
      if (s.password) entry.password = encrypt(s.password)
      if (s.passphrase) entry.passphrase = encrypt(s.passphrase)
      if (s.proxyPassword) entry.proxyPassword = encrypt(s.proxyPassword)
      if (Object.keys(entry).length === 0) delete next[id]
      else next[id] = entry
    }
    return next
  })
}

export async function setSecret(connectionId: string, secret: PlainSecret): Promise<void> {
  const clean: PlainSecret = {
    password: secret.password || undefined,
    passphrase: secret.passphrase || undefined,
    proxyPassword: secret.proxyPassword || undefined
  }

  if (!safeStorage.isEncryptionAvailable()) {
    if (clean.password || clean.passphrase || clean.proxyPassword) {
      memoryFallback.set(connectionId, clean)
    } else memoryFallback.delete(connectionId)
    return
  }

  await store.update((all) => {
    const next = { ...all }
    const entry: StoredSecret = {}
    if (clean.password) entry.password = encrypt(clean.password)
    if (clean.passphrase) entry.passphrase = encrypt(clean.passphrase)
    if (clean.proxyPassword) entry.proxyPassword = encrypt(clean.proxyPassword)
    if (Object.keys(entry).length === 0) delete next[connectionId]
    else next[connectionId] = entry
    return next
  })
}

export async function getSecret(connectionId: string): Promise<PlainSecret> {
  if (!safeStorage.isEncryptionAvailable()) {
    return memoryFallback.get(connectionId) ?? {}
  }
  const all = await store.read()
  const entry = all[connectionId]
  if (!entry) return {}
  return {
    password: entry.password ? decrypt(entry.password) : undefined,
    passphrase: entry.passphrase ? decrypt(entry.passphrase) : undefined,
    proxyPassword: entry.proxyPassword ? decrypt(entry.proxyPassword) : undefined
  }
}

export async function hasSecret(connectionId: string): Promise<boolean> {
  if (!safeStorage.isEncryptionAvailable()) {
    const s = memoryFallback.get(connectionId)
    return Boolean(s && (s.password || s.passphrase))
  }
  const all = await store.read()
  const entry = all[connectionId]
  return Boolean(entry && (entry.password || entry.passphrase))
}

/** 是否保存了代理密码（编辑连接时的"留空保持不变"提示用） */
export async function hasProxyPassword(connectionId: string): Promise<boolean> {
  if (!safeStorage.isEncryptionAvailable()) {
    return Boolean(memoryFallback.get(connectionId)?.proxyPassword)
  }
  const all = await store.read()
  return Boolean(all[connectionId]?.proxyPassword)
}

export async function deleteSecret(connectionId: string): Promise<void> {
  memoryFallback.delete(connectionId)
  if (!safeStorage.isEncryptionAvailable()) return
  await store.update((all) => {
    const next = { ...all }
    delete next[connectionId]
    return next
  })
}
