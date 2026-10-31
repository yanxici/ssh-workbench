import { app, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import type { BackupDetail, BackupMeta } from '@shared/types'

/**
 * 配置备份与对比。
 *
 * 存储：userData/backups/{时间戳}-{名称}.json —— 配置文件都是文本且体积小，
 * 直接内联存储换来「diff / 还原 / 导出」全部零依赖实现。
 *
 * 采集规则：路径可以是文件或目录（目录递归，深度/数量/体积三重上限保护）；
 * 读取失败的文件也会记录（error 字段），便于事后知道"这份备份缺了什么"。
 */


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

  /** 落盘一份备份明细（纯文件写入，不含任何 SSH 采集逻辑） */
  async save(detail: BackupDetail): Promise<void> {
    await fs.mkdir(this.dir(), { recursive: true })
    await fs.writeFile(this.path(detail.id), JSON.stringify(detail, null, 2), 'utf-8')
  }

  /** 生成备份标识：时间戳-名称（供采集侧组装 detail 时使用） */
  newId(name: string): string {
    return `${formatStamp(new Date())}-${sanitize(name)}`
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.path(id), { force: true })
  }

  async openDir(): Promise<void> {
    await fs.mkdir(this.dir(), { recursive: true })
    await shell.openPath(this.dir())
  }
}

export const backupStore = new BackupStore()
