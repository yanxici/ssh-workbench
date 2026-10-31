import type { AppSettings } from '@shared/types'
import { getSettings, setSettings } from '../store/repo/settings'
import { applyUpdatePrefs } from '../updater'

/**
 * 设置的**业务入口**（IPC 传输层只调这里）。
 *
 * 为什么需要这一层：
 *   「更新偏好改完立刻生效」是域逻辑，不是传输层的活。原先它内联在
 *   ipc/settings.ts 的 SETTINGS_SET handler 里，导致同一件事分散在传输层
 *   与渲染层两处（渲染层的 applyTheme 在 settingsStore.ts），改一处漏一处。
 *   但直接把 applyUpdatePrefs 塞进 store/repo/settings.ts 又会重新制造
 *   store → 业务层的反向依赖（updater 依赖 electron-updater 与会话状态）。
 *   所以在 store 之上加一层薄 service：store 只负责持久化，副作用归这里，
 *   IPC 只做转发。
 *
 * 顺序有意为之：先落盘、再施加副作用。副作用失败不该让设置保存失败
 * （用户改了代理地址却没联网，设置本身仍然要存下来）。
 */
export async function updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const next = await setSettings(patch)
  if (patch.update) {
    try {
      applyUpdatePrefs({
        autoCheck: patch.update.autoCheck,
        autoDownload: patch.update.autoDownload,
        proxyUrl: patch.update.proxyUrl
      })
    } catch {
      /* 运行期施加失败已由 updater 内部记录，不影响设置落盘结果 */
    }
  }
  return next
}

/** 读设置（当前无需副作用，保留统一入口便于以后加缓存/埋点） */
export { getSettings }
