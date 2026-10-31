import { homedir } from 'node:os'
import { isAbsolute, normalize, parse, resolve, sep } from 'node:path'

/**
 * 渲染层传入的本地路径守卫。
 *
 * 为什么需要：`localDelete` / `localRename` 直接把渲染层传来的字符串喂给
 * `fs.rm(p, { recursive: true, force: true })`。渲染层一旦被 XSS 或恶意插件控制，
 * `local:delete` 就等价于任意路径的 rm -rf —— 主进程对参数零校验。
 * 同项目的 store/sessionLogs.ts 早就有 assertInside 白名单守卫，两套标准。
 *
 * 守卫能做什么、不能做什么：
 * - 能拦住「明显不该由 UI 发起的路径」：带 `..` 的穿越、系统关键目录、
 *   盘符根/用户主目录本身。这类请求在正常使用里永远不会出现，
 *   出现就说明调用方被污染或代码写错了。
 * - **不能**替代「用户确实想删这个文件」的判断：用户在文件管理器里选中
 *   D:\projects\foo 并确认删除是合法操作，守卫必须放行。
 *   所以这里做的是「形状校验 + 危险位置黑名单」，不是白名单沙箱。
 *
 * 不引入白名单的原因：这个文件管理器是通用的 —— 用户可以浏览任意盘符、
 * 任意目录。维护「允许的目录列表」既不现实也会立刻过期。
 * 真正的护栏是「渲染层无法伪造用户意图」+「危险路径硬拒绝」这两层。
 */

/** 明确拒绝的路径前缀（系统目录、盘符根、用户主目录本身） */
function isForbiddenTarget(path: string): boolean {
  const abs = resolve(path)
  const root = parse(abs).root

  // 盘符根 / `/` 本身：删根目录在任何情况下都不是文件管理器该做的事
  if (abs === root) return true

  // 用户主目录本身（不含其子目录）：误删整个 profile 的代价太大
  const home = resolve(homedir())
  if (abs.toLowerCase() === home.toLowerCase()) return true

  // Windows 系统目录及其直接子级之外的关键位置
  if (process.platform === 'win32') {
    const sysRoot = resolve(process.env.SystemRoot ?? 'C:\\Windows')
    const low = abs.toLowerCase()
    const sysLow = sysRoot.toLowerCase()
    // Windows 目录本身、System32、SysWOW64、WinSxS 等直接子目录一律拒绝
    if (low === sysLow) return true
    for (const critical of ['system32', 'syswow64', 'winsxs', 'windows\\system32']) {
      if (low === `${sysLow}\\${critical}` || low.startsWith(`${sysLow}\\${critical}\\`)) return true
    }
    // 驱动器根下的 Program Files 本身
    for (const pf of ['program files', 'program files (x86)']) {
      if (low === `${sysLow.slice(0, 2)}\\${pf}`) return true
    }
  } else {
    for (const critical of ['/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/proc', '/sys']) {
      if (abs === critical || abs.startsWith(critical + sep)) return true
    }
  }
  return false
}

/**
 * 校验一个「删除 / 重命名目标」路径。
 * @throws 路径形状不合法或落在禁止位置时抛错（消息面向用户，可直接展示）
 */
export function assertSafeLocalPath(path: string, action: string): string {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error(`${action}：路径为空`)
  }
  const raw = path.trim()

  // 必须是绝对路径：相对路径的含义取决于主进程 cwd，与用户看到的目录无关
  if (!isAbsolute(raw)) {
    throw new Error(`${action}：只接受绝对路径`)
  }

  // 穿越检查要在 normalize 之前做 —— normalize 会把 `a/../b` 折叠成 `b`，
  // 看起来「合规」，但这类请求本身不该从 UI 发出，拦下来更容易发现调用方出了问题。
  if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) {
    throw new Error(`${action}：路径包含 .. 穿越`)
  }

  const abs = normalize(raw)

  // 结尾分隔符（`D:\foo\`）意味着「目录」；不影响合法性，但归一化时保留语义
  if (isForbiddenTarget(abs)) {
    throw new Error(`${action}：拒绝操作系统关键位置 ${abs}`)
  }
  return abs
}

/** 批量校验删除目标 */
export function assertSafeLocalPaths(paths: string[], action: string): string[] {
  if (!Array.isArray(paths)) throw new Error(`${action}：路径列表无效`)
  if (paths.length === 0) throw new Error(`${action}：没有选中任何文件`)
  return paths.map((p) => assertSafeLocalPath(p, action))
}
