import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { TunnelConfig, TunnelInput } from '@shared/types'
import { JsonStore, dataDir } from '../jsonStore'

/** 端口转发 / 隧道定义（运行时状态在 ssh/portForward.ts） */

const tunnelStore = new JsonStore<TunnelConfig[]>(join(dataDir(), 'tunnels.json'), () => [])

export async function listTunnels(): Promise<TunnelConfig[]> {
  const list = await tunnelStore.read()
  return [...list].sort((a, b) => a.createdAt - b.createdAt)
}

export async function getTunnel(id: string): Promise<TunnelConfig | undefined> {
  const list = await tunnelStore.read()
  return list.find((t) => t.id === id)
}

/**
 * 校验监听地址。
 *
 * 原来只给默认值不校验范围：用户填 0.0.0.0 就把整台机器的内网出口变成
 * 同网段任一台机器可用的免认证代理（socks5.ts 明确实现的是无认证 CONNECT）。
 * -L 同理，会让本机端口暴露到局域网。
 * 默认只允许回环；确实需要对外暴露的，必须显式勾 allowLan（UI 上有明确提示）。
 */
function normalizeBindHost(raw: string | undefined, allowLan: boolean | undefined): string {
  const host = (raw ?? '').trim() || '127.0.0.1'
  const isLoopback =
    host === '127.0.0.1' ||
    host === '::1' ||
    host === 'localhost' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  if (!isLoopback && !allowLan) {
    throw new Error(
      `监听地址 ${host} 会暴露到局域网，代理无认证等于给同网段开放出口。若要对外监听，请显式允许局域网访问`
    )
  }
  return host
}

export async function saveTunnel(input: TunnelInput): Promise<TunnelConfig> {
  const now = Date.now()
  let saved!: TunnelConfig

  await tunnelStore.update((list) => {
    const base = {
      name: input.name.trim() || '未命名隧道',
      type: input.type,
      bindHost: normalizeBindHost(input.bindHost, input.allowLan),
      bindPort: input.bindPort,
      targetHost: input.targetHost?.trim() || undefined,
      targetPort: input.targetPort,
      connectionId: input.connectionId || undefined,
      remark: input.remark?.trim() || undefined
    }

    if (input.id) {
      const idx = list.findIndex((t) => t.id === input.id)
      if (idx >= 0) {
        const next = [...list]
        saved = { ...list[idx], ...base, updatedAt: now }
        next[idx] = saved
        return next
      }
    }

    saved = { id: randomUUID(), ...base, createdAt: now, updatedAt: now }
    return [...list, saved]
  })

  return saved
}

export async function deleteTunnel(id: string): Promise<void> {
  await tunnelStore.update((list) => list.filter((t) => t.id !== id))
}
