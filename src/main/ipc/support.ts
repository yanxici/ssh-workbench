import { app, BrowserWindow, dialog } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { getSettings } from '../app/settingsService'
import { dataDir } from '../store/jsonStore'
import { exportErrorsText } from '../store/errorLog'
import { buildSupportZip } from '../store/supportBundle'
import { dialogParent } from '../windowRef'
import { dialogDefaultPath, rememberDialogPick } from '../util/dialogDirs'
import { handle } from './handle'

/**
 * 一键诊断包（设置 → 错误日志 → 导出诊断包）。
 *
 * 为什么不做遥测 / 崩溃自动上报：
 * 这类工具式客户端跑在客户内网，静默联网上传是最容易引起信任问题的一步；
 * 而排障真正需要的信息（版本、系统、错误详情、设置、启动日志）完全可以
 * 由用户主动导出一个 zip 给研发。用户看得见发了什么，研发拿得到现场。
 */

/** 读 boot.log：优先 userData，退化到启动目录；不存在则跳过 */
async function readBootLog(): Promise<string | undefined> {
  const candidates = [join(app.getPath('userData'), 'boot.log'), join(process.cwd(), 'boot.log')]
  for (const p of candidates) {
    try {
      return await fs.readFile(p, 'utf-8')
    } catch {
      /* 没有就试下一个 */
    }
  }
  return undefined
}

export function registerSupportIpc(): void {
  handle(IPC.SUPPORT_BUNDLE, async () => {
    const zip = buildSupportZip({
      version: app.getVersion(),
      appInfo: {
        应用版本: app.getVersion(),
        Electron: process.versions.electron ?? '未知',
        Chromium: process.versions.chrome ?? '未知',
        Node: process.versions.node ?? '未知',
        系统: `${process.platform} ${process.arch}`,
        语言: app.getLocale(),
        数据目录: dataDir(),
        开机时长: '见 boot.log'
      },
      settingsJson: JSON.stringify(await getSettings()),
      errorText: await exportErrorsText(),
      bootLog: await readBootLog()
    })

    const stamp = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const name = `ssh-workbench-诊断包-${app.getVersion()}-${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}.zip`

    const res = await dialog.showSaveDialog(dialogParent() as BrowserWindow, {
      title: '导出诊断包',
      defaultPath: dialogDefaultPath('file', name),
      filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
    })
    if (res.canceled || !res.filePath) return { canceled: true as const }
    rememberDialogPick('file', res.filePath, false)
    await fs.writeFile(res.filePath, zip)
    return { canceled: false as const, path: res.filePath, bytes: zip.length }
  })
}
