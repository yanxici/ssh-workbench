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

  /* ---------------- 会话 / 终端 ---------------- */
  SESSION_OPEN: 'session:open',
  /** 在已有会话的 SSH 连接上新开 shell（会话内新建终端） */
  SESSION_OPEN_SHELL: 'session:openShell',
  SESSION_CLOSE: 'session:close',
  SESSION_WRITE: 'session:write',
  SESSION_RESIZE: 'session:resize',
  SESSION_BROADCAST: 'session:broadcast',
  SESSION_LIST: 'session:list',

  /* ---------------- 常用命令 ---------------- */
  CMD_LIST: 'cmd:list',
  CMD_SAVE: 'cmd:save',
  CMD_DELETE: 'cmd:delete',
  CMD_REORDER: 'cmd:reorder',
  CMD_RENAME_GROUP: 'cmd:renameGroup',
  CMD_DELETE_GROUP: 'cmd:deleteGroup',
  CMD_IMPORT: 'cmd:import',
  CMD_EXPORT: 'cmd:export',
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

  /* ---------------- 剪贴板 ---------------- */
  CLIP_READ: 'clip:read',
  CLIP_WRITE: 'clip:write',

  /* ---------------- SFTP 文件管理 ---------------- */
  SFTP_LIST: 'sftp:list',
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
  SFTP_DOWNLOAD_DIALOG: 'sftp:download-dialog',
  SFTP_TRANSFER_PAUSE: 'sftp:transfer-pause',
  SFTP_TRANSFER_RESUME: 'sftp:transfer-resume',
  SFTP_TRANSFER_CANCEL: 'sftp:transfer-cancel',

  /* ---------------- ZMODEM 文件传输（sz / rz） ---------------- */
  ZM_PICK_FILES: 'zm:pick-files',
  ZM_SAVE_FILE: 'zm:save-file',
  ZM_WRITE_FILE: 'zm:write-file',
  ZM_SEND_BYTES: 'zm:send-bytes',

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

  /* ---------------- 主进程 -> 渲染进程 事件 ---------------- */
  EVT_SESSION_DATA: 'evt:session-data',
  EVT_SESSION_STATUS: 'evt:session-status',
  EVT_SESSION_LATENCY: 'evt:session-latency',
  EVT_TRANSFER_PROGRESS: 'evt:transfer-progress',
  EVT_TUNNEL_STATUS: 'evt:tunnel-status',
  EVT_DIAG_PROGRESS: 'evt:diag-progress',
  EVT_BATCH_PROGRESS: 'evt:batch-progress',
  EVT_METRICS: 'evt:metrics',
  EVT_FW_LOG: 'evt:fw-log',
  EVT_DISCOVER_PROGRESS: 'evt:discover-progress'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
