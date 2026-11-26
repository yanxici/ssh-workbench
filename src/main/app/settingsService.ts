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
      /*
       * autoCheck / autoDownload 必须取**合并后的完整设置**，而不是看 patch 里有没有。
       * 渲染层只在用户改开关时带这两个键，改字体、改代理时带的是一个不含它们的
       * update 子对象 —— 只看 'in' 的话这一路 applyUpdatePrefs 拿到的是 undefined，
       * 用户刚关掉的自动检查在下一轮局部 patch 里就复活了（undefined !== false，
       * 照样排一次 2 秒后的检查）。
       */
      const prefs: Parameters<typeof applyUpdatePrefs>[0] = {
        autoCheck: next.update?.autoCheck,
        autoDownload: next.update?.autoDownload
      }
      /*
       * proxyUrl / mirror 反过来必须看 'in'：它们没给默认值，用合并值会把
       * 「用户这次没动代理」当成「重新设置成当前代理」，白白重置一次 net session。
       */
      if ('proxyUrl' in patch.update) prefs.proxyUrl = patch.update.proxyUrl
      if ('mirror' in patch.update) prefs.mirror = patch.update.mirror
      applyUpdatePrefs(prefs)
    } catch (err) {
      // 不阻塞落盘，但至少要留痕：静默 catch 会让「开关没反应」永远查不出原因
      console.error('[settings] applyUpdatePrefs failed:', err)
    }
  }
  return next
}

/** 读设置（当前无需副作用，保留统一入口便于以后加缓存/埋点） */
export { getSettings }
