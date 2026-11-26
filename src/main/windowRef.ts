import { BrowserWindow, dialog } from 'electron'
import type { OpenDialogOptions, OpenDialogReturnValue, SaveDialogOptions, SaveDialogReturnValue } from 'electron'

/**
 * 主窗口引用。
 *
 * 拆出来的理由：绝大多数 IPC 域在弹系统对话框时都需要一个父窗口
 * （`BrowserWindow.getFocusedWindow() ?? mainWindow`）。如果这个变量留在
 * index.ts 里，所有 ipc/*.ts 都要反过来 import 入口文件，形成循环依赖。
 *
 * 只暴露读写两个口子，避免各处直接赋值造成多份真相。
 */
let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}

/**
 * 主进程 → 渲染进程的单向事件。
 *
 * 只判窗口是否销毁是不够的：窗口关闭过程中 window 还活着、webContents 已经
 * 先一步销毁，此时 send 会抛「Object has been destroyed」，而这个异常出现在
 * 各种事件回调里（传输进度、日志尾随），一抛就把调用栈上的业务逻辑一起带走。
 * 所有 EVT_* 广播统一走这里，调用方不用各自判空。
 */
export function sendToMainWindow(channel: string, payload?: unknown): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  if (!wc || wc.isDestroyed()) return
  try {
    if (payload === undefined) wc.send(channel)
    else wc.send(channel, payload)
  } catch {
    // 窗口正在拆，事件丢了就丢了 —— 接收方重连时会自己拉一次全量状态
  }
}

/**
 * 弹系统对话框的父窗口：优先当前聚焦窗口，回退到主窗口。
 * 两者都可能为空（窗口还没建 / 已销毁），调用方按 Electron 的重载自己处理。
 */
export function dialogParent(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? getMainWindow() ?? undefined
}

/*
 * 系统对话框的**安全调用口**。
 *
 * 直接写 `dialog.showOpenDialog(dialogParent() as BrowserWindow, opts)` 会在窗口
 * 失焦/尚未创建时抛 `TypeError: Error processing argument at index 0`
 * —— dialogParent() 允许返回 undefined，而 Electron 的单参重载只接受 opts。
 * 7 处调用点原本全都强转，等于把这个空值路径变成了「对话框随机崩」。
 * 这里按有无父窗口选重载，调用方从此不用关心。
 */
export function showOpenDialog(opts: OpenDialogOptions): Promise<OpenDialogReturnValue> {
  const win = dialogParent()
  return win ? dialog.showOpenDialog(win, opts) : dialog.showOpenDialog(opts)
}

export function showSaveDialog(opts: SaveDialogOptions): Promise<SaveDialogReturnValue> {
  const win = dialogParent()
  return win ? dialog.showSaveDialog(win, opts) : dialog.showSaveDialog(opts)
}
