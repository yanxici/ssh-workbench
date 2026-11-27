import { create } from 'zustand'
import type { AppSettings, ThemeMode } from '@shared/types'
import { call } from '@/lib/ipc'
import { getThemeVariant, type ThemeVars } from '@/theme/colorThemes'
import { applyHighlightPrefs } from '@/lib/highlightRuntime'
import { setActiveLang } from '@/i18n/core'

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
    scrollback: 3000
  },
  commandPanelPosition: 'right',
  latencyProbe: true,
  /* 空串 = 用系统「下载」文件夹（主进程 SFTP_DOWNLOADS_DIR 负责回退） */
  downloadDir: '',
  autoLog: true,
  logPlainText: true,
  logTimestamp: true,
  dangerPatterns: ['rm -rf', 'mkfs', 'dd if=', 'shutdown', 'reboot', 'poweroff'],
  strictHostKey: true,
  /* 与主进程 DEFAULT_SETTINGS 对齐：缺省全部关闭（旧视觉），终端用 DOM 渲染器；动效缺省开启 */
  experimental: { tokens: {}, terminalRenderer: 'dom', motion: true }
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
  // Object.entries 的 value 是 any（ThemeVars 的值类型较宽），显式标注成 string
  for (const [key, value] of Object.entries(vars) as Array<[string, string]>) {
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

/** 系统级「减少动态效果」偏好 */
function prefersReducedMotion(): boolean {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

/**
 * 动效总开关 → html 上的 .motion-off。
 *
 * 两个输入（应用内开关、系统偏好）折算成同一个类，而不是两套规则：
 * 关动效只有一份 CSS（见 index.css 的 .motion-off），类在就全停。
 * 系统偏好优先：它说减少，就减少，不管设置里勾了什么 —— 那是无障碍诉求，
 * 不是审美偏好；反过来系统关掉后要能恢复，所以这里是「重算」而不是「只关」。
 */
function applyMotion(enabled: boolean | undefined): void {
  const off = enabled === false || prefersReducedMotion()
  document.documentElement.classList.toggle('motion-off', off)
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
    setActiveLang(settings.language ?? 'zh-CN')
    set({ settings, loaded: true })
    applyTheme(settings.theme, settings.colorTheme)
    applyMotion(settings.experimental?.motion)
    /*
     * 高亮规则在这里落地，而不是等到终端创建时再读：
     * 设置是全局的，规则变化必须对**已存在的**终端也立刻生效 ——
     * 把规则挂在 store 的加载/更新两处，是唯一能覆盖「先开终端、后改规则」的顺序。
     */
    applyHighlightPrefs(settings.outputHighlight)

    // 「跟随系统」时响应系统主题变化（只绑定一次）
    if (!mediaBound) {
      mediaBound = true
      window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
        const current = useSettingsStore.getState().settings
        if (current.theme === 'system') applyTheme('system', current.colorTheme)
      })
      // 系统偏好变化时重算（不是只关）：用户可能在系统里关掉「减少动态效果」，此时要恢复
      window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', () => {
        applyMotion(useSettingsStore.getState().settings.experimental?.motion)
      })
    }
  },

  update: async (patch) => {
    const raw = await window.api.settings.set(patch)
    const next = raw.ok ? raw.data : null
    if (next) {
      setActiveLang(next.language ?? 'zh-CN')
      set({ settings: next })
      applyTheme(next.theme, next.colorTheme)
      applyMotion(next.experimental?.motion)
      applyHighlightPrefs(next.outputHighlight)
    }
  }
}))

/** 派生：当前是否暗色（组件内使用） */
export function useIsDark(): boolean {
  return useSettingsStore((s) => resolveDark(s.settings.theme))
}
