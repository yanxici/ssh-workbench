import { app, shell } from 'electron'
import { existsSync, readdirSync, realpathSync, type Dirent } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 应用固定的 Windows AppUserModelID（与 electron-builder.yml 的 appId 保持一致）。
 */
export const APP_USER_MODEL_ID = 'com.sshworkbench.app'

/** 只检查名称与本应用相关的开始菜单快捷方式，避免启动时遍历整机几百个无关 .lnk */
const SHORTCUT_NAME_RE = /(?:ssh|workbench)/i
const MAX_SCAN_DEPTH = 2

export interface ShortcutLinkInfo {
  target?: string
  icon?: string
  appUserModelId?: string
}

export interface ResolveAumidOptions {
  platform?: NodeJS.Platform
  isPackaged?: boolean
  execPath?: string
  appId?: string
  startMenuDirs?: string[]
  readShortcutLink?: (shortcutPath: string) => ShortcutLinkInfo
  exists?: (targetPath: string) => boolean
  canonicalize?: (targetPath: string) => string
}

let appliedAppUserModelId: string | null = null

function defaultStartMenuDirs(): string[] {
  const dirs: string[] = []
  if (process.env.APPDATA) {
    dirs.push(join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  }
  if (process.env.ProgramData) {
    dirs.push(join(process.env.ProgramData, 'Microsoft', 'Windows', 'Start Menu', 'Programs'))
  }
  return dirs
}

function defaultCanonicalize(targetPath: string): string {
  try {
    return realpathSync.native(targetPath).toLowerCase()
  } catch {
    return resolve(targetPath).toLowerCase()
  }
}

function expandWinEnv(rawPath: string): string {
  return rawPath.replace(/%([^%]+)%/g, (full, key: string) => process.env[key] ?? full)
}

function collectCandidateShortcuts(rootDir: string, depth = 0, out: string[] = []): string[] {
  if (depth > MAX_SCAN_DEPTH) return out
  let entries: Dirent[]
  try {
    entries = readdirSync(rootDir, { withFileTypes: true })
  } catch {
    // 目录不存在或无权读取时静默跳过，启动链路不因开始菜单权限问题受阻
    return out
  }
  for (const entry of entries) {
    const full = join(rootDir, entry.name)
    if (entry.isDirectory()) {
      collectCandidateShortcuts(full, depth + 1, out)
      continue
    }
    if (!entry.isFile()) continue
    const lower = entry.name.toLowerCase()
    if (!lower.endsWith('.lnk')) continue
    if (SHORTCUT_NAME_RE.test(entry.name)) out.push(full)
  }
  return out
}

/**
 * 决定 Windows 进程是否应绑定显式 AppUserModelID。
 *
 * 根因说明（解压版 / 便携版任务栏白图标）：
 *   Windows 10/11 上，一旦进程调用 `app.setAppUserModelId('com.sshworkbench.app')`，
 *   任务栏按钮不再读取窗口的 `WM_GETICON` 或 exe PE 资源中的图标，而是按
 *   「AUMID -> 开始菜单 .lnk -> 该快捷方式的图标」解析。
 *
 *   - NSIS 安装版会写入 `%APPDATA%/.../Start Menu/Programs/SSH Workbench.lnk`
 *     （带 `System.AppUserModel.ID = com.sshworkbench.app` 且目标指向当前安装的 exe），
 *     因此安装版绑定固定 AUMID 后，任务栏分组、固定与操作中心通知均可正常工作。
 *   - 解压版 zip（win-unpacked）与便携版不经安装器，开始菜单里不存在对应 .lnk
 *     （或残留的旧 .lnk 指向已删除的 `dist-v*` / 另一份安装目录）。此时若无条件绑定
 *     `com.sshworkbench.app`，任务栏查不到有效快捷方式就会退化成白色折角空白文档图标。
 *
 * 策略：
 *   - 非 Windows：返回 null（不调用）。
 *   - Windows 开发模式（!isPackaged）：沿用 `@electron-toolkit/utils` 行为，返回 execPath，
 *     保持开发期与 `verify-notify-e2e.cjs` 行为不变。
 *   - Windows 打包版：仅当开始菜单中存在带相同 AUMID、指向当前 execPath 且图标源有效的
 *     `.lnk` 时才返回 `APP_USER_MODEL_ID`；否则返回 null，让 Windows 直接使用当前 exe 的
 *     多尺寸内嵌图标与窗口 `WM_GETICON`。
 */
export function resolveWindowsAppUserModelId(options: ResolveAumidOptions = {}): string | null {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return null

  const isPackaged = options.isPackaged ?? app.isPackaged
  const execPath = options.execPath ?? process.execPath
  if (!isPackaged) return execPath

  const appId = options.appId ?? APP_USER_MODEL_ID
  const dirs = options.startMenuDirs ?? defaultStartMenuDirs()
  const readLink = options.readShortcutLink ?? ((p: string) => shell.readShortcutLink(p))
  const exists = options.exists ?? existsSync
  const canonicalize = options.canonicalize ?? defaultCanonicalize

  const currentExe = canonicalize(execPath)

  for (const dir of dirs) {
    if (!dir) continue
    const shortcuts = collectCandidateShortcuts(dir)
    for (const lnkPath of shortcuts) {
      let info: ShortcutLinkInfo
      try {
        info = readLink(lnkPath)
      } catch {
        // 坏 .lnk 不影响继续探测其他候选项
        continue
      }
      if (info.appUserModelId !== appId) continue
      const target = (info.target ?? '').trim()
      if (!target || !exists(target)) continue
      if (canonicalize(target) !== currentExe) continue

      const icon = (info.icon ?? '').trim()
      if (icon) {
        const expandedIcon = expandWinEnv(icon)
        if (!exists(expandedIcon)) continue
      }
      return appId
    }
  }

  return null
}

/**
 * 在主进程 `app.whenReady()` 早期（创建窗口之前）调用。
 * 返回最终生效的 AUMID；返回 null 表示刻意跳过绑定，走 exe/窗口原生图标链路。
 */
export function configureWindowsAppUserModelId(appId = APP_USER_MODEL_ID): string | null {
  const resolved = resolveWindowsAppUserModelId({ appId })
  appliedAppUserModelId = resolved
  if (resolved) {
    app.setAppUserModelId(resolved)
  }
  return resolved
}

/** 最近一次启动决策实际应用的 AUMID（供冒烟探针与诊断记录） */
export function getAppliedAppUserModelId(): string | null {
  return appliedAppUserModelId
}
