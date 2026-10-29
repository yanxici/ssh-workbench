import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Command, CommandInput } from '@shared/types'
import { buildSeedCommands } from '../../data/seedCommands'
import { JsonStore, dataDir } from '../jsonStore'

/** 常用命令（命令中心 / 命令按钮墙的数据源） */

const cmdStore = new JsonStore<Command[]>(join(dataDir(), 'commands.json'), () => [])

export async function listCommands(): Promise<Command[]> {
  return cmdStore.read()
}

export async function saveCommand(input: CommandInput): Promise<Command> {
  const now = Date.now()
  let saved!: Command

  await cmdStore.update((list) => {
    const base = {
      name: input.name.trim(),
      command: input.command,
      description: input.description?.trim() || undefined,
      group: input.group.trim() || '默认',
      icon: input.icon,
      color: input.color,
      confirmRequired: input.confirmRequired,
      variables: input.variables ?? []
    }

    if (input.id) {
      const idx = list.findIndex((c) => c.id === input.id)
      if (idx >= 0) {
        const next = [...list]
        saved = { ...list[idx], ...base, updatedAt: now }
        next[idx] = saved
        return next
      }
    }

    const maxOrder = list.reduce((max, c) => Math.max(max, c.sortOrder), 0)
    saved = {
      id: randomUUID(),
      ...base,
      sortOrder: maxOrder + 1,
      useCount: 0,
      createdAt: now,
      updatedAt: now
    }
    return [...list, saved]
  })

  return saved
}

export async function deleteCommand(id: string): Promise<void> {
  await cmdStore.update((list) => list.filter((c) => c.id !== id))
}

/** 分组重命名：一次读改写完成（逐条 save 会产生大量写入），返回移动的命令数 */
export async function renameCommandGroup(from: string, to: string): Promise<number> {
  const target = to.trim()
  if (!target) throw new Error('分组名称不能为空')
  const now = Date.now()
  let count = 0
  await cmdStore.update((list) =>
    list.map((c) => {
      if ((c.group || '默认') !== from) return c
      count++
      return { ...c, group: target, updatedAt: now }
    })
  )
  return count
}

/** 删除分组及其下全部命令，返回删除的命令数 */
export async function deleteCommandGroup(group: string): Promise<number> {
  let count = 0
  await cmdStore.update((list) => {
    const next = list.filter((c) => (c.group || '默认') !== group)
    count = list.length - next.length
    return next
  })
  return count
}

/** 按给定的 id 顺序重排 sortOrder */
export async function reorderCommands(orderedIds: string[]): Promise<void> {
  await cmdStore.update((list) => {
    const orderMap = new Map(orderedIds.map((id, i) => [id, i]))
    return list.map((c) => {
      const order = orderMap.get(c.id)
      return order === undefined ? c : { ...c, sortOrder: order }
    })
  })
}

/**
 * 记录一次执行：useCount + 1，lastUsedAt 置为当前时间。
 *
 * 这两个字段本来就在 Command 模型里（types.ts），但旧代码从未写入过，
 * 于是「最常用 / 最近使用」只能是摆设。命令中心的排序完全依赖它，
 * 所以执行成功后必须从这里打点。
 */
export async function touchCommand(id: string): Promise<Command | null> {
  const now = Date.now()
  let touched: Command | null = null
  await cmdStore.update((list) =>
    list.map((c) => {
      if (c.id !== id) return c
      touched = { ...c, useCount: c.useCount + 1, lastUsedAt: now }
      return touched
    })
  )
  return touched
}

/** 导入：merge = 追加去重（name+command 相同视为重复）；replace = 整体替换 */
export async function importCommands(
  rawList: unknown,
  mode: 'merge' | 'replace'
): Promise<{ imported: number; skipped: number }> {
  if (!Array.isArray(rawList)) throw new Error('导入内容不是命令数组')

  const now = Date.now()
  const normalized: Command[] = []
  let skipped = 0

  for (const item of rawList) {
    const it = item as Partial<Command>
    if (typeof it?.name !== 'string' || typeof it?.command !== 'string') {
      skipped += 1
      continue
    }
    normalized.push({
      id: randomUUID(),
      name: it.name,
      command: it.command,
      description: typeof it.description === 'string' ? it.description : undefined,
      group: typeof it.group === 'string' && it.group ? it.group : '导入',
      icon: typeof it.icon === 'string' ? it.icon : undefined,
      color: typeof it.color === 'string' ? it.color : undefined,
      confirmRequired: Boolean(it.confirmRequired),
      variables: Array.isArray(it.variables) ? it.variables : [],
      sortOrder: typeof it.sortOrder === 'number' ? it.sortOrder : normalized.length,
      useCount: 0,
      createdAt: now,
      updatedAt: now
    })
  }

  if (mode === 'replace') {
    await cmdStore.write(normalized)
    return { imported: normalized.length, skipped }
  }

  let imported = 0
  await cmdStore.update((list) => {
    const seen = new Set(list.map((c) => `${c.name}\u0000${c.command}`))
    const next = [...list]
    for (const c of normalized) {
      const key = `${c.name}\u0000${c.command}`
      if (seen.has(key)) {
        skipped += 1
        continue
      }
      seen.add(key)
      next.push(c)
      imported += 1
    }
    return next
  })
  return { imported, skipped }
}

export async function exportCommands(): Promise<Command[]> {
  const list = await cmdStore.read()
  return [...list].sort((a, b) => a.sortOrder - b.sortOrder)
}

/** 首次运行时注入内置命令 */
export async function seedCommandsIfNeeded(): Promise<void> {
  if (await cmdStore.exists()) return
  await cmdStore.write(buildSeedCommands())
}
