import { dialog, type OpenDialogOptions } from 'electron'
import { dialogParent } from '../windowRef'
import { dialogDefaultPath, rememberDialogPick } from '../util/dialogDirs'

/**
 * trzsz 的两个原生选择器。
 *
 * 单独成文件而不是塞进 sessionManager：sessionManager 目前一个 electron 符号都不 import，
 * 保持「纯逻辑 + 可被脚本直接加载」的形状（scripts/verify-*.cjs 会 esbuild 打包它）。
 */

/**
 * 自动化脚本用的一次性开关：让两个选择器直接返回「用户取消」。
 *
 * 为什么需要：e2e 要在真实应用里跑完「远端握手 → 建过滤器 → 选目录」这条链，
 * 但原生模态对话框会挂住进程，脚本没法点。设了这个环境变量后对话框立即返回
 * canceled，链路其余部分（握手识别、sendAction(false) 回执、状态广播）照常执行。
 *
 * 只在被显式设置时生效，正常使用时读到的永远是 undefined。
 */
const AUTO_DECLINE = process.env.SSHWB_TRZSZ_AUTODECLINE === '1'

function open(options: OpenDialogOptions): Promise<Electron.OpenDialogReturnValue> {
  const parent = dialogParent()
  return parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options)
}

/** 下载（远端 sz/tsz）落盘目录：一次传输只问一次，trzsz 会把多文件都放进去 */
export async function pickTrzszSaveDirectory(): Promise<string | undefined> {
  if (AUTO_DECLINE) return undefined
  const res = await open({
    title: '选择接收目录',
    defaultPath: dialogDefaultPath('folder'),
    properties: ['openDirectory', 'createDirectory']
  })
  const dir = res.canceled ? undefined : res.filePaths[0]
  if (dir) rememberDialogPick('folder', dir, true)
  return dir
}

/** 上传（本地 trz）要发的文件；directory=true 时选目录（远端会收到整棵目录树） */
export async function pickTrzszSendFiles(directory: boolean): Promise<string[] | undefined> {
  if (AUTO_DECLINE) return undefined
  const res = await open({
    title: directory ? '选择要发送的目录' : '选择要发送的文件',
    defaultPath: dialogDefaultPath(directory ? 'folder' : 'file'),
    properties: directory ? ['openDirectory'] : ['openFile', 'multiSelections']
  })
  if (res.canceled || res.filePaths.length === 0) return undefined
  rememberDialogPick(directory ? 'folder' : 'file', res.filePaths[0], directory)
  return res.filePaths
}
