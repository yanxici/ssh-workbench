import { app, BrowserWindow, clipboard, dialog } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, join } from 'node:path'
import { IPC } from '@shared/ipc'
import type { ConnExportOptions, ConnImportMode, ConnectionInput } from '@shared/types'
import { dialogParent } from '../windowRef'
import { handle } from './handle'
import { dataDir } from '../store/jsonStore'
import { MAX_KEY_BYTES, inspectPrivateKey } from '../util/privateKey'
import { hasSecret } from '../store/vault'
import { parseSshCommand } from '../util/parseSshCommand'
import {
  deleteConnection,
  deleteConnectionGroup,
  deleteConnections,
  listConnections,
  renameConnectionGroup,
  saveConnection
} from '../store/repository'
import {
  applyImport,
  exportConnectionsToFile,
  inspectImportFile,
  previewImport
} from '../store/connTransfer'
import { testConnection } from '../ssh/testConnection'

/** 连接管理：增删改查 + 分组 + 测试 + 导入导出 + 剪贴板 ssh 命令识别 */
export function registerConnectionIpc(): void {
  handle(IPC.CONN_LIST, () => listConnections())
  handle(IPC.CONN_SAVE, (input: ConnectionInput) => saveConnection(input))
  handle(IPC.CONN_DELETE, (id: string) => deleteConnection(id))
  handle(IPC.CONN_RENAME_GROUP, (from: string, to: string) => renameConnectionGroup(from, to))
  handle(IPC.CONN_DELETE_GROUP, (group: string) => deleteConnectionGroup(group))
  handle(IPC.CONN_DELETE_MANY, (ids: string[]) => deleteConnections(ids))
  handle(IPC.CONN_TEST, (input: Parameters<typeof testConnection>[0]) => testConnection(input))

  // 连接导出：选保存位置后打包（可带密码 / 私钥，可加口令）
  handle(IPC.CONN_EXPORT, async (opts: ConnExportOptions) => {
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    const res = await dialog.showSaveDialog(dialogParent() as BrowserWindow, {
      title: '导出连接',
      defaultPath: join(app.getPath('desktop'), `SSH连接-${stamp}.swconn`),
      filters: [{ name: 'SSH Workbench 连接', extensions: ['swconn'] }]
    })
    if (res.canceled || !res.filePath) return { canceled: true as const }
    const result = await exportConnectionsToFile(res.filePath, opts)
    return { canceled: false as const, ...result }
  })

  /*
   * 连接导入：只接受本进程对话框选出的文件，渲染层不能指定任意路径。
   * 这是有意的收窄 —— 导入会解析并写入凭据，若允许任意路径，
   * 一个被污染的渲染层就能让主进程去读任意本地文件。
   */
  const importPaths = new Set<string>()
  const assertImportPath = (p: string): void => {
    if (!importPaths.has(p)) throw new Error('请重新选择要导入的文件')
  }

  handle(IPC.CONN_IMPORT_PICK, async () => {
    const res = await dialog.showOpenDialog(dialogParent() as BrowserWindow, {
      title: '导入连接',
      properties: ['openFile'],
      filters: [
        { name: 'SSH Workbench 连接', extensions: ['swconn', 'json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (res.canceled || res.filePaths.length === 0) return { canceled: true }
    const path = res.filePaths[0]
    const { encrypted } = await inspectImportFile(path)
    importPaths.add(path)
    return { canceled: false, path, encrypted }
  })

  handle(IPC.CONN_IMPORT_PREVIEW, (path: string, passphrase?: string) => {
    assertImportPath(path)
    return previewImport(path, passphrase)
  })

  handle(
    IPC.CONN_IMPORT_APPLY,
    async (path: string, passphrase: string | undefined, mode: ConnImportMode) => {
      assertImportPath(path)
      if (mode !== 'skip' && mode !== 'overwrite') throw new Error('导入模式无效')
      return applyImport(path, passphrase, mode)
    }
  )

  // 选择本地私钥：校验格式后复制到应用数据目录（原文件被移动/删除也不影响连接）
  handle(IPC.CONN_PICK_KEY, async () => {
    const res = await dialog.showOpenDialog(dialogParent() as BrowserWindow, {
      title: '选择私钥文件',
      buttonLabel: '使用此私钥',
      properties: ['openFile', 'showHiddenFiles'],
      filters: [
        { name: '所有文件', extensions: ['*'] },
        { name: '私钥', extensions: ['pem', 'key', 'ppk', 'rsa'] }
      ]
    })
    if (res.canceled || res.filePaths.length === 0) return { canceled: true }

    const src = res.filePaths[0]
    const stat = await fs.stat(src)
    if (stat.size > MAX_KEY_BYTES) throw new Error('文件过大，不是私钥文件')
    const data = await fs.readFile(src)
    const info = inspectPrivateKey(data)

    const keysDir = join(dataDir(), 'keys')
    await fs.mkdir(keysDir, { recursive: true })
    const safeName = basename(src).replace(/[^\w.-]/g, '_') || 'key'
    const dest = join(keysDir, `${Date.now().toString(36)}-${safeName}`)
    await fs.writeFile(dest, data, { mode: 0o600 })
    return { canceled: false, path: dest, type: info.type, encrypted: info.encrypted }
  })

  handle(IPC.CONN_HAS_SECRET, (id: string) => hasSecret(id))
  handle(IPC.CONN_PARSE_SSH_CMD, (text?: string) =>
    parseSshCommand(typeof text === 'string' && text ? text : clipboard.readText())
  )
}
