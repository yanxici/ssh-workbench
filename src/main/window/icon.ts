import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 窗口图标路径（见 createWindow 里的注释）。
 * 依次探测打包版的两个位置与开发模式的仓库路径，都不存在时返回 undefined，
 * 让 Electron 走自己的默认行为（至少不会因为传了坏路径而抛错）。
 */
export function pickIconPath(): string | undefined {
  /*
   * .ico 优先，.png 兜底。
   *
   * 为什么要 ico：Windows 任务栏在 125%/150% 缩放比下要 20/24/32/40px 的图标，
   * 而一张 256×256 的 png 交给系统缩，GDI 的双线性会把圆角边缘的白边抹开，
   * 蓝色/绿色的小图标缩完常常整块发白 —— 这正是「图标明明是绿的，任务栏却白」
   * 的来源。ico 里带 16/24/32/48/64/128/256 七个尺寸，系统按需挑，不必缩。
   */
  const candidates = [
    join(process.resourcesPath ?? '', 'icon.ico'),
    join(__dirname, '../../resources/icon.ico'),
    join(app.getAppPath(), 'resources/icon.ico'),
    join(process.resourcesPath ?? '', 'icon.png'),
    join(__dirname, '../../resources/icon.png'),
    join(app.getAppPath(), 'resources/icon.png')
  ]
  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  return undefined
}
