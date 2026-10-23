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
  /** 品牌绿：只用于标题栏底色、活动栏激活指示线、终端成功信息 */
  brand: string
  /** 品牌绿上的文字色（标题栏里的字） */
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
  dark: ThemeVariant
  light: ThemeVariant
}

/* ------------------------------------------------------------------ *
 *  Workbench（原有配色，GitHub 风格）—— 默认主题
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 *  VS Code 浅色（新版默认外观）
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
  name: 'VS Code 浅色',
  swatch: ['#ffffff', '#27c93f', '#e0f2fe'],
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
      'on-brand': '255 255 255',
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
      'on-brand': '10 10 10',
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

const WORKBENCH: ColorThemeDef = {
  id: 'workbench',
  name: 'Workbench',
  swatch: ['#0D1117', '#58A6FF', '#3FB950'],
  dark: {
    vars: {
      app: '13 17 23',
      panel: '22 27 34',
      raised: '28 33 40',
      hover: '33 39 48',
      edge: '48 54 61',
      'edge-soft': '33 38 45',
      ink: '230 237 243',
      'ink-2': '154 164 178',
      'ink-3': '110 118 129',
      accent: '88 166 255',
      success: '63 185 80',
      warning: '210 153 34',
      danger: '248 81 73',
      brand: '39 201 63',
      'on-brand': '255 255 255',
      select: '30 58 74'
    },
    terminal: {
      background: '#0D1117',
      foreground: '#C9D1D9',
      cursor: '#58A6FF',
      cursorAccent: '#0D1117',
      selectionBackground: 'rgba(88, 166, 255, 0.30)',
      black: '#161B22',
      red: '#F85149',
      green: '#3FB950',
      yellow: '#D29922',
      blue: '#58A6FF',
      magenta: '#BC8CFF',
      cyan: '#39C5CF',
      white: '#B1BAC4',
      brightBlack: '#6E7681',
      brightRed: '#FFA198',
      brightGreen: '#56D364',
      brightYellow: '#E3B341',
      brightBlue: '#79C0FF',
      brightMagenta: '#D2A8FF',
      brightCyan: '#56D4DD',
      brightWhite: '#F0F6FC'
    }
  },
  light: {
    vars: {
      app: '240 242 245',
      panel: '255 255 255',
      raised: '255 255 255',
      hover: '243 245 247',
      edge: '208 215 222',
      'edge-soft': '226 232 240',
      ink: '31 35 40',
      'ink-2': '87 96 106',
      'ink-3': '130 138 148',
      accent: '9 105 218',
      success: '26 127 55',
      warning: '154 103 0',
      danger: '207 34 46',
      brand: '39 201 63',
      'on-brand': '255 255 255',
      select: '224 242 254'
    },
    terminal: {
      background: '#FFFFFF',
      foreground: '#1F2328',
      cursor: '#0969DA',
      cursorAccent: '#FFFFFF',
      selectionBackground: 'rgba(9, 105, 218, 0.22)',
      black: '#24292F',
      red: '#CF222E',
      green: '#116329',
      yellow: '#9A6700',
      blue: '#0969DA',
      magenta: '#8250DF',
      cyan: '#1B7C83',
      white: '#6E7781',
      brightBlack: '#57606A',
      brightRed: '#A40E26',
      brightGreen: '#1A7F37',
      brightYellow: '#B08800',
      brightBlue: '#218BFF',
      brightMagenta: '#A475F9',
      brightCyan: '#3192AA',
      brightWhite: '#8C959F'
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Dracula
 * ------------------------------------------------------------------ */

const DRACULA: ColorThemeDef = {
  id: 'dracula',
  name: 'Dracula',
  swatch: ['#282A36', '#BD93F9', '#50FA7B'],
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
      'ink-3': '125 129 150',
      accent: '189 147 249',
      success: '80 250 123',
      warning: '241 250 140',
      danger: '255 85 85',
      brand: '39 201 63',
      'on-brand': '255 255 255',
      select: '30 58 74'
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
      'ink-3': '138 140 158',
      accent: '124 77 199',
      success: '20 140 62',
      warning: '156 116 0',
      danger: '200 40 50',
      brand: '39 201 63',
      'on-brand': '255 255 255',
      select: '224 242 254'
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
 *  Nord
 * ------------------------------------------------------------------ */

const NORD: ColorThemeDef = {
  id: 'nord',
  name: 'Nord',
  swatch: ['#2E3440', '#88C0D0', '#A3BE8C'],
  dark: {
    vars: {
      app: '36 41 51',
      panel: '46 52 64',
      raised: '59 66 82',
      hover: '67 76 94',
      edge: '76 86 106',
      'edge-soft': '59 66 82',
      ink: '236 239 244',
      'ink-2': '161 174 196',
      'ink-3': '118 131 152',
      accent: '136 192 208',
      success: '163 190 140',
      warning: '235 203 139',
      danger: '191 97 106',
      brand: '39 201 63',
      'on-brand': '255 255 255',
      select: '30 58 74'
    },
    terminal: {
      background: '#242933',
      foreground: '#D8DEE9',
      cursor: '#88C0D0',
      cursorAccent: '#242933',
      selectionBackground: 'rgba(136, 192, 208, 0.28)',
      black: '#3B4252',
      red: '#BF616A',
      green: '#A3BE8C',
      yellow: '#EBCB8B',
      blue: '#81A1C1',
      magenta: '#B48EAD',
      cyan: '#88C0D0',
      white: '#E5E9F0',
      brightBlack: '#4C566A',
      brightRed: '#D08770',
      brightGreen: '#B6D39B',
      brightYellow: '#F0D9A0',
      brightBlue: '#8FAFD0',
      brightMagenta: '#C79DBE',
      brightCyan: '#9DD1E0',
      brightWhite: '#ECEFF4'
    }
  },
  light: {
    vars: {
      app: '236 239 244',
      panel: '255 255 255',
      raised: '252 253 255',
      hover: '228 233 240',
      edge: '202 210 222',
      'edge-soft': '222 228 236',
      ink: '46 52 64',
      'ink-2': '76 86 106',
      'ink-3': '118 131 152',
      accent: '94 129 172',
      success: '106 138 84',
      warning: '163 128 42',
      danger: '168 73 82',
      brand: '39 201 63',
      'on-brand': '255 255 255',
      select: '224 242 254'
    },
    terminal: {
      background: '#FFFFFF',
      foreground: '#2E3440',
      cursor: '#5E81AC',
      cursorAccent: '#FFFFFF',
      selectionBackground: 'rgba(94, 129, 172, 0.22)',
      black: '#2E3440',
      red: '#A84952',
      green: '#6A8A54',
      yellow: '#A3802A',
      blue: '#5E81AC',
      magenta: '#8A6F90',
      cyan: '#3B7C8C',
      white: '#4C566A',
      brightBlack: '#768398',
      brightRed: '#BF616A',
      brightGreen: '#7FA364',
      brightYellow: '#B8952F',
      brightBlue: '#6E93C0',
      brightMagenta: '#A07FAB',
      brightCyan: '#4A95A8',
      brightWhite: '#8C99AC'
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Solarized
 * ------------------------------------------------------------------ */

const SOLARIZED: ColorThemeDef = {
  id: 'solarized',
  name: 'Solarized',
  swatch: ['#002B36', '#268BD2', '#859900'],
  dark: {
    vars: {
      app: '0 43 54',
      panel: '7 54 66',
      raised: '14 63 76',
      hover: '20 74 88',
      edge: '35 88 102',
      'edge-soft': '14 63 76',
      ink: '253 246 227',
      'ink-2': '147 161 161',
      'ink-3': '110 128 128',
      accent: '38 139 210',
      success: '133 153 0',
      warning: '181 137 0',
      danger: '220 50 47',
      brand: '39 201 63',
      'on-brand': '255 255 255',
      select: '30 58 74'
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
      ink: '7 54 66',
      'ink-2': '88 110 117',
      'ink-3': '131 148 150',
      accent: '38 139 210',
      success: '101 123 0',
      warning: '150 113 0',
      danger: '203 43 40',
      brand: '39 201 63',
      'on-brand': '255 255 255',
      select: '224 242 254'
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
 *  One Dark
 * ------------------------------------------------------------------ */

const ONEDARK: ColorThemeDef = {
  id: 'onedark',
  name: 'One Dark',
  swatch: ['#282C34', '#61AFEF', '#98C379'],
  dark: {
    vars: {
      app: '33 37 43',
      panel: '40 44 52',
      raised: '50 55 64',
      hover: '59 64 74',
      edge: '70 76 87',
      'edge-soft': '51 56 65',
      ink: '220 223 228',
      'ink-2': '160 168 180',
      'ink-3': '118 126 140',
      accent: '97 175 239',
      success: '152 195 121',
      warning: '229 192 123',
      danger: '224 108 117',
      brand: '39 201 63',
      'on-brand': '255 255 255',
      select: '30 58 74'
    },
    terminal: {
      background: '#21252B',
      foreground: '#ABB2BF',
      cursor: '#61AFEF',
      cursorAccent: '#21252B',
      selectionBackground: 'rgba(97, 175, 239, 0.30)',
      black: '#282C34',
      red: '#E06C75',
      green: '#98C379',
      yellow: '#E5C07B',
      blue: '#61AFEF',
      magenta: '#C678DD',
      cyan: '#56B6C2',
      white: '#ABB2BF',
      brightBlack: '#5C6370',
      brightRed: '#E8888F',
      brightGreen: '#B0D49A',
      brightYellow: '#EDD09A',
      brightBlue: '#84C1F3',
      brightMagenta: '#D396E6',
      brightCyan: '#7CC7D1',
      brightWhite: '#DCDCDF'
    }
  },
  light: {
    vars: {
      app: '245 246 248',
      panel: '255 255 255',
      raised: '250 251 252',
      hover: '237 239 243',
      edge: '213 217 224',
      'edge-soft': '231 234 239',
      ink: '40 44 52',
      'ink-2': '92 99 112',
      'ink-3': '130 137 151',
      accent: '64 120 190',
      success: '80 130 55',
      warning: '160 120 30',
      danger: '190 70 80',
      brand: '39 201 63',
      'on-brand': '255 255 255',
      select: '224 242 254'
    },
    terminal: {
      background: '#FFFFFF',
      foreground: '#383A42',
      cursor: '#4078BE',
      cursorAccent: '#FFFFFF',
      selectionBackground: 'rgba(64, 120, 190, 0.22)',
      black: '#383A42',
      red: '#BE4650',
      green: '#508237',
      yellow: '#A0781E',
      blue: '#4078BE',
      magenta: '#A626A4',
      cyan: '#0E8A96',
      white: '#A0A1A7',
      brightBlack: '#696C77',
      brightRed: '#CA5A63',
      brightGreen: '#5F9543',
      brightYellow: '#B88C24',
      brightBlue: '#5C8FD0',
      brightMagenta: '#B83CB6',
      brightCyan: '#18A1AE',
      brightWhite: '#C6C7C9'
    }
  }
}

/* ------------------------------------------------------------------ *
 *  Gruvbox
 * ------------------------------------------------------------------ */

const GRUVBOX: ColorThemeDef = {
  id: 'gruvbox',
  name: 'Gruvbox',
  swatch: ['#282828', '#FABD2F', '#B8BB26'],
  dark: {
    vars: {
      app: '29 32 33',
      panel: '40 40 40',
      raised: '50 48 47',
      hover: '60 56 54',
      edge: '80 73 69',
      'edge-soft': '50 48 47',
      ink: '235 219 178',
      'ink-2': '168 153 132',
      'ink-3': '124 111 100',
      accent: '250 189 47',
      success: '184 187 38',
      warning: '254 128 25',
      danger: '251 73 52',
      brand: '39 201 63',
      'on-brand': '255 255 255',
      select: '30 58 74'
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
      panel: '249 245 215',
      raised: '255 252 231',
      hover: '240 233 195',
      edge: '213 196 161',
      'edge-soft': '232 220 186',
      ink: '60 56 54',
      'ink-2': '124 111 100',
      'ink-3': '146 131 116',
      accent: '175 125 0',
      success: '121 125 15',
      warning: '175 88 0',
      danger: '175 48 34',
      brand: '39 201 63',
      'on-brand': '255 255 255',
      select: '224 242 254'
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

export const COLOR_THEMES: ColorThemeDef[] = [
  VSCODE,
  WORKBENCH,
  DRACULA,
  NORD,
  SOLARIZED,
  ONEDARK,
  GRUVBOX
]

const BY_ID = new Map<string, ColorThemeDef>(COLOR_THEMES.map((t) => [t.id, t]))

/** 取主题定义；未知 id 回落到 VS Code 浅色（当前默认外观） */
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
