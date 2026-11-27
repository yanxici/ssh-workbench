import { useSettingsStore } from '@/stores/settingsStore'
import { translate, type I18nKey, type Lang } from './core'

export { getActiveLang, setActiveLang, tNow, translate, type I18nKey, type Lang } from './core'

/** 组件里用这个：它订阅设置里的 language，切换语言即时重渲染 */
export function useI18n(): {
  lang: Lang
  t: (key: I18nKey, vars?: Record<string, string | number>) => string
} {
  const lang: Lang = useSettingsStore((s) => s.settings.language) ?? 'zh-CN'
  return { lang, t: (key, vars) => translate(key, lang, vars) }
}
