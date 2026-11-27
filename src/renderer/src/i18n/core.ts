import type { UiLanguage } from '@shared/types'
import { enSettings, zhSettings } from './locales/settings'
import { enCommon, zhCommon } from './locales/common'
import { enConnections, zhConnections } from './locales/connections'
import { enTerminal, zhTerminal } from './locales/terminal'
import { enFiles, zhFiles } from './locales/files'
import { enCommands, zhCommands } from './locales/commands'
import { enPanels, zhPanels } from './locales/panels'

export type Lang = UiLanguage

const zh = {
  ...zhSettings,
  ...zhCommon,
  ...zhConnections,
  ...zhTerminal,
  ...zhFiles,
  ...zhCommands,
  ...zhPanels
} as const

export type I18nKey = keyof typeof zh

const en: Record<I18nKey, string> = {
  ...enSettings,
  ...enCommon,
  ...enConnections,
  ...enTerminal,
  ...enFiles,
  ...enCommands,
  ...enPanels
}

const DICTS: Record<Lang, Record<I18nKey, string>> = { 'zh-CN': zh, en }

let activeLang: Lang = 'zh-CN'

export function setActiveLang(lang: Lang): void {
  activeLang = lang
}

export function getActiveLang(): Lang {
  return activeLang
}

/**
 * 取一条文案。纯函数模块，零 React/Zustand/Electron 依赖，供 stores / lib 与组件共用。
 */
export function translate(
  key: I18nKey,
  lang: Lang,
  vars?: Record<string, string | number>
): string {
  const raw = DICTS[lang]?.[key] ?? zh[key] ?? key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole
  )
}

/** 非 React 模块（stores / lib）使用的同步取词入口 */
export function tNow(key: I18nKey, vars?: Record<string, string | number>): string {
  return translate(key, activeLang, vars)
}
