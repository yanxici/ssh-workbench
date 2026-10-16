import type { IpcResult } from '@shared/types'
import { useToastStore } from '@/stores/toastStore'

/**
 * 统一 IPC 调用助手：把 IpcResult 解包，失败时自动弹 toast。
 * 返回 null 表示失败（调用方可继续用返回值判空）。
 */
export async function call<T>(
  promise: Promise<IpcResult<T>>,
  options: { silent?: boolean; errorTitle?: string } = {}
): Promise<T | null> {
  try {
    const res = await promise
    if (res.ok) return res.data
    if (!options.silent) {
      useToastStore.getState().push({
        kind: 'error',
        title: options.errorTitle ?? '操作失败',
        detail: res.error
      })
    }
    return null
  } catch (err) {
    if (!options.silent) {
      useToastStore.getState().push({
        kind: 'error',
        title: options.errorTitle ?? '操作失败',
        detail: err instanceof Error ? err.message : String(err)
      })
    }
    return null
  }
}
