import type { BackupDetail, BackupDiffResult, BackupFileEntry } from '@shared/types'
import { diffStats, lineDiff } from '../util/lineDiff'
import { backupStore } from '../store/backups'
import { sessionManager } from './sessionManager'
import { sftpManager } from './sftpManager'

/**
 * 配置备份的**采集 / 对比 / 回写**（属 SSH 域）。
 *
 * 为什么放在 ssh 而不是 store：
 *   store 是「数据仓库统一出口」，本应是最底层，只做文件读写。
 *   但备份的这三个动作要靠 SFTP 从远端抓文件、写回远端，
 *   本质是跨 SSH 的业务编排。原先它们写在 store/backups.ts 里，
 *   造成 store → ssh → store 的双向依赖（store 反过来 import 了
 *   sessionManager/sftpManager，而 sessionManager 又 import store/repository）。
 *   现在 store/backups.ts 只留 BackupStore（list/detail/save/remove/openDir，
 *   纯本地文件），采集与回写挪到这里，依赖方向变成 ssh → store，单向。
 *
 * 采集规则：路径可以是文件或目录（目录递归，深度/数量/体积三重上限保护）；
 * 读取失败的文件也会记录（error 字段），便于事后知道「这份备份缺了什么」。
 */

const MAX_FILE_BYTES = 512 * 1024
const MAX_TOTAL_BYTES = 8 * 1024 * 1024
const MAX_FILES = 300
const MAX_DEPTH = 4

/** 从设备采集配置（路径可为文件或目录） */
export async function createBackup(
  sessionId: string,
  name: string,
  paths: string[]
): Promise<BackupDetail> {
  const session = sessionManager.list().find((s) => s.id === sessionId)
  if (!session) throw new Error('会话不存在，请先打开 SSH 连接')
  await sessionManager.waitUntilReady(sessionId)

  const files: BackupFileEntry[] = []
  let total = 0
  const visited = new Set<string>()

  const addFile = async (path: string): Promise<void> => {
    if (files.length >= MAX_FILES || total >= MAX_TOTAL_BYTES || visited.has(path)) return
    visited.add(path)
    try {
      const content = await sftpManager.readText(sessionId, path)
      const size = Buffer.byteLength(content, 'utf-8')
      if (size > MAX_FILE_BYTES) {
        files.push({ path, size, error: `文件过大（${(size / 1024).toFixed(0)} KB），已跳过` })
        return
      }
      if (total + size > MAX_TOTAL_BYTES) {
        files.push({ path, size, error: '备份总量已达上限，已跳过' })
        return
      }
      total += size
      files.push({ path, size, content })
    } catch (err) {
      files.push({ path, size: 0, error: err instanceof Error ? err.message : String(err) })
    }
  }

  const walk = async (path: string, depth: number): Promise<void> => {
    if (files.length >= MAX_FILES || total >= MAX_TOTAL_BYTES) return
    try {
      const entries = await sftpManager.list(sessionId, path)
      for (const entry of entries) {
        if (files.length >= MAX_FILES) break
        if (entry.type === 'directory') {
          if (depth < MAX_DEPTH) await walk(entry.path, depth + 1)
        } else if (entry.type === 'file' || entry.type === 'symlink') {
          await addFile(entry.path)
        }
      }
    } catch {
      // 不是目录（或无权读取目录）→ 当作文件尝试
      await addFile(path)
    }
  }

  for (const p of paths) {
    if (p.trim()) await walk(p.trim(), 0)
  }

  const detail: BackupDetail = {
    id: backupStore.newId(name),
    name,
    connectionName: session.title,
    host: session.host,
    createdAt: Date.now(),
    fileCount: files.filter((f) => !f.error).length,
    totalSize: total,
    paths,
    files
  }
  await backupStore.save(detail)
  return detail
}

/** 备份文件 vs 设备当前内容（旧 = 备份，新 = 当前） */
export async function diffBackup(
  id: string,
  path: string,
  sessionId: string
): Promise<BackupDiffResult> {
  const detail = await backupStore.detail(id)
  const entry = detail.files.find((f) => f.path === path)
  if (!entry) throw new Error('备份中没有该文件')

  if (entry.error || entry.content === undefined) {
    return {
      status: 'error',
      lines: [],
      added: 0,
      removed: 0,
      error: `备份时未取到内容：${entry.error ?? '未知原因'}`
    }
  }

  let current: string
  try {
    await sessionManager.waitUntilReady(sessionId)
    current = await sftpManager.readText(sessionId, path)
  } catch (err) {
    return {
      status: 'remote-missing',
      lines: [],
      added: 0,
      removed: 0,
      error: err instanceof Error ? err.message : String(err)
    }
  }

  if (current === entry.content) {
    return { status: 'same', lines: [], added: 0, removed: 0 }
  }

  const lines = lineDiff(entry.content, current)
  const { added, removed } = diffStats(lines)
  return { status: 'changed', lines, added, removed }
}

/** 把备份内容写回设备（写入前会把设备上的原文件改名为 .bak） */
export async function restoreBackup(
  id: string,
  sessionId: string,
  paths: string[]
): Promise<{ restored: number; failed: Array<{ path: string; error: string }> }> {
  const detail = await backupStore.detail(id)
  await sessionManager.waitUntilReady(sessionId)

  let restored = 0
  const failed: Array<{ path: string; error: string }> = []

  for (const path of paths) {
    const entry = detail.files.find((f) => f.path === path)
    if (!entry || entry.content === undefined) {
      failed.push({ path, error: entry?.error ?? '备份中没有该文件内容' })
      continue
    }
    try {
      await sftpManager.writeText(sessionId, path, entry.content)
      restored += 1
    } catch (err) {
      failed.push({ path, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { restored, failed }
}
