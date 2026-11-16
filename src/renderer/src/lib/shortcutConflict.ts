import type { ShortcutMap } from '@shared/types'
import { parseShortcut, SHORTCUT_ACTIONS, SHORTCUT_SCOPE } from './shortcuts'

/**
 * 快捷键冲突检测（作用域感知）。
 *
 * 为什么需要作用域：同一个组合键在不同作用域里可以合法共存 ——
 * 终端聚焦时 Ctrl+F 是「终端内搜索」，与全局 Ctrl+F 不会同时触发。
 * 原来的实现只按「归一化后的键」分组，会把这种跨作用域重复也报成冲突，
 * 结果是用户想设一个全局 Ctrl+F 时被拦住，而那个键其实完全能用。
 *
 * 判定规则：
 *   - 同作用域内重复 → 真冲突（按一次触发两件事）；
 *   - 跨作用域重复   → 不算冲突（终端聚焦时以终端为准）。
 */

export interface ConflictInfo {
  combo: string
  actions: Array<{ id: string; label: string }>
  /** 冲突所在作用域；同作用域重复才算真冲突 */
  scope: 'global' | 'terminal'
}

/** 归一化为统一写法，用于比较「两种写法是否同一个键」 */
function normalize(combo: string): string | null {
  const parsed = parseShortcut(combo)
  if (!parsed) return null
  return [
    parsed.ctrl ? 'Ctrl' : '',
    parsed.alt ? 'Alt' : '',
    parsed.shift ? 'Shift' : '',
    parsed.key.toUpperCase()
  ]
    .filter(Boolean)
    .join('+')
}

/**
 * 检测快捷键映射中的冲突。
 * @returns 每个冲突项包含组合键、所在作用域、以及涉及的动作
 */
export function detectShortcutConflicts(shortcuts: ShortcutMap | undefined): ConflictInfo[] {
  const map = new Map<string, ConflictInfo>()

  for (const action of SHORTCUT_ACTIONS) {
    const combo = shortcuts?.[action.id] || action.default
    const normalized = normalize(combo)
    if (!normalized) continue

    const scope = SHORTCUT_SCOPE[action.id]
    // 作用域进 key，才不会被别的作用域的同名键串味
    const key = scope + '|' + normalized
    const hit = map.get(key)
    if (hit) {
      hit.actions.push({ id: action.id, label: action.label })
    } else {
      map.set(key, { combo: normalized, scope, actions: [{ id: action.id, label: action.label }] })
    }
  }

  const conflicts: ConflictInfo[] = []
  for (const info of map.values()) {
    if (info.actions.length > 1) conflicts.push(info)
  }
  return conflicts
}

/**
 * 检查某个组合键是否与现有映射冲突。
 *
 * @param combo 要检查的组合键
 * @param excludeAction 排除的动作（编辑自身时用）
 * @param shortcuts 当前映射
 * @param scope 目标动作的作用域；缺省按 global 处理（与「新键默认全局」的直觉一致）
 */
export function checkSingleConflict(
  combo: string,
  excludeAction: string,
  shortcuts: ShortcutMap | undefined,
  scope: 'global' | 'terminal' = 'global'
): { id: string; label: string; scope: 'global' | 'terminal' } | null {
  const normalized = normalize(combo)
  if (!normalized) return null

  for (const action of SHORTCUT_ACTIONS) {
    if (action.id === excludeAction) continue
    if (SHORTCUT_SCOPE[action.id] !== scope) continue

    const actionCombo = shortcuts?.[action.id] || action.default
    if (normalize(actionCombo) === normalized) {
      return { id: action.id, label: action.label, scope }
    }
  }

  return null
}