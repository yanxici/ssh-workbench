/**
 * 配色主题定义 —— 界面外壳与终端调色板共用的唯一事实来源。
 *
 * 设计：每个主题都提供 dark / light 两套「变量表 + 终端调色板」，
 * 与 settings.theme（暗色/亮色/跟随系统）正交组合，任意搭配都成立。
 *
 * 变量与 styles/index.css 里的 :root / .light 一一对应，
 * 以「R G B」三通道书写，配合 tailwind 的 <alpha-value> 实现透明度。
 */

import type { ColorThemeId } from '@shared/types'
import type { ITheme } from '@xterm/xterm'

/** 界面外壳的语义色变量（R G B 三通道） */
export interface ThemeVars {
  app: string
  panel: string
  raised: string
  hover: string
  edge: string
  'edge-soft': string
  ink: string
  'ink-2': string
  'ink-3': string
  /** 强调色：标题栏徽标、活动栏激活指示线、终端成功信息 —— 每套主题自成体系 */
  brand: string
  /** brand 之上的文字色，与 brand 对比度必须 >= 4.5:1 */
  'on-brand': string
  /** 文件树选中行底色 */
  select: string
  accent: string
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
 *  精密默认（中性锌灰 + 克制钢蓝，暗/亮都成立，故不再叫「浅色」）
 *
 *  用户给定的视觉规范全部落在这套变量里：
 *    主背景 #ffffff / 侧栏状态栏 #f8f9fa · #fafafa / hover #f3f4f6
 *    边框 #e5e7eb / 正文 #374151 / 标题 #111827
 *    品牌绿 #27c93f（只给标题栏底色、活动栏指示线、终端成功信息）
 *    文件树选中 #e0f2fe
 *  暗色分支是同一套语义的暗化版本，保证切到暗色时不出现「亮底白字」这类断裂。
 * ------------------------------------------------------------------ */

const VSCODE: ColorThemeDef = {
  id: 'vscode',
  name: '精密默认',
  swatch: ['#ffffff', '#27c93f', '#2563eb'],
  tagline: 'Neutral canvas, precise blue accents',
  light: {
    vars: {
      app: '255 255 255', // #ffffff 主背景
      panel: '248 249 250', // #f8f9fa 侧栏 / 状态栏
      raised: '250 250 250', // #fafafa 浮起面（输入框、卡片）
      hover: '243 244 246', // #f3f4f6 悬停
      edge: '229 231 235', // #e5e7eb 统一分割线
      'edge-soft': '238 240 243', // 更弱的分割线（分组之间）
      ink: '17 24 39', // #111827 标题 / 强调
      'ink-2': '55 65 81', // #374151 正文
      'ink-3': '107 114 128', // #6b7280 次要文字
      brand: '39 201 63', // #27c93f
      'on-brand': '8 24 12',
      select: '224 242 254', // #e0f2fe 选中行
      accent: '37 99 235', // #2563eb 交互强调（蓝，不与品牌绿混用）
      success: '16 185 129', // #10b981
      warning: '234 179 8', // #eab308
      danger: '220 38 38' // #dc2626
    },
    terminal: {
      background: '#FFFFFF',
      foreground: '#374151',
      cursor: '#27C93F',
      cursorAccent: '#FFFFFF',
      selectionBackground: 'rgba(39, 201, 63, 0.20)',
      black: '#111827',
      red: '#dc2626',
      green: '#10b981',
      yellow: '#eab308',
      blue: '#3b82f6',
      magenta: '#8b5cf6',
      cyan: '#06b6d4',
      white: '#9ca3af',
      brightBlack: '#6b7280',
      brightRed: '#ef4444',
      brightGreen: '#27c93f',
      brightYellow: '#facc15',
      brightBlue: '#60a5fa',
      brightMagenta: '#a78bfa',
      brightCyan: '#22d3ee',
      brightWhite: '#111827'
    }
  },
  dark: {
    vars: {
      app: '24 24 27',
      panel: '31 31 35',
      raised: '39 39 42',
      hover: '45 45 50',
      edge: '56 56 62',
      'edge-soft': '43 43 47',
      ink: '244 244 245',
      'ink-2': '212 212 216',
      'ink-3': '161 161 170',
      brand: '39 201 63',
      'on-brand': '8 24 12',
      select: '30 58 74',
      accent: '96 165 250',
      success: '16 185 129',
      warning: '234 179 8',
      danger: '248 113 113'
    },
    terminal: {
      background: '#1E1E20',
      foreground: '#D4D4D8',
      cursor: '#27C93F',
      cursorAccent: '#1E1E20',
      selectionBackground: 'rgba(39, 201, 63, 0.28)',
      black: '#27272A',
      red: '#F87171',
      green: '#10B981',
      yellow: '#EAB308',
      blue: '#60A5FA',
      magenta: '#8B5CF6',
      cyan: '#22D3EE',
      white: '#D4D4D8',
      brightBlack: '#71717A',
      brightRed: '#FCA5A5',
      brightGreen: '#27C93F',
      brightYellow: '#FACC15',
      brightBlue: '#93C5FD',
      brightMagenta: '#C4B5FD',
      brightCyan: '#67E8F9',
      brightWhite: '#FAFAFA'
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
      app: '246 245 250',
      panel: '255 255 255',
      raised: '250 249 253',
      hover: '240 238 248',
      edge: '216 212 232',
      'edge-soft': '233 230 243',
      ink: '40 42 54',
      'ink-2': '98 100 118',
      'ink-3': '116 118 138',
      accent: '168 40 120',
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
      success: '133 153 0',
      warning: '181 137 0',
      danger: '220 50 47',
      brand: '42 161 152',
      'on-brand': '0 30 28',
      select: '18 84 96'
    },
    terminal: {
      // 原版 Solarized 前景 #839496 在 #002B36 上仅 4.75:1，长时间看命令输出偏灰。
      // 这里把前景抬到 base2（#EEE8D5）并保留 Solarized 的强调色，对比度 ~13:1。
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
      app: '253 246 227',
      panel: '238 232 213',
      raised: '248 243 226',
      hover: '233 226 205',
      edge: '211 203 181',
      'edge-soft': '228 221 200',
      ink: '0 43 54',
      'ink-2': '88 110 117',
      'ink-3': '112 128 130',
      accent: '25 116 178',
      success: '101 123 0',
      warning: '150 113 0',
      danger: '203 43 40',
      brand: '42 161 152',
      'on-brand': '0 30 28',
      select: '222 233 231'
    },
    terminal: {
      // 亮色侧同样抬高前景对比度（原版 #657B83 仅 4.13:1 → 这里用近黑的 base03 侧深色）
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
 *  Gruvbox
 * ------------------------------------------------------------------ */

const GRUVBOX: ColorThemeDef = {
  id: 'gruvbox',
  name: 'Gruvbox',
  swatch: ['#1d2021', '#fabd2f', '#83a598'],
  tagline: 'Warm retro amber on dark earth',
  dark: {
    vars: {
      app: '29 32 33',
      panel: '40 40 40',
      raised: '50 48 47',
      hover: '60 56 54',
      edge: '80 73 69',
      'edge-soft': '50 48 47',
      ink: '235 219 178',
      'ink-2': '176 162 140',
      'ink-3': '138 124 110',
      accent: '131 165 152',
      success: '184 187 38',
      warning: '254 128 25',
      danger: '251 73 52',
      brand: '250 189 47',
      'on-brand': '38 24 0',
      select: '74 62 36'
    },
    terminal: {
      background: '#1D2021',
      foreground: '#EBDBB2',
      cursor: '#FABD2F',
      cursorAccent: '#1D2021',
      selectionBackground: 'rgba(250, 189, 47, 0.28)',
      black: '#282828',
      red: '#FB4934',
      green: '#B8BB26',
      yellow: '#FABD2F',
      blue: '#83A598',
      magenta: '#D3869B',
      cyan: '#8EC07C',
      white: '#EBDBB2',
      brightBlack: '#928374',
      brightRed: '#FE8019',
      brightGreen: '#D5C46E',
      brightYellow: '#FADB7E',
      brightBlue: '#A3C1B4',
      brightMagenta: '#E0A3B4',
      brightCyan: '#B0D4A0',
      brightWhite: '#FBF1C7'
    }
  },
  light: {
    vars: {
      app: '251 241 199',
      panel: '246 238 202',
      raised: '255 252 231',
      hover: '240 233 195',
      edge: '213 196 161',
      'edge-soft': '232 220 186',
      ink: '52 46 40',
      'ink-2': '96 87 78',
      'ink-3': '118 104 90',
      accent: '58 118 122',
      success: '121 125 15',
      warning: '175 88 0',
      danger: '175 48 34',
      brand: '250 189 47',
      'on-brand': '43 26 0',
      select: '226 213 175'
    },
    terminal: {
      background: '#FBF1C7',
      foreground: '#3C3836',
      cursor: '#AF7D00',
      cursorAccent: '#FBF1C7',
      selectionBackground: 'rgba(175, 125, 0, 0.22)',
      black: '#3C3836',
      red: '#AF3022',
      green: '#797D0F',
      yellow: '#AF7D00',
      blue: '#076678',
      magenta: '#8F3F71',
      cyan: '#427B58',
      white: '#7C6F64',
      brightBlack: '#928374',
      brightRed: '#AF3A03',
      brightGreen: '#8E8B20',
      brightYellow: '#B57614',
      brightBlue: '#0F7A8C',
      brightMagenta: '#9D437C',
      brightCyan: '#4C8C63',
      brightWhite: '#A89984'
    }
  }
}

export const COLOR_THEMES: ColorThemeDef[] = [VSCODE, GRUVBOX, SOLARIZED, DRACULA]

const BY_ID = new Map<string, ColorThemeDef>(COLOR_THEMES.map((t) => [t.id, t]))

/** 取主题定义；未知 id 回落到精密默认（当前默认外观） */
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
