import { BrowserWindow, dialog, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import { IPC } from '@shared/ipc'
import type { TunnelInput } from '@shared/types'
import { dialogParent } from '../windowRef'
import { handle } from './handle'
import { backupStore } from '../store/backups'
import { createBackup, diffBackup, restoreBackup } from '../ssh/configBackup'
import { deleteTunnel, listTunnels, saveTunnel } from '../store/repository'
import { tunnelManager } from '../ssh/portForward'
import { recorder } from '../ssh/recorder'
import { listSessionLogs, readSessionLog, removeSessionLog } from '../store/sessionLogs'

/** 配置备份对比 + 端口转发/隧道 + 会话日志（录制/回放） */
export function registerBackupTunnelIpc(): void {
  /* ---------------- 配置备份对比 ---------------- */
  handle(IPC.BACKUP_LIST, () => backupStore.list())
  handle(IPC.BACKUP_CREATE, (sessionId: string, name: string, paths: string[]) =>
    createBackup(sessionId, name, paths)
  )
  handle(IPC.BACKUP_DELETE, (id: string) => backupStore.remove(id))
  handle(IPC.BACKUP_DETAIL, (id: string) => backupStore.detail(id))
  handle(IPC.BACKUP_DIFF, (id: string, path: string, sessionId: string) =>
    diffBackup(id, path, sessionId)
  )
  handle(IPC.BACKUP_RESTORE, (id: string, sessionId: string, paths: string[]) =>
    restoreBackup(id, sessionId, paths)
  )
  handle(IPC.BACKUP_OPEN_DIR, () => backupStore.openDir())

  /* ---------------- 端口转发 / 隧道 ---------------- */
  handle(IPC.TUNNEL_LIST, () => listTunnels())
  handle(IPC.TUNNEL_SAVE, (input: TunnelInput) => saveTunnel(input))
  handle(IPC.TUNNEL_DELETE, (id: string) => deleteTunnel(id))
  handle(IPC.TUNNEL_START, (tunnelId: string, sessionId: string) =>
    tunnelManager.start(tunnelId, sessionId)
  )
  handle(IPC.TUNNEL_STOP, (tunnelId: string) => tunnelManager.stop(tunnelId))
  handle(IPC.TUNNEL_STATES, () => tunnelManager.states())

  /* ---------------- 会话日志（录制 / 回放） ---------------- */
  handle(IPC.LOG_LIST, () => listSessionLogs())
  handle(IPC.LOG_READ, (path: string) => readSessionLog(path))
  handle(IPC.LOG_DELETE, (path: string) => removeSessionLog(path))
  handle(IPC.LOG_OPEN_DIR, async () => {
    await shell.openPath(recorder.logDir())
  })
  handle(IPC.LOG_EXPORT, async (path: string) => {
    const res = await dialog.showSaveDialog(dialogParent() as BrowserWindow, {
      title: '导出会话日志',
      defaultPath: basename(path),
      filters: [
        { name: 'Asciinema Cast', extensions: ['cast'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (res.canceled || !res.filePath) return { canceled: true }
    await fs.copyFile(path, res.filePath)
    return { canceled: false, path: res.filePath }
  })
}
