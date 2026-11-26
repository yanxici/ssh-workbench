import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize, parse, resolve, sep } from 'node:path'
import { app } from 'electron'

/**
 * 渲染层传入的本地路径守卫。
 *
 * 为什么需要：`localDelete` / `localRename` 直接把渲染层传来的字符串喂给
 * `fs.rm(p, { recursive: true, force: true })`。渲染层一旦被 XSS 或恶意插件控制，
 * `local:delete` 就等价于任意路径的 rm -rf —— 主进程对参数零校验。
 * 同项目的 store/sessionLogs.ts 早就有 assertInside 白名单守卫，两套标准。
 *
 * **三条守卫按语义区分，不要混用**（混用造成的线上事故见 BUG_REVIEW_REPORT R-C1）：
 * - `assertSafeLocalPath`  破坏性（删除/重命名）：禁止根目录、homedir 本身、系统目录、UNC；
 * - `assertSafeWriteDir`   写入父目录（下载/保存落点）：允许 homedir、盘符根、UNC 共享，
 *   只拦系统核心目录与设备路径。下载落点不是破坏性操作，禁它等于「默认下载 100% 失败」；
 * - `assertSafeReadPath`   只读来源（上传/扫描/TFTP 固件）：规则同写入，另外拒绝应用凭据文件。
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

/**
 * 抹平 Windows 每段末尾的点与空格。
 *
 * Win32 的路径 API 会静默丢掉每段结尾的 `.` 和空格：
 * `C:\Windows\System32.`、`C:\Windows .\System32`、`C:\Users\me. ` 打开的
 * 都是真实目录，但字符串比较时它们与黑名单条目**不相等** —— 一个字符就能绕过。
 * 所以比较之前先按同样的规则归一化，让「黑名单看到的」与「系统真正操作的」是同一个路径。
 */
function stripTrailingDotsAndSpaces(abs: string): string {
  if (process.platform !== 'win32') return abs
  const root = parse(abs).root
  const rest = abs.slice(root.length)
  if (rest === '') return abs
  const segs = rest
    .split(/[\\/]+/)
    .filter((s) => s !== '')
    // 全是点/空格的段（"." ".." 已在调用方拦掉，这里剩的是 "..." "  " 之类）
    // 落成 _ 而不是空串：空串会被 join 折叠成父目录，反而让比较结果更宽松
    .map((s) => s.replace(/[. ]+$/, '') || '_')
  return root + segs.join('\\')
}

/** 剥掉 realpathSync.native 可能返回的 `\\?\` 长路径前缀（否则黑名单比较全部失效） */
function stripLongPrefix(real: string): string {
  if (!/^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(real)) return real.replace(/^[\\/]{2}[?.][\\/]/, '')
  return '\\\\' + real.replace(/^[\\/]{2}[?.][\\/]UNC[\\/]/i, '')
}

/**
 * 真实路径（解引用联接点 / 符号链接）。
 *
 * NTFS 联接点（junction）让 `D:\link` 指向 `C:\Windows\System32`：
 * 字面比较看不出危险，删的却是系统目录。
 *
 * 目标可能尚不存在（下载落点 / 「重命名到」的新路径 / 新建子目录），此时要沿
 * `dirname` **逐级向上**找最近的已存在祖先 —— 只向上追溯一层是不够的：
 * 目标是 `D:\junc\newsub\evil.dll` 且 `newsub` 不存在时，一层解析同样抛 ENOENT，
 * 旧实现直接返回 null 跳过校验，随后 `mkdir(recursive)` 就把文件写进
 * `C:\Windows\System32\newsub\`（BUG_REVIEW_REPORT R-H8）。
 *
 * @returns 真实路径；整条链都解析不出来时返回 null
 */
function realPathOf(abs: string): string | null {
  const tail: string[] = []
  let cur = abs
  for (let guard = 0; guard < 64; guard++) {
    try {
      const real = stripLongPrefix(realpathSync.native(cur))
      if (tail.length === 0) return real
      return join(real, ...tail.reverse())
    } catch {
      const parent = dirname(cur)
      // 走到根还不行：盘符/共享都不可达，交回 null 让调用方跳过按真实路径的二次判定
      if (parent === cur) return null
      tail.push(basename(cur))
      cur = parent
    }
  }
  return null
}

interface ForbiddenOptions {
  /** 允许 homedir 本身（写入父目录/只读来源需要，破坏性操作不需要） */
  allowHome: boolean
  /** 允许盘符根 / `/` 本身（但系统盘根始终拒绝，见 isSystemRoot） */
  allowRoot: boolean
}

/**
 * 系统盘根：Windows 上是 SystemRoot 所在的盘符根，POSIX 上是 `/`。
 *
 * 下载落点 / 保存目录只要不是用户手写，永远落不到这里；而一旦被写成
 * `C:\`，后续的 mkdir/覆盖就把文件散在了系统盘根目录。非系统盘根
 * （`D:\`、U 盘、UNC 共享）是正常用法，必须放行。
 */
function isSystemRoot(abs: string): boolean {
  const root = parse(abs).root
  if (process.platform !== 'win32') return root === '/'
  const sysRoot = resolve(process.env.SystemRoot ?? 'C:\\Windows')
  return root.toLowerCase() === parse(sysRoot).root.toLowerCase()
}

/** 明确拒绝的路径前缀（系统目录；按开关再叠加盘符根与用户主目录） */
function isForbiddenTarget(path: string, opts: ForbiddenOptions): boolean {
  const abs = stripTrailingDotsAndSpaces(resolve(path))
  const root = parse(abs).root

  /*
   * 盘符根 / `/` 本身：删除/改名在任何情况下都不是文件管理器该做的事；
   * 写入侧放宽到非系统盘根，但系统盘根仍拒（见 isSystemRoot）。
   */
  if (abs === root) return !opts.allowRoot || isSystemRoot(abs)

  // 用户主目录本身（不含其子目录）：误删整个 profile 的代价太大
  const home = resolve(homedir())
  if (abs.toLowerCase() === home.toLowerCase()) return !opts.allowHome

  // Windows 系统目录及其直接子级之外的关键位置
  if (process.platform === 'win32') {
    const sysRoot = resolve(process.env.SystemRoot ?? 'C:\\Windows')
    const low = abs.toLowerCase()
    const sysLow = sysRoot.toLowerCase()
    // Windows 目录本身、System32、SysWOW64、WinSxS 等直接子目录一律拒绝
    if (low === sysLow) return true
    for (const critical of ['system32', 'syswow64', 'winsxs']) {
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
  // 长路径形式的 UNC：\\?\UNC\nas\share\x 与 \\nas\share\x 是同一处
  if (/^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(raw)) {
    return '\\\\' + raw.replace(/^[\\/]{2}[?.][\\/]UNC[\\/]/i, '')
  }
  const stripped = raw.replace(/^[\\/]{2}[?.][\\/]/, '')
  // 剥离后必须是带盘符的绝对路径（\\?\C:\...）。\\.\PhysicalDrive0 这类
  // 剥离后是 PhysicalDrive0，没有盘符 —— 它不是文件系统路径，拒绝。
  if (!/^[a-zA-Z]:[\\/]/.test(stripped)) {
    throw new Error(`${action}：拒绝设备路径 ${raw}`)
  }
  return stripped
}

/** UNC 路径：\\.\ 设备路径也算（但不是 \\?\ 长路径），统一先剥前缀再判 */
function isUnc(raw: string): boolean {
  return /^[\\/]{2}(?![?.][\\/])/.test(raw) || /^[\\/]{2}[?.][\\/]UNC[\\/]/i.test(raw)
}

/** UNC 至少要到 \\server\share 一级：\\server 单独不是可写目录 */
function uncHasShare(raw: string): boolean {
  const segs = raw.split(/[\\/]+/).filter((s) => s !== '')
  // segs[0] 是 server，segs[1] 是 share（\\?\UNC\.. 已在剥前缀时归一）
  return segs.length >= 2
}

interface ShapeOptions {
  /** 允许 UNC 网络路径 */
  allowUnc: boolean
}

/**
 * 形状校验（不判危险位置）：剥设备前缀 → 拦 UNC → 必须绝对 → 拦 `..` → normalize。
 *
 * `..` 的检查必须在 normalize 之前：normalize 会把 `a/../b` 折叠成 `b`，
 * 看起来「合规」，但这类请求本身不该从 UI 发出，拦下来更容易发现调用方出了问题。
 */
function parseLocalPath(path: string, action: string, opts: ShapeOptions): string {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error(`${action}：路径为空`)
  }
  const trimmed = path.trim()

  /*
   * 网络路径：破坏性操作一律拒绝（黑名单对 \\attacker\share\x 毫无意义），
   * 但下载落点 / 上传来源必须是允许的 —— 局域网 NAS 是正常用法。
   */
  if (!opts.allowUnc && isUnc(trimmed)) {
    throw new Error(`${action}：不支持对网络路径执行破坏性操作`)
  }

  // 必须在 normalize 之前剥前缀：normalize 会保留 \\?\ 前缀
  const raw = stripExtendedPrefix(trimmed, action)

  if (opts.allowUnc && isUnc(raw) && !uncHasShare(raw)) {
    throw new Error(`${action}：网络路径必须包含共享名 ${raw}`)
  }

  // 必须是绝对路径：相对路径的含义取决于主进程 cwd，与用户看到的目录无关
  if (!isAbsolute(raw)) {
    throw new Error(`${action}：只接受绝对路径`)
  }

  if (/(^|[\\/])\.\.([\\/]|$)/.test(raw)) {
    throw new Error(`${action}：路径包含 .. 穿越`)
  }

  return normalize(raw)
}

/** 按真实路径再判一次：字面比较挡不住联接点/符号链接 */
function assertNotRedirected(abs: string, action: string, opts: ForbiddenOptions): void {
  const real = realPathOf(abs)
  if (real && real !== abs && isForbiddenTarget(real, opts)) {
    throw new Error(`${action}：拒绝操作系统关键位置 ${abs}`)
  }
}

/**
 * 校验一个「删除 / 重命名目标」路径。
 * @throws 路径形状不合法或落在禁止位置时抛错（消息面向用户，可直接展示）
 */
export function assertSafeLocalPath(path: string, action: string): string {
  const abs = parseLocalPath(path, action, { allowUnc: false })
  const opts: ForbiddenOptions = { allowHome: false, allowRoot: false }
  if (isForbiddenTarget(abs, opts)) {
    throw new Error(`${action}：拒绝操作系统关键位置 ${abs}`)
  }
  assertNotRedirected(abs, action, opts)
  return abs
}

/** 批量校验删除目标 */
export function assertSafeLocalPaths(paths: string[], action: string): string[] {
  if (!Array.isArray(paths)) throw new Error(`${action}：路径列表无效`)
  if (paths.length === 0) throw new Error(`${action}：没有选中任何文件`)
  return paths.map((p) => assertSafeLocalPath(p, action))
}

const WRITE_OPTS: ForbiddenOptions = { allowHome: true, allowRoot: true }

/**
 * 校验「写入父目录」（下载落点 / 保存目录）。
 *
 * 允许 homedir、非系统盘根目录（`D:\`）、U 盘根与 UNC 共享 —— 默认下载目录就是
 * homedir，禁掉它等于开箱即坏。仍然拦系统核心目录、设备路径与 `..` 穿越。
 */
export function assertSafeWriteDir(path: string, action: string): string {
  const abs = parseLocalPath(path, action, { allowUnc: true })
  if (isForbiddenTarget(abs, WRITE_OPTS)) {
    throw new Error(`${action}：拒绝操作系统关键位置 ${abs}`)
  }
  assertNotRedirected(abs, action, WRITE_OPTS)
  return abs
}

/** 应用凭据文件（safeStorage 密文）：任何「来源路径」都不该允许读取它 */
function isAppCredentialFile(abs: string): boolean {
  let root: string
  try {
    root = app.getPath('userData')
  } catch {
    // 非 Electron 环境（纯 Node 验证脚本）没有 app，跳过这一项
    return false
  }
  /*
   * 两侧都要归一化再比：候选路径可以写成 `secrets.json.` / `secrets.json `
   * （Win32 API 会静默丢掉尾随点与空格），也可以是指向它的符号链接/联接点。
   * 只比字面串时，这两种写法都能把密文当普通文件读走。
   */
  const secrets = stripTrailingDotsAndSpaces(resolve(root, 'data', 'secrets.json'))
  const secretsReal = realPathOf(secrets)
  const candidate = stripTrailingDotsAndSpaces(resolve(abs))
  if (candidate.toLowerCase() === secrets.toLowerCase()) return true
  const real = realPathOf(candidate)
  if (!real) return false
  const lowReal = stripTrailingDotsAndSpaces(real).toLowerCase()
  return lowReal === secrets.toLowerCase() || (secretsReal !== null && lowReal === secretsReal.toLowerCase())
}

/**
 * 校验「只读来源路径」（上传文件、扫描目录、TFTP 固件）。
 *
 * 规则与 assertSafeWriteDir 相同（允许 homedir / 盘符根 / UNC），另外拒绝把应用
 * 凭据文件当作上传来源，避免 `SFTP_UPLOAD` 把 secrets.json 推到远端。
 */
export function assertSafeReadPath(path: string, action: string): string {
  const abs = parseLocalPath(path, action, { allowUnc: true })
  if (isForbiddenTarget(abs, WRITE_OPTS)) {
    throw new Error(`${action}：拒绝操作系统关键位置 ${abs}`)
  }
  /*
   * 字面路径与真实路径各查一次：`~/x/secrets.json` 直接读走是一路，
   * `~/link-to-secrets` 这种软链/联接点是另一路，只查 abs 会漏第二种。
   */
  const real = realPathOf(abs)
  if (isAppCredentialFile(abs) || (real !== null && isAppCredentialFile(real))) {
    throw new Error(`${action}：拒绝读取应用凭据文件`)
  }
  assertNotRedirected(abs, action, WRITE_OPTS)
  return abs
}

/** 批量校验只读来源 */
export function assertSafeReadPaths(paths: string[], action: string): string[] {
  if (!Array.isArray(paths)) throw new Error(`${action}：路径列表无效`)
  return paths.map((p) => assertSafeReadPath(p, action))
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
