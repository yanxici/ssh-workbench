import { app, BrowserWindow, dialog } from 'electron'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { IPC } from '@shared/ipc'
import { dialogParent } from '../windowRef'
import { handle } from './handle'
import { sessionManager } from '../ssh/sessionManager'

/**
 * ZMODEM 文件传输（rz / sz）。
 *
 * 安全要点：远端送来的文件名不可信 —— 一律过 safeFileName 去路径分隔符，
 * 写入目标只能由「本进程对话框选出的文件夹」产生的令牌决定，
 * 渲染层拿不到任意路径写权限。
 */
export function registerZmodemIpc(): void {
  // 选择要发送到远端的文件（sz 方向：本机 -> 远端）
  handle(IPC.ZM_PICK_FILES, async () => {
    const res = await dialog.showOpenDialog(dialogParent() as BrowserWindow, {
      title: '选择要通过 ZMODEM 发送的文件',
      buttonLabel: '发送',
      properties: ['openFile', 'multiSelections']
    })
    if (res.canceled || res.filePaths.length === 0) return { canceled: true, files: [] }
    const files = res.filePaths.map((p) => {
      const buf = readFileSync(p)
      return { name: basename(p), size: buf.length, data: buf.toString('base64') }
    })
    return { canceled: false, files }
  })

  // 接收方向：先让用户选一次「文件夹」（多文件 sz 只问一次），返回一次性令牌。
  const ZM_TOKEN_TTL = 30 * 60 * 1000
  const zmDirTokens = new Map<string, { dir: string; at: number }>()
  const zmReceives = new Map<string, { path: string; bytes: number; at: number }>()

  const pruneZm = (): void => {
    const now = Date.now()
    for (const [k, v] of zmDirTokens) if (now - v.at > ZM_TOKEN_TTL) zmDirTokens.delete(k)
    for (const [k, v] of zmReceives) if (now - v.at > ZM_TOKEN_TTL) zmReceives.delete(k)
  }

  // 远端送来的文件名不可信：去掉路径分隔符与 Windows 保留字符，只留纯文件名
  const safeFileName = (name: string): string => {
    const cleaned = basename(String(name || 'download.bin').replace(/[\\/:*?"<>|]/g, '_'))
    return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'download.bin'
  }

  // 同名文件自动加序号，绝不覆盖已有文件
  const uniquePath = (dir: string, name: string): string => {
    const ext = extname(name)
    const stem = name.slice(0, name.length - ext.length) || 'download'
    let candidate = join(dir, name)
    let i = 1
    while (existsSync(candidate)) {
      candidate = join(dir, `${stem} (${i})${ext}`)
      i += 1
    }
    return candidate
  }

  handle(IPC.ZM_PICK_DIR, async () => {
    const res = await dialog.showOpenDialog(dialogParent() as BrowserWindow, {
      title: '选择接收文件的保存文件夹',
      buttonLabel: '保存到此处',
      defaultPath: app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths.length) return { canceled: true }
    pruneZm()
    const token = randomUUID()
    zmDirTokens.set(token, { dir: res.filePaths[0], at: Date.now() })
    return { canceled: false, token, dir: res.filePaths[0] }
  })

  // 开始接收一个文件：在已选目录里建好目标文件（重名自动编号），返回写入句柄
  handle(IPC.ZM_SAVE_BEGIN, (token: string, suggestedName: string) => {
    pruneZm()
    const rec = zmDirTokens.get(token)
    if (!rec) throw new Error('保存文件夹已失效，请重新选择')
    mkdirSync(rec.dir, { recursive: true })
    const target = uniquePath(rec.dir, safeFileName(suggestedName))
    // 先建成空文件，后续按块追加（大数据不必在内存里拼整份）
    writeFileSync(target, Buffer.alloc(0))
    const saveId = randomUUID()
    zmReceives.set(saveId, { path: target, bytes: 0, at: Date.now() })
    return { saveId, path: target }
  })

  // 追加一块数据（base64），返回累计字节数
  handle(IPC.ZM_SAVE_APPEND, (saveId: string, base64: string) => {
    const rec = zmReceives.get(saveId)
    if (!rec) throw new Error('接收会话已失效或已结束')
    const buf = Buffer.from(String(base64 || ''), 'base64')
    if (buf.length) appendFileSync(rec.path, buf)
    rec.bytes += buf.length
    rec.at = Date.now()
    return { bytes: rec.bytes }
  })

  // 收尾：关闭句柄，返回最终路径与大小
  handle(IPC.ZM_SAVE_FINISH, (saveId: string) => {
    const rec = zmReceives.get(saveId)
    if (!rec) throw new Error('接收会话已失效或已结束')
    zmReceives.delete(saveId)
    return { path: rec.path, size: rec.bytes }
  })

  handle(IPC.ZM_SEND_BYTES, (sessionId: string, base64: string) =>
    sessionManager.writeBytes(sessionId, Buffer.from(String(base64), 'base64'))
  )
}
