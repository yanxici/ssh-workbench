import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 通用 JSON 文件存储。
 *
 * 设计取舍：
 * - 原子写：先写同目录临时文件，再 rename 覆盖 —— 中途崩溃/断电不会写坏正式文件；
 * - 写队列串行化：同一文件的多次写入按调用顺序执行，杜绝并发竞态；
 * - 缓存：读一次进内存，后续读零 IO；写时同步更新缓存。
 *
 * 为什么用 JSON 而不是 SQLite：本项目数据量小（几十~几百条），
 * better-sqlite3 需要按 Electron ABI 重建 native 模块，在团队机器上有安装失败风险；
 * JSON 零依赖、可读可改、方便备份迁移。若将来数据量增长，只需替换本文件与 repository。
 */
export class JsonStore<T> {
  private cache: T | null = null
  private writeChain: Promise<void> = Promise.resolve()
  /** 读-改串行锁：并发 update 时后者基于前者结果修改，避免互相覆盖 */
  private mutateChain: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly fallback: () => T
  ) {}

  /** 文件是否已存在（用于「首次运行」判断） */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.file)
      return true
    } catch {
      return false
    }
  }

  async read(): Promise<T> {
    if (this.cache !== null) return this.cache
    try {
      const raw = await fs.readFile(this.file, 'utf-8')
      this.cache = JSON.parse(raw) as T
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        // 文件损坏：保留现场，降级为默认值，避免阻塞启动
        await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {})
      }
      this.cache = this.fallback()
    }
    return this.cache
  }

  /** 读-改-写：fn 收到当前值，返回新值；返回值已持久化 */
  async update(fn: (current: T) => T): Promise<T> {
    // 修复：原实现在 await read() 后才执行 fn，两个并发 update 会拿到同一份旧值，
    // 后写入者覆盖前者（丢更新）。现在读-改按调用顺序串行，并在同一步里入写队列，
    // 保证落盘顺序与修改顺序一致
    let written!: Promise<void>
    const step = this.mutateChain.then(async () => {
      const current = await this.read()
      const next = fn(current)
      this.cache = next
      written = this.persist(next)
      return next
    })
    this.mutateChain = step.then(
      () => undefined,
      () => undefined
    )
    const next = await step
    await written
    return next
  }

  /** 无条件覆盖写入 */
  async write(value: T): Promise<void> {
    this.cache = value
    await this.persist(value)
  }

  private persist(value: T): Promise<void> {
    const task = async (): Promise<void> => {
      await fs.mkdir(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8')
      await fs.rename(tmp, this.file)
    }
    // 前一次写入失败也不阻塞后续写入
    this.writeChain = this.writeChain.then(task, task)
    return this.writeChain
  }
}

/** 数据根目录：%APPDATA%/ssh-workbench/data（随平台自动变化） */
export function dataDir(): string {
  return join(app.getPath('userData'), 'data')
}
