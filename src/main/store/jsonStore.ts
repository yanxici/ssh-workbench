import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { dirname, join } from 'node:path'
/**
 * 通用 JSON 文件存储。
 *
 * 设计取舍：
 * - 原子写：先写同目录临时文件，再 rename 覆盖 —— 中途崩溃/断电不会写坏正式文件；
 * - 读-改-写串行化：同一文件的修改按调用顺序执行，且**写盘成功之后**才释放队列，
 *   杜绝并发竞态与「写失败但缓存已是新值」的投毒；
 * - 缓存：读一次进内存，后续读零 IO；写成功后同步刷新缓存与指纹。
 *
 * 为什么用 JSON 而不是 SQLite：本项目数据量小（几十~几百条），
 * better-sqlite3 需要按 Electron ABI 重建 native 模块，在团队机器上有安装失败风险；
 * JSON 零依赖、可读可改、方便备份迁移。若将来数据量增长，只需替换本文件与 repository。
 */
/**
 * 所有 JsonStore 实例的登记表。
 *
 * 写盘是异步的：IPC 处理返回之后，commit() 的 rename 可能还在路上。
 * 退出时若直接 app.quit()，这些没落盘的改动就丢了（表现为「刚改的设置
 * 重启后又变回去了」）。这里让退出流程能等一等所有在途写入。
 */
const allStores = new Set<JsonStore<unknown>>()

export class JsonStore<T> {
  private cache: T | null = null
  /** 缓存对应的文件指纹（mtime:size），用于检测外部改动 */
  private cacheSignature: string | null = null
  /**
   * 写世代计数器。
   *
   * 用来识别「读盘期间有写入落地」这个竞态：load() 里 await fs.readFile 之后、
   * 赋值 cache 之前，只要中间发生过 update()/write()，磁盘上那份内容就已经
   * 比内存里的 cache 旧了。旧实现会照旧把磁盘内容写进 cache —— 更糟的是当
   * readFile 以 ENOENT 失败时（文件在「读」和「写」之间才被创建），catch 分支
   * 会把 cache 置成 fallback()（空对象）而 cacheSignature 刷成**新文件**的指纹，
   * 于是「缓存命中」条件成立，之后每次 read() 都返回空对象，直到文件 mtime 再变。
   * 实测表现：渲染层把 splitLayout 写进 settings.json 成功、紧接着 IPC 读回来是 {}，
   * 重启后又能读到（新进程 cache 为 null，走真实 load）。
   */
  private writeGen = 0
  /**
   * 正在落盘的写次数。
   *
   * 写盘期间磁盘不是最新真相：此时 load() 一律不碰 cache，把内存里那份交出去。
   * 只从队列任务内部 +1 不够 —— 排队前那一小段仍然可被 load() 读穿，
   * 所以 commit() 在改 cache 的同时同步 +1。
   */
  private writesInFlight = 0
  /** 读-改-写串行锁：写盘成功后才 resolve，后续修改必然基于已落盘的最新值 */
  private mutateChain: Promise<void> = Promise.resolve()


  constructor(
    private readonly file: string,
    private readonly fallback: () => T
  ) {
    allStores.add(this)
  }

  /**
   * 等所有实例的在途写入落地（退出前调用）。
   * 循环等待直到微任务/下一轮事件循环不再挂出新的 mutateChain，
   * 避免退出时 closeAll() 经异步链路新排队的 transfer-records.json 写入被漏掉。
   * mutateChain 内部已吞掉错误，这里不会因单个 store 写失败而卡住退出。
   */
  static async flushAll(): Promise<void> {
    for (let round = 0; round < 20; round += 1) {
      const snapshot = new Map<JsonStore<unknown>, Promise<void>>()
      for (const s of allStores) snapshot.set(s, s.mutateChain)
      await Promise.all(snapshot.values())
      await new Promise<void>((resolve) => setImmediate(resolve))
      let changed = false
      for (const s of allStores) {
        if (snapshot.get(s) !== s.mutateChain) {
          changed = true
          break
        }
      }
      if (!changed) break
    }
  }

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
    return this.load('read')
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
    return this.load('mutate')
  }

  /**
   * 从磁盘重新加载（唯一真正读盘的入口）。
   *
   * mode 决定「读不到」时怎么办，**不再用实例上的共享字段传递瞬时错误**：
   * 共享字段会被并发的 read() 提前清空，update() 醒来后看到 null，
   * 就拿着兜底空值 fn() 后写回磁盘，把用户整份 connections.json 覆写成一条。
   *
   * - 'mutate'：读不到就抛错，让这次修改失败（宁可改不成，也不能拿空值覆盖）；
   * - 'read'：读不到返回内存里那份或兜底值，绝不改 cacheSignature。
   */
  private async load(mode: 'read' | 'mutate'): Promise<T> {
    const gen = this.writeGen
    if (this.writesInFlight > 0) return this.cache ?? this.fallback()

    let raw: string
    try {
      raw = await fs.readFile(this.file, 'utf-8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        // 文件不存在 = 首次运行或刚被删，按兜底值处理
        const sig = await this.statSignature()
        if (gen !== this.writeGen || this.writesInFlight > 0) return this.cache ?? this.fallback()
        this.cacheSignature = sig
        this.cache = this.fallback()
        return this.cache
      }
      /*
       * 其它一切 OS 读错（EBUSY/EPERM/EACCES/EAGAIN/EIO/UNKNOWN…）都是「这会儿读不到」，
       * 文件内容完好。旧实现用 5 个错误码的白名单判瞬时错误，剩下的统统一路走到
       * rename(.corrupt-<ts>) —— OneDrive、杀软、索引服务一个 EAGAIN 就把用户
       * 所有连接和密码改名隔离掉了。这里改成反过来的白名单：只有 ENOENT 与
       * 解析失败是「文件的事」，其余都是「环境的事」。
       */
      if (mode === 'mutate') {
        throw new Error(
          `读取 ${this.file} 失败（文件可能被其他程序临时占用），已放弃本次写入以免覆盖数据：` +
            (err instanceof Error ? err.message : String(err))
        )
      }
      return this.cache ?? this.fallback()
    }

    if (gen !== this.writeGen || this.writesInFlight > 0) return this.cache ?? this.fallback()

    let parsed: T
    try {
      parsed = JSON.parse(raw) as T
    } catch (err) {
      if (!(err instanceof SyntaxError)) {
        // 解析器的其它异常（内存不足等）不代表文件坏，别隔离现场
        if (mode === 'mutate') {
          throw new Error(
            `读取 ${this.file} 失败，已放弃本次写入以免覆盖数据：` +
              (err instanceof Error ? err.message : String(err))
          )
        }
        return this.cache ?? this.fallback()
      }
      /*
       * 真损坏。但必须先确认「这段时间没有写入落地」再改名：
       * 旧实现先 rename 后检查世代，会把并发刚写好的**有效新文件**改名成 .corrupt-*。
       */
      if (gen !== this.writeGen || this.writesInFlight > 0) return this.cache ?? this.fallback()
      /*
       * 改名隔离的串行化：
       * - mode === 'mutate' 已处于 this.mutateChain 内部，直接就地改名即可；
       *   如果此时再调 isolateCorrupt() 往 this.mutateChain 尾部排队，会与当前 update() 100% 永久自死锁。
       * - mode === 'read' 不在链里，必须排进 isolateCorrupt() 串行链并在链内复核世代，
       *   避免并发刚落盘的有效新文件被 rename 成 .corrupt-* 搬走。
       */
      let isolated = false
      if (mode === 'mutate') {
        await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {})
        isolated = true
      } else {
        isolated = await this.isolateCorrupt(gen)
      }
      /*
       * 隔离期间的 await 也可能有写入落地：磁盘上已经是有效新值，
       * 此时把 cache 刷成 fallback() 并绑上新指纹就是**永久投毒**
       * （之后每次 read() 都命中空值，直到文件 mtime 再变）。
       */
      const sig = isolated ? await this.statSignature() : null
      if (!isolated || gen !== this.writeGen || this.writesInFlight > 0) {
        return this.cache ?? this.fallback()
      }
      this.cacheSignature = sig
      this.cache = this.fallback()
      return this.cache
    }

    /*
     * 解析成功后才同时更新 cache 与指纹。
     * 旧实现先写 cacheSignature 再 parse，parse 一失败就留下「新指纹 + 旧缓存」，
     * 之后每次 read() 都命中那份错误缓存。
     */
    const sig = await this.statSignature()
    if (gen !== this.writeGen || this.writesInFlight > 0) return this.cache ?? this.fallback()
    this.cache = parsed
    this.cacheSignature = sig
    return parsed
  }

  /**
   * 把损坏文件改名隔离（.corrupt-<ts>），排进串行链后执行。
   * 返回 true 表示确实由本次调用完成隔离；false 表示排队期间已有写入落地，
   * 那个新文件是有效数据，不能动。
   */
  private async isolateCorrupt(gen: number): Promise<boolean> {
    let isolated = false
    const step = this.mutateChain.then(async () => {
      if (gen !== this.writeGen || this.writesInFlight > 0) return
      await fs.rename(this.file, `${this.file}.corrupt-${Date.now()}`).catch(() => {})
      isolated = true
    })
    this.mutateChain = step.then(
      () => undefined,
      () => undefined
    )
    await step
    return isolated
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
    /*
     * 读-改-写整体在串行链里，且**写盘成功才出链**：
     * 旧实现的链在 await written 之前就释放了，写盘失败时后续 update 会基于
     * 那份「已报错、没落盘」的值继续提交，把错误一路带到磁盘。
     */
    let next!: T
    const step = this.mutateChain.then(async () => {
      const current = await this.readForMutate()
      next = fn(current)
      await this.commit(next)
    })
    this.mutateChain = step.then(
      () => undefined,
      () => undefined
    )
    await step
    return next
  }

  /**
   * 无条件覆盖写入。
   *
   * 必须和 update() 共用同一条串行链：旧实现直接写盘，一个 write(全量列表)
   * 与一个 update(追加一项) 并发时，先后顺序由 rename 的调度决定，
   * 慢的那次会把快的整份覆盖 —— 表现为「刚加的命令/连接又没了」。
   */
  async write(value: T): Promise<void> {
    const step = this.mutateChain.then(() => this.commit(value))
    this.mutateChain = step.then(
      () => undefined,
      () => undefined
    )
    await step
  }

  /**
   * 落盘 + 缓存提交（写成功后缓存才算数，失败回滚）。
   *
   * 旧实现先把 cache 改成新值再去 persist：写一旦失败（磁盘满、Windows 上
   * rename 连续 5 次被锁），既没回滚也没失效，而 cacheSignature 还是磁盘旧指纹 ——
   * 之后每次 read() 都命中这份**从未落盘的幻影数据**，直到重启全丢。
   */
  private async commit(next: T): Promise<void> {
    const prevCache = this.cache
    const prevSignature = this.cacheSignature
    this.writeGen += 1
    const gen = this.writeGen
    this.cache = next
    this.writesInFlight += 1
    try {
      await this.writeOnce(next)
    } catch (err) {
      // 期间若又有新的提交，就别回滚（那次的 prev 已经不是这份数据了）
      if (gen === this.writeGen) {
        this.cache = prevCache
        this.cacheSignature = prevSignature
      }
      throw err
    } finally {
      this.writesInFlight -= 1
    }
  }

  private async writeOnce(value: T): Promise<void> {
    await fs.mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    try {
      await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf-8')
      await renameWithRetry(tmp, this.file)
    } catch (err) {
      // 半截临时文件不能留：下次写入会复用同名 tmp，残留内容可能被误当有效数据
      try {
        await fs.rm(tmp, { force: true })
      } catch {
        /* 清不掉不影响正式文件 */
      }
      throw err
    }
    /*
     * 写完刷新指纹，避免下一次外部 read() 因为 mtime 变了而多余地重读。
     * 必须在 rename 之后取：mtime 是 rename 落地才更新的。
     */
    this.cacheSignature = await this.statSignature()
  }
}

/**
 * rename 覆盖已有文件时，Windows 会因目标被短暂占用而抛 EPERM/EBUSY/EACCES，
 * 而 POSIX 下同样的操作是原子的、不会失败。
 * 旧实现不重试：一次失败就整次写入失败，且 cache 已被改成新值 ——
 * 内存与磁盘从此不一致，重启后刚改的东西全丢。
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastErr: unknown = null
  for (let i = 0; i < 5; i += 1) {
    try {
      await fs.rename(from, to)
      return
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES') break
      await new Promise((r) => setTimeout(r, 20 * (i + 1)))
    }
  }
  try {
    await fs.rm(from, { force: true })
  } catch {
    /* 临时文件清不掉不影响正式文件 */
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

/** 数据根目录：%APPDATA%/ssh-workbench/data（随平台自动变化） */
export function dataDir(): string {
  return join(app.getPath('userData'), 'data')
}
