import { create } from 'zustand'
import type { AppSettings, ThemeMode } from '@shared/types'
import { call } from '@/lib/ipc'

/** 与主进程 DEFAULT_SETTINGS 对齐的兜底值（加载完成前使用） */
const FALLBACK: AppSettings = {
  theme: 'dark',
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

function applyTheme(mode: ThemeMode): void {
  document.documentElement.classList.toggle('light', !resolveDark(mode))
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
    applyTheme(settings.theme)

    // 「跟随系统」时响应系统主题变化（只绑定一次）
    if (!mediaBound) {
      mediaBound = true
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        const current = useSettingsStore.getState().settings
        if (current.theme === 'system') applyTheme('system')
      })
    }
  },

  update: async (patch) => {
    const next = await call(window.api.settings.set(patch))
    if (next) {
      set({ settings: next })
      applyTheme(next.theme)
    }
  }
}))

/** 派生：当前是否暗色（组件内使用） */
export function useIsDark(): boolean {
  return useSettingsStore((s) => resolveDark(s.settings.theme))
}
