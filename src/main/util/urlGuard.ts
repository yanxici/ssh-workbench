/**
 * 外部链接白名单。
 *
 * shell.openExternal 把 URL 原样交给系统：Windows 上是 ShellExecuteEx，
 * 所以 `file:`、`ms-msdt:`、`\\attacker\share\x.exe` 这类字符串
 * 都等于「启动一个程序」。链接来自渲染层与终端输出，属于不可信输入，
 * 统一在这里过一道协议白名单，只放行浏览器语义的 http/https。
 */
export function isWebUrl(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.trim() === '') return false
  try {
    const { protocol } = new URL(raw)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}
