import { app, BrowserWindow, dialog } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { dialogParent } from '../windowRef'
import { handle } from './handle'
import {
  clearErrors,
  deleteError,
  errorStats,
  exportErrorsText,
  listErrors,
  recordError
} from '../store/errorLog'
import { sessionManager } from '../ssh/sessionManager'

/**
 * 错误日志 + 渲染层异常上报 + 自动重连的取消入口。
 *
 * 这三块放在一起是因为它们都围绕「出错了怎么办」：错误的产生（渲染层上报、
 * IPC 失败自动记录）、错误的读取（列表/统计/导出），以及把用户从错误里
 * 捞出来的自动重连取消。
 */
export function registerErrorIpc(): void {
  handle(IPC.ERR_LIST, () => listErrors())
  handle(IPC.ERR_STATS, () => errorStats())
  handle(IPC.ERR_CLEAR, () => clearErrors())
  handle(IPC.ERR_DELETE, (id: string) => deleteError(id))

  handle(IPC.ERR_EXPORT, async () => {
    const text = await exportErrorsText()
    const res = await dialog.showSaveDialog(dialogParent() as BrowserWindow, {
      title: '导出错误日志',
      defaultPath: join(app.getPath('desktop'), `错误日志-${Date.now()}.txt`),
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    })
    if (res.canceled || !res.filePath) return { canceled: true as const }
    await fs.writeFile(res.filePath, text, 'utf-8')
    return { canceled: false as const, path: res.filePath, bytes: Buffer.byteLength(text) }
  })

  handle(IPC.ERR_REPORT, (input: { source: string; title: string; detail?: string }) =>
    recordError({
      level: 'error',
      // 渲染层上报统一加前缀，和主进程错误区分开
      source: `renderer:${input.source}`,
      title: input.title,
      detail: input.detail
    })
  )

  // 自动重连：用户主动关标签时取消，否则标签关了还会被"重连"拉回来
  handle(IPC.SESSION_RECONNECT_CANCEL, (sessionId: string) => {
    sessionManager.cancelReconnect(sessionId)
  })
}
