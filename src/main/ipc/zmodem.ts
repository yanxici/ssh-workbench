import { dialog, type OpenDialogOptions } from 'electron'
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { appendFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/ipc'
import { dialogParent } from '../windowRef'
import { dialogDefaultPath, rememberDialogDir, rememberDialogPick } from '../util/dialogDirs'
import { handle } from './handle'
import { sessionManager } from '../ssh/sessionManager'

/** 单文件 ZMODEM 上传体积上限（超过请改用 SFTP 或 trzsz 流式传输） */
export const ZM_MAX_UPLOAD_BYTES = 256 * 1024 * 1024

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
    { path: string; bytes: number; at: number; writeChain: Promise<void> }
  >()
  const claimedPaths = new Set<string>()
  const claimKey = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

  const pruneZm = (): void => {
    const now = Date.now()
    for (const [k, v] of zmDirTokens) if (now - v.at > ZM_TOKEN_TTL) zmDirTokens.delete(k)
    for (const [k, v] of zmReceives) {
      if (now - v.at > ZM_TOKEN_TTL) {
        zmReceives.delete(k)
        claimedPaths.delete(claimKey(v.path))
      }
    }
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

  // 开始接收一个文件：在已选目录里排他创建目标文件（重名自动编号 + wx 堵住 TOCTOU），返回写入句柄
  handle(IPC.ZM_SAVE_BEGIN, (token: string, suggestedName: string) => {
    pruneZm()
    const rec = zmDirTokens.get(token)
    if (!rec) throw new Error('保存文件夹已失效，请重新选择')
    rec.at = Date.now()
    mkdirSync(rec.dir, { recursive: true })
    const safeName = safeFileName(suggestedName)

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
      bytes: 0,
      at: Date.now(),
      writeChain: Promise.resolve()
    })
    return { saveId, path: target }
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
    rec.writeChain = work.catch(() => undefined)
    await work
    return { bytes: rec.bytes }
  })

  // 收尾：等在途写盘完成，释放句柄与路径占用；用户取消且 0 字节时顺手删掉空占位文件
  handle(IPC.ZM_SAVE_FINISH, async (saveId: string, opts?: { canceled?: boolean }) => {
    const rec = zmReceives.get(saveId)
    if (!rec) throw new Error('接收会话已失效或已结束')
    await rec.writeChain
    zmReceives.delete(saveId)
    claimedPaths.delete(claimKey(rec.path))
    if (opts?.canceled && rec.bytes === 0) {
      try {
        unlinkSync(rec.path)
      } catch {
        /* 已删除或无权限 */
      }
    }
    return { path: rec.path, size: rec.bytes }
  })

  handle(IPC.ZM_SEND_BYTES, (sessionId: string, base64: string) =>
    sessionManager.writeBytes(sessionId, Buffer.from(String(base64), 'base64'))
  )
}
