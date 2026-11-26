import { IPC } from '@shared/ipc'
import type { TftpServerState } from '@shared/types'
import { handle } from './handle'
import { assertSafeReadPath } from '../store/pathGuard'
import { tftpServer } from '../tftp/server'

/**
 * 内置 TFTP 服务端：给 U-Boot 供固件。
 *
 * 只有三条通道 —— 起、停、查。传输过程不轮询，靠主进程推 EVT_TFTP_LOG；
 * 进度（transferred/total）在每次日志后由界面自己查一次，足够用了。
 */
export function registerTftpIpc(): void {
  /*
   * 固件路径必须过一遍路径守卫：TFTP 会把这份文件读出来发给局域网里任何
   * 发 RRQ 的设备，未校验就等于「指定任意本地文件对外公开」。
   * 端口顺手限一下合法范围，避免 undefined/NaN 一路传到 bind。
   */
  handle(IPC.TFTP_START, (filePath: string, port?: number): Promise<TftpServerState> => {
    // 只读来源：TFTP 只把这份文件发出去，用 assertSafeReadPath（允许盘符根/UNC/SMB）
    const safePath = assertSafeReadPath(filePath, 'TFTP 固件')
    const safePort =
      typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536 ? port : 69
    return tftpServer.start(safePath, safePort)
  })
  handle(IPC.TFTP_STOP, (): TftpServerState => {
    tftpServer.stop()
    return tftpServer.state()
  })
  handle(IPC.TFTP_STATE, (): TftpServerState => tftpServer.state())
}
