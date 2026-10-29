import { Monitor, Moon, Palette, Sun } from 'lucide-react'
import type { ColorThemeId, ThemeMode } from '@shared/types'
import { COLOR_THEMES } from '@/theme/colorThemes'
import { useIsDark, useSettingsStore } from '@/stores/settingsStore'
import { cn } from '@/lib/utils'
import { Row, Segmented } from './sectionUi'

/** 设置 → 外观（明暗模式 + 配色主题画廊） */

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: JSX.Element }> = [
  { value: 'dark', label: '暗色', icon: <Moon size={13} /> },
  { value: 'light', label: '亮色', icon: <Sun size={13} /> },
  { value: 'system', label: '跟随系统', icon: <Monitor size={13} /> }
]

/**
 * 配色主题画廊：每个主题给出一张色板预览（背景 / 强调色 / 成功色），
 * 点击即用，切换无需重载。颜色取自主题定义本身，因此预览必然与真实配色一致。
 */
export function ColorThemeGallery({
  value,
  dark,
  onChange
}: {
  value: ColorThemeId
  dark: boolean
  onChange: (next: ColorThemeId) => void
}): JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-2">
      {COLOR_THEMES.map((t) => {
        const variant = dark ? t.dark : t.light
        const active = t.id === value
        return (
          <button
            key={t.id}
            type="button"
            title={t.name}
            aria-label={`配色主题 ${t.name}`}
            aria-pressed={active}
            className={cn(
              'group flex flex-col gap-1.5 rounded-lg border p-2 text-left transition-colors',
              active
                ? 'border-accent bg-accent/10'
                : 'border-edge bg-raised hover:border-accent/40 hover:bg-hover'
            )}
            onClick={() => onChange(t.id)}
          >
            {/* 色板预览：用主题自己的变量着色，所见即所得 */}
            <div
              className="flex h-7 items-center gap-1 overflow-hidden rounded-md border border-edge-soft px-1.5"
              style={{ background: `rgb(${variant.vars.app})` }}
            >
              <span
                className="h-3 w-3 rounded-full"
                style={{ background: `rgb(${variant.vars.accent})` }}
              />
              <span
                className="h-3 w-3 rounded-full"
                style={{ background: `rgb(${variant.vars.success})` }}
              />
              <span
                className="h-3 w-3 rounded-full"
                style={{ background: `rgb(${variant.vars.danger})` }}
              />
              <span
                className="ml-auto h-4 w-8 rounded-sm"
                style={{ background: `rgb(${variant.vars.panel})` }}
              />
            </div>
            <div className="flex items-center gap-1">
              <span
                className={cn(
                  'truncate text-2xs',
                  active ? 'font-medium text-accent' : 'text-ink-2 group-hover:text-ink'
                )}
              >
                {t.name}
              </span>
              {active && (
                <span className="ml-auto shrink-0 text-3xs text-accent" aria-hidden>
                  ✓
                </span>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}

export function AppearanceSection(): JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const dark = useIsDark()

  return (
    <>
      <Row label="主题" hint="浅色为默认，跟随系统会实时响应系统深浅色">
        <Segmented
          value={settings.theme}
          options={THEME_OPTIONS}
          onChange={(v) => void update({ theme: v })}
        />
      </Row>
      <div className="mt-3 border-t border-edge-soft pt-3">
        <div className="mb-2 flex items-center gap-1.5">
          <Palette size={13} className="text-ink-3" />
          <span className="text-xs font-medium text-ink-2">配色主题</span>
          <span className="text-2xs text-ink-3">· 界面与终端配色联动</span>
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
