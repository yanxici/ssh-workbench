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
 * 剥离 Windows 扩展长度 / 设备路径前缀。
 *
 * 为什么必须做（Volt 实测的 P0）：`\\?\` 前缀会让整条位置黑名单失效。
 * `path.resolve('//?/C:/Windows/System32/config')` 返回的就是
 * `\\?\C:\Windows\System32\config` —— 前缀原样保留，与黑名单里的
 * `c:\windows\system32` 永远不相等，于是全部放行。
 * 攻击者只需给任意路径加四个字符就能绕过守卫：
 *   \\?\C:\Windows\System32\config      → 放行
 *   \\?\C:\Users\<me>                  → 放行（home 本身）
 *   \\?\GLOBALROOT\Device\...ShadowCopy → 放行（读阴影副本绕文件锁）
 * 配合 localDelete 的 recursive + force，`\\?\D:\projects` 一次删掉整棵树。
 *
 * @returns 剥离后的路径；遇到 GLOBALROOT 或非 C:\ 形态的设备路径时抛错
 */
function stripExtendedPrefix(raw: string, action: string): string {
  // \\?\ 与 //?/ 等价（前者是后者的规范化形式），统一用正则覆盖
  const isExtended = /^[\\/]{2}[?.][\\/]/.test(raw)
  if (!isExtended) return raw

  // GLOBALROOT 是通往设备命名空间的入口（阴影副本、物理磁盘），
  // 剥离后也没有合法的文件语义，直接拒绝。
  if (/^[\\/]{2}[?.][\\/]GLOBALROOT/i.test(raw)) {
    throw new Error(`${action}：拒绝设备路径 ${raw}`)
  }
  const stripped = raw.replace(/^[\\/]{2}[?.][\\/]/, '')
  // 剥离后必须是带盘符的绝对路径（\\?\C:\...）。\\.\PhysicalDrive0 这类
  // 剥离后是 PhysicalDrive0，没有盘符 —— 它不是文件系统路径，拒绝。
  if (!/^[a-zA-Z]:[\\/]/.test(stripped)) {
    throw new Error(`${action}：拒绝设备路径 ${raw}`)
  }
  return stripped
}

/**
 * 校验一个「删除 / 重命名目标」路径。
 * @throws 路径形状不合法或落在禁止位置时抛错（消息面向用户，可直接展示）
 */
export function assertSafeLocalPath(path: string, action: string): string {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error(`${action}：路径为空`)
  }
  let raw = path.trim()

  /*
   * UNC 网络路径（\\server\share）：浏览可以，破坏性操作拒绝。
   * 位置黑名单对网络路径没有意义 —— 黑名单里的都是本机系统目录，
   * 而 \\attacker\share\x 既不等于它们也不在其下，会一路放行。
   * 删除/重命名落到别人的共享目录上，风险与收益完全不对等，直接拒绝。
   */
  if (/^[\\/]{2}(?![?.][\\/])/.test(raw)) {
    throw new Error(`${action}：不支持对网络路径执行破坏性操作`)
  }

  // 必须在 normalize 之前剥前缀：normalize 会保留 \\?\ 前缀
  raw = stripExtendedPrefix(raw, action)

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

/**
 * 校验「新建」用的**文件名**（不是路径）。
 *
 * 为什么必须单独校验名字：`join(dir, name)` 会先把 `..` 折叠掉再交给
 * assertSafeLocalPath —— 那时 `..` 已经从字符串里消失了，路径级的守卫
 * 就看不见它。实测 `join('/home/u', '../../etc/evil')` → `\etc\evil`，
 * 看起来是个合法的绝对路径，位置校验也可能放行。
 * 所以名字的形状必须在 join **之前**验。
 */
export function assertSafeName(name: string, action: string): string {
  if (typeof name !== 'string') throw new Error(`${action}：名称无效`)
  const trimmed = name.trim()
  if (trimmed === '') throw new Error(`${action}：名称不能为空`)
  // 路径分隔符：新建文件夹/文件本来就不该接受，它意味着调用方在拼路径而不是给名字
  if (/[\\/]/.test(trimmed)) throw new Error(`${action}：名称不能包含路径分隔符`)
  // `..` / `.` 作为名字没有意义，且是穿越的原料
  if (trimmed === '.' || trimmed === '..') throw new Error(`${action}：名称无效`)
  // Windows 文件名保留字符（与资源管理器一致；跨平台也一并拒绝，避免同名文件在别的系统上出错）
  if (/[<>:"|?*]/.test(trimmed)) throw new Error(`${action}：名称包含非法字符 < > : " | ? *`)
  // Windows 保留设备名：即使在普通目录下也不该创建
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(trimmed)) {
    throw new Error(`${action}：${trimmed} 是系统保留名称`)
  }
  return trimmed
}

/**
 * 只校验形状、**不拦位置**的路径检查（供 localList 这类只读浏览用）。
 *
 * 为什么不能复用 assertSafeLocalPath：文件管理器必须能列 `C:\` 和 `/`，
 * 而 assertSafeLocalPath 明确拒绝盘符根。这里只拦「相对路径」与「带 .. 字面量」，
 * 位置合法性交给系统权限，不人为限制。
 */
export function assertBrowsableDir(dir: string): string {
  if (typeof dir !== 'string' || dir.trim() === '') throw new Error('浏览目录：路径为空')
  /*
   * 浏览也要剥设备前缀：`\\?\C:\Windows\System32` 与 `C:\Windows\System32`
   * 是同一个目录，不剥的话 localList 会把前者当成另一条路径绕过去。
   * 浏览不拦位置（文件管理器要能列盘符根），但设备路径不该出现在浏览里。
   */
  const raw = stripExtendedPrefix(dir.trim(), '浏览目录')
  if (!isAbsolute(raw)) throw new Error('浏览目录：只接受绝对路径')
  if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) throw new Error('浏览目录：路径包含 .. 穿越')
  return normalize(raw)
}
