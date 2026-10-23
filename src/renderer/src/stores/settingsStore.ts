import { create } from 'zustand'
import type { AppSettings, ThemeMode } from '@shared/types'
import { call } from '@/lib/ipc'
import { getThemeVariant, type ThemeVars } from '@/theme/colorThemes'

/** 与主进程 DEFAULT_SETTINGS 对齐的兜底值（加载完成前使用） */
const FALLBACK: AppSettings = {
  theme: 'light',
  colorTheme: 'vscode',
  terminal: {
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
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
  /*
   * 两个类都要切：颜色本身由内联变量覆盖，但 `--shadow-pop` 这类「非颜色主题项」
   * 只在 index.css 的 .light / .dark 分支里，不挂 .dark 就会在暗色下拿到浅色投影
   * （结果是黑底上的浮层几乎没有边界）。classList.toggle 的第二个参数是 force，
   * 两个都写才不会出现「既没有 .light 也没有 .dark」的空档。
   */
  document.documentElement.classList.toggle('light', !dark)
  document.documentElement.classList.toggle('dark', dark)
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
