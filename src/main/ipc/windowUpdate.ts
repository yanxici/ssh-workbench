import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import { handle } from './handle'
import {
  checkForUpdates,
  dismiss as dismissUpdate,
  downloadUpdate,
  getUpdateStatus,
  openReleasePage,
  quitAndInstall as quitAndInstallUpdate
} from '../updater'

/** 窗口控制（无边框自绘标题栏）+ 应用内更新 */
export function registerWindowUpdateIpc(): void {
  /*
   * 这三个不走 handle 包装：它们直接操作调用方窗口，不需要 { ok, data } 结果，
   * 也永远不会失败到需要写错误日志。
   */
  ipcMain.handle(IPC.WIN_MINIMIZE, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.handle(IPC.WIN_TOGGLE_MAX, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle(IPC.WIN_CLOSE, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })

  handle(IPC.UPDATE_STATE, () => getUpdateStatus())
  handle(IPC.UPDATE_CHECK, (force?: boolean) => checkForUpdates(force === true))
  handle(IPC.UPDATE_DOWNLOAD, () => downloadUpdate())
  handle(IPC.UPDATE_INSTALL, (options?: { later?: boolean }) => {
    // later=true 表示「稍后」：本会话内收起提示，不安装
    if (options?.later) return dismissUpdate()
    quitAndInstallUpdate()
    return getUpdateStatus()
  })
  handle(IPC.UPDATE_OPEN_RELEASE, async () => {
    await openReleasePage()
  })
}
