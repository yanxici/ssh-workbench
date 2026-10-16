import type { ITheme } from '@xterm/xterm'

/**
 * 终端配色方案 —— 与界面主题联动，不引入外部配色包。
 */

export interface TerminalThemeDef {
  name: string
  dark: boolean
  theme: ITheme
}

const DARK: ITheme = {
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

const LIGHT: ITheme = {
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

export const TERMINAL_THEMES: TerminalThemeDef[] = [
  { name: 'Workbench Dark', dark: true, theme: DARK },
  { name: 'Workbench Light', dark: false, theme: LIGHT }
]

export function getTerminalTheme(dark: boolean): ITheme {
  return dark ? DARK : LIGHT
}
