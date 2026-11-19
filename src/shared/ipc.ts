/**
 * IPC 通道常量 —— 主进程与渲染进程共用的唯一来源，杜绝字符串硬编码。
 * P0 已实现：连接 / 会话 / 命令 / 设置；
 * 后续阶段（SFTP、隧道、诊断、批量等）在此文件扩展。
 */

export const IPC = {
  /* ---------------- 连接管理 ---------------- */
  CONN_LIST: 'conn:list',
  CONN_SAVE: 'conn:save',
  CONN_DELETE: 'conn:delete',
  CONN_TEST: 'conn:test',
  CONN_HAS_SECRET: 'conn:has-secret',
  CONN_PARSE_SSH_CMD: 'conn:parse-ssh-cmd',
  /** 选择本地私钥文件：校验后复制到应用数据目录 */
  CONN_PICK_KEY: 'conn:pick-key',
  /** 连接导出 / 导入（带凭据，发给同事直接可用） */
  CONN_EXPORT: 'conn:export',
  CONN_IMPORT_PICK: 'conn:import-pick',
  CONN_IMPORT_PREVIEW: 'conn:import-preview',
  CONN_IMPORT_APPLY: 'conn:import-apply',
  /** 连接分组：重命名 / 删除（整组迁移或清空） */
  CONN_RENAME_GROUP: 'conn:rename-group',
  CONN_DELETE_GROUP: 'conn:delete-group',
  /** 批量删除连接（多选后一次删掉） */
  CONN_DELETE_MANY: 'conn:delete-many',
  /** 批量改标签（多选后一次读写落盘，替代逐条 save） */
  CONN_UPDATE_TAGS: 'conn:update-tags',

  /* ---------------- 会话 / 终端 ---------------- */
  SESSION_OPEN: 'session:open',
  /** 在已有会话的 SSH 连接上新开 shell（会话内新建终端） */
  SESSION_OPEN_SHELL: 'session:openShell',
  SESSION_CLOSE: 'session:close',
  SESSION_WRITE: 'session:write',
  SESSION_RESIZE: 'session:resize',
  SESSION_BROADCAST: 'session:broadcast',
  SESSION_LIST: 'session:list',
  /**
   * 在线切换串口波特率（不重开会话）。
   *
   * 设备两个阶段跑不同速率是常态：7628 的 U-Boot 57600、进系统 115200；
   * ESP 的 ROM 74880、应用 115200。以前的唯一办法是断开 → 改连接 → 重连，
   * 而那几秒恰好是启动日志最密集的几秒。
   */
  SESSION_SET_BAUD: 'session:setBaud',
  /** 发 BREAK：TX 拉低一段时间，bootloader / 交换机控制台进维护模式用 */
  SESSION_BREAK: 'session:break',

  /* ---------------- 串口设备 ---------------- */
  /**
   * 枚举当前可用串口。
   *
   * 不缓存到渲染层长期复用：USB 转串口设备可以在任意时刻插拔，
   * 连接编辑器每次打开都该问主进程要一次最新的。
   */
  SERIAL_LIST: 'serial:list',
  /** 主动刷新（用户点「刷新」按钮）：与 SERIAL_LIST 同源，但会顺带更新热插拔指纹 */
  SERIAL_REFRESH: 'serial:refresh',

  /* ---------------- 内置 TFTP 服务端（U-Boot 刷机供固件） ---------------- */
  /**
   * 起一个内置 TFTP 服务端，把固件目录共享给板子。
   *
   * 现场刷机流程里这一步原来是「PC 打开 tftp 工具，选固件路径」——
   * 也就是说刷一块板子要先装一个第三方 TFTP 软件。这里把它收进主进程，
   * 端口固定 69（U-Boot 的 tftpboot 默认只发 69），只支持读。
   */
  TFTP_START: 'tftp:start',
  TFTP_STOP: 'tftp:stop',
  /** 查询当前状态（是否在跑、本机 IP、已传多少字节） */
  TFTP_STATE: 'tftp:state',

  /* ---------------- 常用命令 ---------------- */
  CMD_LIST: 'cmd:list',
  CMD_SAVE: 'cmd:save',
  CMD_DELETE: 'cmd:delete',
  CMD_REORDER: 'cmd:reorder',
  CMD_RENAME_GROUP: 'cmd:renameGroup',
  CMD_DELETE_GROUP: 'cmd:deleteGroup',
  CMD_IMPORT: 'cmd:import',
  CMD_EXPORT: 'cmd:export',
  /** 记录一次执行：useCount+1 并刷新 lastUsedAt（命令中心「最近/最常用」的数据来源） */
  CMD_TOUCH: 'cmd:touch',
  HIST_LIST: 'hist:list',
  HIST_ADD: 'hist:add',
  HIST_CLEAR: 'hist:clear',

  /* ---------------- 设置 ---------------- */
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  STORE_PATHS: 'store:paths',

  /* ---------------- 已知主机指纹 ---------------- */
  KNOWN_HOSTS_LIST: 'known:list',
  KNOWN_HOSTS_DELETE: 'known:delete',
  /** 探测某 host:port 当前的主机指纹（不校验、不落库），用于「旧 → 新」对比 */
  KNOWN_HOSTS_PROBE: 'known:probe',
  /** 把记录里的指纹更新为指定值（缺省 = 现场探测到的最新值） */
  KNOWN_HOSTS_REFRESH: 'known:refresh',

  /* ---------------- 剪贴板 ---------------- */
  CLIP_READ: 'clip:read',
  CLIP_WRITE: 'clip:write',

  /* ---------------- SFTP 文件管理 ---------------- */
  SFTP_LIST: 'sftp:list',
  /** 一次 IPC 批量列多个目录（展开目录树时省掉 N 个往返的调度开销） */
  SFTP_LIST_MANY: 'sftp:list-many',
  /** 首次打开文件面板：一次往返拿回 home + 该目录内容（省掉 realpath → readdir 的串行） */
  SFTP_BOOTSTRAP: 'sftp:bootstrap',
  SFTP_HOME: 'sftp:home',
  SFTP_MKDIR: 'sftp:mkdir',
  SFTP_DELETE: 'sftp:delete',
  SFTP_RENAME: 'sftp:rename',
  SFTP_CHMOD: 'sftp:chmod',
  SFTP_READ: 'sftp:read',
  SFTP_WRITE: 'sftp:write',
  SFTP_UPLOAD: 'sftp:upload',
  SFTP_DOWNLOAD: 'sftp:download',
  SFTP_UPLOAD_DIALOG: 'sftp:upload-dialog',
  /** 选择本地文件夹上传（保留目录名，目录树整棵建到远端） */
  SFTP_UPLOAD_FOLDER_DIALOG: 'sftp:upload-folder-dialog',
  /** 扫描待上传目录：文件数 / 总字节数 / 一级条目预览 */
  SFTP_SCAN_FOLDERS: 'sftp:scan-folders',
  SFTP_DOWNLOAD_DIALOG: 'sftp:download-dialog',
  /** 当前下载落点（设置里的下载目录，失效时回退系统「下载」） */
  SFTP_DOWNLOADS_DIR: 'sftp:downloads-dir',
  /** 选择下载目录（写进设置） */
  SFTP_PICK_DOWNLOAD_DIR: 'sftp:pick-download-dir',
  SFTP_TRANSFER_PAUSE: 'sftp:transfer-pause',
  SFTP_TRANSFER_RESUME: 'sftp:transfer-resume',
  SFTP_TRANSFER_CANCEL: 'sftp:transfer-cancel',

  /* ---------------- 传输记录（历史账本） ---------------- */
  /** 列出全部传输记录（新的在前） */
  TRANSFER_RECORD_LIST: 'transfer:record-list',
  /** 渲染层回报一条记录（ZMODEM 跑在渲染进程，走这条通道） */
  TRANSFER_RECORD_UPSERT: 'transfer:record-upsert',
  /** 标记旧记录已被某条新记录重试过 */
  TRANSFER_RECORD_RETRIED: 'transfer:record-retried',
  /** 记录规模统计（总条数 / 带明细条数） */
  TRANSFER_RECORD_STATS: 'transfer:record-stats',
  /** 启动时清理僵尸 running 记录（也可以手动触发） */
  TRANSFER_RECORD_SWEEP: 'transfer:record-sweep',
  /** 在系统文件管理器中定位本机文件 */
  TRANSFER_REVEAL: 'transfer:reveal',
  /** 打开某个本机目录 */
  TRANSFER_OPEN_DIR: 'transfer:open-dir',

  /* ---------------- ZMODEM 文件传输（sz / rz） ---------------- */
  ZM_PICK_FILES: 'zm:pick-files',
  ZM_PICK_DIR: 'zm:pick-dir',
  ZM_SAVE_BEGIN: 'zm:save-begin',
  ZM_SAVE_APPEND: 'zm:save-append',
  ZM_SAVE_FINISH: 'zm:save-finish',
  ZM_SEND_BYTES: 'zm:send-bytes',

  /* ---------------- trzsz 文件传输（trz / tsz） ---------------- */
  /**
   * 主动上传：拖文件进终端，或右键「发送文件」。
   *
   * 与 ZMODEM 的区别：zmodem 由远端发起 sz/rz，这边被动响应；
   * trzsz 支持本地主动推，所以要一条从渲染层来的入口。
   */
  TRZSZ_UPLOAD: 'trzsz:upload',
  /** 中断当前传输（等价于终端里按 Ctrl-C） */
  TRZSZ_CANCEL: 'trzsz:cancel',

  /* ---------------- 本地文件系统（文件管理器左侧栏） ---------------- */
  LOCAL_HOME: 'local:home',
  LOCAL_DRIVES: 'local:drives',
  LOCAL_LIST: 'local:list',
  LOCAL_MKDIR: 'local:mkdir',
  LOCAL_DELETE: 'local:delete',
  LOCAL_RENAME: 'local:rename',

  /* ---------------- 会话日志（录制 / 回放） ---------------- */
  LOG_LIST: 'log:list',
  LOG_READ: 'log:read',
  LOG_DELETE: 'log:delete',
  LOG_EXPORT: 'log:export',
  LOG_OPEN_DIR: 'log:open-dir',

  /* ---------------- 错误日志（用户可见、可导出） ---------------- */
  ERR_LIST: 'err:list',
  ERR_STATS: 'err:stats',
  ERR_CLEAR: 'err:clear',
  ERR_DELETE: 'err:delete',
  ERR_EXPORT: 'err:export',
  /** 渲染层把自身异常上报给主进程（窗口崩溃、React 错误等） */
  ERR_REPORT: 'err:report',
  /**
   * 一键诊断包：应用与运行环境 + 错误日志 + 设置（敏感字段已剔除）+ 启动日志，
   * 打成一个 zip 交给研发。不联网、不自动上传 —— 用户主动点才产出。
   */
  SUPPORT_BUNDLE: 'support:bundle',

  /* ---------------- 自动重连 ---------------- */
  /**
   * 取消正在进行的自动重连（用户主动关闭标签）。
   *
   * 注：这里曾有一个 SESSION_RECONNECT_NOW（手动立即重连），但从未注册过也没有
   * 任何调用方 —— 重连走的是渲染层 sessionStore.reconnect() 重新发 SESSION_OPEN，
   * 那条死通道在 v1.6.0 拆分 IPC 时被 verify-ipc-registration 抓出来并删除。
   */
  SESSION_RECONNECT_CANCEL: 'session:reconnect-cancel',

  /* ---------------- 端口转发 / 隧道 ---------------- */
  TUNNEL_LIST: 'tunnel:list',
  TUNNEL_SAVE: 'tunnel:save',
  TUNNEL_DELETE: 'tunnel:delete',
  TUNNEL_START: 'tunnel:start',
  TUNNEL_STOP: 'tunnel:stop',
  TUNNEL_STATES: 'tunnel:states',

  /* ---------------- 一键诊断巡检 + 报告 ---------------- */
  DIAG_SECTIONS_LIST: 'diag:sections',
  DIAG_SECTION_SAVE: 'diag:section-save',
  DIAG_SECTION_DELETE: 'diag:section-delete',
  DIAG_RUN: 'diag:run',
  DIAG_CANCEL: 'diag:cancel',
  DIAG_REPORTS_LIST: 'diag:reports',
  DIAG_REPORT_READ: 'diag:report-read',
  DIAG_REPORT_DELETE: 'diag:report-delete',
  DIAG_REPORT_EXPORT: 'diag:report-export',
  DIAG_REPORT_TEXT: 'diag:report-text',
  DIAG_REPORTS_OPEN_DIR: 'diag:reports-open-dir',
  DIAG_BUNDLE_PREVIEW: 'diag:bundle-preview',
  DIAG_BUNDLE_EXPORT: 'diag:bundle-export',
  DIAG_BUNDLE_REVEAL: 'diag:bundle-reveal',

  /* ---------------- 多设备批量执行 ---------------- */
  BATCH_RUN: 'batch:run',
  BATCH_CANCEL: 'batch:cancel',

  /* ---------------- 客户 / 设备档案 ---------------- */
  PROFILE_LIST: 'profile:list',
  PROFILE_SAVE: 'profile:save',
  PROFILE_DELETE: 'profile:delete',

  /* ---------------- 资源仪表盘（实时监控） ---------------- */
  METRICS_START: 'metrics:start',
  METRICS_STOP: 'metrics:stop',
  METRICS_STATES: 'metrics:states',

  /* ---------------- 固件升级助手 ---------------- */
  FW_PICK_FILE: 'fw:pick-file',
  FW_UPLOAD: 'fw:upload',
  FW_VERIFY: 'fw:verify',
  FW_UPGRADE: 'fw:upgrade',
  FW_CANCEL: 'fw:cancel',
  FW_REBOOT: 'fw:reboot',
  NET_PROBE: 'net:probe',
  SSH_EXEC: 'ssh:exec',

  /* ---------------- 设备发现（局域网扫描 / mDNS） ---------------- */
  NET_IFACES: 'discover:ifaces',
  NET_SCAN: 'discover:scan',
  NET_SCAN_CANCEL: 'discover:cancel',
  NET_MDNS: 'discover:mdns',

  /* ---------------- 配置备份对比 ---------------- */
  BACKUP_LIST: 'backup:list',
  BACKUP_CREATE: 'backup:create',
  BACKUP_DELETE: 'backup:delete',
  BACKUP_DETAIL: 'backup:detail',
  BACKUP_DIFF: 'backup:diff',
  BACKUP_RESTORE: 'backup:restore',
  BACKUP_OPEN_DIR: 'backup:open-dir',

  /* ---------------- 窗口控制（无边框自绘标题栏） ---------------- */
  WIN_MINIMIZE: 'win:minimize',
  WIN_TOGGLE_MAX: 'win:toggle-max',
  WIN_CLOSE: 'win:close',
  /** 把窗口提到前台并聚焦（点系统通知时用） */
  WIN_FOCUS: 'win:focus',
  /** 查询窗口当前是否聚焦（渲染层据此决定发不发系统通知） */
  WIN_IS_FOCUSED: 'win:is-focused',

  /* ---------------- 任务完成通知 ---------------- */
  /** 弹一条系统级通知（Windows 操作中心） */
  NOTIFY_SHOW: 'notify:show',

  /* ---------------- 应用内更新 ---------------- */
  /** 读取当前更新状态（渲染层首帧对齐用，不会错过启动时的那一次检测） */
  UPDATE_STATE: 'update:state',
  /** 主动检查更新 */
  UPDATE_CHECK: 'update:check',
  /** 下载已发现的更新包 */
  UPDATE_DOWNLOAD: 'update:download',
  /** 退出并安装（silent=false 走安装向导，便于用户看到进度） */
  UPDATE_INSTALL: 'update:install',
  /** 打开发布页（用户想手动下载/看更新说明时） */
  UPDATE_OPEN_RELEASE: 'update:open-release',
  /** 打开国内镜像发布页（Gitee）。与上一条同属兜底，不改自动更新源 */
  UPDATE_OPEN_MIRROR: 'update:open-mirror',

  /* ---------------- 主进程 -> 渲染进程 事件 ---------------- */
  /** 更新状态机变化（检查中/有新版/下载进度/待重启安装/失败） */
  EVT_UPDATE_STATUS: 'evt:update-status',
  EVT_SESSION_DATA: 'evt:session-data',
  EVT_SESSION_STATUS: 'evt:session-status',
  EVT_SESSION_LATENCY: 'evt:session-latency',
  /** 自动重连进度（scheduled / connecting / restored / failed / gave-up） */
  EVT_RECONNECT: 'evt:reconnect',
  EVT_TRANSFER_PROGRESS: 'evt:transfer-progress',
  EVT_TUNNEL_STATUS: 'evt:tunnel-status',
  EVT_DIAG_PROGRESS: 'evt:diag-progress',
  EVT_BATCH_PROGRESS: 'evt:batch-progress',
  EVT_METRICS: 'evt:metrics',
  EVT_FW_LOG: 'evt:fw-log',
  EVT_DISCOVER_PROGRESS: 'evt:discover-progress',
  /**
   * 串口端口列表变化（插拔）。
   *
   * 只在指纹真的变了才发：枚举结果的顺序抖动不该让界面刷新，
   * 否则用户在下拉框里选端口的动作会被莫名打断。
   */
  EVT_SERIAL_PORTS: 'evt:serial-ports',
  /** 内置 TFTP 服务端日志：U-Boot 发起 RRQ、重传、完成、失败 */
  EVT_TFTP_LOG: 'evt:tftp-log',
  /**
   * 用户点了系统通知。
   *
   * 为什么由主进程发：通知对象活在主进程，渲染层拿不到它的 click。
   * 主进程收到 click 先 restore/focus 窗口，再把 sessionId 转发过来，
   * 渲染层才知道该切哪个标签。
   */
  EVT_NOTIFY_CLICK: 'evt:notify-click',
  /**
   * trzsz 传输状态（有没有在传 / 传哪个文件 / 百分比 / 远端没装 trz）。
   *
   * 进度条本身不走这条：它是普通终端文本（\r 原地重绘），
   * 混在会话数据里下发，回滚和搜索才有内容。这条只喂状态条。
   */
  EVT_TRZSZ_STATE: 'evt:trzsz-state',
  /**
   * 传输记录已变更。
   *
   * 只发信号不发内容：面板收到就重拉列表。若广播整条记录，
   * 渲染层就要维护一份与磁盘可能不同步的镜像，两套更新路径迟早打架。
   * 主进程侧节流 300ms（见 transferRecord.RECORD_EMIT_MS）。
   */
  EVT_TRANSFER_RECORD_CHANGED: 'evt:transfer-record-changed'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
