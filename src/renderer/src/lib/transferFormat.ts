import type { TransferRecord } from '@shared/types'
import { tNow } from '../i18n/core'
import { formatBytes } from './utils'

/**
 * 传输记录的展示口径（历史面板与侧栏「传输」列表共用）。
 *
 * 抽出来是因为两处都要回答同样三个问题：这条记录了多大、能不能定位到文件、
 * 状态叫什么。复制一份的结果必然是「面板里写着已完成、侧栏写着 done」。
 */

export function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

/** 远端 POSIX 父目录（空串表示拿不到） */
export function parentOf(p: string): string {
  const i = p.lastIndexOf('/')
  if (i <= 0) return i === 0 ? '/' : ''
  return p.slice(0, i)
}

export function amountText(r: TransferRecord): string {
  if (r.unit === 'files') {
    return tNow('files.ui.transfer.filesCount', { done: r.transferred, total: r.size })
  }
  if (r.size > 0) return `${formatBytes(r.transferred)} / ${formatBytes(r.size)}`
  return r.transferred > 0 ? formatBytes(r.transferred) : '—'
}

export type LocateTarget = 'local-file' | 'local-dir' | 'remote' | 'none'

/**
 * 这条记录能往哪儿定位。
 *
 * 判据是「我们真的知道路径」而不是「猜一个看起来合理的」：
 * trzsz 下载的文件名是库自己决定的，ZMODEM 发送的落点是远端，
 * 这两种都没有本机路径可开，就老实写「原始位置未记录」。
 */
export function locateKind(r: TransferRecord): LocateTarget {
  if (r.via === 'sftp') {
    if (r.direction === 'download') return r.localPath ? 'local-file' : 'none'
    return r.remotePath ? 'remote' : 'none'
  }
  if (r.via === 'zmodem') {
    return r.direction === 'download' && r.localPath ? 'local-file' : 'none'
  }
  // trzsz 下载：我们只记了用户选的保存目录
  return r.direction === 'download' && r.localPath ? 'local-dir' : 'none'
}

export function statusLabel(status: TransferRecord['status']): string {
  switch (status) {
    case 'pending':
      return tNow('files.ui.transfer.status.pending')
    case 'running':
      return tNow('files.ui.transfer.status.running')
    case 'done':
      return tNow('files.ui.transfer.status.done')
    case 'error':
      return tNow('files.ui.transfer.status.error')
    case 'canceled':
      return tNow('files.ui.transfer.status.canceled')
    case 'interrupted':
      return tNow('files.ui.transfer.status.interrupted')
  }
}

/** 状态对应的文字颜色 token（Tailwind class） */
export const STATUS_CLASS: Record<TransferRecord['status'], string> = {
  pending: 'text-ink-3',
  running: 'text-accent',
  done: 'text-success',
  error: 'text-danger',
  canceled: 'text-ink-3',
  interrupted: 'text-warning'
}
