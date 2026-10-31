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
  /** 缓存对应的文件指纹（mtime:size），用于检测外部改动 */
  private cacheSignature: string | null = null
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
    /*
     * 缓存 + mtime 校验。
     * 直接返回缓存会让「JSON 可读可改」这个卖点失效：用户改了 %APPDATA%
     * 下的 connections.json，主进程到重启前都读不到（缓存永不过期）。
     * 但每次都 stat + 全量 parse 又太浪费，所以：文件 mtime/size 没变就直回缓存，
     * 变了才重读。stat 一次约几微秒，比 JSON.parse 上千条连接便宜得多。
     */
    if (this.cache !== null) {
      const fresh = await this.statSignature()
      if (fresh !== null && fresh === this.cacheSignature) return this.cache
      // 文件被外部改过（或删了）—— 缓存作废，走下面的重新加载
    }
    return this.load()
  }

  /**
   * 读缓存用于读-改-写（**不做 mtime 校验**）。
   *
   * update 的串行链里必须用这个：写盘是异步的，persist 未完成时文件 mtime
   * 已经变了而 cacheSignature 还没刷新，此时若走 read() 的 mtime 校验，
   * 会把刚写进 cache 的新值当成「过期的外部改动」丢掉，反向从磁盘读回旧值 ——
   * 表现为并发 update 丢更新（50 次并发只保住 6 个标签）。
   * 链内自己就是唯一写入者，缓存必然比磁盘新，直接信任。
   */
  private async readForMutate(): Promise<T> {
    if (this.cache !== null) return this.cache
    return this.load()
  }

  /** 从磁盘重新加载并刷新指纹（唯一真正读盘的入口） */
  private async load(): Promise<T> {
    try {
      const raw = await fs.readFile(this.file, 'utf-8')
      this.cacheSignature = await this.statSignature()
      this.cache = JSON.parse(raw) as T
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') {
        // 文件损坏：保留现场，降级为默认值，避免阻塞启动
        await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {})
      }
      this.cacheSignature = await this.statSignature()
      this.cache = this.fallback()
    }
    return this.cache
  }

  /** 文件指纹（mtime + size）；文件不存在返回 null */
  private async statSignature(): Promise<string | null> {
    try {
      const st = await fs.stat(this.file)
      return `${st.mtimeMs}:${st.size}`
    } catch {
      return null
    }
  }

  /** 手动让缓存失效（外部已知文件被改动时调用） */
  invalidate(): void {
    this.cache = null
    this.cacheSignature = null
  }

  /** 读-改-写：fn 收到当前值，返回新值；返回值已持久化 */
  async update(fn: (current: T) => T): Promise<T> {
    // 修复：原实现在 await read() 后才执行 fn，两个并发 update 会拿到同一份旧值，
    // 后写入者覆盖前者（丢更新）。现在读-改按调用顺序串行，并在同一步里入写队列，
    // 保证落盘顺序与修改顺序一致
    let written!: Promise<void>
    const step = this.mutateChain.then(async () => {
      const current = await this.readForMutate()
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
      /*
       * 写完刷新指纹，避免下一次外部 read() 因为 mtime 变了而多余地重读。
       * 必须在 rename 之后取：mtime 是 rename 落地才更新的。
       * 链内读取走 readForMutate（不看指纹），所以这里即使与并发写有
       * 极短的时序交错，也不会造成丢更新。
       */
      this.cacheSignature = await this.statSignature()
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
