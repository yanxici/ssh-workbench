import type { TransferProgressEvent } from '@shared/types'
import { getMainWindow } from '../windowRef'

/**
 * Windows 任务栏进度条。
 *
 * 从 main/index.ts 抽出来的原因：入口文件承担了窗口创建、IPC 注册、冒烟自检、
 * 传输聚合等一堆互不相关的事，1432 行里真正属于「窗口编排」的只是一部分。
 * 这块是自包含的 —— 只有一个 Map 和一个聚合函数，外部只需要一个入口
 * `onTransferProgress(event)`，全仓没有别的引用点（grep 证实），
 * 抽出去不会产生新的依赖环。
 */

/** 正在进行的传输任务（完成/失败即移除） */
const activeTransfers = new Map<string, { transferred: number; total: number }>()

/** 把当前所有传输任务聚合成任务栏进度；没有任务时清除 */
function updateTaskbarProgress(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  if (activeTransfers.size === 0) {
    win.setProgressBar(-1)
    return
  }
  const tasks = [...activeTransfers.values()].filter((t) => t.total > 0)
  if (tasks.length === 0) {
    // 总大小未知（例如目录还在遍历）：任务栏显示不确定态
    win.setProgressBar(2)
    return
  }
  const ratio =
    tasks.reduce((sum, t) => sum + Math.min(t.transferred / t.total, 1), 0) / tasks.length
  // 传输中最多显示 99%，避免任务栏提前显示「已完成」
  win.setProgressBar(Math.min(Math.max(ratio, 0), 0.999))
}

/**
 * 收到一次传输进度事件后更新任务栏。
 * 运行中的任务进 Map，结束（完成/失败/取消）的移出。
 */
export function onTransferProgress(event: TransferProgressEvent): void {
  if (event.status === 'running' || event.status === 'pending' || event.status === 'paused') {
    activeTransfers.set(event.taskId, {
      transferred: event.transferred,
      total: event.total
    })
  } else {
    activeTransfers.delete(event.taskId)
  }
  updateTaskbarProgress()
}

/** 当前在途任务数（测试用） */
export function activeTransferCount(): number {
  return activeTransfers.size
}
