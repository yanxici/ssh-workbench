import { join } from 'node:path'
import { JsonStore, dataDir } from '../jsonStore'

/**
 * 已知主机指纹（首次连接自动记录，之后按 sha256 校验）。
 *
 * 用 Record<"host:port", entry> 而不是数组：校验发生在每次握手的同步回调里，
 * 按 key 直接查能省掉一次线性扫描。
 */

export interface KnownHost {
  host: string
  port: number
  /** SHA256:<base64> 格式（与 OpenSSH 一致）；老记录可能是 SHA256:<hex>，校验时兼容 */
  fingerprint: string
  addedAt: number
}

const knownHostStore = new JsonStore<Record<string, KnownHost>>(
  join(dataDir(), 'known-hosts.json'),
  () => ({})
)

export function hostKey(host: string, port: number): string {
  return `${host}:${port}`
}

export async function getKnownHost(host: string, port: number): Promise<KnownHost | undefined> {
  const all = await knownHostStore.read()
  return all[hostKey(host, port)]
}

export async function upsertKnownHost(entry: KnownHost): Promise<void> {
  await knownHostStore.update((all) => ({ ...all, [hostKey(entry.host, entry.port)]: entry }))
}

export async function listKnownHosts(): Promise<KnownHost[]> {
  const all = await knownHostStore.read()
  return Object.values(all).sort((a, b) => b.addedAt - a.addedAt)
}

/**
 * 更新一条已知主机记录的指纹（设备重装 / 固件升级 / 换证书之后）。
 * 只改指纹与时间戳，不动 host/port 主键。
 */
export async function refreshKnownHost(
  host: string,
  port: number,
  fingerprint: string
): Promise<KnownHost> {
  const entry: KnownHost = { host, port, fingerprint, addedAt: Date.now() }
  await upsertKnownHost(entry)
  return entry
}

export async function deleteKnownHost(key: string): Promise<void> {
  await knownHostStore.update((all) => {
    const next = { ...all }
    delete next[key]
    return next
  })
}
