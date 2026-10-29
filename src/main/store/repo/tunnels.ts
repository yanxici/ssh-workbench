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

export async function saveTunnel(input: TunnelInput): Promise<TunnelConfig> {
  const now = Date.now()
  let saved!: TunnelConfig

  await tunnelStore.update((list) => {
    const base = {
      name: input.name.trim() || '未命名隧道',
      type: input.type,
      bindHost: input.bindHost.trim() || '127.0.0.1',
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
