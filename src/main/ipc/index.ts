import { registerBackupTunnelIpc } from './backupTunnel'
import { registerCommandIpc } from './commands'
import { registerConnectionIpc } from './connections'
import { registerDeviceIpc } from './devices'
import { registerDiagnosticsIpc } from './diagnostics'
import { registerErrorIpc } from './errors'
import { registerLocalFsIpc } from './localFs'
import { registerSessionIpc } from './sessions'
import { registerSftpIpc } from './sftp'
import { registerSettingsIpc } from './settings'
import { registerWindowUpdateIpc } from './windowUpdate'
import { registerZmodemIpc } from './zmodem'

/**
 * 全部 IPC 通道的注册入口。
 *
 * 拆分前这里是 index.ts 里的一个 615 行 registerIpc()，134 个 handle 调用挤在
 * 一个函数里，22 个业务域互相之间没有边界（改 SFTP 和改固件升级要动同一处，
 * blame 一直交叉）。现在按域分文件，这里只负责按顺序调用。
 *
 * 顺序无依赖：每个注册函数都是自包含的（handle 包装、错误日志、窗口引用
 * 都已各自 import），不需要谁先谁后。
 */
export function registerAllIpc(): void {
  registerErrorIpc()
  registerConnectionIpc()
  registerSessionIpc()
  registerCommandIpc()
  registerSettingsIpc()
  registerSftpIpc()
  registerZmodemIpc()
  registerLocalFsIpc()
  registerDiagnosticsIpc()
  registerDeviceIpc()
  registerBackupTunnelIpc()
  registerWindowUpdateIpc()
}
