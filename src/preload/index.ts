import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AppSettings,
  BackupDetail,
  BackupDiffResult,
  BackupMeta,
  BatchProgressEvent,
  BatchSessionResult,
  BundleOptions,
  BundlePreview,
  Command,
  CommandHistoryEntry,
  CommandInput,
  ConnExportOptions,
  ConnExportResult,
  ConnImportMode,
  ConnImportPreview,
  ConnImportResult,
  Connection,
  ConnectionInput,
  DeviceProfile,
  DeviceProfileInput,
  DiagProgressEvent,
  DiagReport,
  DiagReportMeta,
  DiagSection,
  DiagSectionInput,
  DiscoverHost,
  DiscoverProgressEvent,
  FirmwareFileInfo,
  FirmwareLogEvent,
  FirmwareUpgradeResult,
  FirmwareVerifyResult,
  HistoryFilter,
  IpcResult,
  LocalFile,
  MdnsService,
  MetricsEvent,
  NetInterfaceInfo,
  NetProbeResult,
  ParsedSshCommand,
  RemoteFile,
  SessionDataEvent,
  SessionInfo,
  SessionLogFile,
  SessionStatusEvent,
  SshExecResult,
  TestConnectionInput,
  TestConnectionResult,
  TransferProgressEvent,
  TunnelConfig,
  TunnelInput,
  TunnelRuntimeInfo
} from '@shared/types'

/**
 * 预加载桥 —— 渲染进程与主进程之间的唯一通道。
 *
 * 渲染层通过 window.api.* 调用全部能力；所有方法返回统一的 IpcResult<T>，
 * 渲染层不会接触到主进程异常。这一层是刻意收窄的边界：
 * 将来若替换底层（如迁移 Tauri），只需重写本文件与主进程，渲染层不动。
 */

export interface KnownHostInfo {
  host: string
  port: number
  fingerprint: string
  addedAt: number
}

export interface StorePaths {
  dataDir: string
  userData: string
}

export interface ImportCommandsResult {
  canceled: boolean
  imported: number
  skipped: number
  path?: string
}

export interface ExportCommandsResult {
  canceled: boolean
  count: number
  path?: string
}

export interface LatencyEvent {
  sessionId: string
  ms: number
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<IpcResult<T>> {
  return ipcRenderer.invoke(channel, ...args) as Promise<IpcResult<T>>
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

export const api = {
  conn: {
    list: (): Promise<IpcResult<Connection[]>> => invoke(IPC.CONN_LIST),
    save: (input: ConnectionInput): Promise<IpcResult<Connection>> => invoke(IPC.CONN_SAVE, input),
    remove: (id: string): Promise<IpcResult<void>> => invoke(IPC.CONN_DELETE, id),
    pickPrivateKey: (): Promise<
      IpcResult<{ canceled: boolean; path?: string; type?: string; encrypted?: boolean }>
    > => invoke(IPC.CONN_PICK_KEY),
    exportToFile: (
      opts: ConnExportOptions
    ): Promise<IpcResult<ConnExportResult | { canceled: true }>> => invoke(IPC.CONN_EXPORT, opts),
    importPick: (): Promise<IpcResult<{ canceled: boolean; path?: string; encrypted?: boolean }>> =>
      invoke(IPC.CONN_IMPORT_PICK),
    importPreview: (path: string, passphrase?: string): Promise<IpcResult<ConnImportPreview>> =>
      invoke(IPC.CONN_IMPORT_PREVIEW, path, passphrase),
    importApply: (
      path: string,
      passphrase: string | undefined,
      mode: ConnImportMode
    ): Promise<IpcResult<ConnImportResult>> =>
      invoke(IPC.CONN_IMPORT_APPLY, path, passphrase, mode),
    test: (input: TestConnectionInput): Promise<IpcResult<TestConnectionResult>> =>
      invoke(IPC.CONN_TEST, input),
    /** 连接分组重命名：返回整组迁移的连接数 */
    renameGroup: (from: string, to: string): Promise<IpcResult<number>> =>
      invoke(IPC.CONN_RENAME_GROUP, from, to),
    /** 连接分组删除：返回连带删除的连接数 */
    deleteGroup: (group: string): Promise<IpcResult<number>> =>
      invoke(IPC.CONN_DELETE_GROUP, group),
    hasSecret: (id: string): Promise<IpcResult<boolean>> => invoke(IPC.CONN_HAS_SECRET, id),
    parseSshCommand: (text?: string): Promise<IpcResult<ParsedSshCommand>> =>
      invoke(IPC.CONN_PARSE_SSH_CMD, text)
  },

  session: {
    open: (input: {
      sessionId: string
      connectionId: string
      cols: number
      rows: number
    }): Promise<IpcResult<void>> => invoke(IPC.SESSION_OPEN, input),
    openShell: (input: {
      sessionId: string
      connectionId: string
      hostSessionId: string
      cols: number
      rows: number
    }): Promise<IpcResult<void>> => invoke(IPC.SESSION_OPEN_SHELL, input),
    close: (sessionId: string): Promise<IpcResult<void>> => invoke(IPC.SESSION_CLOSE, sessionId),
    write: (sessionId: string, data: string): Promise<IpcResult<void>> =>
      invoke(IPC.SESSION_WRITE, sessionId, data),
    resize: (sessionId: string, cols: number, rows: number): Promise<IpcResult<void>> =>
      invoke(IPC.SESSION_RESIZE, sessionId, cols, rows),
    broadcast: (sessionIds: string[], data: string): Promise<IpcResult<void>> =>
      invoke(IPC.SESSION_BROADCAST, sessionIds, data),
    list: (): Promise<IpcResult<SessionInfo[]>> => invoke(IPC.SESSION_LIST)
  },

  command: {
    list: (): Promise<IpcResult<Command[]>> => invoke(IPC.CMD_LIST),
    save: (input: CommandInput): Promise<IpcResult<Command>> => invoke(IPC.CMD_SAVE, input),
    remove: (id: string): Promise<IpcResult<void>> => invoke(IPC.CMD_DELETE, id),
    reorder: (ids: string[]): Promise<IpcResult<void>> => invoke(IPC.CMD_REORDER, ids),
    renameGroup: (from: string, to: string): Promise<IpcResult<number>> =>
      invoke(IPC.CMD_RENAME_GROUP, from, to),
    deleteGroup: (group: string): Promise<IpcResult<number>> =>
      invoke(IPC.CMD_DELETE_GROUP, group),
    import: (mode: 'merge' | 'replace'): Promise<IpcResult<ImportCommandsResult>> =>
      invoke(IPC.CMD_IMPORT, mode),
    export: (): Promise<IpcResult<ExportCommandsResult>> => invoke(IPC.CMD_EXPORT),
    /** 执行成功后打点：useCount+1 / lastUsedAt，驱动「最近 / 最常用」 */
    touch: (id: string): Promise<IpcResult<Command | null>> => invoke(IPC.CMD_TOUCH, id)
  },

  history: {
    list: (filter?: HistoryFilter): Promise<IpcResult<CommandHistoryEntry[]>> =>
      invoke(IPC.HIST_LIST, filter),
    add: (entry: Omit<CommandHistoryEntry, 'id'>): Promise<IpcResult<CommandHistoryEntry>> =>
      invoke(IPC.HIST_ADD, entry),
    clear: (connectionId?: string): Promise<IpcResult<void>> => invoke(IPC.HIST_CLEAR, connectionId)
  },

  settings: {
    get: (): Promise<IpcResult<AppSettings>> => invoke(IPC.SETTINGS_GET),
    set: (patch: Partial<AppSettings>): Promise<IpcResult<AppSettings>> =>
      invoke(IPC.SETTINGS_SET, patch),
    paths: (): Promise<IpcResult<StorePaths>> => invoke(IPC.STORE_PATHS)
  },

  knownHosts: {
    list: (): Promise<IpcResult<KnownHostInfo[]>> => invoke(IPC.KNOWN_HOSTS_LIST),
    remove: (key: string): Promise<IpcResult<void>> => invoke(IPC.KNOWN_HOSTS_DELETE, key)
  },

  sftp: {
    list: (sessionId: string, path: string): Promise<IpcResult<RemoteFile[]>> =>
      invoke(IPC.SFTP_LIST, sessionId, path),
    home: (sessionId: string): Promise<IpcResult<string>> => invoke(IPC.SFTP_HOME, sessionId),
    mkdir: (sessionId: string, path: string): Promise<IpcResult<void>> =>
      invoke(IPC.SFTP_MKDIR, sessionId, path),
    remove: (sessionId: string, path: string): Promise<IpcResult<void>> =>
      invoke(IPC.SFTP_DELETE, sessionId, path),
    rename: (sessionId: string, from: string, to: string): Promise<IpcResult<void>> =>
      invoke(IPC.SFTP_RENAME, sessionId, from, to),
    chmod: (sessionId: string, path: string, mode: number): Promise<IpcResult<void>> =>
      invoke(IPC.SFTP_CHMOD, sessionId, path, mode),
    readText: (sessionId: string, path: string): Promise<IpcResult<string>> =>
      invoke(IPC.SFTP_READ, sessionId, path),
    writeText: (sessionId: string, path: string, content: string): Promise<IpcResult<void>> =>
      invoke(IPC.SFTP_WRITE, sessionId, path, content),
    upload: (
      sessionId: string,
      localPaths: string[],
      remoteDir: string
    ): Promise<IpcResult<string[]>> => invoke(IPC.SFTP_UPLOAD, sessionId, localPaths, remoteDir),
    download: (
      sessionId: string,
      remotePaths: string[],
      localDir: string
    ): Promise<IpcResult<string[]>> => invoke(IPC.SFTP_DOWNLOAD, sessionId, remotePaths, localDir),
    uploadDialog: (
      sessionId: string,
      remoteDir: string
    ): Promise<IpcResult<{ canceled: boolean; count: number }>> =>
      invoke(IPC.SFTP_UPLOAD_DIALOG, sessionId, remoteDir),
    downloadDialog: (
      sessionId: string,
      remotePaths: string[]
    ): Promise<IpcResult<{ canceled: boolean; count: number }>> =>
      invoke(IPC.SFTP_DOWNLOAD_DIALOG, sessionId, remotePaths),
    pauseTransfer: (taskId: string): Promise<IpcResult<boolean>> =>
      invoke(IPC.SFTP_TRANSFER_PAUSE, taskId),
    resumeTransfer: (taskId: string): Promise<IpcResult<boolean>> =>
      invoke(IPC.SFTP_TRANSFER_RESUME, taskId),
    cancelTransfer: (taskId: string): Promise<IpcResult<boolean>> =>
      invoke(IPC.SFTP_TRANSFER_CANCEL, taskId)
  },

  local: {
    home: (): Promise<IpcResult<string>> => invoke(IPC.LOCAL_HOME),
    drives: (): Promise<IpcResult<string[]>> => invoke(IPC.LOCAL_DRIVES),
    list: (dir: string): Promise<IpcResult<LocalFile[]>> => invoke(IPC.LOCAL_LIST, dir),
    mkdir: (dir: string, name: string): Promise<IpcResult<void>> => invoke(IPC.LOCAL_MKDIR, dir, name),
    remove: (paths: string[]): Promise<IpcResult<void>> => invoke(IPC.LOCAL_DELETE, paths),
    rename: (from: string, to: string): Promise<IpcResult<void>> =>
      invoke(IPC.LOCAL_RENAME, from, to)
  },

  logs: {
    list: (): Promise<IpcResult<SessionLogFile[]>> => invoke(IPC.LOG_LIST),
    read: (path: string): Promise<IpcResult<string>> => invoke(IPC.LOG_READ, path),
    remove: (path: string): Promise<IpcResult<void>> => invoke(IPC.LOG_DELETE, path),
    exportOne: (path: string): Promise<IpcResult<{ canceled: boolean; path?: string }>> =>
      invoke(IPC.LOG_EXPORT, path),
    openDir: (): Promise<IpcResult<void>> => invoke(IPC.LOG_OPEN_DIR)
  },

  tunnel: {
    list: (): Promise<IpcResult<TunnelConfig[]>> => invoke(IPC.TUNNEL_LIST),
    save: (input: TunnelInput): Promise<IpcResult<TunnelConfig>> => invoke(IPC.TUNNEL_SAVE, input),
    remove: (id: string): Promise<IpcResult<void>> => invoke(IPC.TUNNEL_DELETE, id),
    start: (tunnelId: string, sessionId: string): Promise<IpcResult<TunnelRuntimeInfo>> =>
      invoke(IPC.TUNNEL_START, tunnelId, sessionId),
    stop: (tunnelId: string): Promise<IpcResult<void>> => invoke(IPC.TUNNEL_STOP, tunnelId),
    states: (): Promise<IpcResult<TunnelRuntimeInfo[]>> => invoke(IPC.TUNNEL_STATES)
  },

  clip: {
    read: (): Promise<IpcResult<string>> => invoke(IPC.CLIP_READ),
    write: (text: string): Promise<IpcResult<void>> => invoke(IPC.CLIP_WRITE, text)
  },

  zmodem: {
    pickFiles: (): Promise<
      IpcResult<{ canceled: boolean; files: Array<{ name: string; size: number; data: string }> }>
    > => invoke(IPC.ZM_PICK_FILES),
    /** 选一次保存文件夹（多文件 sz 只问一次） */
    pickDir: (): Promise<IpcResult<{ canceled: boolean; token?: string; dir?: string }>> =>
      invoke(IPC.ZM_PICK_DIR),
    /** 在已选目录建目标文件（重名自动编号） */
    saveBegin: (
      token: string,
      suggestedName: string
    ): Promise<IpcResult<{ saveId: string; path: string }>> =>
      invoke(IPC.ZM_SAVE_BEGIN, token, suggestedName),
    /** 追加一块数据，避免整份文件驻留渲染进程内存 */
    saveAppend: (saveId: string, base64: string): Promise<IpcResult<{ bytes: number }>> =>
      invoke(IPC.ZM_SAVE_APPEND, saveId, base64),
    saveFinish: (saveId: string): Promise<IpcResult<{ path: string; size: number }>> =>
      invoke(IPC.ZM_SAVE_FINISH, saveId),
    sendBytes: (sessionId: string, base64: string): Promise<IpcResult<void>> =>
      invoke(IPC.ZM_SEND_BYTES, sessionId, base64)
  },

  diag: {
    sections: (): Promise<IpcResult<DiagSection[]>> => invoke(IPC.DIAG_SECTIONS_LIST),
    saveSection: (input: DiagSectionInput): Promise<IpcResult<DiagSection>> =>
      invoke(IPC.DIAG_SECTION_SAVE, input),
    removeSection: (id: string): Promise<IpcResult<void>> => invoke(IPC.DIAG_SECTION_DELETE, id),
    run: (runId: string, sessionId: string, sectionIds: string[]): Promise<IpcResult<DiagReport>> =>
      invoke(IPC.DIAG_RUN, runId, sessionId, sectionIds),
    cancel: (runId: string): Promise<IpcResult<void>> => invoke(IPC.DIAG_CANCEL, runId),
    reports: (): Promise<IpcResult<DiagReportMeta[]>> => invoke(IPC.DIAG_REPORTS_LIST),
    readReport: (id: string): Promise<IpcResult<DiagReport>> =>
      invoke(IPC.DIAG_REPORT_READ, id),
    removeReport: (id: string): Promise<IpcResult<void>> => invoke(IPC.DIAG_REPORT_DELETE, id),
    exportReport: (
      id: string,
      format: 'md' | 'html'
    ): Promise<IpcResult<{ canceled: boolean; path?: string }>> =>
      invoke(IPC.DIAG_REPORT_EXPORT, id, format),
    reportText: (id: string, format: 'md' | 'html'): Promise<IpcResult<string>> =>
      invoke(IPC.DIAG_REPORT_TEXT, id, format),
    openDir: (): Promise<IpcResult<void>> => invoke(IPC.DIAG_REPORTS_OPEN_DIR),
    bundlePreview: (reportId: string): Promise<IpcResult<BundlePreview>> =>
      invoke(IPC.DIAG_BUNDLE_PREVIEW, reportId),
    bundleExport: (
      reportId: string,
      options: BundleOptions
    ): Promise<IpcResult<{ canceled: boolean; path?: string; size?: number; entries?: number }>> =>
      invoke(IPC.DIAG_BUNDLE_EXPORT, reportId, options),
    bundleReveal: (filePath: string): Promise<IpcResult<void>> =>
      invoke(IPC.DIAG_BUNDLE_REVEAL, filePath)
  },

  batch: {
    run: (
      runId: string,
      sessionIds: string[],
      command: string,
      timeoutMs: number
    ): Promise<IpcResult<BatchSessionResult[]>> =>
      invoke(IPC.BATCH_RUN, runId, sessionIds, command, timeoutMs),
    cancel: (runId: string): Promise<IpcResult<void>> => invoke(IPC.BATCH_CANCEL, runId)
  },

  profiles: {
    list: (): Promise<IpcResult<DeviceProfile[]>> => invoke(IPC.PROFILE_LIST),
    save: (input: DeviceProfileInput): Promise<IpcResult<DeviceProfile>> =>
      invoke(IPC.PROFILE_SAVE, input),
    remove: (id: string): Promise<IpcResult<void>> => invoke(IPC.PROFILE_DELETE, id)
  },

  metrics: {
    start: (sessionId: string): Promise<IpcResult<void>> => invoke(IPC.METRICS_START, sessionId),
    stop: (sessionId: string): Promise<IpcResult<void>> => invoke(IPC.METRICS_STOP, sessionId),
    states: (): Promise<IpcResult<string[]>> => invoke(IPC.METRICS_STATES)
  },

  firmware: {
    pickFile: (): Promise<IpcResult<{ canceled: boolean; file?: FirmwareFileInfo }>> =>
      invoke(IPC.FW_PICK_FILE),
    upload: (
      sessionId: string,
      localPath: string,
      remoteDir: string
    ): Promise<IpcResult<{ taskId: string; remotePath: string }>> =>
      invoke(IPC.FW_UPLOAD, sessionId, localPath, remoteDir),
    verify: (
      sessionId: string,
      localPath: string,
      remotePath: string
    ): Promise<IpcResult<FirmwareVerifyResult>> =>
      invoke(IPC.FW_VERIFY, sessionId, localPath, remotePath),
    upgrade: (
      runId: string,
      sessionId: string,
      command: string,
      timeoutMs: number
    ): Promise<IpcResult<FirmwareUpgradeResult>> =>
      invoke(IPC.FW_UPGRADE, runId, sessionId, command, timeoutMs),
    cancel: (runId: string): Promise<IpcResult<void>> => invoke(IPC.FW_CANCEL, runId),
    reboot: (sessionId: string, command: string): Promise<IpcResult<void>> =>
      invoke(IPC.FW_REBOOT, sessionId, command),
    probe: (host: string, port: number, timeoutMs?: number): Promise<IpcResult<NetProbeResult>> =>
      invoke(IPC.NET_PROBE, host, port, timeoutMs)
  },

  discovery: {
    interfaces: (): Promise<IpcResult<NetInterfaceInfo[]>> => invoke(IPC.NET_IFACES),
    scan: (
      runId: string,
      cidr: string,
      ports: number[],
      timeoutMs?: number
    ): Promise<IpcResult<DiscoverHost[]>> => invoke(IPC.NET_SCAN, runId, cidr, ports, timeoutMs),
    cancel: (runId: string): Promise<IpcResult<void>> => invoke(IPC.NET_SCAN_CANCEL, runId),
    mdns: (timeoutMs?: number): Promise<IpcResult<MdnsService[]>> => invoke(IPC.NET_MDNS, timeoutMs)
  },

  exec: {
    run: (sessionId: string, command: string, timeoutMs?: number): Promise<IpcResult<SshExecResult>> =>
      invoke(IPC.SSH_EXEC, sessionId, command, timeoutMs)
  },

  backups: {
    list: (): Promise<IpcResult<BackupMeta[]>> => invoke(IPC.BACKUP_LIST),
    create: (
      sessionId: string,
      name: string,
      paths: string[]
    ): Promise<IpcResult<BackupDetail>> => invoke(IPC.BACKUP_CREATE, sessionId, name, paths),
    remove: (id: string): Promise<IpcResult<void>> => invoke(IPC.BACKUP_DELETE, id),
    detail: (id: string): Promise<IpcResult<BackupDetail>> => invoke(IPC.BACKUP_DETAIL, id),
    diff: (id: string, path: string, sessionId: string): Promise<IpcResult<BackupDiffResult>> =>
      invoke(IPC.BACKUP_DIFF, id, path, sessionId),
    restore: (
      id: string,
      sessionId: string,
      paths: string[]
    ): Promise<IpcResult<{ restored: number; failed: Array<{ path: string; error: string }> }>> =>
      invoke(IPC.BACKUP_RESTORE, id, sessionId, paths),
    openDir: (): Promise<IpcResult<void>> => invoke(IPC.BACKUP_OPEN_DIR)
  },

  win: {
    minimize: (): Promise<void> => ipcRenderer.invoke(IPC.WIN_MINIMIZE) as Promise<void>,
    toggleMax: (): Promise<void> => ipcRenderer.invoke(IPC.WIN_TOGGLE_MAX) as Promise<void>,
    close: (): Promise<void> => ipcRenderer.invoke(IPC.WIN_CLOSE) as Promise<void>
  },

  on: {
    sessionData: (cb: (e: SessionDataEvent) => void): (() => void) =>
      subscribe(IPC.EVT_SESSION_DATA, cb),
    sessionStatus: (cb: (e: SessionStatusEvent) => void): (() => void) =>
      subscribe(IPC.EVT_SESSION_STATUS, cb),
    sessionLatency: (cb: (e: LatencyEvent) => void): (() => void) =>
      subscribe(IPC.EVT_SESSION_LATENCY, cb),
    transferProgress: (cb: (e: TransferProgressEvent) => void): (() => void) =>
      subscribe(IPC.EVT_TRANSFER_PROGRESS, cb),
    tunnelStatus: (cb: (e: TunnelRuntimeInfo) => void): (() => void) =>
      subscribe(IPC.EVT_TUNNEL_STATUS, cb),
    diagProgress: (cb: (e: DiagProgressEvent) => void): (() => void) =>
      subscribe(IPC.EVT_DIAG_PROGRESS, cb),
    batchProgress: (cb: (e: BatchProgressEvent) => void): (() => void) =>
      subscribe(IPC.EVT_BATCH_PROGRESS, cb),
    metrics: (cb: (e: MetricsEvent) => void): (() => void) => subscribe(IPC.EVT_METRICS, cb),
    fwLog: (cb: (e: FirmwareLogEvent) => void): (() => void) => subscribe(IPC.EVT_FW_LOG, cb),
    discoverProgress: (cb: (e: DiscoverProgressEvent) => void): (() => void) =>
      subscribe(IPC.EVT_DISCOVER_PROGRESS, cb)
  }
}

export type WorkbenchApi = typeof api

contextBridge.exposeInMainWorld('api', api)
