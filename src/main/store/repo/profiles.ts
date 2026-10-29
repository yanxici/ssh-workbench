import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { DeviceProfile, DeviceProfileInput } from '@shared/types'
import { JsonStore, dataDir } from '../jsonStore'

/** 客户 / 设备档案（现场记录：客户名、机型、SN、固件版本、工单号） */

const profileStore = new JsonStore<DeviceProfile[]>(join(dataDir(), 'profiles.json'), () => [])

export async function listProfiles(): Promise<DeviceProfile[]> {
  const list = await profileStore.read()
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function saveProfile(input: DeviceProfileInput): Promise<DeviceProfile> {
  const now = Date.now()
  let saved!: DeviceProfile

  await profileStore.update((list) => {
    const base = {
      customerName: input.customerName.trim() || '未命名客户',
      project: input.project?.trim() || undefined,
      deviceModel: input.deviceModel?.trim() || undefined,
      sn: input.sn?.trim() || undefined,
      firmwareVersion: input.firmwareVersion?.trim() || undefined,
      contact: input.contact?.trim() || undefined,
      ticketNo: input.ticketNo?.trim() || undefined,
      connectionIds: input.connectionIds ?? [],
      commandGroup: input.commandGroup?.trim() || undefined,
      remark: input.remark?.trim() || undefined
    }

    if (input.id) {
      const idx = list.findIndex((p) => p.id === input.id)
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

export async function deleteProfile(id: string): Promise<void> {
  await profileStore.update((list) => list.filter((p) => p.id !== id))
}
