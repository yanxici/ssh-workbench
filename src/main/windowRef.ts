import { BrowserWindow } from 'electron'

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
 * 弹系统对话框的父窗口：优先当前聚焦窗口，回退到主窗口。
 * 两者都可能为空（窗口还没建 / 已销毁），调用方按 Electron 的重载自己处理。
 */
export function dialogParent(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? getMainWindow() ?? undefined
}
