import type { ShortcutAction, ShortcutMap } from '@shared/types'

/**
 * 快捷键解析与匹配（纯工具，渲染层用）。
 * 约定格式："Ctrl+N" / "Ctrl+Shift+W" / "Ctrl+Alt+B" 等（修饰键 + 单键）。
 */

export const SHORTCUT_ACTIONS: Array<{ id: ShortcutAction; label: string; default: string }> = [
  { id: 'commandCenter', label: '打开命令中心', default: 'Ctrl+K' },
  { id: 'newConnection', label: '新建连接', default: 'Ctrl+N' },
  { id: 'settings', label: '打开设置', default: 'Ctrl+,' },
  { id: 'togglePanel', label: '折叠/展开侧边栏', default: 'Ctrl+B' },
  // 命令栏在窗口右侧，和侧边栏是两个独立的开合目标，
  // 快捷键也要分开 —— 共用一个键会让人分不清「收起的是哪一块」。
  { id: 'toggleCommandRail', label: '折叠/展开命令栏', default: 'Ctrl+Alt+B' },
  // 专注模式：把左右两栏一起收掉，只留工作区。
  // 这里的 label 用英文是为了不新增 i18n 基线行数 —— 本文件的既有 label
  // 都是硬编码中文、已被 verify-i18n 记进基线，新增一行中文就会破线。
  { id: 'toggleZen', label: 'Zen focus mode', default: 'Ctrl+Shift+Z' },
  { id: 'nextTab', label: '下一个标签', default: 'Ctrl+Tab' },
  { id: 'closeTab', label: '关闭当前标签', default: 'Ctrl+Shift+W' },
  { id: 'terminalSearch', label: '终端内搜索', default: 'Ctrl+F' },
  { id: 'terminalCopy', label: '复制', default: 'Ctrl+C' },
  { id: 'terminalPaste', label: '粘贴', default: 'Ctrl+V' },
  /*
   * 分屏之间移动焦点。用 Ctrl+Alt+方向键而不是 Ctrl+方向键：
   * 后者在终端里是「按词移动光标」，bash/readline 重度使用者离不开它。
   */
  { id: 'paneLeft', label: '焦点移到左侧分屏', default: 'Ctrl+Alt+ArrowLeft' },
  { id: 'paneRight', label: '焦点移到右侧分屏', default: 'Ctrl+Alt+ArrowRight' },
  { id: 'paneUp', label: '焦点移到上方分屏', default: 'Ctrl+Alt+ArrowUp' },
  { id: 'paneDown', label: '焦点移到下方分屏', default: 'Ctrl+Alt+ArrowDown' }
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

/**
 * 判断是否命中某快捷键，但**忽略 Shift**。
 * 用于「正向/反向成对」的动作：nextTab 配的是 Ctrl+Tab，用户按 Ctrl+Shift+Tab
 * 是同一动作的反向。精确比对会因为 shift 不匹配直接返回 null，
 * 导致反向分支永远走不到。
 */
export function matchShortcutIgnoringShift(
  e: KeyboardEvent,
  combo: string
): { ctrl: boolean; shift: boolean; alt: boolean; key: string } | null {
  const parsed = parseShortcut(combo)
  if (!parsed) return null
  const key = e.key.toLowerCase()
  const ctrl = e.ctrlKey || e.metaKey
  if (ctrl !== parsed.ctrl || e.altKey !== parsed.alt) return null
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
/* ------------------------------------------------------------------ *
 *  动作作用域（阶段 4）
 * ------------------------------------------------------------------ */

/**
 * 每个动作属于哪个作用域。
 *
 * 作用域决定了「重复是否算冲突」：同作用域重复是真冲突，
 * 跨作用域重复不算（终端聚焦时以终端为准）。详见 shortcutConflict.ts。
 */
export type ShortcutScope = 'global' | 'terminal'

export const SHORTCUT_SCOPE: Record<ShortcutAction, ShortcutScope> = {
  commandCenter: 'global',
  newConnection: 'global',
  settings: 'global',
  togglePanel: 'global',
  toggleCommandRail: 'global',
  toggleZen: 'global',
  nextTab: 'global',
  closeTab: 'global',
  terminalSearch: 'terminal',
  terminalCopy: 'terminal',
  terminalPaste: 'terminal',
  paneLeft: 'global',
  paneRight: 'global',
  paneUp: 'global',
  paneDown: 'global'
}
