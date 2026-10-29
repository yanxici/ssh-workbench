import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { DiagSection, DiagSectionInput } from '@shared/types'
import { BUILTIN_DIAG_SECTIONS } from '../../data/diagTemplates'
import { JsonStore, dataDir } from '../jsonStore'

/**
 * 诊断巡检项：内置清单（代码里）+ 用户自定义（这个 JSON）。
 *
 * 自定义项的 id 统一加 `custom.` 前缀，方便和内置项区分、也防止覆盖内置项。
 */

const diagSectionStore = new JsonStore<DiagSection[]>(
  join(dataDir(), 'diag-sections.json'),
  () => []
)

/** 全部诊断项 = 内置 + 自定义 */
export async function listDiagSections(): Promise<DiagSection[]> {
  const custom = await diagSectionStore.read()
  return [...BUILTIN_DIAG_SECTIONS, ...custom]
}

export async function saveDiagSection(input: DiagSectionInput): Promise<DiagSection> {
  const now = Date.now()
  let saved!: DiagSection

  await diagSectionStore.update((list) => {
    const base = {
      name: input.name.trim() || '未命名检查',
      group: input.group.trim() || '自定义',
      command: input.command,
      timeoutMs: Math.min(Math.max(input.timeoutMs || 12000, 1000), 120000),
      description: input.description?.trim() || undefined,
      builtin: false
    }

    if (input.id) {
      const idx = list.findIndex((s) => s.id === input.id)
      if (idx >= 0) {
        const next = [...list]
        saved = { ...list[idx], ...base, updatedAt: now }
        next[idx] = saved
        return next
      }
    }

    saved = { id: `custom.${randomUUID()}`, ...base, createdAt: now, updatedAt: now }
    return [...list, saved]
  })

  return saved
}

export async function deleteDiagSection(id: string): Promise<void> {
  await diagSectionStore.update((list) => list.filter((s) => s.id !== id))
}
