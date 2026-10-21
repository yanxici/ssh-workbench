import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron'
import {
  promises as fs,
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { IPC } from '@shared/ipc'
import type {
  BundleOptions,
  CommandInput,
  ConnectionInput,
  DeviceProfileInput,
  DiagSectionInput,
  HistoryFilter,
  TestConnectionInput,
  TunnelInput,
  ConnExportOptions,
  ConnImportMode
} from '@shared/types'
import {
  applyImport,
  exportConnectionsToFile,
  inspectImportFile,
  previewImport
} from './store/connTransfer'
import { dataDir } from './store/jsonStore'
import { MAX_KEY_BYTES, inspectPrivateKey } from './util/privateKey'
import {
  addHistory,
  clearHistory,
  deleteCommand,
  deleteCommandGroup,
  deleteConnection,
  deleteDiagSection,
  deleteKnownHost,
  deleteProfile,
  deleteTunnel,
  exportCommands,
  getSettings,
  importCommands,
  listCommands,
  listConnections,
  listDiagSections,
  listHistory,
  listKnownHosts,
  listProfiles,
  listTunnels,
  renameCommandGroup,
  reorderCommands,
  saveCommand,
  saveConnection,
  saveDiagSection,
  saveProfile,
  saveTunnel,
  seedCommandsIfNeeded,
  setSettings
} from './store/repository'
import {
  exportReport,
  listReports,
  openReportsDir,
  readReport,
  removeReport,
  reportText
} from './store/reports'
import { bundlePreview, exportBundle, revealBundle } from './store/bundle'
import { batchRunner } from './ssh/batchExec'
import { diagnosticsRunner } from './ssh/diagnostics'
import { execCollect } from './ssh/exec'
import { firmwareOps } from './ssh/firmware'
import { metricsSampler } from './ssh/metrics'
import { netScanner } from './ssh/netScan'
import { backupStore } from './store/backups'
import { discoverMdns } from './util/mdns'
import { tcpProbe } from './util/tcpProbe'
import { hasSecret } from './store/vault'
import { listDrives, localDelete, localList, localMkdir, localRename } from './store/localFs'
import { recorder } from './store/recorder'
import { parseSshCommand } from './util/parseSshCommand'
import { sessionManager } from './ssh/sessionManager'
import { sftpManager } from './ssh/sftpManager'
import { tunnelManager } from './ssh/portForward'
import { testConnection } from './ssh/testConnection'

let mainWindow: BrowserWindow | null = null

/** 正在进行的传输任务（用于任务栏进度条；完成/失败即移除） */
const activeTransfers = new Map<string, { transferred: number; total: number }>()

/** 把当前所有传输任务聚合成 Windows 任务栏进度；没有任务时清除 */
function updateTaskbarProgress(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (activeTransfers.size === 0) {
    win.setProgressBar(-1)
    return
  }
  const tasks = [...activeTransfers.values()].filter((t) => t.total > 0)
  if (tasks.length === 0) {
    // 总大小未知（例如目录还在遍历）：任务栏显示不确定态
    win.setProgressBar(2)
    return
  }
  const ratio =
    tasks.reduce((sum, t) => sum + Math.min(t.transferred / t.total, 1), 0) / tasks.length
  // 传输中最多显示 99%，避免任务栏提前显示"已完成"
  win.setProgressBar(Math.min(Math.max(ratio, 0), 0.999))
}

/* ------------------------------------------------------------------ *
 *  启动日志与全局异常 —— 排查"静默退出"的关键抓手
 * ------------------------------------------------------------------ */

function log(...args: unknown[]): void {
  process.stdout.write(`[main] ${args.map(String).join(' ')}\n`)
}

/** 启动诊断日志（仅冒烟模式写文件，避免正常使用时累积；也用于无人工验证启动流程） */
function bootLog(...args: unknown[]): void {
  if (process.env.SSHW_SMOKE !== '1' && !process.argv.includes('--smoke')) return
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`
  try {
    appendFileSync(join(app.getPath('userData'), 'boot.log'), line)
  } catch {
    /* ignore */
  }
  try {
    appendFileSync(join(process.cwd(), 'boot.log'), line)
  } catch {
    /* ignore */
  }
}

process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err)
  bootLog('uncaughtException:', String(err))
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason)
  bootLog('unhandledRejection:', String(reason))
})

log('boot: module loaded')
bootLog('boot: module loaded')

// 终端工具用 canvas 渲染，无需 GPU 加速；禁用可避免远程桌面/虚拟机/老机器上的
// GPU 进程崩溃（GPU 崩溃会导致整个应用退出），对技术支持场景的稳定性至关重要。
app.disableHardwareAcceleration()

/* ------------------------------------------------------------------ *
 *  IPC 包装：主进程异常统一转为 { ok:false, error }，渲染层不感知异常
 * ------------------------------------------------------------------ */

function handle(channel: string, fn: (...args: never[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      const data = await fn(...(args as never[]))
      return { ok: true, data }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}

function registerIpc(): void {
  /* ---------------- 连接管理 ---------------- */
  handle(IPC.CONN_LIST, () => listConnections())
  handle(IPC.CONN_SAVE, (input: ConnectionInput) => saveConnection(input))
  handle(IPC.CONN_DELETE, (id: string) => deleteConnection(id))
  handle(IPC.CONN_TEST, (input: TestConnectionInput) => testConnection(input))

  // 连接导出：选保存位置后打包（可带密码 / 私钥，可加口令）
  handle(IPC.CONN_EXPORT, async (opts: ConnExportOptions) => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const d = new Date()
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
    const res = await dialog.showSaveDialog(win as BrowserWindow, {
      title: '导出连接',
      defaultPath: join(app.getPath('desktop'), `SSH连接-${stamp}.swconn`),
      filters: [{ name: 'SSH Workbench 连接', extensions: ['swconn'] }]
    })
    if (res.canceled || !res.filePath) return { canceled: true as const }
    const result = await exportConnectionsToFile(res.filePath, opts)
    return { canceled: false as const, ...result }
  })

  // 连接导入：只接受本进程对话框选出的文件，渲染层不能指定任意路径
  const importPaths = new Set<string>()
  const assertImportPath = (p: string): void => {
    if (!importPaths.has(p)) throw new Error('请重新选择要导入的文件')
  }
  handle(IPC.CONN_IMPORT_PICK, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const res = await dialog.showOpenDialog(win as BrowserWindow, {
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
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const res = await dialog.showOpenDialog(win as BrowserWindow, {
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

  /* ---------------- 会话 / 终端 ---------------- */
  handle(
    IPC.SESSION_OPEN,
    (input: { sessionId: string; connectionId: string; cols: number; rows: number }) =>
      sessionManager.open(input.sessionId, input.connectionId, input.cols, input.rows)
  )
  handle(
    IPC.SESSION_OPEN_SHELL,
    (input: {
      sessionId: string
      connectionId: string
      hostSessionId: string
      cols: number
      rows: number
    }) =>
      sessionManager.openShell(
        input.sessionId,
        input.connectionId,
        input.hostSessionId,
        input.cols,
        input.rows
      )
  )
  handle(IPC.SESSION_CLOSE, (sessionId: string) => sessionManager.close(sessionId))
  handle(IPC.SESSION_WRITE, (sessionId: string, data: string) =>
    sessionManager.write(sessionId, data)
  )
  handle(IPC.SESSION_RESIZE, (sessionId: string, cols: number, rows: number) =>
    sessionManager.resize(sessionId, cols, rows)
  )
  handle(IPC.SESSION_BROADCAST, (sessionIds: string[], data: string) =>
    sessionManager.broadcast(sessionIds, data)
  )
  handle(IPC.SESSION_LIST, () => sessionManager.list())

  /* ---------------- 常用命令 ---------------- */
  handle(IPC.CMD_LIST, () => listCommands())
  handle(IPC.CMD_SAVE, (input: CommandInput) => saveCommand(input))
  handle(IPC.CMD_DELETE, (id: string) => deleteCommand(id))
  handle(IPC.CMD_REORDER, (ids: string[]) => reorderCommands(ids))
  handle(IPC.CMD_RENAME_GROUP, (from: string, to: string) => renameCommandGroup(from, to))
  handle(IPC.CMD_DELETE_GROUP, (group: string) => deleteCommandGroup(group))

  handle(IPC.CMD_IMPORT, async (mode: 'merge' | 'replace' = 'merge') => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const res = await dialog.showOpenDialog(win as BrowserWindow, {
      title: '导入常用命令',
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
      properties: ['openFile']
    })
    if (res.canceled || res.filePaths.length === 0) {
      return { canceled: true, imported: 0, skipped: 0 }
    }
    const raw = await fs.readFile(res.filePaths[0], 'utf-8')
    const parsed = JSON.parse(raw) as unknown
    const list = Array.isArray(parsed)
      ? parsed
      : (parsed as { commands?: unknown })?.commands
    const result = await importCommands(list, mode)
    return { canceled: false, ...result, path: res.filePaths[0] }
  })

  handle(IPC.CMD_EXPORT, async () => {
    const cmds = await exportCommands()
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const stamp = new Date().toISOString().slice(0, 10)
    const res = await dialog.showSaveDialog(win as BrowserWindow, {
      title: '导出常用命令',
      defaultPath: `ssh-workbench-commands-${stamp}.json`,
      filters: [{ name: 'JSON 文件', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return { canceled: true, count: 0 }
    await fs.writeFile(
      res.filePath,
      JSON.stringify({ version: 1, exportedAt: Date.now(), commands: cmds }, null, 2),
      'utf-8'
    )
    return { canceled: false, path: res.filePath, count: cmds.length }
  })

  handle(IPC.HIST_LIST, (filter: HistoryFilter) => listHistory(filter))
  handle(IPC.HIST_ADD, (entry: Parameters<typeof addHistory>[0]) => addHistory(entry))
  handle(IPC.HIST_CLEAR, (connectionId?: string) => clearHistory(connectionId))

  /* ---------------- 设置 / 存储 ---------------- */
  handle(IPC.SETTINGS_GET, () => getSettings())
  handle(IPC.SETTINGS_SET, (patch: Parameters<typeof setSettings>[0]) => setSettings(patch))
  handle(IPC.STORE_PATHS, () => ({
    dataDir: dataDir(),
    userData: app.getPath('userData')
  }))

  /* ---------------- 已知主机 ---------------- */
  handle(IPC.KNOWN_HOSTS_LIST, () => listKnownHosts())
  handle(IPC.KNOWN_HOSTS_DELETE, (key: string) => deleteKnownHost(key))

  /* ---------------- 剪贴板 ---------------- */
  handle(IPC.CLIP_READ, () => clipboard.readText())
  handle(IPC.CLIP_WRITE, (text: string) => clipboard.writeText(text))

  /* ---------------- SFTP 文件管理 ---------------- */
  handle(IPC.SFTP_LIST, (sessionId: string, path: string) => sftpManager.list(sessionId, path))
  handle(IPC.SFTP_HOME, (sessionId: string) => sftpManager.home(sessionId))
  handle(IPC.SFTP_MKDIR, (sessionId: string, path: string) => sftpManager.mkdir(sessionId, path))
  handle(IPC.SFTP_DELETE, (sessionId: string, path: string) => sftpManager.remove(sessionId, path))
  handle(IPC.SFTP_RENAME, (sessionId: string, from: string, to: string) =>
    sftpManager.rename(sessionId, from, to)
  )
  handle(IPC.SFTP_CHMOD, (sessionId: string, path: string, mode: number) =>
    sftpManager.chmod(sessionId, path, mode)
  )
  handle(IPC.SFTP_READ, (sessionId: string, path: string) => sftpManager.readText(sessionId, path))
  handle(IPC.SFTP_WRITE, (sessionId: string, path: string, content: string) =>
    sftpManager.writeText(sessionId, path, content)
  )
  handle(IPC.SFTP_UPLOAD, (sessionId: string, localPaths: string[], remoteDir: string) =>
    sftpManager.upload(sessionId, localPaths, remoteDir)
  )
  handle(IPC.SFTP_DOWNLOAD, (sessionId: string, remotePaths: string[], localDir: string) =>
    sftpManager.download(sessionId, remotePaths, localDir)
  )
  handle(IPC.SFTP_TRANSFER_PAUSE, (taskId: string) => sftpManager.pauseTransfer(taskId))
  handle(IPC.SFTP_TRANSFER_RESUME, (taskId: string) => sftpManager.resumeTransfer(taskId))
  handle(IPC.SFTP_TRANSFER_CANCEL, (taskId: string) => sftpManager.cancelTransfer(taskId))

  // 通过系统对话框选择文件/目录（文件树面板的单点上传/下载）
  handle(IPC.SFTP_UPLOAD_DIALOG, async (sessionId: string, remoteDir: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const res = await dialog.showOpenDialog(win as BrowserWindow, {
      title: '选择要上传的文件',
      buttonLabel: '上传',
      properties: ['openFile', 'multiSelections']
    })
    if (res.canceled || res.filePaths.length === 0) return { canceled: true, count: 0 }
    const ids = sftpManager.upload(sessionId, res.filePaths, remoteDir)
    return { canceled: false, count: ids.length }
  })

  handle(IPC.SFTP_DOWNLOAD_DIALOG, async (sessionId: string, remotePaths: string[]) => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const res = await dialog.showOpenDialog(win as BrowserWindow, {
      title: '选择保存目录',
      buttonLabel: '下载到此处',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return { canceled: true, count: 0 }
    const ids = sftpManager.download(sessionId, remotePaths, res.filePaths[0])
    return { canceled: false, count: ids.length }
  })

  /* ---------------- ZMODEM 文件传输（sz / rz） ---------------- */
  // 选择要发送到远端的文件（sz 方向：本机 -> 远端）
  handle(IPC.ZM_PICK_FILES, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const res = await dialog.showOpenDialog(win as BrowserWindow, {
      title: '选择要通过 ZMODEM 发送的文件',
      buttonLabel: '发送',
      properties: ['openFile', 'multiSelections']
    })
    if (res.canceled || res.filePaths.length === 0) return { canceled: true, files: [] }
    const files = res.filePaths.map((p) => {
      const buf = readFileSync(p)
      return { name: basename(p), size: buf.length, data: buf.toString('base64') }
    })
    return { canceled: false, files }
  })

  // 接收方向：先让用户选一次「文件夹」（多文件 sz 只问一次），返回一次性令牌。
  // 渲染层只能凭令牌写入，不能指定任意路径。
  const ZM_TOKEN_TTL = 30 * 60 * 1000
  const zmDirTokens = new Map<string, { dir: string; at: number }>()
  const zmReceives = new Map<string, { path: string; bytes: number; at: number }>()

  const pruneZm = (): void => {
    const now = Date.now()
    for (const [k, v] of zmDirTokens) if (now - v.at > ZM_TOKEN_TTL) zmDirTokens.delete(k)
    for (const [k, v] of zmReceives) if (now - v.at > ZM_TOKEN_TTL) zmReceives.delete(k)
  }

  // 远端送来的文件名不可信：去掉路径分隔符与 Windows 保留字符，只留纯文件名
  const safeFileName = (name: string): string => {
    const cleaned = basename(String(name || 'download.bin').replace(/[\\/:*?"<>|]/g, '_'))
    return cleaned && cleaned !== '.' && cleaned !== '..' ? cleaned : 'download.bin'
  }

  // 同名文件自动加序号，绝不覆盖已有文件
  const uniquePath = (dir: string, name: string): string => {
    const ext = extname(name)
    const stem = name.slice(0, name.length - ext.length) || 'download'
    let candidate = join(dir, name)
    let i = 1
    while (existsSync(candidate)) {
      candidate = join(dir, `${stem} (${i})${ext}`)
      i += 1
    }
    return candidate
  }

  handle(IPC.ZM_PICK_DIR, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const res = await dialog.showOpenDialog(win as BrowserWindow, {
      title: '选择接收文件的保存文件夹',
      buttonLabel: '保存到此处',
      defaultPath: app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths.length) return { canceled: true }
    pruneZm()
    const token = randomUUID()
    zmDirTokens.set(token, { dir: res.filePaths[0], at: Date.now() })
    return { canceled: false, token, dir: res.filePaths[0] }
  })

  // 开始接收一个文件：在已选目录里建好目标文件（重名自动编号），返回写入句柄
  handle(IPC.ZM_SAVE_BEGIN, (token: string, suggestedName: string) => {
    pruneZm()
    const rec = zmDirTokens.get(token)
    if (!rec) throw new Error('保存文件夹已失效，请重新选择')
    mkdirSync(rec.dir, { recursive: true })
    const target = uniquePath(rec.dir, safeFileName(suggestedName))
    // 先建成空文件，后续按块追加（大数据不必在内存里拼整份）
    writeFileSync(target, Buffer.alloc(0))
    const saveId = randomUUID()
    zmReceives.set(saveId, { path: target, bytes: 0, at: Date.now() })
    return { saveId, path: target }
  })

  // 追加一块数据（base64），返回累计字节数
  handle(IPC.ZM_SAVE_APPEND, (saveId: string, base64: string) => {
    const rec = zmReceives.get(saveId)
    if (!rec) throw new Error('接收会话已失效或已结束')
    const buf = Buffer.from(String(base64 || ''), 'base64')
    if (buf.length) appendFileSync(rec.path, buf)
    rec.bytes += buf.length
    rec.at = Date.now()
    return { bytes: rec.bytes }
  })

  // 收尾：关闭句柄，返回最终路径与大小
  handle(IPC.ZM_SAVE_FINISH, (saveId: string) => {
    const rec = zmReceives.get(saveId)
    if (!rec) throw new Error('接收会话已失效或已结束')
    zmReceives.delete(saveId)
    return { path: rec.path, size: rec.bytes }
  })

  handle(IPC.ZM_SEND_BYTES, (sessionId: string, base64: string) =>
    sessionManager.writeBytes(sessionId, Buffer.from(String(base64), 'base64'))
  )

  /* ---------------- 本地文件系统 ---------------- */
  handle(IPC.LOCAL_HOME, () => app.getPath('home'))
  handle(IPC.LOCAL_DRIVES, () => listDrives())
  handle(IPC.LOCAL_LIST, (dir: string) => localList(dir))
  handle(IPC.LOCAL_MKDIR, (dir: string, name: string) => localMkdir(dir, name))
  handle(IPC.LOCAL_DELETE, (paths: string[]) => localDelete(paths))
  handle(IPC.LOCAL_RENAME, (from: string, to: string) => localRename(from, to))

  /* ---------------- 一键诊断巡检 + 报告 ---------------- */
  handle(IPC.DIAG_SECTIONS_LIST, () => listDiagSections())
  handle(IPC.DIAG_SECTION_SAVE, (input: DiagSectionInput) => saveDiagSection(input))
  handle(IPC.DIAG_SECTION_DELETE, (id: string) => deleteDiagSection(id))
  handle(IPC.DIAG_RUN, (runId: string, sessionId: string, sectionIds: string[]) =>
    diagnosticsRunner.run(runId, sessionId, sectionIds)
  )
  handle(IPC.DIAG_CANCEL, (runId: string) => diagnosticsRunner.cancel(runId))
  handle(IPC.DIAG_REPORTS_LIST, () => listReports())
  handle(IPC.DIAG_REPORT_READ, (id: string) => readReport(id))
  handle(IPC.DIAG_REPORT_DELETE, (id: string) => removeReport(id))
  handle(IPC.DIAG_REPORT_EXPORT, (id: string, format: 'md' | 'html') =>
    exportReport(id, format)
  )
  handle(IPC.DIAG_REPORT_TEXT, (id: string, format: 'md' | 'html') => reportText(id, format))
  handle(IPC.DIAG_REPORTS_OPEN_DIR, () => openReportsDir())
  handle(IPC.DIAG_BUNDLE_PREVIEW, (reportId: string) => bundlePreview(reportId))
  handle(IPC.DIAG_BUNDLE_EXPORT, (reportId: string, options: BundleOptions) =>
    exportBundle(reportId, options)
  )
  handle(IPC.DIAG_BUNDLE_REVEAL, (filePath: string) => revealBundle(filePath))

  /* ---------------- 多设备批量执行 ---------------- */
  handle(IPC.BATCH_RUN, (runId: string, sessionIds: string[], command: string, timeoutMs: number) =>
    batchRunner.run(runId, sessionIds, command, timeoutMs)
  )
  handle(IPC.BATCH_CANCEL, (runId: string) => batchRunner.cancel(runId))

  /* ---------------- 客户 / 设备档案 ---------------- */
  handle(IPC.PROFILE_LIST, () => listProfiles())
  handle(IPC.PROFILE_SAVE, (input: DeviceProfileInput) => saveProfile(input))
  handle(IPC.PROFILE_DELETE, (id: string) => deleteProfile(id))

  /* ---------------- 资源仪表盘（实时监控） ---------------- */
  handle(IPC.METRICS_START, (sessionId: string, intervalMs?: number) =>
    metricsSampler.start(sessionId, intervalMs)
  )
  handle(IPC.METRICS_STOP, (sessionId: string) => metricsSampler.stop(sessionId))
  handle(IPC.METRICS_STATES, () => metricsSampler.states())

  /* ---------------- 固件升级助手 ---------------- */
  handle(IPC.FW_PICK_FILE, () => firmwareOps.pickFile())
  handle(IPC.FW_UPLOAD, (sessionId: string, localPath: string, remoteDir: string) =>
    firmwareOps.upload(sessionId, localPath, remoteDir)
  )
  handle(IPC.FW_VERIFY, (sessionId: string, localPath: string, remotePath: string) =>
    firmwareOps.verify(sessionId, localPath, remotePath)
  )
  handle(IPC.FW_UPGRADE, (runId: string, sessionId: string, command: string, timeoutMs: number) =>
    firmwareOps.upgrade(runId, sessionId, command, timeoutMs)
  )
  handle(IPC.FW_CANCEL, (runId: string) => firmwareOps.cancel(runId))
  handle(IPC.FW_REBOOT, (sessionId: string, command: string) =>
    firmwareOps.reboot(sessionId, command)
  )
  handle(IPC.NET_PROBE, (host: string, port: number, timeoutMs?: number) =>
    tcpProbe(host, port, timeoutMs)
  )
  handle(IPC.SSH_EXEC, async (sessionId: string, command: string, timeoutMs?: number) => {
    await sessionManager.waitUntilReady(sessionId)
    const client = sessionManager.getClient(sessionId)
    if (!client) throw new Error('会话不可用，请检查连接状态')
    const out = await execCollect(client, command, timeoutMs ?? 20000)
    return {
      status: out.status,
      exitCode: out.exitCode,
      stdout: out.stdout,
      stderr: out.stderr,
      error: out.error
    }
  })

  /* ---------------- 设备发现（局域网扫描 / mDNS） ---------------- */
  handle(IPC.NET_IFACES, () => netScanner.interfaces())
  handle(IPC.NET_SCAN, (runId: string, cidr: string, ports: number[], timeoutMs?: number) =>
    netScanner.scan(runId, cidr, ports, timeoutMs)
  )
  handle(IPC.NET_SCAN_CANCEL, (runId: string) => netScanner.cancel(runId))
  handle(IPC.NET_MDNS, (timeoutMs?: number) => discoverMdns(timeoutMs))

  /* ---------------- 配置备份对比 ---------------- */
  handle(IPC.BACKUP_LIST, () => backupStore.list())
  handle(IPC.BACKUP_CREATE, (sessionId: string, name: string, paths: string[]) =>
    backupStore.create(sessionId, name, paths)
  )
  handle(IPC.BACKUP_DELETE, (id: string) => backupStore.remove(id))
  handle(IPC.BACKUP_DETAIL, (id: string) => backupStore.detail(id))
  handle(IPC.BACKUP_DIFF, (id: string, path: string, sessionId: string) =>
    backupStore.diff(id, path, sessionId)
  )
  handle(IPC.BACKUP_RESTORE, (id: string, sessionId: string, paths: string[]) =>
    backupStore.restore(id, sessionId, paths)
  )
  handle(IPC.BACKUP_OPEN_DIR, () => backupStore.openDir())

  /* ---------------- 端口转发 / 隧道 ---------------- */
  handle(IPC.TUNNEL_LIST, () => listTunnels())
  handle(IPC.TUNNEL_SAVE, (input: TunnelInput) => saveTunnel(input))
  handle(IPC.TUNNEL_DELETE, (id: string) => deleteTunnel(id))
  handle(IPC.TUNNEL_START, (tunnelId: string, sessionId: string) =>
    tunnelManager.start(tunnelId, sessionId)
  )
  handle(IPC.TUNNEL_STOP, (tunnelId: string) => tunnelManager.stop(tunnelId))
  handle(IPC.TUNNEL_STATES, () => tunnelManager.states())

  /* ---------------- 会话日志（录制 / 回放） ---------------- */
  handle(IPC.LOG_LIST, () => recorder.list())
  handle(IPC.LOG_READ, (path: string) => recorder.read(path))
  handle(IPC.LOG_DELETE, (path: string) => recorder.remove(path))
  handle(IPC.LOG_OPEN_DIR, async () => {
    await shell.openPath(recorder.logDir())
  })
  handle(IPC.LOG_EXPORT, async (path: string) => {
    const win = BrowserWindow.getFocusedWindow() ?? mainWindow
    const res = await dialog.showSaveDialog(win as BrowserWindow, {
      title: '导出会话日志',
      defaultPath: basename(path),
      filters: [
        { name: 'Asciinema Cast', extensions: ['cast'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (res.canceled || !res.filePath) return { canceled: true }
    await fs.copyFile(path, res.filePath)
    return { canceled: false, path: res.filePath }
  })

  /* ---------------- 窗口控制（无边框自绘标题栏） ---------------- */
  ipcMain.handle(IPC.WIN_MINIMIZE, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
  })
  ipcMain.handle(IPC.WIN_TOGGLE_MAX, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.handle(IPC.WIN_CLOSE, (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
  })
}

/* ------------------------------------------------------------------ *
 *  窗口
 * ------------------------------------------------------------------ */


/** 冒烟自检：--smoke / SSHW_SMOKE=1 启动 → 渲染完成后截图 → 写结果文件（userData + cwd 双落盘）→ 退出 */
function runSmoke(win: BrowserWindow): void {
  const report = (status: string, extra: Record<string, unknown> = {}): void => {
    const payload = JSON.stringify({ status, at: Date.now(), ...extra }, null, 2)
    try {
      writeFileSync(join(app.getPath('userData'), 'smoke-result.json'), payload)
    } catch {
      /* ignore */
    }
    try {
      writeFileSync(join(process.cwd(), 'smoke-result.json'), payload)
    } catch {
      /* ignore */
    }
  }

  let finished = false
  const finish = (fn: () => void): void => {
    if (finished) return
    finished = true
    fn()
    app.quit()
  }

  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void (async () => {
        try {
          const image = await win.webContents.capturePage()
          const png = image.toPNG()
          const out = join(app.getPath('userData'), 'smoke-shot.png')
          await fs.writeFile(out, png)
          finish(() => report('ok', { screenshot: out, bytes: png.length }))
        } catch (err) {
          finish(() => report('capture-failed', { error: String(err) }))
        }
      })()
    }, 2500)
  })

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    finish(() => report('load-failed', { code, desc }))
  })

  // 兜底：12s 内未完成也记录并退出
  setTimeout(() => finish(() => report('timeout', { reason: '渲染未在 12s 内完成' })), 12000)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 812,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: '#0D1117',
    title: 'SSH Workbench',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 外部链接交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 开发期 F12 开关 DevTools（无边框窗口没有菜单栏，快捷键需要手动补）
  if (is.dev) {
    mainWindow.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        mainWindow?.webContents.toggleDevTools()
      }
    })
    // 渲染层 console 转发到终端，方便在启动阶段定位渲染错误
    mainWindow.webContents.on('console-message', (_event, level, message) => {
      log(`renderer[${level}]:`, message)
    })
  }

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] renderer process gone:', details)
    bootLog('render-process-gone:', JSON.stringify(details))
  })
  mainWindow.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error(`[main] page load failed: ${code} ${desc} ${url}`)
    bootLog('did-fail-load:', code, desc, url)
  })
  mainWindow.webContents.on('did-finish-load', () => {
    log('renderer page loaded')
    bootLog('renderer page loaded')
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  if (process.argv.includes('--smoke') || process.env.SSHW_SMOKE === '1') runSmoke(mainWindow)
}

/* ------------------------------------------------------------------ *
 *  生命周期
 * ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock()
bootLog('requestSingleInstanceLock:', String(gotLock))
if (!gotLock) {
  log('another instance holds the lock, exiting')
  bootLog('no lock, exiting')
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  void app.whenReady().then(async () => {
    log('app ready')
    bootLog('app ready')
    electronApp.setAppUserModelId('com.sshworkbench.app')
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    app.on('child-process-gone', (_event, details) => {
      console.error('[main] child process gone:', details)
    })

    // 无边框自绘标题栏：去掉默认菜单（菜单的加速键也一并不存在，属预期）
    Menu.setApplicationMenu(null)

    await seedCommandsIfNeeded()
    log('seed commands done')
    bootLog('seed commands done')

    sessionManager.setHandlers({
      onData: (sessionId, data, raw) =>
        mainWindow?.webContents.send(IPC.EVT_SESSION_DATA, {
          sessionId,
          data,
          raw: raw?.length ? raw.toString('base64') : undefined
        }),
      onStatus: (sessionId, status, error) =>
        mainWindow?.webContents.send(IPC.EVT_SESSION_STATUS, { sessionId, status, error }),
      onLatency: (sessionId, ms) =>
        mainWindow?.webContents.send(IPC.EVT_SESSION_LATENCY, { sessionId, ms })
    })

    sftpManager.setProgressHandler((event) => {
      mainWindow?.webContents.send(IPC.EVT_TRANSFER_PROGRESS, event)
      if (
        event.status === 'running' ||
        event.status === 'pending' ||
        event.status === 'paused'
      ) {
        activeTransfers.set(event.taskId, {
          transferred: event.transferred,
          total: event.total
        })
      } else {
        activeTransfers.delete(event.taskId)
      }
      updateTaskbarProgress()
    })

    tunnelManager.setStatusHandler((info) => {
      mainWindow?.webContents.send(IPC.EVT_TUNNEL_STATUS, info)
    })

    diagnosticsRunner.setProgressHandler((event) => {
      mainWindow?.webContents.send(IPC.EVT_DIAG_PROGRESS, event)
    })

    batchRunner.setProgressHandler((event) => {
      mainWindow?.webContents.send(IPC.EVT_BATCH_PROGRESS, event)
    })

    metricsSampler.setEventHandler((event) => {
      mainWindow?.webContents.send(IPC.EVT_METRICS, event)
    })

    firmwareOps.setLogHandler((event) => {
      mainWindow?.webContents.send(IPC.EVT_FW_LOG, event)
    })

    netScanner.setProgressHandler((event) => {
      mainWindow?.webContents.send(IPC.EVT_DISCOVER_PROGRESS, event)
    })

    // 会话关闭时清理其上的 SFTP 通道、运行中的隧道与监控
    sessionManager.setOnClosed((sessionId) => {
      sftpManager.clearSession(sessionId)
      tunnelManager.onSessionClosed(sessionId)
      metricsSampler.onSessionClosed(sessionId)
    })

    registerIpc()
    log('ipc registered')
    bootLog('ipc registered')

    createWindow()
    log('window created')
    bootLog('window created')

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    bootLog('window-all-closed fired')
    if (process.platform !== 'darwin') app.quit()
  })
}
