import { create } from 'zustand'
import type { AppSettings, ThemeMode } from '@shared/types'
import { call } from '@/lib/ipc'
import { getThemeVariant, type ThemeVars } from '@/theme/colorThemes'

/** 与主进程 DEFAULT_SETTINGS 对齐的兜底值（加载完成前使用） */
const FALLBACK: AppSettings = {
  theme: 'dark',
  colorTheme: 'workbench',
  terminal: {
    fontFamily: "'JetBrains Mono', 'Cascadia Code', Consolas, 'Microsoft YaHei Mono', monospace",
    fontSize: 13.5,
    lineHeight: 1.35,
    cursorStyle: 'block',
    cursorBlink: true,
    scrollback: 5000
  },
  commandPanelPosition: 'right',
  latencyProbe: true,
  autoLog: true,
  dangerPatterns: ['rm -rf', 'mkfs', 'dd if=', 'shutdown', 'reboot', 'poweroff'],
  strictHostKey: true
}

/** 按主题模式解析当前是否为暗色 */
export function resolveDark(mode: ThemeMode): boolean {
  if (mode === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches
  }
  return mode === 'dark'
}

/**
 * 把配色主题写进 CSS 变量。
 * 直接覆盖 html 上的内联变量，优先级高于 index.css 里的 :root / .light 兜底值，
 * 这样切换主题无需重新加载样式表，也不会闪烁。
 */
function applyThemeVars(vars: ThemeVars): void {
  const root = document.documentElement
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(`--c-${key}`, value)
  }
}

function applyTheme(mode: ThemeMode, colorTheme: string | undefined): void {
  const dark = resolveDark(mode)
  document.documentElement.classList.toggle('light', !dark)
  applyThemeVars(getThemeVariant(colorTheme, dark).vars)
}

let mediaBound = false

interface SettingsState {
  loaded: boolean
  settings: AppSettings
  load: () => Promise<void>
  update: (patch: Partial<AppSettings>) => Promise<void>
}

export const useSettingsStore = create<SettingsState>()((set) => ({
  loaded: false,
  settings: FALLBACK,

  load: async () => {
    const s = await call(window.api.settings.get(), { silent: true })
    const settings = s ?? FALLBACK
    set({ settings, loaded: true })
    applyTheme(settings.theme, settings.colorTheme)

    // 「跟随系统」时响应系统主题变化（只绑定一次）
    if (!mediaBound) {
      mediaBound = true
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        const current = useSettingsStore.getState().settings
        if (current.theme === 'system') applyTheme('system', current.colorTheme)
      })
    }
  },

  update: async (patch) => {
    const next = await call(window.api.settings.set(patch))
    if (next) {
      set({ settings: next })
      applyTheme(next.theme, next.colorTheme)
    }
  }
}))

/** 派生：当前是否暗色（组件内使用） */
export function useIsDark(): boolean {
  return useSettingsStore((s) => resolveDark(s.settings.theme))
}
