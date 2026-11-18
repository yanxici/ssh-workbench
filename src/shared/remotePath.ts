/**
 * 远端（POSIX）路径与名字的校验。
 *
 * 为什么不复用 store/pathGuard 的 assertSafeName：那套是照 Windows 资源管理器
 * 写的，会拒掉 `:` `?` `*` —— 而这几个字符在 Linux 上完全合法
 * （`access_2024-01-01.log:1` 这种文件名在服务器上到处都是）。
 * 反过来，远端真正要防的只有三件事：路径分隔符（意味着调用方在拼路径）、
 * `.` / `..`（穿越）、控制字符（会把终端和日志搞乱）。
 *
 * 放在 shared：渲染层要在弹框前给即时反馈，主进程要兜住所有 IPC 入口 ——
 * 两边用同一套规则，界面说可以的名字后端就不会拒。
 */

/**
 * 是否含控制字符（含 \0，SFTP 会把它截断成另一条路径）。
 * 不用正则 [\x00-\x1f]：eslint 的 no-control-regex 会拦，且这种逐字符
 * 判断本来就比正则更清楚它到底在查什么。
 */
function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    if (c < 0x20 || c === 0x7f) return true
  }
  return false
}

/** 校验「一个名字」（不是一条路径）：新建目录、重命名的目标名 */
export function assertSafeRemoteName(name: string, action: string): string {
  if (typeof name !== 'string') throw new Error(`${action}：名称无效`)
  const trimmed = name.trim()
  if (trimmed === '') throw new Error(`${action}：名称不能为空`)
  if (trimmed === '.' || trimmed === '..') throw new Error(`${action}：名称无效`)
  // 分隔符：意味着调用方想写一条路径，而不是一个名字
  if (trimmed.includes('/')) throw new Error(`${action}：名称不能包含 /`)
  if (hasControlChar(trimmed)) throw new Error(`${action}：名称包含不可见控制字符`)
  return trimmed
}

/**
 * 校验「一条远端绝对路径」。
 *
 * 用于所有从渲染层直接传进来的操作路径（删除、读取、写入）。
 * 不要求落在 home 里 —— 运维经常要动 /etc、/opt；
 * 但必须绝对、必须不含 `..`（含了就不是用户看得见的那条路径）。
 */
export function assertRemotePath(path: string, action: string): string {
  if (typeof path !== 'string') throw new Error(`${action}：路径无效`)
  const trimmed = path.trim()
  if (trimmed === '') throw new Error(`${action}：路径不能为空`)
  if (!trimmed.startsWith('/')) throw new Error(`${action}：只接受绝对路径`)
  if (hasControlChar(trimmed)) throw new Error(`${action}：路径包含不可见控制字符`)
  // 逐段检查 `..`：`/a/../b` 在 SFTP 服务端由内核折叠，等于 /b，
  // 而界面上显示的是整条字符串，用户看不出实际动的是哪
  if (trimmed.split('/').includes('..')) throw new Error(`${action}：路径包含 .. 穿越`)
  return trimmed
}
