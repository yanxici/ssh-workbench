import { dialog, type OpenDialogOptions } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { appendFile, rename } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/ipc'
import { dialogParent } from '../windowRef'
import { dialogDefaultPath, rememberDialogDir, rememberDialogPick } from '../util/dialogDirs'
import { handle } from './handle'
import { sessionManager } from '../ssh/sessionManager'

export interface ZmSaveBeginOptions {
  /** 是否启用「同名跳过、变大覆盖旧文件」 */
  skipExisting?: boolean
  /** 远端 ZFILE 报出的字节数（null/undefined 表示未提供） */
  size?: number | null
  /** 保留兼容字段（不再用于跳过判定，也不回写本机 mtime） */
  mtime?: number | null
}

/** 单文件 ZMODEM 上传体积上限（超过请改用 SFTP 或 trzsz 流式传输） */
export const ZM_MAX_UPLOAD_BYTES = 256 * 1024 * 1024

/**
 * Windows 上 rename 会被短期句柄（Defender 扫描、缩略图预览、索引器）打断，
 * 表现为 EBUSY/EPERM/EACCES；退避重试比直接失败友好得多。
 * 其它错误（ENOENT/ENOSPC/EXDEV…）重试也没用，立刻抛。
 */
const RENAME_RETRY_DELAYS = [50, 150, 300]
const RETRYABLE_RENAME_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])

const renameWithRetry = async (from: string, to: string): Promise<void> => {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? ''
      if (attempt >= RENAME_RETRY_DELAYS.length || !RETRYABLE_RENAME_CODES.has(code)) throw err
      await new Promise<void>((resolve) => setTimeout(resolve, RENAME_RETRY_DELAYS[attempt]))
    }
  }
}

const WIN_RESERVED_DEVICE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i
const MAX_SAFE_NAME_LEN = 200

/**
 * 远端送来的文件名不可信：去掉路径分隔符、Windows 非法字符与尾随点/空格，
 * 避开 Windows 保留设备名（CON/PRN/AUX/NUL/COM1-9/LPT1-9，含带扩展名形式），
 * 并将总长截断在 200 字符以内且保留扩展名。
 */
export const safeFileName = (name: string): string => {
  /* eslint-disable-next-line no-control-regex -- 清洗远端文件名里的 ASCII 控制字符（含 DEL 0x7F） */
  let cleaned = basename(String(name || 'download.bin').replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_'))
  while (/[. ]+$/.test(cleaned)) {
    cleaned = cleaned.replace(/[. ]+$/, '')
  }
  if (!cleaned || cleaned === '.' || cleaned === '..') return 'download.bin'

  const guardReserved = (s: string): string => {
    const dot = s.indexOf('.')
    const stem = dot >= 0 ? s.slice(0, dot) : s
    return WIN_RESERVED_DEVICE.test(stem) ? `_${s}` : s
  }

  cleaned = guardReserved(cleaned)
  if (cleaned.length > MAX_SAFE_NAME_LEN) {
    const ext = extname(cleaned)
    const keepExt = ext.length < MAX_SAFE_NAME_LEN ? ext : ''
    const stem = cleaned.slice(0, cleaned.length - keepExt.length)
    let cut = stem.slice(0, MAX_SAFE_NAME_LEN - keepExt.length)
    while (/[. ]+$/.test(cut)) {
      cut = cut.replace(/[. ]+$/, '')
    }
    cleaned = guardReserved((cut || 'download') + keepExt)
    if (cleaned.length > MAX_SAFE_NAME_LEN) {
      cleaned = cleaned.slice(0, MAX_SAFE_NAME_LEN)
    }
  }
  return cleaned
}

/**
 * ZMODEM 文件传输（rz / sz）。
 *
 * 安全要点：远端送来的文件名不可信 —— 一律过 safeFileName 去路径分隔符，
 * 写入目标只能由「本进程对话框选出的文件夹」产生的令牌决定，
 * 渲染层拿不到任意路径写权限。
 */
export function registerZmodemIpc(): void {
  const showOpenDialog = (opts: OpenDialogOptions) => {
    const parent = dialogParent()
    return parent ? dialog.showOpenDialog(parent, opts) : dialog.showOpenDialog(opts)
  }

  // 选择要发送到远端的文件（sz 方向：本机 -> 远端）
  handle(IPC.ZM_PICK_FILES, async () => {
    const res = await showOpenDialog({
      title: '选择要通过 ZMODEM 发送的文件',
      buttonLabel: '发送',
      defaultPath: dialogDefaultPath('file'),
      properties: ['openFile', 'multiSelections']
    })
    if (res.canceled || res.filePaths.length === 0) return { canceled: true, files: [] }
    rememberDialogPick('file', res.filePaths[0], false)
    // 先检查大小再读盘，防止 256MB+ 大文件把主进程内存打爆
    for (const p of res.filePaths) {
      if (statSync(p).size > ZM_MAX_UPLOAD_BYTES) {
        throw new Error('暂不支持超过 256MB 的文件，请改用 SFTP 或 trzsz 上传')
      }
    }
    const files = res.filePaths.map((p) => {
      const buf = readFileSync(p)
      // path 一并返回：传输记录要能回答「这个文件原本在哪」，而记录只认绝对路径
      return { name: basename(p), path: p, size: buf.length, data: buf.toString('base64') }
    })
    return { canceled: false, files }
  })

  // 接收方向：先让用户选一次「文件夹」（多文件 sz 只问一次），返回一次性令牌。
  const ZM_TOKEN_TTL = 30 * 60 * 1000
  const zmDirTokens = new Map<string, { dir: string; at: number }>()
  const zmReceives = new Map<
    string,
    {
      /** 实际写入路径（新建时为目标路径，覆盖旧文件时为同目录临时 .part 文件） */
      path: string
      /** 非 null 时表示正常收尾后需原子替换的目标旧文件路径 */
      overwriteTarget: string | null
      bytes: number
      at: number
      writeChain: Promise<void>
      /** 任一分块写盘失败即置位：finish 时按异常收尾，绝不用残缺文件覆盖旧文件 */
      failed: boolean
    }
  >()
  const claimedPaths = new Set<string>()
  const claimKey = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

  const releaseReceiveClaims = (rec: { path: string; overwriteTarget: string | null }): void => {
    claimedPaths.delete(claimKey(rec.path))
    if (rec.overwriteTarget) claimedPaths.delete(claimKey(rec.overwriteTarget))
  }

  const pruneZm = (): void => {
    const now = Date.now()
    for (const [k, v] of zmDirTokens) if (now - v.at > ZM_TOKEN_TTL) zmDirTokens.delete(k)
    for (const [k, v] of zmReceives) {
      if (now - v.at > ZM_TOKEN_TTL) {
        zmReceives.delete(k)
        // 覆盖模式的 path 是同目录临时 .part：不删就永久留在用户目录里
        if (v.overwriteTarget) {
          try {
            unlinkSync(v.path)
          } catch {
            /* 已删除或无权限 */
          }
        }
        releaseReceiveClaims(v)
      }
    }
  }

  /**
   * 开启「跳过已存在同名文件（变大覆盖旧文件）」时的策略判定：
   *  1) 若目录内原名或历史编号副本里已有完全同大小的普通文件（且未被并发写入占位），直接跳过
   *     （不依赖 mtime，彻底免疫 1970-01-01 空白修改日期或设备时钟偏移导致的误重下）；
   *  2) 若主目标同名普通文件已存在且未在写入中：
   *     - 远端明确更大（活动日志增长或本地为残缺文件）-> 走临时 .part 原子覆盖该旧文件；
   *     - 其余情况（本地更大或远端未报大小）-> 直接跳过；
   *  3) 同名目录或正在写入占位 -> 退回新建编号文件，不误跳也不覆盖。
   */
  const resolveExistingAction = (
    dir: string,
    name: string,
    remoteSize: number | null
  ):
    | { action: 'skip'; path: string; size: number }
    | { action: 'overwrite'; target: string }
    | { action: 'create' } => {
    const primaryPath = join(dir, name)
    const primaryKey = claimKey(primaryPath)
    const ext = extname(name)
    const stem = name.slice(0, name.length - ext.length) || 'download'

    if (remoteSize !== null) {
      let candidate = primaryPath
      let i = 1
      while (existsSync(candidate) || claimedPaths.has(claimKey(candidate))) {
        if (!claimedPaths.has(claimKey(candidate))) {
          try {
            const st = statSync(candidate)
            if (st.isFile() && st.size === remoteSize) {
              return { action: 'skip', path: candidate, size: st.size }
            }
          } catch {
            /* 读取失败时继续 */
          }
        }
        candidate = join(dir, `${stem} (${i})${ext}`)
        i += 1
      }
    }

    if (!claimedPaths.has(primaryKey) && existsSync(primaryPath)) {
      try {
        const st = statSync(primaryPath)
        if (st.isFile()) {
          if (remoteSize !== null && remoteSize > st.size) {
            return { action: 'overwrite', target: primaryPath }
          }
          return { action: 'skip', path: primaryPath, size: st.size }
        }
      } catch {
        /* 读取失败时保守新建 */
      }
    }

    return { action: 'create' }
  }

  // 同名文件自动加序号，绝不覆盖已有文件或已被并发占用的目标路径
  const uniquePath = (dir: string, name: string): string => {
    const ext = extname(name)
    const stem = name.slice(0, name.length - ext.length) || 'download'
    let candidate = join(dir, name)
    let i = 1
    while (existsSync(candidate) || claimedPaths.has(claimKey(candidate))) {
      candidate = join(dir, `${stem} (${i})${ext}`)
      i += 1
    }
    return candidate
  }

  handle(IPC.ZM_PICK_DIR, async () => {
    const res = await showOpenDialog({
      title: '选择接收文件的保存文件夹',
      buttonLabel: '保存到此处',
      defaultPath: dialogDefaultPath('folder'),
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths.length) return { canceled: true }
    rememberDialogDir('folder', res.filePaths[0])
    pruneZm()
    const token = randomUUID()
    zmDirTokens.set(token, { dir: res.filePaths[0], at: Date.now() })
    return { canceled: false, token, dir: res.filePaths[0] }
  })

  // 开始接收一个文件：开启 skipExisting 时同名跳过、变大走临时 .part 覆盖旧文件；否则编号新建
  handle(IPC.ZM_SAVE_BEGIN, (token: string, suggestedName: string, opts?: ZmSaveBeginOptions) => {
    pruneZm()
    const rec = zmDirTokens.get(token)
    if (!rec) throw new Error('保存文件夹已失效，请重新选择')
    rec.at = Date.now()
    mkdirSync(rec.dir, { recursive: true })
    const safeName = safeFileName(suggestedName)

    const remoteSize =
      typeof opts?.size === 'number' && Number.isFinite(opts.size) && opts.size >= 0
        ? opts.size
        : null

    if (opts?.skipExisting === true) {
      const decision = resolveExistingAction(rec.dir, safeName, remoteSize)
      if (decision.action === 'skip') {
        return { skipped: true as const, path: decision.path, size: decision.size }
      }
      if (decision.action === 'overwrite') {
        const target = decision.target
        const targetKey = claimKey(target)
        claimedPaths.add(targetKey)
        let tempPath = ''
        let createdTemp = false
        for (let attempt = 0; attempt < 5; attempt++) {
          const cand = join(rec.dir, `.${safeName}.${randomUUID().slice(0, 8)}.part`)
          const tempKey = claimKey(cand)
          if (claimedPaths.has(tempKey)) continue
          claimedPaths.add(tempKey)
          try {
            writeFileSync(cand, Buffer.alloc(0), { flag: 'wx' })
            tempPath = cand
            createdTemp = true
            break
          } catch (err) {
            claimedPaths.delete(tempKey)
            const code = (err as NodeJS.ErrnoException)?.code
            if (code !== 'EEXIST') {
              claimedPaths.delete(targetKey)
              throw err
            }
          }
        }
        if (!createdTemp) {
          claimedPaths.delete(targetKey)
          throw new Error('无法创建临时覆盖文件')
        }
        const saveId = randomUUID()
        zmReceives.set(saveId, {
          path: tempPath,
          overwriteTarget: target,
          bytes: 0,
          at: Date.now(),
          writeChain: Promise.resolve(),
          failed: false
        })
        return { skipped: false as const, saveId, path: target }
      }
    }

    let target = ''
    let created = false
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = uniquePath(rec.dir, safeName)
      const key = claimKey(candidate)
      claimedPaths.add(key)
      try {
        writeFileSync(candidate, Buffer.alloc(0), { flag: 'wx' })
        target = candidate
        created = true
        break
      } catch (err) {
        claimedPaths.delete(key)
        const code = (err as NodeJS.ErrnoException)?.code
        if (code !== 'EEXIST') throw err
      }
    }
    if (!created) throw new Error('目标文件名冲突过多，无法创建接收文件')

    const saveId = randomUUID()
    zmReceives.set(saveId, {
      path: target,
      overwriteTarget: null,
      bytes: 0,
      at: Date.now(),
      writeChain: Promise.resolve(),
      failed: false
    })
    return { skipped: false as const, saveId, path: target }
  })

  // 异步追加一块数据（base64），按单文件串行保序且不阻塞主进程事件循环
  handle(IPC.ZM_SAVE_APPEND, async (saveId: string, base64: string) => {
    const rec = zmReceives.get(saveId)
    if (!rec) throw new Error('接收会话已失效或已结束')
    const buf = Buffer.from(String(base64 || ''), 'base64')
    const work = rec.writeChain.then(async () => {
      if (buf.length) await appendFile(rec.path, buf)
      rec.bytes += buf.length
      rec.at = Date.now()
    })
    // 失败必须留下记号：只吞掉异常的话，残缺文件会被当成正常收尾去覆盖用户的旧文件
    rec.writeChain = work.catch(() => {
      rec.failed = true
    })
    await work
    return { bytes: rec.bytes }
  })

  // 收尾：等在途写盘完成，释放句柄与路径占用；覆盖模式下正常完成则原子替换旧文件，异常/取消则删临时 .part 保住原文件
  handle(
    IPC.ZM_SAVE_FINISH,
    async (saveId: string, opts?: { canceled?: boolean; aborted?: boolean }) => {
      const rec = zmReceives.get(saveId)
      if (!rec) throw new Error('接收会话已失效或已结束')
      /*
       * 摘表必须在 await 之前同步完成。
       *
       * 曾经写成 `await rec.writeChain` 之后再 delete：await 期间 saveId 还在表里，
       * 这一瞬间到达的 ZM_SAVE_APPEND 能查到 rec 并挂上 P2 = P1.then(append)，
       * 随后 finish 只等到 P1 就恢复并开始 rename，与仍在跑的 P2 撞在一起 ——
       * Windows 上 EBUSY，POSIX 上直接丢尾块。同步摘表后后到的 append 一律
       * 立刻拿到「会话已失效」，根本进不了追加分支。
       */
      zmReceives.delete(saveId)
      try {
        await rec.writeChain

        const broken = opts?.canceled === true || opts?.aborted === true || rec.failed

        if (rec.overwriteTarget) {
          const target = rec.overwriteTarget
          if (broken) {
            try {
              unlinkSync(rec.path)
            } catch {
              /* 已删除或无权限 */
            }
            return { path: target, size: 0 }
          }
          /*
           * 覆盖失败时**绝不先删原文件**：Windows 上 .part 被 Defender 短暂锁住
           * 会让 rename 抛 EPERM，旧代码 unlink 掉用户的完好旧文件后两次 rename
           * 仍然失败 —— 原文件就这么没了。这里退回另存编号副本，原文件保持不动。
           *
           * 但「短暂锁住」本身要重试：杀毒软件/资源管理器预览句柄通常几十毫秒就放，
           * 一次失败就直接另存编号副本，用户会看到一串 app (1).bin (2).bin。只在
           * 可重试的 Windows 错误码上退避，路径不存在之类的错误立刻走兜底。
           */
          try {
            await renameWithRetry(rec.path, target)
            return { path: target, size: rec.bytes }
          } catch {
            const fallback = uniquePath(dirname(target), basename(target))
            try {
              await renameWithRetry(rec.path, fallback)
            } catch (err) {
              // 两处都落不了地：删掉临时 .part 再抛，否则残留文件永远不会被清理
              try {
                unlinkSync(rec.path)
              } catch {
                /* 已删除或无权限 */
              }
              throw err
            }
            return { path: fallback, size: rec.bytes }
          }
        }

        // 中断（canceled 或渲染层报错 aborted）留下的 0 字节残桩：不删会让
        // 下次 skipExisting 永远判定「已存在」而跳过，真实文件再也下不来
        if (broken && rec.bytes === 0) {
          try {
            unlinkSync(rec.path)
          } catch {
            /* 已删除或无权限 */
          }
        }
        return { path: rec.path, size: rec.bytes }
      } finally {
        zmReceives.delete(saveId)
        releaseReceiveClaims(rec)
      }
    }
  )

  handle(IPC.ZM_SEND_BYTES, (sessionId: string, base64: string) =>
    sessionManager.writeBytes(sessionId, Buffer.from(String(base64), 'base64'))
  )
}
