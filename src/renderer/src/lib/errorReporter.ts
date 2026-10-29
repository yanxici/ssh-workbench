/**
 * 渲染层错误上报。
 *
 * 主进程只能捕获 IPC 处理器里的异常；渲染层自己的异常（React 渲染抛错、
 * 未捕获 Promise、事件回调里的 throw）此前只会进 DevTools 控制台 ——
 * 打包后用户根本看不到，等于消失。
 *
 * 这里挂三个全局兜底，把它们送进主进程的错误日志，
 * 用户就能在「错误日志」面板里看到并导出。
 */

import { call } from './ipc'

let installed = false
/** 防止同一个异常在短时间里刷爆日志（主进程还会再做一次聚合，这里是第一道闸） */
const seen = new Map<string, number>()
const THROTTLE_MS = 10_000

function shouldReport(key: string): boolean {
  const now = Date.now()
  const last = seen.get(key)
  if (last !== undefined && now - last < THROTTLE_MS) return false
  seen.set(key, now)
  // 简单清理，避免 seen 无限增长
  if (seen.size > 200) {
    for (const [k, t] of seen) {
      if (now - t > THROTTLE_MS) seen.delete(k)
    }
  }
  return true
}

function report(source: string, title: string, detail?: string): void {
  if (!shouldReport(source + '|' + title + '|' + (detail ?? ''))) return
  // 上报本身失败也不能再抛，否则会形成错误风暴
  void call(window.api.errors.report({ source, title, detail }), { silent: true }).catch(
    () => undefined
  )
}

/** 安装全局错误捕获。重复调用是安全的（只装一次）。 */
export function installErrorReporter(): void {
  if (installed) return
  installed = true

  window.addEventListener('error', (event) => {
    // ErrorEvent.error 是 any（可以是任意抛出值，不一定是 Error）
    const err: unknown = event.error
    report(
      'window-error',
      event.message || '未捕获的脚本错误',
      err instanceof Error ? (err.stack ?? err.message) : String(event.message ?? '')
    )
  })

  window.addEventListener('unhandledrejection', (event) => {
    // 拒绝理由同样可以是任意值（reject('字符串') 很常见）
    const reason: unknown = event.reason
    report(
      'unhandled-rejection',
      '未处理的 Promise 异常',
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    )
  })
}

/** React 错误边界用：手动上报渲染期异常 */
export function reportRenderError(error: Error, componentStack?: string): void {
  report('react-render', '界面渲染出错', (error.stack ?? error.message) + (componentStack ?? ''))
}
