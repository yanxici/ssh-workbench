import { shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { IPC } from '@shared/ipc'
import type { TransferRecord } from '@shared/types'
import { handle } from './handle'
import {
  listRecords,
  markRetried,
  recordStats,
  sweepStale,
  upsertRecord
} from '../store/transferRecord'

/**
 * 传输记录的读写通道。
 *
 * 写者有两个：主进程自己（SFTP / trzsz 直接调 store）和渲染层的 ZMODEM
 * （它跑在渲染进程里，只能经 IPC 回报）。读取只有面板一处。
 *
 * 变更通知是「信号」不是内容：主进程落盘后发一条 EVT_TRANSFER_RECORD_CHANGED，
 * 面板收到就重拉列表。若主进程广播整条记录，渲染层就得维护一份与磁盘
 * 可能不同步的镜像 —— 两套状态更新路径迟早打架。
 */
export function registerTransferRecordIpc(): void {
  handle(IPC.TRANSFER_RECORD_LIST, () => listRecords())

  handle(IPC.TRANSFER_RECORD_UPSERT, (record: TransferRecord) => upsertRecord(record))

  handle(IPC.TRANSFER_RECORD_RETRIED, (oldId: string, newId: string) =>
    markRetried(oldId, newId)
  )

  handle(IPC.TRANSFER_RECORD_STATS, () => recordStats())

  handle(IPC.TRANSFER_RECORD_SWEEP, () => sweepStale())

  /*
   * 「打开所在文件夹」：主进程做，渲染层没有 shell 权限。
   *
   * 先 existsSync 再 reveal：文件被删/被移走后 showItemInFolder 什么都不会发生，
   * 用户点了没反应会以为功能坏了，不如明确报「文件已不在原位置」。
   */
  handle(IPC.TRANSFER_REVEAL, (path: string) => {
    if (!path || !existsSync(path)) {
      throw new Error('文件已不在原位置（可能被移动或删除）')
    }
    shell.showItemInFolder(path)
  })

  /**
   * 只打开文件所在目录（不选中文件）：用于目录类记录的「打开上级目录」。
   *
   * 旧实现拿 existsSync 当类型判断，传进来的是文件时会直接把文件交给
   * showItemInFolder —— 那是在错误的层级打开，目录类记录点「打开上级目录」
   * 反而跳进了自己的父级的父级。必须按 stat 判是不是目录。
   */
  handle(IPC.TRANSFER_OPEN_DIR, async (path: string) => {
    if (!path) throw new Error('路径为空')
    if (!existsSync(path)) throw new Error('目录已不存在（可能被移动或删除）')
    const dir = statSync(path).isDirectory() ? path : dirname(path)
    if (!existsSync(dir)) throw new Error('目录已不存在（可能被移动或删除）')
    const err = await shell.openPath(dir)
    if (err) throw new Error(err)
  })
}
