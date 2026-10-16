import type { ShortcutAction, ShortcutMap } from '@shared/types'

/**
 * 快捷键解析与匹配（纯工具，渲染层用）。
 * 约定格式："Ctrl+N" / "Ctrl+Shift+W" / "Ctrl+Alt+B" 等（修饰键 + 单键）。
 */

export const SHORTCUT_ACTIONS: Array<{ id: ShortcutAction; label: string; default: string }> = [
  { id: 'newConnection', label: '新建连接', default: 'Ctrl+N' },
  { id: 'settings', label: '打开设置', default: 'Ctrl+,' },
  { id: 'togglePanel', label: '折叠/展开命令面板', default: 'Ctrl+B' },
  { id: 'nextTab', label: '下一个标签', default: 'Ctrl+Tab' },
  { id: 'closeTab', label: '关闭当前标签', default: 'Ctrl+Shift+W' },
  { id: 'terminalSearch', label: '终端内搜索', default: 'Ctrl+F' },
  { id: 'terminalCopy', label: '复制', default: 'Ctrl+Shift+C' },
  { id: 'terminalPaste', label: '粘贴', default: 'Ctrl+Shift+V' }
]

/** 归一化：把用户输入/存储的字符串解析为可比较的结构 */
export function parseShortcut(combo: string): {
  ctrl: boolean
  shift: boolean
  alt: boolean
  key: string
} | null {
  const parts = combo
    .trim()
    .toLowerCase()
    .split(/[+_\s]+/)
    .filter(Boolean)
  const ctrl = parts.includes('ctrl') || parts.includes('control')
  const shift = parts.includes('shift')
  const alt = parts.includes('alt') || parts.includes('option')
  const keyPart = parts.find((p) => !['ctrl', 'control', 'shift', 'alt', 'option', 'meta', 'cmd'].includes(p))
  if (!keyPart) return null
  return { ctrl, shift, alt, key: keyPart }
}

/** 判断一个键盘事件是否命中某快捷键 */
export function matchShortcut(
  e: KeyboardEvent,
  combo: string
): { ctrl: boolean; shift: boolean; alt: boolean; key: string } | null {
  const parsed = parseShortcut(combo)
  if (!parsed) return null
  const key = e.key.toLowerCase()
  const ctrl = e.ctrlKey || e.metaKey
  if (ctrl !== parsed.ctrl || e.shiftKey !== parsed.shift || e.altKey !== parsed.alt) return null
  if (key !== parsed.key) return null
  return parsed
}

/** 解析设置里的快捷键映射，缺失项回退默认值 */
export function resolveShortcuts(map: ShortcutMap | undefined): Record<ShortcutAction, string> {
  const out = {} as Record<ShortcutAction, string>
  for (const action of SHORTCUT_ACTIONS) {
    out[action.id] = map?.[action.id] || action.default
  }
  return out
}
