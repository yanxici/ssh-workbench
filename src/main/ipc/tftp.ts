import { IPC } from '@shared/ipc'
import type { TftpServerState } from '@shared/types'
import { handle } from './handle'
import { tftpServer } from '../tftp/server'

/**
 * 内置 TFTP 服务端：给 U-Boot 供固件。
 *
 * 只有三条通道 —— 起、停、查。传输过程不轮询，靠主进程推 EVT_TFTP_LOG；
 * 进度（transferred/total）在每次日志后由界面自己查一次，足够用了。
 */
export function registerTftpIpc(): void {
  handle(IPC.TFTP_START, (filePath: string, port?: number): Promise<TftpServerState> =>
    tftpServer.start(filePath, port ?? 69)
  )
  handle(IPC.TFTP_STOP, (): TftpServerState => {
    tftpServer.stop()
    return tftpServer.state()
  })
  handle(IPC.TFTP_STATE, (): TftpServerState => tftpServer.state())
}
