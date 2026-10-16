import { app, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { BackupDetail, BackupDiffResult, BackupFileEntry, BackupMeta } from '@shared/types'
import { sessionManager } from '../ssh/sessionManager'
import { sftpManager } from '../ssh/sftpManager'
import { diffStats, lineDiff } from '../util/lineDiff'

/**
 * 配置备份与对比。
 *
 * 存储：userData/backups/{时间戳}-{名称}.json —— 配置文件都是文本且体积小，
 * 直接内联存储换来「diff / 还原 / 导出」全部零依赖实现。
 *
 * 采集规则：路径可以是文件或目录（目录递归，深度/数量/体积三重上限保护）；
 * 读取失败的文件也会记录（error 字段），便于事后知道"这份备份缺了什么"。
 */

const MAX_FILE_BYTES = 512 * 1024
const MAX_TOTAL_BYTES = 8 * 1024 * 1024
const MAX_FILES = 300
const MAX_DEPTH = 4

function formatStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]/g, '_').trim() || 'backup'
}

function toMeta(detail: BackupDetail): BackupMeta {
  const { files: _files, ...meta } = detail
  return meta
}

class BackupStore {
  dir(): string {
    return join(app.getPath('userData'), 'backups')
  }

  private path(id: string): string {
    if (!id || /[\\/:*?"<>|]/.test(id) || id.includes('..') || id.startsWith('.')) {
      throw new Error('非法备份标识')
    }
    const dir = resolve(this.dir())
    const target = resolve(join(dir, `${id}.json`))
    if (!target.startsWith(dir + sep)) throw new Error('非法备份路径')
    return target
  }

  async list(): Promise<BackupMeta[]> {
    await fs.mkdir(this.dir(), { recursive: true })
    const names = await fs.readdir(this.dir())
    const out: BackupMeta[] = []
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      try {
        const raw = await fs.readFile(join(this.dir(), name), 'utf-8')
        out.push(toMeta(JSON.parse(raw) as BackupDetail))
      } catch {
        /* 跳过损坏文件 */
      }
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  async detail(id: string): Promise<BackupDetail> {
    const raw = await fs.readFile(this.path(id), 'utf-8')
    return JSON.parse(raw) as BackupDetail
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.path(id), { force: true })
  }

  async openDir(): Promise<void> {
    await fs.mkdir(this.dir(), { recursive: true })
    await shell.openPath(this.dir())
  }

  /** 从设备采集配置（路径可为文件或目录） */
  async create(sessionId: string, name: string, paths: string[]): Promise<BackupDetail> {
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
      id: `${formatStamp(new Date())}-${sanitize(name)}`,
      name,
      connectionName: session.title,
      host: session.host,
      createdAt: Date.now(),
      fileCount: files.filter((f) => !f.error).length,
      totalSize: total,
      paths,
      files
    }
    await fs.mkdir(this.dir(), { recursive: true })
    await fs.writeFile(this.path(detail.id), JSON.stringify(detail, null, 2), 'utf-8')
    return detail
  }

  /** 备份文件 vs 设备当前内容（旧 = 备份，新 = 当前） */
  async diff(id: string, path: string, sessionId: string): Promise<BackupDiffResult> {
    const detail = await this.detail(id)
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
  async restore(
    id: string,
    sessionId: string,
    paths: string[]
  ): Promise<{ restored: number; failed: Array<{ path: string; error: string }> }> {
    const detail = await this.detail(id)
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
}

export const backupStore = new BackupStore()
