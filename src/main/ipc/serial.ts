import { IPC } from '@shared/ipc'
import type { SerialPortInfo } from '@shared/types'
import { handle } from './handle'
import { listSerialPorts } from '../transport/serialPorts'
import { getSerialWatcher } from '../transport/serialWatcherHolder'

/**
 * 串口设备：枚举端口。
 *
 * 只有两条通道 —— 枚举与刷新。热插拔通知不走 IPC 请求，而是主进程
 * 主动推 EVT_SERIAL_PORTS（见 main/index.ts 里的 watcher 接线）。
 */
export function registerSerialIpc(): void {
  handle(IPC.SERIAL_LIST, () => listSerialPorts())

  /*
   * 刷新：除了返回最新列表，还顺手把 watcher 的指纹对齐。
   * 不同步的话，用户手动刷新看到的新列表与 watcher 内部的旧指纹会不一致，
   * 下一次轮询会把「用户刚看到的东西」当成变化再推一遍。
   */
  handle(IPC.SERIAL_REFRESH, async (): Promise<SerialPortInfo[]> => {
    const watcher = getSerialWatcher()
    if (watcher) return watcher.refresh()
    return listSerialPorts()
  })
}
