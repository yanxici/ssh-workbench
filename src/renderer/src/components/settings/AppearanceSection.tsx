import type * as React from 'react'
import { Monitor, Moon, Palette, Sun } from 'lucide-react'
import type { ColorThemeId, ThemeMode } from '@shared/types'
import { COLOR_THEMES } from '@/theme/colorThemes'
import { useIsDark, useSettingsStore } from '@/stores/settingsStore'
import { cn } from '@/lib/utils'
import { useI18n, type I18nKey } from '@/i18n'
import { Row, Segmented } from './sectionUi'

/** 设置 → 外观（明暗模式 + 配色主题画廊） */

const THEME_OPTIONS: Array<{ value: ThemeMode; labelKey: I18nKey; icon: React.JSX.Element }> = [
  { value: 'dark', labelKey: 'settings.ext.appearance.dark', icon: <Moon size={13} /> },
  { value: 'light', labelKey: 'settings.ext.appearance.light', icon: <Sun size={13} /> },
  { value: 'system', labelKey: 'settings.ext.appearance.system', icon: <Monitor size={13} /> }
]

/**
 * 配色主题画廊：2x2 大色板，每块展示「画布 / 侧栏 / 选中行 / 强调色」四处取色，
 * 下方一行风格标签。四处取色足以区分四套主题，颜色全部取自主题定义本身，
 * 因此预览必然与真实配色一致；点击即用，切换无需重载。
 */
export function ColorThemeGallery({
  value,
  dark,
  onChange
}: {
  value: ColorThemeId
  dark: boolean
  onChange: (next: ColorThemeId) => void
}): React.JSX.Element {
  const { t } = useI18n()
  return (
    <div className="grid grid-cols-2 gap-2.5">
      {COLOR_THEMES.map((theme) => {
        const variant = dark ? theme.dark : theme.light
        const active = theme.id === value
        return (
          <button
            key={theme.id}
            type="button"
            title={theme.name}
            aria-label={t('settings.ext.appearance.colorThemeAria', { name: theme.name })}
            aria-pressed={active}
            className={cn(
              'group flex flex-col gap-1.5 rounded-lg border p-2 text-left transition-colors',
              active
                ? 'border-accent bg-accent/10'
                : 'border-edge bg-raised hover:border-accent/40 hover:bg-hover'
            )}
            onClick={() => onChange(theme.id)}
          >
            {/*
              * 色板预览：画布底 + 侧栏 / 选中行 / 强调色 / 品牌块，用主题自己的变量着色
              */}
            <div
              className="flex h-8 items-center gap-1 overflow-hidden rounded-md border border-edge-soft px-1.5"
              style={{ background: `rgb(${variant.vars.app})` }}
            >
              <span
                className="h-4 w-4 rounded-sm border border-edge-soft"
                style={{ background: `rgb(${variant.vars.panel})` }}
              />
              <span
                className="h-4 w-4 rounded-sm"
                style={{ background: `rgb(${variant.vars.select})` }}
              />
              <span
                className="h-4 w-4 rounded-full"
                style={{ background: `rgb(${variant.vars.accent})` }}
              />
              <span
                className="ml-auto h-3 w-6 rounded-sm"
                style={{ background: `rgb(${variant.vars.brand})` }}
              />
            </div>
            <div className="flex items-center gap-1">
              <span
                className={cn(
                  'truncate text-2xs',
                  active ? 'font-medium text-accent' : 'text-ink-2 group-hover:text-ink'
                )}
              >
                {theme.name}
              </span>
              {active && (
                <span className="ml-auto shrink-0 text-3xs text-accent" aria-hidden>
                  ✓
                </span>
              )}
            </div>
            <span className="truncate text-3xs text-ink-3">{theme.tagline}</span>
          </button>
        )
      })}
    </div>
  )
}

export function AppearanceSection(): React.JSX.Element {
  const { t } = useI18n()
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const dark = useIsDark()

  return (
    <>
      <Row
        label={t('settings.ext.appearance.theme')}
        hint={t('settings.ext.appearance.themeHint')}
      >
        <Segmented
          value={settings.theme}
          options={THEME_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey), icon: o.icon }))}
          onChange={(v) => void update({ theme: v })}
        />
      </Row>
      <div className="mt-3 border-t border-edge-soft pt-3">
        <div className="mb-2 flex items-center gap-1.5">
          <Palette size={13} className="text-ink-3" />
          <span className="text-xs font-medium text-ink-2">
            {t('settings.ext.appearance.colorTheme')}
          </span>
          <span className="text-2xs text-ink-3">
            {t('settings.ext.appearance.colorThemeLinkHint')}
          </span>
        </div>
        <ColorThemeGallery
          value={settings.colorTheme ?? 'vscode'}
          dark={dark}
          onChange={(v) => void update({ colorTheme: v })}
        />
      </div>
    </>
  )
}
