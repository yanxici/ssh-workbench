/**
 * 远端 home 的渲染进程级缓存。
 *
 * 背景：`sftpManager.home()` 在主进程里已经把 realpath 结果缓存下来了，但渲染层
 * 每个用到「主目录」的组件（侧栏文件面板、终端文件树、文件管理器）都会各自再发
 * 一次 `sftp:home` IPC。侧栏打开文件面板时是「先 await home、拿到后再 list」的
 * 两段串行，即使主进程命中缓存，第一个目录也要多等一个 IPC 来回才开始列。
 *
 * 这里把它提到渲染进程里：命中后可以同步拿到路径，立刻发起 list —— 少一跳。
 *
 * 失效时机：home 在一个 SSH 会话生命周期内不会变（realpath '.' 的结果），
 * 会话换了 sessionId 就天然隔离，所以只需要在显式断开时 forget。
 */
const cache = new Map<string, string>()

export function cachedHome(sessionId: string): string {
  return cache.get(sessionId) ?? ''
}

export function rememberHome(sessionId: string, home: string): void {
  if (home) cache.set(sessionId, home)
}

export function forgetHome(sessionId: string): void {
  cache.delete(sessionId)
}
