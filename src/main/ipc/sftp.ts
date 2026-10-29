import { app, BrowserWindow, dialog } from 'electron'
import { mkdirSync } from 'node:fs'
import { IPC } from '@shared/ipc'
import { dialogParent } from '../windowRef'
import { handle } from './handle'
import { sftpManager } from '../ssh/sftpManager'

/**
 * SFTP 文件管理：目录浏览、增删改、远程编辑、上传下载与传输控制。
 *
 * 所有「选文件的系统对话框」都在这里：目标目录解析统一退化为远端 home，
 * 绝不静默落到根目录 `/`（历史上这么干过，用户文件会跑到根下）。
 */
export function registerSftpIpc(): void {
  handle(IPC.SFTP_LIST, (sessionId: string, path: string) => sftpManager.list(sessionId, path))
  handle(IPC.SFTP_LIST_MANY, (sessionId: string, dirs: string[]) =>
    sftpManager.listMany(sessionId, dirs)
  )
  handle(IPC.SFTP_BOOTSTRAP, (sessionId: string) => sftpManager.bootstrap(sessionId))
  handle(IPC.SFTP_HOME, (sessionId: string) => sftpManager.home(sessionId))
  handle(IPC.SFTP_MKDIR, (sessionId: string, path: string) => sftpManager.mkdir(sessionId, path))
  handle(IPC.SFTP_DELETE, (sessionId: string, path: string) => sftpManager.remove(sessionId, path))
  handle(IPC.SFTP_RENAME, (sessionId: string, from: string, to: string) =>
    sftpManager.rename(sessionId, from, to)
  )
  handle(IPC.SFTP_CHMOD, (sessionId: string, path: string, mode: number) =>
    sftpManager.chmod(sessionId, path, mode)
  )
  handle(IPC.SFTP_READ, (sessionId: string, path: string) => sftpManager.readText(sessionId, path))
  handle(IPC.SFTP_WRITE, (sessionId: string, path: string, content: string) =>
    sftpManager.writeText(sessionId, path, content)
  )

  handle(
    IPC.SFTP_UPLOAD,
    async (
      sessionId: string,
      localPaths: string[],
      remoteDir: string,
      options?: { keepRoot?: boolean }
    ) => {
      // 兜底：渲染层传空/空白目录时不再落到远端根 '/'，改用 home
      const target = remoteDir?.trim() || (await sftpManager.home(sessionId))
      return sftpManager.upload(sessionId, localPaths, target, options)
    }
  )

  handle(IPC.SFTP_DOWNLOAD, (sessionId: string, remotePaths: string[], localDir: string) =>
    sftpManager.download(sessionId, remotePaths, localDir)
  )

  handle(IPC.SFTP_TRANSFER_PAUSE, (taskId: string) => sftpManager.pauseTransfer(taskId))
  handle(IPC.SFTP_TRANSFER_RESUME, (taskId: string) => sftpManager.resumeTransfer(taskId))
  handle(IPC.SFTP_TRANSFER_CANCEL, (taskId: string) => sftpManager.cancelTransfer(taskId))

  // 通过系统对话框选择文件（文件树面板的单点上传）
  handle(IPC.SFTP_UPLOAD_DIALOG, async (sessionId: string, remoteDir: string) => {
    const target = remoteDir?.trim() || (await sftpManager.home(sessionId))
    const res = await dialog.showOpenDialog(dialogParent() as BrowserWindow, {
      title: `选择要上传到 ${target} 的文件`,
      buttonLabel: '上传',
      properties: ['openFile', 'multiSelections']
    })
    if (res.canceled || res.filePaths.length === 0) return { canceled: true, count: 0 }
    const ids = sftpManager.upload(sessionId, res.filePaths, target)
    return { canceled: false, count: ids.length }
  })

  // 上传文件夹：系统对话框只让选目录，落点是「远端目标目录/本地目录名」
  handle(
    IPC.SFTP_UPLOAD_FOLDER_DIALOG,
    async (sessionId: string, remoteDir: string, keepRoot?: boolean) => {
      const target = remoteDir?.trim() || (await sftpManager.home(sessionId))
      const res = await dialog.showOpenDialog(dialogParent() as BrowserWindow, {
        title: `选择要上传到 ${target} 的文件夹（可多选）`,
        buttonLabel: '上传',
        properties: ['openDirectory', 'multiSelections']
      })
      if (res.canceled || res.filePaths.length === 0) return { canceled: true, count: 0 }
      const ids = sftpManager.upload(sessionId, res.filePaths, target, {
        // 默认保留目录名，用户明确选的是「文件夹」而不是「文件夹里的东西」
        keepRoot: keepRoot !== false
      })
      return { canceled: false, count: ids.length }
    }
  )

  // 扫描待上传目录（选择文件夹后先给出文件数/体积预览，再决定是否上传）
  handle(IPC.SFTP_SCAN_FOLDERS, (localPaths: string[]) => sftpManager.scanFolders(localPaths))

  handle(IPC.SFTP_DOWNLOAD_DIALOG, async (sessionId: string, remotePaths: string[]) => {
    const res = await dialog.showOpenDialog(dialogParent() as BrowserWindow, {
      title: '选择保存目录',
      buttonLabel: '下载到此处',
      defaultPath: app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return { canceled: true, count: 0 }
    const ids = sftpManager.download(sessionId, remotePaths, res.filePaths[0])
    return { canceled: false, count: ids.length }
  })

  // 一键下载的落点：本机「下载」文件夹。系统可能没有该目录（精简版 Windows），
  // 这里按需建出来，免得后续每个文件都写失败。
  handle(IPC.SFTP_DOWNLOADS_DIR, () => {
    const dir = app.getPath('downloads')
    mkdirSync(dir, { recursive: true })
    return dir
  })
}
