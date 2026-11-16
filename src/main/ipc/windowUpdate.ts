import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '@shared/ipc'
import type { TaskNotifyPayload } from '@shared/types'
import { handle } from './handle'
import { focusMainWindow, isMainWindowFocused, showTaskNotification } from '../window/notifier'
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
  // 这两条同样不走 handle：focus 的直接对调用方窗口生效；
  // isFocused 必须返回裸 boolean（不是 { ok, data }），否则渲染层每次都要解包
  ipcMain.handle(IPC.WIN_FOCUS, () => {
    focusMainWindow()
  })
  ipcMain.handle(IPC.WIN_IS_FOCUSED, () => isMainWindowFocused())

  /*
   * 弹系统通知。
   *
   * 走 handle 包装（失败要进错误日志）：通知失败虽然不影响任务本身，
   * 但"批处理跑完了没收到任何提示"是用户会来问的问题，错误日志里得留痕。
   */
  handle(IPC.NOTIFY_SHOW, (payload?: TaskNotifyPayload) =>
    showTaskNotification(payload ?? { title: '' })
  )

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
