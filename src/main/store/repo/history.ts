import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { CommandHistoryEntry, HistoryFilter } from '@shared/types'
import { JsonStore, dataDir } from '../jsonStore'
import { touchCommand } from './commands'

/**
 * 命令历史。
 *
 * 与「常用命令」是两个东西：这里是每次执行留痕（含终端里手敲的），
 * 上限 HISTORY_LIMIT 条后按 FIFO 丢弃。
 */

const histStore = new JsonStore<CommandHistoryEntry[]>(join(dataDir(), 'history.json'), () => [])

const HISTORY_LIMIT = 2000

export async function listHistory(filter: HistoryFilter = {}): Promise<CommandHistoryEntry[]> {
  let list = await histStore.read()
  if (filter.connectionId) list = list.filter((e) => e.connectionId === filter.connectionId)
  if (filter.keyword) {
    const kw = filter.keyword.toLowerCase()
    list = list.filter((e) => e.command.toLowerCase().includes(kw))
  }
  /*
   * limit 显式传 0 是「要 0 条」，不是「没传」。
   * ?? 会放行 0，而 slice(-0) 等于 slice(0) —— 返回全部历史，
   * 分页/导出按 0 条请求时反而拿到全量。
   */
  const limit = filter.limit ?? 500
  // NaN / Infinity 都当非法：Infinity 会让 slice(-Infinity) 抛异常，NaN 会静默返回全量
  if (!Number.isFinite(limit) || limit <= 0) return []
  return list.slice(-limit).reverse()
}

export async function addHistory(
  entry: Omit<CommandHistoryEntry, 'id'>
): Promise<CommandHistoryEntry> {
  const full: CommandHistoryEntry = { ...entry, id: randomUUID() }

  await histStore.update((list) => {
    const next = [...list, full]
    return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next
  })

  // 来自常用命令的执行：同步使用计数，供「最常用」排序
  if (full.snippetId) await touchCommand(full.snippetId)

  return full
}

export async function clearHistory(connectionId?: string): Promise<void> {
  if (!connectionId) {
    await histStore.write([])
    return
  }
  await histStore.update((list) => list.filter((e) => e.connectionId !== connectionId))
}
