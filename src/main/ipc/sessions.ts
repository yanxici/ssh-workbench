import { BrowserWindow, dialog } from 'electron'
import { promises as fs } from 'node:fs'
import { IPC } from '@shared/ipc'
import { dialogParent } from '../windowRef'
import { dialogDefaultPath, rememberDialogPick } from '../util/dialogDirs'
import { handle } from './handle'
import { sessionManager } from '../ssh/sessionManager'

/** 会话 / 终端：开连接、开会话内新终端、输入、尺寸、广播、列表 */
export function registerSessionIpc(): void {
  handle(
    IPC.SESSION_OPEN,
    (input: { sessionId: string; connectionId: string; cols: number; rows: number }) =>
      sessionManager.open(input.sessionId, input.connectionId, input.cols, input.rows)
  )
  handle(
    IPC.SESSION_OPEN_SHELL,
    (input: {
      sessionId: string
      connectionId: string
      hostSessionId: string
      cols: number
      rows: number
    }) =>
      sessionManager.openShell(
        input.sessionId,
        input.connectionId,
        input.hostSessionId,
        input.cols,
        input.rows
      )
  )
  handle(IPC.SESSION_CLOSE, (sessionId: string) => sessionManager.close(sessionId))
  handle(IPC.SESSION_WRITE, (sessionId: string, data: string) =>
    sessionManager.write(sessionId, data)
  )
  handle(IPC.SESSION_RESIZE, (sessionId: string, cols: number, rows: number) =>
    sessionManager.resize(sessionId, cols, rows)
  )
  handle(IPC.SESSION_BROADCAST, (sessionIds: string[], data: string) =>
    sessionManager.broadcast(sessionIds, data)
  )
  handle(IPC.SESSION_SET_BAUD, (sessionId: string, baudRate: number) =>
    sessionManager.setSerialBaudRate(sessionId, baudRate)
  )
  handle(IPC.SESSION_BREAK, (sessionId: string, durationMs?: number) =>
    sessionManager.sendSerialBreak(sessionId, durationMs)
  )
  handle(
    IPC.SESSION_EXPORT_BUFFER,
    async (input: { suggestedName: string; content: string }) => {
      const safeName =
        Array.from(input.suggestedName, (ch) => (ch.charCodeAt(0) < 32 ? '_' : ch))
          .join('')
          .replace(/[<>:"/\\|?*]/g, '_')
          .trim() || 'terminal-output'
      const defaultName = safeName.endsWith('.txt') ? safeName : `${safeName}.txt`
      const res = await dialog.showSaveDialog(dialogParent() as BrowserWindow, {
        title: '导出终端输出',
        defaultPath: dialogDefaultPath('file', defaultName),
        filters: [{ name: '文本文件', extensions: ['txt'] }]
      })
      if (res.canceled || !res.filePath) return { canceled: true as const }
      rememberDialogPick('file', res.filePath, false)
      await fs.writeFile(res.filePath, input.content, 'utf-8')
      return {
        canceled: false as const,
        path: res.filePath,
        bytes: Buffer.byteLength(input.content, 'utf-8')
      }
    }
  )
  handle(IPC.SESSION_LIST, () => sessionManager.list())
}
