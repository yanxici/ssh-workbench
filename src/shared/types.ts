/**
 * 全局共享类型 —— 主进程 / 预加载 / 渲染进程三端共用。
 * 这是三端唯一的契约来源：改这里，三端类型同步生效。
 */

/* ------------------------------------------------------------------ *
 *  SSH 连接
 * ------------------------------------------------------------------ */

export type AuthType = 'password' | 'privateKey' | 'agent'

/**
 * 连接类型。
 *
 * 用同一个 Connection 实体承载两种连接，而不是并列两套实体：
 * 分组、标签、色标、备注、最近使用时间、搜索、批量打标签、导入导出
 * 这些能力对两种连接完全一样，拆两套就要复制一遍。
 *
 * 缺省（undefined）一律按 'ssh' 处理 —— V1.x 存下来的连接没有这个字段，
 * 不做数据迁移，读取时就地兜底。
 */
export type ConnKind = 'ssh' | 'serial'

export type SerialDataBits = 5 | 6 | 7 | 8
export type SerialStopBits = 1 | 1.5 | 2
export type SerialParity = 'none' | 'even' | 'odd' | 'mark' | 'space'
export type SerialFlowControl = 'none' | 'hardware' | 'software'
/** 串口字符编码。现场设备大量是 GBK（国产模组、老工控屏），UTF-8 会显示成乱码 */
export type SerialCharset = 'utf-8' | 'gbk' | 'gb18030'
/**
 * 发送时追加的换行。
 *
 * 必须是配置项而不是写死 CR：U-Boot / BusyBox 认 LF，多数 MCU 的 AT 通道认 CR，
 * 而 Windows 串口工具惯用 CRLF。认 CR 的设备收到 CRLF 会当成两次回车，
 * 直接执行两遍命令 —— 在设备上是实打实的副作用。
 */
export type SerialNewline = 'cr' | 'lf' | 'crlf'

/** 串口连接参数（仅 kind = 'serial' 时有值） */
export interface SerialConfig {
  /** 端口路径：Windows 为 COM3，Linux/macOS 为 /dev/ttyUSB0 */
  path: string
  baudRate: number
  dataBits: SerialDataBits
  stopBits: SerialStopBits
  parity: SerialParity
  flowControl: SerialFlowControl
  charset: SerialCharset
  newline: SerialNewline
  /**
   * 打开端口时是否拉 DTR 触发设备复位。
   *
   * 默认关闭。ESP32 / STM32 / Arduino 的自动下载电路会把 DTR 接到 EN 脚，
   * 一拉就重启 —— 用户只是想看日志，结果把设备重启了，在现场是事故。
   */
  autoReset?: boolean
  /**
   * 逐字符发送间隔（毫秒），0 / 缺省 = 整段直发。
   *
   * 为什么需要：往 U-Boot 提示符或 9600 波特率的老设备上粘贴一整条长命令时，
   * 对端常常来不及收 —— 缓冲区溢出的表现是中间几个字符凭空消失，
   * 用户看到的命令和发出去的不是同一条，排查时极易误判成设备问题。
   * 加上字符间隔后，发送节奏由本端控制，等价于「手敲得慢一点」。
   *
   * 上限见 serialTiming.ts 的 SERIAL_MAX_CHAR_DELAY_MS：延迟是按字符累加的，
   * 允许填大值等于允许把一次粘贴变成几分钟的无响应。
   */
  charDelayMs?: number
  /**
   * 每个换行之后的追加间隔（毫秒），0 / 缺省 = 不加。
   *
   * 有些设备（AT 通道、bootloader 菜单）要「执行完这一行才回 OK」，
   * 连发多条命令时即使逐字符间隔够大，行与行之间仍会撞车。
   */
  lineDelayMs?: number
  /**
   * USB 身份，用于拔插后找回同一台设备。
   *
   * 优先 serialNumber（芯片出厂唯一），退而求其次 pnpId（含 VID/PID/序列号，
   * 但某些廉价 CH340 的 pnpId 只有 VID/PID，同型号两个设备就分不开），
   * 两者都没有时只能退回 COM 号 —— 那时拔插后可能连到别的设备上，
   * 见 resolveSerialPath 的注释。
   */
  usbSerialNumber?: string
  usbPnpId?: string
  /**
   * 端口待确认：导入别人的连接、或插拔后原端口消失且无法用 USB 身份匹配时置位。
   * 渲染层据此提示「请重新选择端口」，而不是拿着一个不存在的 COM 号去连。
   */
  pathPending?: boolean
}

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
  /** 连接类型；缺省按 'ssh' 处理 */
  kind?: ConnKind
  /**
   * SSH 主机。
   *
   * 串口连接保留这个字段但存空串 —— 不改成可选，因为可选会让所有读
   * conn.host 的地方（连接配置构建、指纹校验、跳板、导入导出、搜索）
   * 全部需要收窄，扩散面几十处，而收益只是"类型上更诚实"。
   * 语义上：host / port / username / authType 只对 kind='ssh' 有意义，
   * 串口连接的界面与逻辑一律先看 kind 再决定读不读这些字段。
   */
  host: string
  port: number
  username: string
  authType: AuthType
  /** 私钥文件路径（authType = privateKey） */
  privateKeyPath?: string
  /** 串口参数（kind = 'serial'） */
  serial?: SerialConfig
  /** 分组名，'/' 分隔表示层级 */
  group: string
  tags: string[]
  /** 列表左侧色标（十六进制） */
  color?: string
  remark?: string
  /** 跳板机链（ProxyJump），存的是其他 Connection 的 id，按顺序跳 */
  proxyJump?: string[]
  proxy?: ProxyConfig
  /** 启用老设备兼容算法（旧固件只支持 group1-sha1 / ssh-dss / 3des-cbc 等） */
  legacyAlgorithms?: boolean
  lastUsedAt?: number
  createdAt: number
  updatedAt: number
}

/** 系统枚举到的串口（SerialPort.list() 的投影，只保留用得上的字段） */
export interface SerialPortInfo {
  path: string
  manufacturer?: string
  serialNumber?: string
  pnpId?: string
  locationId?: string
  productId?: string
  vendorId?: string
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
  /** 串口连接数 */
  serialCount: number
  /**
   * 其中端口需要重新确认的条数：别人机器上的 COM 号在本机大概率不存在，
   * 且没有 USB 身份可以对上。导入后这些连接带着「待确认」标记，
   * 用户得自己选一次端口才能连。
   */
  pendingPorts: number
}

export interface ConnImportResult {
  added: number
  updated: number
  skipped: number
  keysWritten: number
  /** 文件里格式不对、被丢弃的私钥数（这些连接会退回原私钥或不带私钥） */
  invalidKeys: number
  invalid: number
  /** 端口待确认的串口连接数（见 ConnImportPreview.pendingPorts） */
  pendingPorts: number
}

/** 连接凭据：独立于连接对象存储，密文落盘（safeStorage） */
export interface ConnectionSecret {
  connectionId: string
  password?: string
  passphrase?: string
}

/* ---------- 外部 SSH 客户端导入（ssh_config / MobaXterm / Xshell / SecureCRT / FinalShell） ---------- */

/** 外部配置来源；与 src/main/store/externalImport.ts 的解析器一一对应 */
export type ExternalImportSource =
  | 'ssh-config'
  | 'mobaxterm'
  | 'xshell'
  | 'securecrt'
  | 'finalshell'

/**
 * 导入预览。
 *
 * 刻意不带任何凭据字段：这几家的密码都是各自算法加密的（SecureCRT 的 Blowfish、
 * Xshell 的会话密钥），解析它们既不可靠也没必要 —— 导入只搬「连到哪、用什么身份」。
 */
export interface ExternalImportPreview {
  source: ExternalImportSource
  /** 解析出的 SSH 连接数 */
  count: number
  groups: Array<{ name: string; count: number }>
  /** 与本机现有连接重复的条数（名称+地址+端口+用户名） */
  duplicates: number
  /** 协议不是 SSH 被跳过的会话数（RDP / VNC / Telnet ...） */
  skippedNonSsh: number
  /** 字段缺失或格式坏掉、无法成条的会话数 */
  invalid: number
  /** 导入后需要自己补密码的连接数 */
  withoutPasswordCount: number
  /** 前几条连接名，供预览列表展示 */
  sampleNames: string[]
  /** 实际读取的配置文件数 */
  files: number
}

export interface ExternalImportResult {
  added: number
  updated: number
  skipped: number
  invalid: number
  skippedNonSsh: number
  files: number
}

/**
 * 连接过程中的细分阶段。
 *
 * 为什么需要它：原先只有 connecting / connected / disconnected 三态，
 * 用户在看到「连接中」时无法判断卡在哪一步 —— TCP 没通、认证被拒、还是跳板链在等。
 * 这三类问题的排查动作完全不同（查网络 / 查凭据 / 查跳板机），所以必须外露。
 *
 * 取值刻意保持粗粒度：细到「第几个跳板」对用户没有意义，反而让状态栏抖动。
 */
export type ConnPhase = 'tcp' | 'handshake' | 'auth' | 'jump' | 'shell'

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
  /**
   * 适用环境。缺省（undefined）= SSH 与串口都适用。
   * 内置命令大多是为 shell 写的（systemctl / journalctl / lsblk），
   * 串口 Console 接的常是 bootloader、U-Boot 或 BusyBox，一半按钮按下去只会报错，
   * 所以需要这个标记把不适用的从串口会话里滤掉。
   */
  envs?: ConnKind[]
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
  /** 连接类型；缺省按 'ssh' 处理 */
  kind?: ConnKind
  /**
   * SSH 主机（串口会话为空串）。
   * 与 Connection.host 同理：保持必填形状，显示一律用 target。
   */
  host: string
  username: string
  /**
   * 一行显示用的目标描述，取代渲染层到处拼 `${username}@${host}`。
   *
   * SSH 会话是 `user@host`，串口会话是 `COM3 · 115200 8N1`。
   * 以前每个面板各自拼字符串，串口接进来之后这些地方全会显示成
   * `@`（空串拼接），所以统一收到主进程算好、渲染层只负责显示。
   */
  target: string
  title: string
  status: ConnStatus
  /**
   * 连接细分阶段（仅在 status === 'connecting' 时有意义）。
   * 缺省表示未知（老数据 / 串口会话）。
   */
  phase?: ConnPhase
  error?: string
  createdAt: number
  /** 最近一次探测的往返延迟（ms） */
  latencyMs?: number
  cols: number
  rows: number
  /**
   * 串口会话当前生效的波特率（SSH 会话无此字段）。
   *
   * 单独给一个字段而不是让渲染层从 target 里抠数字：target 是给人看的一整串
   * （`COM3 · 115200 8N1`），而且用户在会话中途可以改速率 —— 那时 target 与
   * 输入框都该跟着变，靠字符串解析会把「改了但显示没改」变成常态故障。
   */
  baudRate?: number
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
export type ColorThemeId = 'vscode' | 'gruvbox' | 'solarized' | 'dracula'

export interface TerminalPrefs {
  fontFamily: string
  fontSize: number
  lineHeight: number
  cursorStyle: 'block' | 'underline' | 'bar'
  cursorBlink: boolean
  scrollback: number
  /** 选中终端文本后自动复制到剪贴板 */
  copyOnSelect?: boolean
  /** 右键直接复制/粘贴（按住 Shift+右键 唤出完整菜单） */
  rightClickPaste?: boolean
  /** 拖文件进终端时的默认通道：sftp = 直传当前目录，trzsz = 走 trzsz 协议 */
  dropUploadMode?: 'sftp' | 'trzsz'
  /** 粘贴多行内容前弹确认框（单行从不弹）；undefined 视为开 */
  confirmMultilinePaste?: boolean
}

/**
 * 终端输出高亮的一条规则。
 *
 * 为什么 pattern 存字符串而不是 RegExp：它要落进 settings.json。
 * 正则源串 + 标志分开存，编译时机由使用方决定（渲染层 compileRules），
 * 这样「写错的正则」可以在设置页就地报错，而不是加载设置时整份配置炸掉。
 *
 * 为什么只支持 #RRGGBB：xterm 的 IDecorationOptions.backgroundColor /
 * foregroundColor 只认这一种格式，喂 rgba() 会静默不上色。
 */
export interface HighlightRule {
  id: string
  name: string
  /** 正则源串（不含定界符） */
  pattern: string
  /** 正则标志，只允许 i / m / s / u 的子集（g、y 有状态，会残留 lastIndex） */
  flags?: string
  enabled: boolean
  /** 整行背景色 */
  background?: string
  /** 行内文字前景色（缺省保留终端原有配色） */
  foreground?: string
}

/**
 * 终端输出高亮的偏好。
 *
 * 缺省规则（两条内置规则）刻意**不**写在主进程的 DEFAULT_SETTINGS 里，
 * 而是由渲染层的 lib/highlight.ts 提供 —— 规则的默认值和渲染逻辑必须
 * 待在一起，否则两边各存一份必然漂移（本项目已经有过 FALLBACK 与
 * DEFAULT_SETTINGS 不一致的先例）。这里 undefined 就表示「用渲染层默认」。
 */
export interface OutputHighlightPrefs {
  enabled: boolean
  rules: HighlightRule[]
}

/**
 * 界面语言。新增语言时同步 src/renderer/src/i18n/index.ts 的 DICTS。
 *
 * 只覆盖**外壳文案**（设置面板、标题栏、对话框标题）；终端里的内容永远是
 * 远端程序的输出，与这里无关。缺省中文 —— 这个工具的主要使用场景是
 * 国内现场，默认英文才是意外行为。
 */
export type UiLanguage = 'zh-CN' | 'en'

export interface AppSettings {
  /** 界面语言，缺省 zh-CN */
  language?: UiLanguage
  theme: ThemeMode
  /** 配色主题（缺省为 vscode，即浅色 VS Code 规范配色） */
  colorTheme?: ColorThemeId
  terminal: TerminalPrefs
  /** 常用命令面板位置 */
  commandPanelPosition: 'right' | 'bottom' | 'floating'
  /** 是否执行前探测会话延迟 */
  latencyProbe: boolean
  /** 是否自动录制会话日志（终端输入输出，cast 格式） */
  autoLog: boolean
  /**
   * 是否同时写一份纯文本日志（.log）。
   *
   * cast 是给回放器用的，要按时间轴重放就得保留原始控制码 —— 于是它没法
   * 直接扔给 grep，也没法发到微信里让同事看。现场排查时想要的是后者。
   * 默认开：多写一份纯文本的成本只是磁盘，而"录了但读不了"的成本是白录。
   */
  logPlainText?: boolean
  /** 纯文本日志是否带墙上时间戳（默认开；关掉只影响 .log，cast 始终是相对秒） */
  logTimestamp?: boolean
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
  /** 手动新建的连接分组（含暂时没有连接的空分组） */
  connectionGroups?: string[]
  /** 连接分组的显示顺序（分组名数组）；未列出的分组排在后面按名称排序 */
  connectionGroupOrder?: string[]
  /** 连接分组色标：分组名 -> 十六进制颜色（侧栏分组头左侧色条） */
  connectionGroupColors?: Record<string, string>
  /**
   * 断线自动重连。
   * 现场设备（充电桩/机器人）常因网络抖动断开，手动点重连很烦；
   * 关掉的话保持旧行为，只显示断线状态。
   */
  autoReconnect?: boolean
  /** 最多重试次数，用尽后停止并提示（默认 5） */
  autoReconnectMax?: number
  /** 三栏尺寸（拖拽分隔条后写入）；缺省用渲染层内置默认值，老配置无需迁移 */
  layout?: LayoutSizes
  /** 命令中心里收藏（置顶）的命令 id */
  pinnedCommandIds?: string[]
  /** 命令中心默认排序方式 */
  commandSort?: 'smart' | 'name' | 'recent' | 'frequent'
  /**
   * 会话恢复：记录退出时打开的连接ID列表，重启后自动恢复
   */
  restoreSessions?: boolean
  /** 上次退出时打开的连接ID列表 */
  lastOpenSessions?: Array<{ connectionId: string; connectionName: string }>
  /**
   * 侧栏文件面板是否跟随终端的 `cd`。
   *
   * 缺省（undefined）按开启处理：这是「终端里 cd 一下、侧栏就跳过去」的直觉行为，
   * 绝大多数人第一次用就期待它生效。不想被跟随的人（习惯在侧栏独立浏览）可以
   * 在文件面板头部一键关掉，也可以到设置里关。
   */
  filesFollowTerminalCwd?: boolean
  /**
   * 下载落点目录。
   *
   * 缺省（undefined）用系统「下载」文件夹。存下来是因为现场笔记本上
   * 「下载」往往在小容量系统盘，而客户资料得落在 D 盘或移动硬盘上 ——
   * 每次下载都手动选一遍目录，等于每次多点三次。
   * 目录失效（U 盘拔了）时主进程回退到系统下载目录，不会把下载弄失败。
   */
  downloadDir?: string
  /** 应用内自动更新的偏好（检查频率 / 自动下载 / 更新专用代理） */
  update?: UpdatePrefs
  /**
   * 用户选择「跳过」的版本号。
   *
   * 存版本号而不是布尔：跳过的只该是「那一个版本」，下次发新版还得提醒，
   * 否则等于永久关掉了更新提示。
   */
  updateSkippedVersion?: string
  /** 终端输出关键词高亮（缺省 undefined = 用渲染层内置的两条规则） */
  outputHighlight?: OutputHighlightPrefs
  /** 任务完成通知偏好（缺省由主进程 DEFAULT_SETTINGS 补齐） */
  taskNotify?: TaskNotifyPrefs
  /**
   * 分屏布局（按**连接 id**存，不是会话 id）。
   *
   * 只在 restoreSessions 打开时写/读。单格标签不写 —— 那种情况下什么都没变，
   * 存了反而让 lastOpenSessions 与它两处都要维护同一份信息。
   */
  splitLayout?: SplitLayoutMap
  /**
   * 外观外壳版本号。
   *
   * 每次外壳整体换代就 +1，用于把老配置一次性迁到新默认值 ——
   * 老配置里存的主题/配色/字体恰好等于旧默认值，单看值分不清是
   * 「用户主动选的」还是「装的时候写进去的」，只能靠版本号判定。
   */
  uiShellVersion?: number
  /**
   * 实验性开关（设计 token 灰度）。
   *
   * 为什么按「面板」而不是按「token 类别」分：验收标准是「各面板看起来统一」，
   * 按面板灰度才能逐个面板确认视觉；按类别分会让每个面板都处于半新半旧状态，
   * 反而更难看，也让「关掉谁能回到旧样子」这个问题失去答案。
   *
   * 为什么走 settings 而不是 URL 参数/localStorage：项目已有一条完整的
   * 持久化链路（settingsService + JsonStore + IpcResult），复用它不新增依赖，
   * 也能让用户跨会话保留选择。
   */
  experimental?: ExperimentalFlags
}

/** 实验性开关（缺省全部关闭 = 旧视觉） */
export interface ExperimentalFlags {
  /** 各面板的设计 token 灰度开关；true 表示该面板使用新 token */
  tokens?: Partial<Record<TokenPanel, boolean>>
  /**
   * 界面动效总开关（缺省视为开）。
   *
   * 为什么是一个总开关、而不是按面板拆：动效只有一套 CSS（index.css 的
   * .motion-lift / .motion-in / .chev-rot），拆成面板级会变成「某几处还在动、
   * 某几处不动」的拼贴感；而用户关它的动机通常是「机器卡」或「看着晃眼」，
   * 那是全局判断，不是逐面板判断。系统级 prefers-reduced-motion 折算到同一个类上。
   */
  motion?: boolean
  /**
   * 强制软件渲染（关闭 GPU 加速）。
   *
   * 由**自愈机制**自动写入：检测到 GPU 进程异常退出后，下一次启动直接走软件路径，
   * 避免同一台机器反复崩。也可以由用户在设置里手动打开（远程桌面/老显卡场景）。
   *
   * 为什么用「自我修复 + 持久化」而不是启动时探测：
   *   `app.disableHardwareAcceleration()` 必须在 whenReady 之前**同步**调用，
   *   而 `app.getGPUInfo()` 是异步的 —— 探测不到真实 GPU 状态。
   *   与其假装能预判，不如把「真实崩溃」当作信号，崩一次之后永久降级。
   */
  softwareRender?: boolean
  /**
   * 终端渲染后端。
   *
   * 为什么默认 DOM 而不是 WebGL：
   *   xterm 6.0.0 + @xterm/addon-webgl 0.19.0 在 Intel UHD / ANGLE D3D11 上
   *   把字形画得明显小于格子（实测同一行 `MWMWMWMW` 的墨迹宽度 WebGL 27~34px、
   *   DOM 31px，细笔 `i`/`l` 只剩 5~7px），视觉上就是「字距突然变宽、笔画变细」。
   *   格子（cell）尺寸两条路径完全一致，所以这不是字号/DPI/字体栈问题，
   *   而是图集栅格化后的字形尺寸回归 —— 只能靠换后端绕开。
   *   帧率收益远不如「看着正常」重要，因此默认 DOM，WebGL 作为可选加速。
   *
   * 取值：'dom'（默认）| 'webgl'（强制，失败仍回落）| 'auto'（先试 WebGL）
   */
  terminalRenderer?: TerminalRenderer
}

/** 终端渲染后端 */
export type TerminalRenderer = 'dom' | 'webgl' | 'auto'

/** 可独立灰度的面板 */
export type TokenPanel = 'terminal' | 'sftp' | 'connections' | 'commandPanel' | 'statusBar'

/**
 * 侧栏尺寸。每个值都是「用户显式拖动过」才会写入，
 * 缺省时渲染层用内置默认值。
 *
 * 只有 sidebar 一个键 —— 新外壳把连接/文件/命令/历史/日志/隧道收进同一个
 * 侧栏由活动栏切换，横向只剩这一个自由度。老配置里的 fileTree /
 * commandPanel / commandPanelHeight 会留在文件里（无害），但不再读取。
 */
export interface LayoutSizes {
  /** 右侧命令栏宽度（常用命令常驻在右侧，一行三个按钮） */
  commandRail?: number
  /** 左侧面板栏宽度 */
  sidebar?: number
}

/**
 * 自动更新的偏好。
 *
 * 为什么不复用 `ProxyConfig`：那个是「SSH 连接自己的代理」（socks5/http 到跳板），
 * 而更新包是主进程用 Electron net 去拉的，走的完全是另一条链路 ——
 * 国内直连 GitHub 基本拉不动，必须让用户能单独给更新配一个 HTTP 代理。
 */
export interface UpdatePrefs {
  /** 启动后自动检查更新（默认开） */
  autoCheck?: boolean
  /** 检查到更新时自动开始下载（默认关：现场网络贵，让用户自己点） */
  autoDownload?: boolean
  /**
   * 更新专用代理，形如 http://127.0.0.1:7897。
   * 留空则跟随系统代理（Windows 的「Internet 选项」设置）。
   */
  proxyUrl?: string
  /**
   * 更新通道 / 镜像源。
   *
   * 留空或 `'auto'` = 自动（未配代理时优先 Gitee 国内源，不通依次回退
   * GitHub 官方与公共加速站；配了代理时优先 GitHub 官方以享差量更新）。
   * 也可显式指定 `'gitee'`、`'github'`、镜像前缀（如 `https://gh-proxy.com`）
   * 或完整的 `…/releases/latest/download` 内网镜像地址。
   */
  mirror?: string
}

/** 可自定义的快捷键动作 */
export type ShortcutAction =
  | 'newConnection'
  | 'settings'
  | 'togglePanel'
  | 'toggleCommandRail'
  | 'toggleZen'
  | 'nextTab'
  | 'closeTab'
  | 'terminalSearch'
  | 'terminalCopy'
  | 'terminalPaste'
  | 'commandCenter'
  | 'paneLeft'
  | 'paneRight'
  | 'paneUp'
  | 'paneDown'

export type ShortcutMap = Partial<Record<ShortcutAction, string>>

/* ------------------------------------------------------------------ *
 *  分屏
 * ------------------------------------------------------------------ */

/**
 * 落盘用的分屏树。
 *
 * 字段名压缩成单字母是因为这棵树会按连接重复存进 settings.json，
 * 每多一个键就多一份冗余（一棵 4 格树 = 7 个节点）。
 *
 * 叶子里存 **connectionId** 而不是 sessionId：sessionId 是每次启动新生成的
 * uid()，存它下次启动一个都对不上。恢复时把 connectionId 换成「这次启动
 * 新建的会话」—— 由于分屏只在同一连接内，顺序是确定的。
 */
export type PersistedPane =
  | { t: 'l'; c: string }
  | { t: 's'; d: 'row' | 'col'; r: number; k: [PersistedPane, PersistedPane] }

/** connectionId -> 该连接的标签分屏树 */
export type SplitLayoutMap = Record<string, PersistedPane>

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

/** 自动重连的阶段 */
export type ReconnectPhase =
  /** 已安排下一次尝试（等待退避） */
  | 'scheduled'
  /** 正在连接 */
  | 'connecting'
  /** 重连成功 */
  | 'restored'
  /** 本次尝试失败，还会继续重试 */
  | 'failed'
  /** 次数用尽，放弃 */
  | 'gave-up'
  /**
   * 串口专用：设备已拔出，正在等它插回来。
   *
   * 串口不复用上面的退避重试 —— 拔掉线缆时按 1/2/4/8/16 秒去「重试打开一个
   * 不存在的设备」既没有意义，又会在插回的瞬间正好落在长间隔里，让人以为
   * 功能坏了。改成被动等热插拔事件：设备一出现就重开，与人的动作对齐。
   */
  | 'waiting-device'

export interface ReconnectEvent {
  sessionId: string
  phase: ReconnectPhase
  /** 给用户看的一句话 */
  message: string
  /** 第几次尝试（从 1 开始） */
  attempt: number
}

/* ---------- 错误日志 ---------- */

/** 一条错误记录。设计目标是「用户能看懂 + 开发能定位」，不是完整堆栈转储。 */
export interface ErrorEntry {
  id: string
  /** 记录时间 */
  at: number
  /** 严重程度：错误 / 警告 */
  level: 'error' | 'warn'
  /** 来源层：主进程 / 渲染层 / IPC 通道名 */
  source: string
  /** 人话标题，给用户看的（例如「保存连接失败」） */
  title: string
  /** 详细信息：错误消息、通道名、可能的堆栈首行 */
  detail?: string
  /** 发生次数：相同内容只记一条并累加，避免刷屏占满磁盘 */
  count: number
  /** 最近一次发生时间（首次记录时等于 at） */
  lastAt: number
  /** 应用版本，排查时能区分版本差异 */
  version?: string
}

export interface ErrorLogStats {
  total: number
  /** 按来源聚合，用于「哪个模块错得最多」 */
  bySource: Array<{ source: string; count: number }>
}

/* ------------------------------------------------------------------ *
 *  IPC 请求 / 响应
 * ------------------------------------------------------------------ */

export interface ConnectionInput {
  id?: string
  name: string
  /** 连接类型；缺省 'ssh' */
  kind?: ConnKind
  /**
   * SSH 连接必填。串口连接传空串（见 Connection.host 的注释：
   * 这些字段保留必填形状，只对 kind='ssh' 有意义）。
   */
  host: string
  port: number
  username: string
  authType: AuthType
  password?: string
  privateKeyPath?: string
  passphrase?: string
  /** 串口参数（kind = 'serial'） */
  serial?: SerialConfig
  group: string
  tags: string[]
  color?: string
  remark?: string
  proxyJump?: string[]
  proxy?: ProxyConfig
  /** 老设备兼容算法（仅 kind = 'ssh' 有意义；串口忽略） */
  legacyAlgorithms?: boolean
  /**
   * 「另存为新设备」时带上原连接 id：新记录落库后把原连接保险箱里的
   * password / passphrase / proxyPassword 复制一份过去。
   *
   * 没有这个字段的话，另存出来的新 id 在保险箱里是空的 —— 用户点了
   * 「另存为新设备并连接」，密码却丢了，第一次连接又要手输一遍。
   * 只对「新建记录」生效（同 id 更新本来就沿用原值），源 id 不存在时静默跳过。
   */
  reuseSecretFrom?: string
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
  /** 老设备兼容算法（与连接上的同名字段一致） */
  legacyAlgorithms?: boolean
}

export interface TestConnectionResult {
  ok: boolean
  error?: string
  durationMs: number
  /** 远端 banner */
  banner?: string
  /** 主机密钥指纹（SHA256） */
  fingerprint?: string
  /**
   * 主机指纹冲突详情：known = 本地记录里的，actual = 设备当前的。
   * 有值时渲染层可以直接给出「更新主机指纹」的入口。
   */
  hostKeyMismatch?: { known: string | null; actual: string }
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
  /** 适用环境，见 Command.envs；缺省 = 两者都适用 */
  envs?: ConnKind[]
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

/**
 * 文件通道后端模式。
 *
 * - 'sftp'：正常的 ssh2 SFTP 子系统通道；
 * - 'shell'：远端根本没有 sftp 子系统（老式 dropbear / 精简 BusyBox），
 *   退化成 "在 shell 里跑 ls/cat/cp" 的纯命令通道。
 *
 * 只在「确认子系统不存在」时才会变成 shell，网络抖动、认证失败、单目录权限
 * 错误都不降级 —— 否则一台正常服务器会莫名其妙掉进慢速通道。
 */
export type SftpBackendMode = 'sftp' | 'shell'

/** 会话的文件通道模式发生变化（主进程 → 渲染层单向广播） */
export interface SftpModeEvent {
  sessionId: string
  mode: SftpBackendMode
}

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
  status: 'pending' | 'running' | 'paused' | 'done' | 'error' | 'canceled'
  error?: string
  speedBps?: number
  /** 进度单位：字节（单文件）或文件个数（目录递归传输）；缺省按 bytes 处理 */
  unit?: 'bytes' | 'files'
  /** 非失败类说明（跳过链接、空目录等），与 error 区分显示 */
  note?: string
  startedAt: number
  finishedAt?: number
}

/** 待上传文件夹的扫描结果（选完目录后给用户一个「多少文件、多大」的预览） */
export interface UploadScanItem {
  localPath: string
  name: string
  isDir: boolean
  /** 该条目（目录则递归）包含的文件数 */
  files: number
  bytes: number
  /** files/bytes 只是下限（目录过大，扫描提前收手） */
  truncated?: boolean
}

export interface UploadScanResult {
  totalFiles: number
  totalBytes: number
  items: UploadScanItem[]
}

export interface LocalFile {
  name: string
  path: string
  isDir: boolean
  size: number
  mtime: number
}

/** 文本文件编码（写回时必须与读入一致，否则中文内容会变成乱码） */
export type TextEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030'

/** 读取远程文本的结果：内容 + 探测出的编码 */
export interface RemoteText {
  content: string
  encoding: TextEncoding
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
  /**
   * 附带说明（非失败）：例如「跳过 N 个符号链接」「文件夹里没有文件，只建了目录」。
   * 与 error 分开，避免把「部分跳过」渲染成红色失败。
   */
  note?: string
  /**
   * 目录任务里逐文件的失败清单（可能上千条）。
   *
   * error 只有一句人读的摘要（前 3 条样例），这里给全量结构化数据，
   * 由主进程按错误原因聚合后落盘到传输记录 —— 界面才能回答
   * 「这 300 个失败是不是全都是 Permission denied」。
   */
  failures?: Array<{ path: string; message: string }>
}

/* ------------------------------------------------------------------ *
 *  传输记录（跨会话、跨重启的历史账本）
 * ------------------------------------------------------------------ */

/** 传输记录状态：比 TransferTask 多一个 interrupted（上次未收尾就退出） */
export type TransferRecordStatus =
  | 'pending'
  | 'running'
  | 'done'
  | 'error'
  | 'canceled'
  | 'interrupted'

/** 按错误原因聚合后的失败明细（一组 = 一个原因） */
export interface TransferFailureGroup {
  message: string
  /** 该原因下失败的文件总数（可能远大于 sample 长度） */
  count: number
  /** 样例路径（最多 50 条，超出部分只体现在 count 里） */
  sample: string[]
}

/**
 * 一次传输的持久记录。
 *
 * 与 TransferTask 的区别：这是「发生过什么」的账本，不是「现在怎么样」的视图。
 * 身份全部用**写入时快照**（connectionName / target），不靠 sessionId join ——
 * sessionId 每次启动新生成（见 SessionInfo 的注释），重启后必然全部失配。
 */
export interface TransferRecord {
  id: string
  /** 排错时用来定位连接；会话已关也能显示是人类可读的 host */
  connectionId?: string
  connectionName?: string
  /** user@host 或 COM3 · 115200 8N1（主进程算好的展示串） */
  target?: string
  direction: 'upload' | 'download'
  /** 走哪条链路：SFTP 文件管理 / trzsz / ZMODEM（sz、rz） */
  via: 'sftp' | 'trzsz' | 'zmodem'
  /** 本机路径（下载落点；上传时是本地源；拿不到就留空） */
  localPath: string
  /** 远端路径（上传目标；下载时是远端源；ZMODEM 发送拿不到远端路径） */
  remotePath: string
  /** 列表里显示的名字（不带目录） */
  fileName: string
  /** 总字节数；unit=files 时是总文件数 */
  size: number
  transferred: number
  unit?: 'bytes' | 'files'
  status: TransferRecordStatus
  error?: string
  note?: string
  /** 失败明细（按原因聚合，只有 error / interrupted 才可能有） */
  failures?: TransferFailureGroup[]
  failureCount?: number
  startedAt: number
  finishedAt?: number
  /** 被哪条新记录重试过（旧记录保留，行上显示「已被重试」） */
  retriedBy?: string
  /**
   * 本次运行内的会话 id，**只用于回查实时进度**，不作为身份。
   *
   * 重启后它一定失配 —— 那时 panel 显示「进度未知」正好是对的，
   * 不要用它 join 出连接信息（那要用上面快照的三个字段）。
   */
  sessionId?: string
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
  /**
   * 是否已授权非回环监听（持久化字段）。
   * 必须存下来：否则用户勾选保存 0.0.0.0 成功后，下次打开编辑框再保存时
   * allowLan 已丢失，saveTunnel 会重新校验并抛错 —— 改个名字都存不了。
   * 旧版本（v1.6.5 及之前无校验）已存的 0.0.0.0 配置同样依赖它放行。
   */
  allowLan?: boolean
  /**
   * 随所绑定的 connectionId 自动启动。
   *
   * 只在 connectionId 存在时有意义：没有绑定连接的隧道属于「临时手动开一个」，
   * 任何会话连上都去拉它会让用户莫名其妙多出一堆监听端口。
   */
  autoStart?: boolean
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
  /**
   * 允许监听非回环地址（默认 false）。
   * 不开这个开关时 bindHost 只能是 127.0.0.1 / ::1 / localhost，
   * 避免用户随手填 0.0.0.0 就把本机变成同网段可用的免认证 SOCKS5 出口。
   */
  allowLan?: boolean
  /** 随所绑定连接自动启动（仅当 connectionId 存在时保存） */
  autoStart?: boolean
}

/**
 * 远端上一个正在监听的端口（P0-3 快速转发的数据源）。
 *
 * targetHost 是经过归一化、可直接当作隧道目标的地址：
 * - 通配监听（0.0.0.0 / * / ::）说明同网段可达，但隧道目标是相对设备自身的，
 *   所以归一化为设备自己的回环 127.0.0.1；
 * - 具体内网 IP 原样保留（服务可能只认这个网卡）；
 * - 纯 IPv6 回环 [::1] 若同端口另有 IPv4 监听则折叠为 127.0.0.1，仅在独占时保留 ::1。
 * address 保留归一化后的同值，方便 UI 直接展示；isLoopback 说明它是否只在本机可达。
 */
export interface RemoteListeningPort {
  proto: 'tcp' | 'tcp6'
  address: string
  port: number
  /** 可直接用作隧道目标的地址（已归一化） */
  targetHost: string
  pid?: number
  process?: string
  isLoopback: boolean
}

/**
 * reconnecting：会话意外断开且正在自动重连，隧道挂起等恢复。
 *
 * 之所以不直接置 error/stopped：用户什么都没做，只是网络抖了一下；
 * 重连成功后这些隧道会被自动拉起来，界面需要表达「等一等就好」。
 */
export type TunnelStatus = 'stopped' | 'starting' | 'active' | 'reconnecting' | 'error'

/**
 * 临时转发（会话级快捷转发）的配置快照。
 *
 * 只活在内存里，绝不写 tunnels.json：用户点「转发」是为了立刻用一下，
 * 不是要往隧道列表里塞一堆一次性条目。需要长期保留的走 promote 转存。
 */
export interface EphemeralTunnelConfig {
  name: string
  type: 'local'
  bindHost: string
  bindPort: number
  targetHost: string
  targetPort: number
  /** 远端监听该端口的进程名（探测结果里带过来的，便于界面区分端口用途） */
  process?: string
  connectionId?: string
}

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
  /** remote 类型 bindPort=0 时，服务端实际分配的端口；临时转发为真实监听端口 */
  actualPort?: number
  /** 会话级临时转发（不落盘） */
  ephemeral?: boolean
  /**
   * 该运行时已从内存中移除（关闭会话、放弃重连、停掉临时转发时推送）。
   * 渲染层收到后必须把这条从 Map 里删掉 —— 否则界面会留一条永远点不动的僵尸。
   */
  removed?: boolean
  /** 临时转发的配置快照（用于「保存为持久隧道」与界面展示） */
  ephemeralConfig?: EphemeralTunnelConfig
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
  /** 统一显示名（同 SessionInfo.target），批量结果列表直接展示它 */
  target: string
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
  /**
   * 原文件编码。回写时必须用同一种，否则一份 GBK 的配置备份还原回去
   * 就变成满屏乱码 —— 备份等于把配置毁了。
   */
  encoding?: TextEncoding
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

/** 一次会话的日志文件：.cast（asciinema cast v2）或 .log（剥了控制码的纯文本） */
export interface SessionLogFile {
  path: string
  /** 文件名，形如 20261014-155401-A区.cast / 20261014-155401-A区.log */
  name: string
  size: number
  mtime: number
  /**
   * 格式。缺省按 'cast' 处理（V2.1.x 及更早只有这一种）。
   *
   * 'cast' 给回放器用；'log' 是给人看、给 grep 用的纯文本 —— 界面据此
   * 决定「回放」按钮能不能点（纯文本没有时间轴，回放没意义）。
   */
  format?: 'cast' | 'log'
}

/** 统一 IPC 返回结构：主进程永不抛异常给渲染层，统一包装 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** 会话状态推送 */
export interface SessionStatusEvent {
  sessionId: string
  status: ConnStatus
  error?: string
  /** 连接阶段（仅 connecting 时有值） */
  phase?: ConnPhase
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

/* ------------------------------------------------------------------ *
 *  trzsz 文件传输（trz / tsz）
 * ------------------------------------------------------------------ */

/**
 * 一个会话的 trzsz 传输状态。
 *
 * 为什么不复用 TransferProgressEvent：那套是 SFTP 的字节级进度（transferred/total），
 * 而 trzsz 的进度只存在于远端发来的进度条文本里（「文件名 [███░░░] 45% | …」），
 * 我们只能从文本里抠百分比，拿不到总字节数。硬塞进同一张表会让状态条要么显示假数据、
 * 要么到处判空。
 */
export interface TrzszTransferState {
  /** 是否有传输在进行（false 表示这条状态是收尾/提示） */
  active: boolean
  /** 当前文件名（trzsz 进度条里那一个，可能是截断过的） */
  file?: string
  /** 0~100，拿不到具体进度条时缺省 */
  percent?: number
  /**
   * 多文件进度：「第 index 个 / 共 total 个」。
   *
   * 取自进度条前缀 (2/5) —— trzsz 只在 fileCount > 1 时才输出这段，
   * 单文件传输下拿不到，所以是可选的。
   */
  files?: { index: number; total: number }
  /** 方向：upload 是我们推过去，download 是远端 sz 推过来 */
  direction?: 'upload' | 'download'
  /** 非进度类的提示 */
  notice?: 'no-remote-trz'
}

/* ------------------------------------------------------------------ *
 *  应用内更新（electron-updater）
 * ------------------------------------------------------------------ */

/**
 * 更新状态机的阶段。
 *
 * 刻意做成单值枚举而不是多个布尔（如 `isChecking` / `isDownloading`）：
 * 这些阶段天然互斥，用多个布尔会出现「既在检查又在下载」这种不可能状态，
 * 渲染层还得自己拼 if 链才能决定显示什么。
 */
export type UpdatePhase =
  /** 空闲：没检查过，或检查完确认是最新 */
  | 'idle'
  /** 正在向发布源查询 latest.yml */
  | 'checking'
  /** 查到新版本，等用户点「更新」 */
  | 'available'
  /** 正在下载安装包 */
  | 'downloading'
  /** 下载完成，等用户点「重启安装」 */
  | 'downloaded'
  /** 出错（网络不通 / 发布源缺文件 / 校验失败） */
  | 'error'

/** 主进程推给渲染层的更新状态快照（每次都推全量，渲染层无需自己合并） */
export interface UpdateStatus {
  phase: UpdatePhase
  /** 当前运行版本，如 1.4.4 */
  currentVersion: string
  /** 发布源上的最新版本，未检查到时为 undefined */
  latestVersion?: string
  /** 下载进度百分比 0-100；phase=downloading 时有效 */
  percent?: number
  /** 已下载字节 / 总字节，用于「12.3 MB / 78.6 MB」这类文案 */
  transferred?: number
  total?: number
  /** 每秒字节数，用于显示剩余时间 */
  bytesPerSecond?: number
  /** phase=error 时的用户可读原因 */
  error?: string
  /** 更新说明（Release notes / CHANGELOG 片段），可能为空 */
  releaseNotes?: string
  /** 发布页地址，供「打开发布页」使用 */
  releaseUrl?: string
  /** 国内镜像地址（Gitee），GitHub 连不上时的替代下载入口 */
  mirrorUrl?: string
  /** 本次检查或下载实际命中的更新通道名（如「Gitee 国内源」「GitHub 官方」「gh-proxy.com」） */
  sourceLabel?: string
  /**
   * 本次会话里用户是否点过「稍后」。
   * 点过后标题栏收起成一个小圆点，不再强提示；重启应用会重置。
   */
  dismissed?: boolean
}
/* ------------------------------------------------------------------ *
 *  TFTP：给 U-Boot 刷机用的内置服务端
 * ------------------------------------------------------------------ */

/**
 * 内置 TFTP 服务端状态。
 *
 * 只服务「一台设备、一个文件」这一种用法：现场刷 7628 时 U-Boot 侧
 * 只会 RRQ 一次固件，服务完就该停掉 —— 长期挂在 69 端口上等着，
 * 等于把本机文件系统的一部分暴露给同网段的任何人。
 */
export interface TftpServerState {
  running: boolean
  port: number
  /** 服务目录（固件所在目录）。未启动时为空 */
  dir: string | null
  /** 当前对外提供的文件名（固件名），未启动时为空 */
  file: string | null
  /** 本机可用 IPv4，用于在 U-Boot 里 setenv serverip */
  addresses: string[]
  /** 最近一次传输的对端（ip:port），无传输时为空 */
  client: string | null
  /** 已传字节 / 总字节，用于进度显示 */
  transferred: number
  total: number
}

/** TFTP 服务端日志（启动/请求/重传/失败/完成），推给串口引导条显示 */
export interface TftpLogEvent {
  level: 'info' | 'error'
  message: string
  at: number
}

/**
 * 任务完成通知偏好（v2.1.4）。
 *
 * 为什么四项攒成一个对象而不是散在 AppSettings 顶层：它们是同一件事
 * 「长任务跑完了要不要吵我」的四个维度，设置页里也是一个分区；散着放
 * 以后每加一个维度就要动一次 mergeSettings 的键清单。
 */
export interface TaskNotifyPrefs {
  /** 总开关：关掉后不再产生任何任务完成提示 */
  enabled: boolean
  /** 窗口失焦时发系统通知（Windows 操作中心），聚焦时只留应用内 toast */
  system: boolean
  /** 伴随提示音 */
  sound: boolean
  /**
   * 启发式「疑似任务结束」：终端静默 1.5s 以上且窗口失焦时提醒。
   *
   * 默认关闭 —— 它只能靠「没动静了」来猜，猜错就是纯噪声：用户在别的
   * 窗口看文档、设备那边 tail -f 每隔几秒吐一行，永远不触发；反过来
   * 编译到一半去倒水，回来收到一条「疑似完成」。文案里写「疑似」而不是
   * 「已完成」，就是不让它冒充确定事实。
   */
  heuristic: boolean
  /**
   * 已静音的连接 id。
   *
   * 存**连接**而不是会话：sessionId 每次启动都是新的，按会话静音的话，
   * 「重启后那条一直在刷日志的设备又开始弹」会反复发生；用户真正想要的
   * 语义是「这台设备别烦我」。
   */
  mutedConnectionIds?: string[]
}

/** 弹一条系统通知的入参（渲染层 -> 主进程） */
export interface TaskNotifyPayload {
  title: string
  body?: string
  /** 点击通知后要切过去的会话 id；空则只激活窗口、不切标签 */
  sessionId?: string
  /** 这条不响（逐条覆盖，最终是否出声还看偏好里的 sound） */
  silent?: boolean
}
