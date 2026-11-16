/**
 * 系统对话框的默认目录记忆。
 *
 * 为什么需要这一层（Electron 43 行为变更）：
 *   43 起 `dialog.showOpenDialog` / `showSaveDialog` 在未显式给 `defaultPath` 时
 *   默认落到「下载」文件夹，且操作系统不再帮我们记住上次浏览的目录。
 *   对本项目影响很直接：上传固件、导入连接、导出报告这些动作，用户几乎总是
 *   在同一个工作目录里反复操作（现场笔记本上就是那个「固件」文件夹）。
 *   退化成每次都从「下载」开始，等于每次多点两三次。
 *
 * 取舍：
 *   - 只在内存里记忆，不落盘。理由：这是纯会话期的便利，不是用户数据；
 *     写进 settings.json 会给设置 schema 加字段、要处理迁移与校验，
 *     收益却只是「重启后还记得上次目录」—— 不值。
 *   - 记忆按「类别」分开，不共用一条：导出报告到桌面、上传固件从 U 盘，
 *     共用会让每次都要重新导航。
 *   - 目录不存在时（U 盘拔了 / 网络盘掉线）退回下载目录，绝不把失效路径
 *     塞给对话框 —— 那是 Windows 上「对话框卡 5 秒才弹出来」的经典原因。
 */
import { existsSync, statSync } from 'node:fs'
import { dirname, join, isAbsolute } from 'node:path'
import { app } from 'electron'

/** 记忆类别：按「用户在干什么」分，而不是按对话框 API 分 */
export type DialogDirKind = 'file' | 'folder' | 'firmware' | 'report' | 'backup'

const memory = new Map<DialogDirKind, string>()

/** 下载目录兜底。可能存在不存在的平台（精简版 Windows），此时退 userData 的上一级 */
function fallbackDir(): string {
  try {
    const dl = app.getPath('downloads')
    if (dl) return dl
  } catch {
    /* 拿不到就用 home */
  }
  try {
    return app.getPath('home')
  } catch {
    return process.cwd()
  }
}

function usableDir(p: string | undefined): string | undefined {
  if (!p) return undefined
  if (!isAbsolute(p)) return undefined
  try {
    if (!existsSync(p)) return undefined
    if (!statSync(p).isDirectory()) return undefined
    return p
  } catch {
    return undefined
  }
}

/** 记住「已存在的目录」为某类别的起点 */
export function rememberDialogDir(kind: DialogDirKind, dir: string | undefined): void {
  const ok = usableDir(dir)
  if (ok) memory.set(kind, ok)
}

/**
 * 从选中的条目反推目录并记住。
 * `pickedIsDir` 为 true（选的是文件夹）时直接记该路径本身。
 */
export function rememberDialogPick(
  kind: DialogDirKind,
  picked: string | undefined,
  pickedIsDir: boolean
): void {
  if (!picked) return
  rememberDialogDir(kind, pickedIsDir ? picked : dirname(picked))
}

/**
 * 算对话框的 `defaultPath`。
 *
 * - 传 `fileName` 时拼成「记忆目录/文件名」，用于保存对话框；
 * - 没记忆或记忆目录已失效时退回未指定（由调用方决定是否传 downloads），
 *   这里统一回下载目录，与 Electron 43 的新默认行为一致，避免出现「有时有默认、
 *   有时没有」的双标。
 */
export function dialogDefaultPath(kind: DialogDirKind, fileName?: string): string {
  const base = usableDir(memory.get(kind)) ?? fallbackDir()
  if (!fileName) return base
  // 文件名里绝不能带分隔符，否则 join 会把记忆目录吃掉
  const safe = fileName.replace(/[\\/]+/g, '_')
  return join(base, safe)
}
/** 仅供自检使用：清空记忆 */
export function resetDialogDirs(): void {
  memory.clear()
}