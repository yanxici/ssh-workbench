import type { ShortcutMap } from '@shared/types'
import { parseShortcut, SHORTCUT_ACTIONS } from './shortcuts'

/**
 * 快捷键冲突检测
 */

export interface ConflictInfo {
  combo: string
  actions: Array<{ id: string; label: string }>
}

/**
 * 检测快捷键映射中的冲突
 * @returns 冲突列表，每项包含冲突的组合键和涉及的操作
 */
export function detectShortcutConflicts(shortcuts: ShortcutMap | undefined): ConflictInfo[] {
  const map = new Map<string, Array<{ id: string; label: string }>>()
  
  // 构建实际生效的快捷键映射
  for (const action of SHORTCUT_ACTIONS) {
    const combo = shortcuts?.[action.id] || action.default
    const parsed = parseShortcut(combo)
    if (!parsed) continue
    
    // 归一化为统一格式用于比较
    const normalized = [
      parsed.ctrl ? 'Ctrl' : '',
      parsed.alt ? 'Alt' : '',
      parsed.shift ? 'Shift' : '',
      parsed.key.toUpperCase()
    ]
      .filter(Boolean)
      .join('+')
    
    if (!map.has(normalized)) {
      map.set(normalized, [])
    }
    map.get(normalized)!.push({ id: action.id, label: action.label })
  }
  
  // 找出冲突项（同一个组合键对应多个操作）
  const conflicts: ConflictInfo[] = []
  for (const [combo, actions] of map.entries()) {
    if (actions.length > 1) {
      conflicts.push({ combo, actions })
    }
  }
  
  return conflicts
}

/**
 * 检查某个快捷键是否与现有映射冲突
 * @param combo 要检查的组合键
 * @param excludeAction 排除的操作（编辑自身时用）
 * @param shortcuts 当前快捷键映射
 * @returns 冲突的操作，如果无冲突则返回 null
 */
export function checkSingleConflict(
  combo: string,
  excludeAction: string,
  shortcuts: ShortcutMap | undefined
): { id: string; label: string } | null {
  const parsed = parseShortcut(combo)
  if (!parsed) return null
  
  const normalized = [
    parsed.ctrl ? 'Ctrl' : '',
    parsed.alt ? 'Alt' : '',
    parsed.shift ? 'Shift' : '',
    parsed.key.toUpperCase()
  ]
    .filter(Boolean)
    .join('+')
  
  for (const action of SHORTCUT_ACTIONS) {
    if (action.id === excludeAction) continue
    
    const actionCombo = shortcuts?.[action.id] || action.default
    const actionParsed = parseShortcut(actionCombo)
    if (!actionParsed) continue
    
    const actionNormalized = [
      actionParsed.ctrl ? 'Ctrl' : '',
      actionParsed.alt ? 'Alt' : '',
      actionParsed.shift ? 'Shift' : '',
      actionParsed.key.toUpperCase()
    ]
      .filter(Boolean)
      .join('+')
    
    if (actionNormalized === normalized) {
      return { id: action.id, label: action.label }
    }
  }
  
  return null
}
