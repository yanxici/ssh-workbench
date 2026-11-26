import { clipboard } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { IPC } from '@shared/ipc'
import type {
  ConnExportOptions,
  ConnImportMode,
  ConnectionInput,
  ExternalImportSource
} from '@shared/types'
import { showOpenDialog, showSaveDialog } from '../windowRef'
import { dialogDefaultPath, rememberDialogPick } from '../util/dialogDirs'
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
  saveConnection,
  updateConnectionsTags
} from '../store/repository'
import {
  applyImport,
  exportConnectionsToFile,
  inspectImportFile,
  previewImport
} from '../store/connTransfer'
import {
  applyExternalImport,
  defaultSshConfigPath,
  fileExists,
  previewExternalImport,
  scanConfigFiles
} from '../store/externalImport'
import { testConnection } from '../ssh/testConnection'

/** 连接管理：增删改查 + 分组 + 测试 + 导入导出 + 剪贴板 ssh 命令识别 */
export function registerConnectionIpc(): void {
  handle(IPC.CONN_LIST, () => listConnections())
  handle(IPC.CONN_SAVE, (input: ConnectionInput) => saveConnection(input))
  handle(IPC.CONN_DELETE, (id: string) => deleteConnection(id))
  handle(IPC.CONN_RENAME_GROUP, (from: string, to: string) => renameConnectionGroup(from, to))
  handle(IPC.CONN_DELETE_GROUP, (group: string) => deleteConnectionGroup(group))
  handle(IPC.CONN_DELETE_MANY, (ids: string[]) => deleteConnections(ids))
  // 批量改标签：一次读改写落盘，避免渲染层多选后逐条 save（N 次 IPC + N 次全表重渲染）
  handle(IPC.CONN_UPDATE_TAGS, (ids: string[], tags: string[], mode?: 'add' | 'remove' | 'replace') =>
    updateConnectionsTags(ids, tags, mode ?? 'add')
  )
  handle(IPC.CONN_TEST, (input: Parameters<typeof testConnection>[0]) => testConnection(input))

  // 连接导出：选保存位置后打包（可带密码 / 私钥，可加口令）
  handle(IPC.CONN_EXPORT, async (opts: ConnExportOptions) => {
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    const res = await showSaveDialog({
      title: '导出连接',
      defaultPath: dialogDefaultPath('file', `SSH连接-${stamp}.swconn`),
      filters: [{ name: 'Portix 连接', extensions: ['swconn'] }]
    })
    if (res.canceled || !res.filePath) return { canceled: true as const }
    rememberDialogPick('file', res.filePath, false)
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
    const res = await showOpenDialog({
      title: '导入连接',
      defaultPath: dialogDefaultPath('file'),
      properties: ['openFile'],
      filters: [
        { name: 'Portix 连接', extensions: ['swconn', 'json'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (res.canceled || res.filePaths.length === 0) return { canceled: true }
    const path = res.filePaths[0]
    rememberDialogPick('file', path, false)
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

  /*
   * 外部客户端导入：与上面的导出包导入完全独立的通道。
   *
   * 白名单同样是必须的：这几家的配置放在用户目录深处（%APPDATA%\MobaXterm、
   * C:\Users\x\Documents\NetSarang\...），只能由主进程对话框选出来；
   * 渲染层拿到的路径必须来自本进程登记过的集合，否则一个被污染的渲染层
   * 就能让主进程去读任意本地文件。
   */
  const extImportPaths = new Set<string>()
  const assertExtImportPath = (p: string): void => {
    if (!extImportPaths.has(p)) throw new Error('请重新选择要导入的配置')
  }
  const rememberExtPaths = (paths: string[]): string[] => {
    for (const p of paths) extImportPaths.add(p)
    return paths
  }

  handle(IPC.CONN_EXT_IMPORT_PICK, async (source: ExternalImportSource) => {
    const isSshConfig = source === 'ssh-config'
    // ssh_config 只有一个文件，且默认就在 ~/.ssh/config —— 存在时直接拿来用，
    // 让用户少点一次「选择文件」；不存在才弹框让他自己找。
    if (isSshConfig) {
      const guess = defaultSshConfigPath()
      if (await fileExists(guess)) {
        rememberDialogPick('file', guess, false)
        return { canceled: false, paths: rememberExtPaths([guess]), root: dirname(guess), defaultPath: guess }
      }
    }
    const res = await showOpenDialog({
      title: isSshConfig ? '选择 ssh_config 文件' : '选择外部客户端配置目录',
      defaultPath: isSshConfig ? dialogDefaultPath('file') : dialogDefaultPath('folder'),
      // 目录与文件都允许：MobaXterm 是单个 .mxtsessions，SecureCRT 是整个 Sessions 目录
      properties: isSshConfig ? ['openFile', 'showHiddenFiles'] : ['openFile', 'openDirectory'],
      filters: isSshConfig
        ? [
            { name: 'SSH 配置', extensions: ['config', 'conf', 'txt'] },
            { name: '所有文件', extensions: ['*'] }
          ]
        : undefined
    })
    if (res.canceled || res.filePaths.length === 0) return { canceled: true }
    const picked = res.filePaths[0]
    rememberDialogPick(isSshConfig ? 'file' : 'folder', picked, !isSshConfig)
    let files: string[]
    if (isSshConfig) {
      files = [picked]
    } else {
      const st = await fs.stat(picked)
      files = st.isDirectory() ? scanConfigFiles(picked, source) : [picked]
    }
    if (files.length === 0) throw new Error('该目录下没有找到可导入的配置文件')
    return {
      canceled: false,
      paths: rememberExtPaths(files),
      root: isSshConfig ? dirname(picked) : picked,
      defaultPath: picked
    }
  })

  handle(IPC.CONN_EXT_IMPORT_PREVIEW, (source: ExternalImportSource, paths: string[]) => {
    for (const p of paths) assertExtImportPath(p)
    return previewExternalImport(source, paths)
  })

  handle(
    IPC.CONN_EXT_IMPORT_APPLY,
    async (source: ExternalImportSource, paths: string[], mode: ConnImportMode) => {
      for (const p of paths) assertExtImportPath(p)
      if (mode !== 'skip' && mode !== 'overwrite') throw new Error('导入模式无效')
      return applyExternalImport(source, paths, mode)
    }
  )

  // 选择本地私钥：校验格式后复制到应用数据目录（原文件被移动/删除也不影响连接）
  handle(IPC.CONN_PICK_KEY, async () => {
    const res = await showOpenDialog({
      title: '选择私钥文件',
      buttonLabel: '使用此私钥',
      defaultPath: dialogDefaultPath('file'),
      properties: ['openFile', 'showHiddenFiles'],
      filters: [
        { name: '所有文件', extensions: ['*'] },
        { name: '私钥', extensions: ['pem', 'key', 'ppk', 'rsa'] }
      ]
    })
    if (res.canceled || res.filePaths.length === 0) return { canceled: true }

    const src = res.filePaths[0]
    rememberDialogPick('file', src, false)
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
  handle(IPC.CONN_PARSE_SSH_CMD, async (text?: string) => {
    // eslint-disable-next-line @typescript-eslint/await-thenable -- Electron 33 同步返回 string、45 返回 Promise；verify-clipboard 强制保留 await 护栏
    const fromClip = typeof text === 'string' && text ? text : await clipboard.readText()
    return parseSshCommand(fromClip)
  })
}