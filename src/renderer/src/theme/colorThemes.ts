/**
 * 配色主题定义 —— 界面外壳与终端调色板共用的唯一事实来源。
 *
 * 设计：每个主题都提供 dark / light 两套「四级表面变量表 + 终端调色板」，
 * 与 settings.theme（亮色默认 / 暗色 / 跟随系统）正交组合，任意搭配都成立。
 *
 * 四级表面层级：
 *   chrome（最外层顶栏与活动栏）→ panel（侧栏/命令栏/状态栏）→ app（终端画布与激活标签）→ raised（卡片/输入框）
 * 颜色全部以「R G B」三通道书写，配合 Tailwind 的 <alpha-value> 实现透明度。
 */

import type { ColorThemeId } from '@shared/types'
import type { ITheme } from '@xterm/xterm'

/** 界面外壳的语义色变量（R G B 三通道） */
export interface ThemeVars {
  /** 最外层窗口骨架（标题栏、活动栏、设置左轨） */
  chrome: string
  /** 主内容画布（终端舞台、激活标签、欢迎页） */
  app: string
  /** 导航与工具面板层（侧栏、命令栏、状态栏） */
  panel: string
  /** 浮起控件与卡片层（命令卡、输入框、胶囊控件） */
  raised: string
  hover: string
  edge: string
  'edge-soft': string
  ink: string
  'ink-2': string
  'ink-3': string
  /** 品牌结构指示色（活动栏 2px 条、激活标签指示条、连接行 hover 左竖条） */
  brand: string
  /** brand 之上的文字色，与 brand 对比度必须 >= 4.5:1 */
  'on-brand': string
  /** 选中行 / 柔和激活底色 */
  select: string
  /** 主交互强调色（主按钮、焦点环、亮底前景强调图标） */
  accent: string
  /** accent 之上的文字色（.btn-primary），与 accent 对比度必须 >= 4.5:1 */
  'on-accent': string
  success: string
  warning: string
  danger: string
}

export interface ThemeVariant {
  vars: ThemeVars
  terminal: ITheme
}

export interface ColorThemeDef {
  id: ColorThemeId
  name: string
  /** 设置面板色板预览用的代表色 */
  swatch: [string, string, string]
  /** 风格标签（英文，避免新增 i18n 债务） */
  tagline: string
  dark: ThemeVariant
  light: ThemeVariant
}

/* ------------------------------------------------------------------ *
 *  Portix 默认（内部 ID 保留 vscode 兼容旧配置文件）
 *
 *  Qoder 四级中性石墨层次 + 单一翡翠绿（亮 #0A7E5C / 暗 #2ED39A）：
 *  brand 与 accent 收敛统一，彻底消除旧版荧光绿 + 皇家蓝的视觉分裂。
 * ------------------------------------------------------------------ */

const VSCODE: ColorThemeDef = {
  id: 'vscode',
  name: 'Portix 默认',
  swatch: ['#ffffff', '#0a7e5c', '#eff2f6'],
  tagline: 'Crisp slate with jade emerald accents',
  light: {
    vars: {
      chrome: '239 242 246', // #EFF2F6 chrome frame
      app: '255 255 255', // #FFFFFF canvas & active tab
      panel: '246 248 250', // #F6F8FA sidebar / command rail / statusbar
      raised: '255 255 255', // #FFFFFF cards & inputs
      hover: '233 238 244', // #E9EEF4 hover
      edge: '223 228 235', // #DFE4EB hairline border
      'edge-soft': '235 239 245', // #EBEFF5 subtle border
      ink: '15 23 36', // #0F1724 primary text
      'ink-2': '58 69 86', // #3A4556 body text
      'ink-3': '104 115 131', // #687383 muted text
      brand: '10 126 92', // #0A7E5C Portix jade emerald (5.06:1 vs white)
      'on-brand': '255 255 255',
      select: '230 245 239', // #E6F5EF soft mint selection
      accent: '10 126 92', // #0A7E5C unified interactive accent
      'on-accent': '255 255 255',
      success: '16 156 107', // #109C6B
      warning: '202 138 4', // #CA8A04
      danger: '217 45 56' // #D92D38
    },
    terminal: {
      background: '#FFFFFF',
      foreground: '#1E293B',
      cursor: '#0A7E5C',
      cursorAccent: '#FFFFFF',
      selectionBackground: 'rgba(10, 126, 92, 0.16)',
      black: '#0F1724',
      red: '#D92D38',
      green: '#0A7E5C',
      yellow: '#CA8A04',
      blue: '#2563EB',
      magenta: '#7C3AED',
      cyan: '#0891B2',
      white: '#94A3B8',
      brightBlack: '#64748B',
      brightRed: '#EF4444',
      brightGreen: '#109C6B',
      brightYellow: '#EAB308',
      brightBlue: '#3B82F6',
      brightMagenta: '#8B5CF6',
      brightCyan: '#06B6D4',
      brightWhite: '#0F1724'
    }
  },
  dark: {
    vars: {
      chrome: '15 17 21', // #0F1115 obsidian chrome
      app: '13 15 19', // #0D0F13 terminal canvas
      panel: '21 24 30', // #15181E sidebar / command rail / statusbar
      raised: '29 33 41', // #1D2129 raised cards & inputs
      hover: '37 42 52', // #252A34
      edge: '46 52 64', // #2E3440
      'edge-soft': '33 38 47', // #21262F
      ink: '238 241 246', // #EEF1F6
      'ink-2': '178 186 198', // #B2BAC6
      'ink-3': '124 134 150', // #7C8696
      brand: '46 211 154', // #2ED39A emerald (9.20:1 vs dark ink)
      'on-brand': '7 28 20',
      select: '20 56 46', // #14382E deep pine selection
      accent: '46 211 154',
      'on-accent': '7 28 20',
      success: '46 211 154',
      warning: '245 185 66',
      danger: '248 113 113'
    },
    terminal: {
      background: '#0D0F13',
      foreground: '#DCE3EC',
      cursor: '#2ED39A',
      cursorAccent: '#0D0F13',
      selectionBackground: 'rgba(46, 211, 154, 0.24)',
      black: '#1D2129',
      red: '#F87171',
      green: '#2ED39A',
      yellow: '#F5B942',
      blue: '#60A5FA',
      magenta: '#A78BFA',
      cyan: '#38BDF8',
      white: '#DCE3EC',
      brightBlack: '#6B7686',
      brightRed: '#FCA5A5',
      brightGreen: '#5CE5B5',
      brightYellow: '#FDE047',
      brightBlue: '#93C5FD',
      brightMagenta: '#C4B5FD',
      brightCyan: '#67E8F9',
      brightWhite: '#F8FAFC'
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Dracula
 * ------------------------------------------------------------------ */

const DRACULA: ColorThemeDef = {
  id: 'dracula',
  name: 'Dracula',
  swatch: ['#282a36', '#bd93f9', '#ff79c6'],
  tagline: 'Purple night with vivid pink accents',
  dark: {
    vars: {
      chrome: '24 25 34',
      app: '30 31 41',
      panel: '40 42 54',
      raised: '52 54 70',
      hover: '60 62 80',
      edge: '68 71 90',
      'edge-soft': '52 55 70',
      ink: '248 248 242',
      'ink-2': '177 180 196',
      'ink-3': '142 146 168',
      accent: '255 121 198',
      'on-accent': '36 10 28',
      success: '80 250 123',
      warning: '241 250 140',
      danger: '255 85 85',
      brand: '189 147 249',
      'on-brand': '32 14 56',
      select: '62 44 96'
    },
    terminal: {
      background: '#1E1F29',
      foreground: '#F8F8F2',
      cursor: '#BD93F9',
      cursorAccent: '#1E1F29',
      selectionBackground: 'rgba(189, 147, 249, 0.30)',
      black: '#21222C',
      red: '#FF5555',
      green: '#50FA7B',
      yellow: '#F1FA8C',
      blue: '#BD93F9',
      magenta: '#FF79C6',
      cyan: '#8BE9FD',
      white: '#F8F8F2',
      brightBlack: '#6272A4',
      brightRed: '#FF6E6E',
      brightGreen: '#69FF94',
      brightYellow: '#FFFFA5',
      brightBlue: '#D6ACFF',
      brightMagenta: '#FF92DF',
      brightCyan: '#A4FFFF',
      brightWhite: '#FFFFFF'
    }
  },
  light: {
    vars: {
      chrome: '236 233 245',
      app: '249 248 252',
      panel: '244 242 250',
      raised: '255 255 255',
      hover: '234 231 245',
      edge: '216 212 232',
      'edge-soft': '233 230 243',
      ink: '40 42 54',
      'ink-2': '98 100 118',
      'ink-3': '116 118 138',
      accent: '168 40 120',
      'on-accent': '255 255 255',
      success: '20 140 62',
      warning: '156 116 0',
      danger: '200 40 50',
      brand: '189 147 249',
      'on-brand': '32 14 56',
      select: '232 226 248'
    },
    terminal: {
      background: '#FFFFFF',
      foreground: '#282A36',
      cursor: '#7C4DC7',
      cursorAccent: '#FFFFFF',
      selectionBackground: 'rgba(124, 77, 199, 0.22)',
      black: '#282A36',
      red: '#C82832',
      green: '#148C3E',
      yellow: '#9C7400',
      blue: '#7C4DC7',
      magenta: '#C7407F',
      cyan: '#0E8B9E',
      white: '#6E7086',
      brightBlack: '#8A8C9E',
      brightRed: '#D63A44',
      brightGreen: '#1BA34A',
      brightYellow: '#B08A00',
      brightBlue: '#9463DE',
      brightMagenta: '#D9568F',
      brightCyan: '#12A0B5',
      brightWhite: '#FFFFFF'
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Solarized
 * ------------------------------------------------------------------ */

const SOLARIZED: ColorThemeDef = {
  id: 'solarized',
  name: 'Solarized',
  swatch: ['#002b36', '#2aa198', '#268bd2'],
  tagline: 'Deep teal, low glare',
  dark: {
    vars: {
      chrome: '0 34 44',
      app: '0 43 54',
      panel: '7 54 66',
      raised: '14 63 76',
      hover: '20 74 88',
      edge: '35 88 102',
      'edge-soft': '14 63 76',
      ink: '253 246 227',
      'ink-2': '160 172 172',
      'ink-3': '128 148 148',
      accent: '96 168 227',
      'on-accent': '0 28 42',
      success: '133 153 0',
      warning: '181 137 0',
      danger: '220 50 47',
      brand: '42 161 152',
      'on-brand': '0 30 28',
      select: '18 84 96'
    },
    terminal: {
      background: '#002B36',
      foreground: '#E4DDC8',
      cursor: '#268BD2',
      cursorAccent: '#002B36',
      selectionBackground: 'rgba(38, 139, 210, 0.30)',
      black: '#073642',
      red: '#DC322F',
      green: '#859900',
      yellow: '#B58900',
      blue: '#268BD2',
      magenta: '#D33682',
      cyan: '#2AA198',
      white: '#EEE8D5',
      brightBlack: '#657B83',
      brightRed: '#CB4B16',
      brightGreen: '#B8C24A',
      brightYellow: '#D9B033',
      brightBlue: '#5AA9DE',
      brightMagenta: '#E05FA0',
      brightCyan: '#4FC2B8',
      brightWhite: '#FDF6E3'
    }
  },
  light: {
    vars: {
      chrome: '231 224 203',
      app: '253 246 227',
      panel: '240 234 216',
      raised: '251 247 234',
      hover: '233 226 205',
      edge: '211 203 181',
      'edge-soft': '228 221 200',
      ink: '0 43 54',
      'ink-2': '88 110 117',
      'ink-3': '112 128 130',
      accent: '25 116 178',
      'on-accent': '255 255 255',
      success: '101 123 0',
      warning: '150 113 0',
      danger: '203 43 40',
      brand: '42 161 152',
      'on-brand': '0 30 28',
      select: '222 233 231'
    },
    terminal: {
      background: '#FDF6E3',
      foreground: '#3C4F55',
      cursor: '#268BD2',
      cursorAccent: '#FDF6E3',
      selectionBackground: 'rgba(38, 139, 210, 0.22)',
      black: '#073642',
      red: '#B3241F',
      green: '#5C6E00',
      yellow: '#8A6600',
      blue: '#1C6EA8',
      magenta: '#B02464',
      cyan: '#1B7A74',
      white: '#93A1A1',
      brightBlack: '#7A8F94',
      brightRed: '#CB4B16',
      brightGreen: '#839496',
      brightYellow: '#657B83',
      brightBlue: '#4A8FC7',
      brightMagenta: '#6C71C4',
      brightCyan: '#2AA198',
      brightWhite: '#EEE8D5'
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Monochrome (Pure Black & White)
 * ------------------------------------------------------------------ */

const MONO: ColorThemeDef = {
  id: 'mono',
  name: '极简黑白',
  swatch: ['#000000', '#111111', '#ffffff'],
  tagline: 'Pure monochrome black & white',
  dark: {
    vars: {
      chrome: '12 12 12',
      app: '0 0 0',
      panel: '18 18 18',
      raised: '26 26 26',
      hover: '38 38 38',
      edge: '46 46 46',
      'edge-soft': '30 30 30',
      ink: '250 250 250',
      'ink-2': '184 184 184',
      'ink-3': '128 128 128',
      accent: '250 250 250',
      'on-accent': '10 10 10',
      success: '74 222 128',
      warning: '250 204 21',
      danger: '248 113 113',
      brand: '250 250 250',
      'on-brand': '10 10 10',
      select: '42 42 42'
    },
    terminal: {
      background: '#000000',
      foreground: '#F5F5F5',
      cursor: '#FFFFFF',
      cursorAccent: '#000000',
      selectionBackground: 'rgba(255, 255, 255, 0.22)',
      black: '#1A1A1A',
      red: '#F87171',
      green: '#4ADE80',
      yellow: '#FACC15',
      blue: '#60A5FA',
      magenta: '#C084FC',
      cyan: '#22D3EE',
      white: '#E5E5E5',
      brightBlack: '#737373',
      brightRed: '#FCA5A5',
      brightGreen: '#86EFAC',
      brightYellow: '#FDE047',
      brightBlue: '#93C5FD',
      brightMagenta: '#D8B4FE',
      brightCyan: '#67E8F9',
      brightWhite: '#FFFFFF'
    }
  },
  light: {
    vars: {
      chrome: '236 236 236',
      app: '255 255 255',
      panel: '245 245 245',
      raised: '255 255 255',
      hover: '232 232 232',
      edge: '223 223 223',
      'edge-soft': '238 238 238',
      ink: '10 10 10',
      'ink-2': '64 64 64',
      'ink-3': '115 115 115',
      accent: '17 17 17',
      'on-accent': '255 255 255',
      success: '22 163 74',
      warning: '180 83 9',
      danger: '220 38 38',
      brand: '17 17 17',
      'on-brand': '255 255 255',
      select: '229 229 229'
    },
    terminal: {
      background: '#FFFFFF',
      foreground: '#111111',
      cursor: '#111111',
      cursorAccent: '#FFFFFF',
      selectionBackground: 'rgba(17, 17, 17, 0.14)',
      black: '#111111',
      red: '#DC2626',
      green: '#15803D',
      yellow: '#A16207',
      blue: '#1D4ED8',
      magenta: '#7E22CE',
      cyan: '#0E7490',
      white: '#737373',
      brightBlack: '#525252',
      brightRed: '#EF4444',
      brightGreen: '#16A34A',
      brightYellow: '#CA8A04',
      brightBlue: '#2563EB',
      brightMagenta: '#9333EA',
      brightCyan: '#0891B2',
      brightWhite: '#111111'
    }
  }
}

export const COLOR_THEMES: ColorThemeDef[] = [VSCODE, MONO, SOLARIZED, DRACULA]

const BY_ID = new Map<string, ColorThemeDef>(COLOR_THEMES.map((t) => [t.id, t]))

/** 取主题定义；未知 id 回落到 Portix 默认 */
export function getColorTheme(id: string | undefined): ColorThemeDef {
  return (id && BY_ID.get(id)) || VSCODE
}

/** 取某主题在指定明暗下的变体 */
export function getThemeVariant(id: string | undefined, dark: boolean): ThemeVariant {
  const def = getColorTheme(id)
  return dark ? def.dark : def.light
}

/** 终端调色板（与界面配色联动） */
export function getXtermTheme(id: string | undefined, dark: boolean): ITheme {
  return getThemeVariant(id, dark).terminal
}
