/**
 * 数据仓库 —— 全部持久化读写的统一出口。
 *
 * 文件布局（%APPDATA%/ssh-workbench/data/）：
 *   connections.json   连接定义（不含任何密码）
 *   secrets.json       凭据密文（vault 管理，safeStorage 加密）
 *   commands.json      常用命令
 *   history.json       命令历史
 *   settings.json      应用设置
 *   known-hosts.json   已知主机指纹
 *   diag-sections.json 自定义巡检项
 *   profiles.json      客户/设备档案
 *   tunnels.json       端口转发定义
 *
 * 拆分说明：这个文件原本 764 行，8 个互不相干的业务域挤在一起
 * （连接 / 命令 / 历史 / 设置 / 巡检项 / 档案 / 隧道 / 已知主机）。
 * 现在按域落到 ./repo/*.ts，这里只做 re-export —— 保留统一入口的好处是
 * 调用方（40 多个 import 点）一行都不用改，将来要再拆也不会波及它们。
 *
 * 新增数据域请直接在 ./repo/ 下开新文件，并在这里补一行 export。
 */

export {
  bulkUpsertConnections,
  deleteConnection,
  deleteConnectionGroup,
  deleteConnections,
  getConnection,
  listConnections,
  renameConnectionGroup,
  saveConnection,
  updateConnectionsTags,
  touchConnection
} from './repo/connections'

export {
  deleteCommand,
  deleteCommandGroup,
  exportCommands,
  importCommands,
  listCommands,
  renameCommandGroup,
  reorderCommands,
  saveCommand,
  seedCommandsIfNeeded,
  touchCommand
} from './repo/commands'

export { addHistory, clearHistory, listHistory } from './repo/history'

/*
 * 设置出口刻意**不**导出 setSettings。
 *
 * 写设置必须走 app/settingsService.ts 的 updateSettings —— 它负责在落盘后
 * 施加「更新偏好立刻生效」等副作用。如果这里也暴露 setSettings，
 * 任何人都能绕过 service 直调，设置存下来了但副作用没跑，
 * 表现为「改了代理地址要重启才生效」，而且这种错不会报任何警告。
 * 摘掉之后，「改设置必须过副作用」从口头约定变成编译期约束：
 * 直调会 import 不到。
 */
export { DEFAULT_SETTINGS, getSettings } from './repo/settings'

export { deleteDiagSection, listDiagSections, saveDiagSection } from './repo/diagSections'

export { deleteProfile, listProfiles, saveProfile } from './repo/profiles'

export { deleteTunnel, getTunnel, listTunnels, saveTunnel } from './repo/tunnels'

export {
  deleteKnownHost,
  getKnownHost,
  hostKey,
  listKnownHosts,
  refreshKnownHost,
  upsertKnownHost,
  type KnownHost
} from './repo/knownHosts'
