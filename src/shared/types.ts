/**
 * 全局共享类型 —— 主进程 / 预加载 / 渲染进程三端共用。
 * 这是三端唯一的契约来源：改这里，三端类型同步生效。
 */

/* ------------------------------------------------------------------ *
 *  SSH 连接
 * ------------------------------------------------------------------ */

export type AuthType = 'password' | 'privateKey' | 'agent'

export interface ProxyConfig {
  type: 'socks5' | 'http'
  host: string
  port: number
  username?: string
  password?: string
}

export interface Connection {
  id: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  /** 私钥文件路径（authType = privateKey） */
  privateKeyPath?: string
  /** 分组名，'/' 分隔表示层级 */
  group: string
  tags: string[]
  /** 列表左侧色标（十六进制） */
  color?: string
  remark?: string
  /** 跳板机链（ProxyJump），存的是其他 Connection 的 id，按顺序跳 */
  proxyJump?: string[]
  proxy?: ProxyConfig
  lastUsedAt?: number
  createdAt: number
  updatedAt: number
}

/* ---------- 连接导出 / 导入（发给同事直接可用） ---------- */

export interface ConnExportOptions {
  /** 只导出这些分组；缺省 = 全部 */
  groups?: string[]
  /** 是否带上密码与私钥（不带则对方需自行补全凭据） */
  includeSecrets: boolean
  /** 设置后用口令加密整个文件 */
  passphrase?: string
}

export interface ConnExportResult {
  canceled: false
  path: string
  count: number
  /** 打包的私钥文件数（相同私钥只存一份） */
  keyCount: number
  /** 密码登录但本机没有可用密码的连接数 */
  noPassword: number
  /** 私钥登录但私钥文件找不到的连接数 */
  missingKeys: number
  /** 跳板机不在导出范围内、被去掉的引用数 */
  droppedJumps: number
}

/** skip = 跳过重复；overwrite = 覆盖重复（名称+地址+端口+用户名相同视为重复） */
export type ConnImportMode = 'skip' | 'overwrite'

export interface ConnImportPreview {
  path: string
  encrypted: boolean
  exportedAt?: number
  count: number
  groups: Array<{ name: string; count: number }>
  /** 与本机现有连接重复的条数 */
  duplicates: number
  keyCount: number
  /** 带凭据（密码 / 私钥）的连接数 */
  withSecrets: number
  /** 字段不合法被忽略的条数 */
  invalid: number
}

export interface ConnImportResult {
  added: number
  updated: number
  skipped: number
  keysWritten: number
  invalid: number
}

/** 连接凭据：独立于连接对象存储，密文落盘（safeStorage） */
export interface ConnectionSecret {
  connectionId: string
  password?: string
  passphrase?: string
}

export type ConnStatus =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'error'

/* ------------------------------------------------------------------ *
 *  常用命令（重点模块）
 * ------------------------------------------------------------------ */

export interface CommandVariable {
  /** 占位符名，对应命令内的 {{name}} */
  name: string
  /** 表单展示名 */
  label?: string
  type: 'text' | 'select'
  defaultValue?: string
  /** type = select 时的候选项 */
  options?: string[]
  placeholder?: string
  required?: boolean
}

export interface Command {
  id: string
  name: string
  /** 命令原文，支持 {{var}} 占位符 */
  command: string
  description?: string
  /** 分组名，'/' 分隔表示层级 */
  group: string
  /** lucide-react 图标名 */
  icon?: string
  color?: string
  /** 危险命令：发送前必须二次确认 */
  confirmRequired: boolean
  variables: CommandVariable[]
  sortOrder: number
  /** 使用次数，用于「最常用」排序 */
  useCount: number
  lastUsedAt?: number
  createdAt: number
  updatedAt: number
}

export interface CommandHistoryEntry {
  id: string
  sessionId: string
  connectionId: string
  connectionName: string
  /** 实际发送到终端的命令原文（变量已替换） */
  command: string
  /** 变量取值，便于一键还原 */
  variables?: Record<string, string>
  source: 'manual' | 'snippet'
  /** 来自哪条常用命令 */
  snippetId?: string
  executedAt: number
}

/* ------------------------------------------------------------------ *
 *  会话 / 终端
 * ------------------------------------------------------------------ */

export interface SessionInfo {
  id: string
  connectionId: string
  connectionName: string
  host: string
  username: string
  title: string
  status: ConnStatus
  error?: string
  createdAt: number
  /** 最近一次探测的往返延迟（ms） */
  latencyMs?: number
  cols: number
  rows: number
}

/* ------------------------------------------------------------------ *
 *  设置
 * ------------------------------------------------------------------ */

export type ThemeMode = 'dark' | 'light' | 'system'

/**
 * 配色主题（界面外壳 + 终端调色板联动）。
 * 与 ThemeMode 是两个正交维度：
 *   theme     决定明暗（dark / light / 跟随系统）
 *   colorTheme 在这套明暗之上换一整套配色
 * 每个配色主题都同时提供 dark 与 light 两套变量，因此任意组合都成立。
 */
export type ColorThemeId = 'workbench' | 'dracula' | 'nord' | 'solarized' | 'onedark' | 'gruvbox'

export interface TerminalPrefs {
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorStyle: 'block' | 'underline' | 'bar'
  cursorBlink: boolean
  scrollback: number
}

export interface AppSettings {
  theme: ThemeMode
  /** 配色主题（缺省为 workbench，即原有 GitHub 风格配色） */
  colorTheme?: ColorThemeId
  terminal: TerminalPrefs
  /** 常用命令面板位置 */
  commandPanelPosition: 'right' | 'bottom' | 'floating'
  /** 是否执行前探测会话延迟 */
  latencyProbe: boolean
  /** 是否自动录制会话日志（终端输入输出，cast 格式） */
  autoLog: boolean
  /** 危险命令关键词（命中即需要二次确认，即使命令未标记危险） */
  dangerPatterns: string[]
  /** 连接时忽略主机指纹首次记录（严格模式默认开启校验） */
  strictHostKey: boolean
  /** 快捷键映射（action -> 组合键），缺省项使用内置默认 */
  shortcuts?: ShortcutMap
  /** 手动新建的常用命令分组（含暂时没有命令的空分组） */
  commandGroups?: string[]
  /** 常用命令分组的显示顺序（分组名数组）；未列出的分组排在后面按名称排序 */
  commandGroupOrder?: string[]
}

/** 可自定义的快捷键动作 */
export type ShortcutAction =
  | 'newConnection'
  | 'settings'
  | 'togglePanel'
  | 'nextTab'
  | 'closeTab'
  | 'terminalSearch'
  | 'terminalCopy'
  | 'terminalPaste'

export type ShortcutMap = Partial<Record<ShortcutAction, string>>

/* ------------------------------------------------------------------ *
 *  设备档案（P2 使用，类型先行）
 * ------------------------------------------------------------------ */

export interface DeviceProfile {
  id: string
  customerName: string
  project?: string
  deviceModel?: string
  sn?: string
  firmwareVersion?: string
  contact?: string
  ticketNo?: string
  connectionIds: string[]
  /** 常用命令分组名（与命令面板 group 对应，一个档案一键筛选该客户在用命令） */
  commandGroup?: string
  remark?: string
  createdAt: number
  updatedAt: number
}

export interface DeviceProfileInput {
  id?: string
  customerName: string
  project?: string
  deviceModel?: string
  sn?: string
  firmwareVersion?: string
  contact?: string
  ticketNo?: string
  connectionIds: string[]
  commandGroup?: string
  remark?: string
}

/* ------------------------------------------------------------------ *
 *  资源仪表盘（实时监控）
 * ------------------------------------------------------------------ */

/** 一次采样的指标快照（字段缺省 = 该设备不支持或首次基准未建立） */
export interface MetricsSample {
  ts: number
  /** CPU 使用率 %（首次采样无基准，缺省） */
  cpuPercent?: number
  memPercent?: number
  memTotalMb?: number
  memUsedMb?: number
  diskPercent?: number
  diskUsedGb?: number
  diskTotalGb?: number
  /** 网络速率 KB/s（首次采样无基准，缺省） */
  netRxKbps?: number
  netTxKbps?: number
  /** 温度 ℃ */
  tempC?: number
  load1?: number
}

export interface MetricsEvent {
  sessionId: string
  /** true = 样本推送；false = 停止（error 有值说明是异常停止） */
  running: boolean
  sample?: MetricsSample
  error?: string
}

/* ------------------------------------------------------------------ *
 *  IPC 请求 / 响应
 * ------------------------------------------------------------------ */

export interface ConnectionInput {
  id?: string
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  privateKeyPath?: string
  passphrase?: string
  group: string
  tags: string[]
  color?: string
  remark?: string
  proxyJump?: string[]
  proxy?: ProxyConfig
}

export interface TestConnectionInput {
  /** 编辑已保存连接时传入：未重新输入密码则复用保险箱中的凭据 */
  connectionId?: string
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  privateKeyPath?: string
  passphrase?: string
  proxyJump?: string[]
  proxy?: ProxyConfig
}

export interface TestConnectionResult {
  ok: boolean
  error?: string
  durationMs: number
  /** 远端 banner */
  banner?: string
  /** 主机密钥指纹（SHA256） */
  fingerprint?: string
}

/** 剪贴板 ssh 命令解析结果 */
export interface ParsedSshCommand {
  ok: boolean
  username?: string
  host?: string
  port?: number
  privateKeyPath?: string
}

export interface CommandInput {
  id?: string
  name: string
  command: string
  description?: string
  group: string
  icon?: string
  color?: string
  confirmRequired: boolean
  variables: CommandVariable[]
}

export interface HistoryFilter {
  connectionId?: string
  /** 关键字，模糊匹配命令文本 */
  keyword?: string
  limit?: number
}

/* ------------------------------------------------------------------ *
 *  SFTP / 本地文件管理
 * ------------------------------------------------------------------ */

/** 远端文件条目（SFTP readdir 结果） */
export interface RemoteFile {
  name: string
  path: string
  type: 'file' | 'directory' | 'symlink'
  size: number
  mode: number
  /** 权限字符串，如 -rwxr-xr-x */
  modeStr: string
  uid: number
  gid: number
  mtime: number
  isLink: boolean
}

/** 传输任务（渲染层维护的任务视图） */
export interface TransferTask {
  id: string
  sessionId: string
  direction: 'upload' | 'download'
  localPath: string
  remotePath: string
  transferred: number
  total: number
  status: 'pending' | 'running' | 'done' | 'error' | 'canceled'
  error?: string
  speedBps?: number
  /** 进度单位：字节（单文件）或文件个数（目录递归传输）；缺省按 bytes 处理 */
  unit?: 'bytes' | 'files'
  startedAt: number
  finishedAt?: number
}

export interface LocalFile {
  name: string
  path: string
  isDir: boolean
  size: number
  mtime: number
}

/** 传输进度推送（主进程 -> 渲染进程，节流发送） */
export interface TransferProgressEvent {
  taskId: string
  sessionId: string
  direction: 'upload' | 'download'
  localPath: string
  remotePath: string
  transferred: number
  total: number
  status: TransferTask['status']
  error?: string
  speedBps?: number
  /** 进度单位：bytes=字节数，files=已完成文件数（目录传输） */
  unit?: 'bytes' | 'files'
}

/* ------------------------------------------------------------------ *
 *  端口转发 / 隧道
 * ------------------------------------------------------------------ */

/**
 * local   (-L)：本机监听 → 经 SSH 隧道 → 远端可访问的目标（如设备 Web UI / 内网服务）
 * remote  (-R)：远端监听 → 经 SSH 隧道 → 本机可访问的目标（把本机服务临时暴露给设备）
 * dynamic (-D)：本机建立 SOCKS5 代理，全部流量经 SSH 隧道出去（相当于简易 VPN）
 */
export type TunnelType = 'local' | 'remote' | 'dynamic'

export interface TunnelConfig {
  id: string
  name: string
  type: TunnelType
  /** local/dynamic = 本机监听地址；remote = 远端监听地址 */
  bindHost: string
  /** local/dynamic = 本机监听端口；remote = 远端监听端口（0 = 由服务端分配） */
  bindPort: number
  /** local = 相对远端可达的目标地址；remote = 相对本机可达的目标地址；dynamic 不用 */
  targetHost?: string
  targetPort?: number
  /** 关联的连接（启动时优先用该连接的在线会话；留空则用当前活动会话） */
  connectionId?: string
  remark?: string
  createdAt: number
  updatedAt: number
}

export interface TunnelInput {
  id?: string
  name: string
  type: TunnelType
  bindHost: string
  bindPort: number
  targetHost?: string
  targetPort?: number
  connectionId?: string
  remark?: string
}

export type TunnelStatus = 'stopped' | 'starting' | 'active' | 'error'

/** 隧道的实时运行状态（主进程维护，事件推送到渲染层） */
export interface TunnelRuntimeInfo {
  tunnelId: string
  status: TunnelStatus
  sessionId?: string
  sessionTitle?: string
  error?: string
  startedAt?: number
  /** 已转发的连接数 */
  connectionCount: number
  /** remote 类型 bindPort=0 时，服务端实际分配的端口 */
  actualPort?: number
}

/* ------------------------------------------------------------------ *
 *  一键诊断巡检 + 报告
 * ------------------------------------------------------------------ */

/** 诊断项（内置或自定义）：一条在设备侧执行的采集命令 */
export interface DiagSection {
  id: string
  name: string
  group: string
  command: string
  /** 单节执行超时 ms */
  timeoutMs: number
  description?: string
  /** 内置节不可删除/改名，可复制为自定义 */
  builtin: boolean
  createdAt?: number
  updatedAt?: number
}

export interface DiagSectionInput {
  id?: string
  name: string
  group: string
  command: string
  timeoutMs: number
  description?: string
}

export type DiagSectionStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'error'
  | 'timeout'
  | 'skipped'

export interface DiagSectionResult {
  sectionId: string
  name: string
  group: string
  command: string
  status: DiagSectionStatus
  /** stdout（超长已截断） */
  output: string
  /** stderr 或错误说明 */
  error?: string
  exitCode: number | null
  durationMs: number
}

export interface DiagReportMeta {
  id: string
  title: string
  connectionName: string
  host: string
  username: string
  startedAt: number
  finishedAt: number
  sectionCount: number
  /** 正常完成的节数 */
  okCount: number
  /** 异常/超时/跳过的节数 */
  problemCount: number
  size: number
}

export interface DiagReport extends DiagReportMeta {
  sections: DiagSectionResult[]
}

/** 诊断进度推送（主进程 -> 渲染进程，逐节推送） */
export interface DiagProgressEvent {
  runId: string
  sectionId: string
  status: DiagSectionStatus
  index: number
  total: number
  result?: DiagSectionResult
}

/** 诊断打包（zip）选项与预览 */
export interface BundleOptions {
  includeLogs: boolean
  includeHistory: boolean
  includeBackups: boolean
}

export interface BundlePreview {
  reportTitle: string
  connectionName: string
  host: string
  logFiles: number
  logBytes: number
  historyCount: number
  backups: number
  profileName?: string
}

/* ------------------------------------------------------------------ *
 *  多设备批量执行
 * ------------------------------------------------------------------ */

export type BatchStatus = 'running' | 'done' | 'error' | 'timeout' | 'cancelled'

export interface BatchSessionResult {
  sessionId: string
  sessionTitle: string
  host: string
  username: string
  status: BatchStatus
  stdout: string
  stderr: string
  exitCode: number | null
  durationMs: number
  /** 执行框架层面的错误（如会话不可用） */
  error?: string
}

export interface BatchProgressEvent {
  runId: string
  sessionId: string
  status: BatchStatus
  result?: BatchSessionResult
}

/* ------------------------------------------------------------------ *
 *  固件升级助手
 * ------------------------------------------------------------------ */

export interface FirmwareFileInfo {
  path: string
  name: string
  size: number
}

export interface FirmwareVerifyResult {
  algo: 'sha256' | 'md5'
  localHash: string
  remoteHash: string
  match: boolean
  remotePath: string
}

export interface FirmwareUpgradeResult {
  runId: string
  status: 'done' | 'timeout' | 'cancelled' | 'error'
  exitCode: number | null
  output: string
  error?: string
  durationMs: number
}

/** 升级过程的实时输出（主进程 -> 渲染进程） */
export interface FirmwareLogEvent {
  runId: string
  stream: 'out' | 'err'
  chunk: string
}

/** 一次性命令执行结果（抓启动日志等通用场景） */
export interface SshExecResult {
  status: 'done' | 'timeout' | 'cancelled' | 'error'
  exitCode: number | null
  stdout: string
  stderr: string
  error?: string
}

export interface NetProbeResult {
  reachable: boolean
  latencyMs?: number
}

/* ------------------------------------------------------------------ *
 *  设备发现（局域网扫描 / mDNS）
 * ------------------------------------------------------------------ */

export interface NetInterfaceInfo {
  name: string
  address: string
  netmask: string
  /** 可直接用于扫描的网段，如 192.168.1.0/24 */
  cidr: string
  hostCount: number
}

export interface DiscoverHost {
  ip: string
  openPorts: number[]
  latencyMs?: number
  hostname?: string
  mac?: string
}

export interface DiscoverProgressEvent {
  runId: string
  scanned: number
  total: number
  found: DiscoverHost[]
  done: boolean
}

export interface MdnsService {
  /** 服务类型，如 _http._tcp.local */
  type: string
  /** 实例名（去掉类型后缀） */
  name: string
  host?: string
  address?: string
  port?: number
}

/* ------------------------------------------------------------------ *
 *  配置备份对比
 * ------------------------------------------------------------------ */

export interface BackupFileEntry {
  path: string
  size: number
  mtime?: number
  content?: string
  /** 备份时读取失败的原因 */
  error?: string
}

export interface BackupMeta {
  id: string
  name: string
  connectionName: string
  host: string
  createdAt: number
  fileCount: number
  totalSize: number
  paths: string[]
}

export interface BackupDetail extends BackupMeta {
  files: BackupFileEntry[]
}

export type BackupDiffStatus = 'same' | 'changed' | 'remote-missing' | 'error'

export interface DiffLine {
  type: 'same' | 'add' | 'del'
  text: string
}

export interface BackupDiffResult {
  status: BackupDiffStatus
  lines: DiffLine[]
  added: number
  removed: number
  error?: string
}

/* ------------------------------------------------------------------ *
 *  会话日志录制
 * ------------------------------------------------------------------ */

/** 一次会话的录制文件（asciinema cast v2 兼容格式） */
export interface SessionLogFile {
  path: string
  /** 文件名，形如 20261014-155401-A区.cast */
  name: string
  size: number
  mtime: number
}

/** 统一 IPC 返回结构：主进程永不抛异常给渲染层，统一包装 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** 会话状态推送 */
export interface SessionStatusEvent {
  sessionId: string
  status: ConnStatus
  error?: string
}

/** 终端数据推送（主进程 -> 渲染进程） */
export interface SessionDataEvent {
  sessionId: string
  data: string
  /**
   * 与 data 对应的原始字节（base64）。
   * ZMODEM 等二进制协议只有在原始字节上才能正确解析，
   * 而 data 是经 StringDecoder 解码的文本，不能用于协议解析。
   */
  raw?: string
}
