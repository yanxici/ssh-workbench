import type * as React from 'react'
import { useState } from 'react'
import { AlertTriangle, Keyboard, RotateCcw } from 'lucide-react'
import type { ShortcutAction } from '@shared/types'
import { SHORTCUT_ACTIONS, SHORTCUT_SCOPE, resolveShortcuts } from '@/lib/shortcuts'
import { detectShortcutConflicts, checkSingleConflict } from '@/lib/shortcutConflict'
import { useSettingsStore } from '@/stores/settingsStore'
import { cn } from '@/lib/utils'
import { Modal } from '@/components/ui'
import { useI18n } from '@/i18n'

/**
 * 设置 → 快捷键：点击后按下新组合键即可录制；Esc 取消、Backspace 清空。
 *
 * 冲突处理是这里的重点：录入一个已被占用的组合键时不能直接覆盖，
 * 先弹窗告诉用户「被谁占了」，由他决定取消还是强制保存。
 */
export function ShortcutSection(): React.JSX.Element {
  const { t } = useI18n()
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const current = resolveShortcuts(settings.shortcuts)
  const [recording, setRecording] = useState<ShortcutAction | null>(null)
  const [pendingCombo, setPendingCombo] = useState<string>('')
  const [conflictWarning, setConflictWarning] = useState<{
    action: string
    conflict: string
  } | null>(null)

  // 检测当前快捷键映射中的冲突
  const conflicts = detectShortcutConflicts(settings.shortcuts)

  /*
   * 一键恢复「冲突涉及的动作」为默认值。
   *
   * 为什么需要：单行重置按钮早就有（下面每行的 RotateCcw），但一次改坏三四个键时，
   * 冲突提示只列「哪个键被谁占了」，用户得逐行去点小图标，而且不知道点哪几行 ——
   * 提示里给的是 label，行里显示的是组合键，两者对不上。
   *
   * 为什么只重置冲突项而不是全部恢复：用户可能有意把某几个键改成自己顺手的组合，
   * 那些没冲突的自定义值不该被顺手抹掉。所以按 ConflictInfo.actions[].id 精确取集合。
   */
  const resetConflicts = (): void => {
    const ids = new Set<string>()
    for (const c of conflicts) {
      for (const a of c.actions) ids.add(a.id)
    }
    if (ids.size === 0) return
    const next = { ...settings.shortcuts }
    for (const id of ids) delete next[id as ShortcutAction]
    void update({ shortcuts: next })
    setRecording(null)
  }

  const commit = (action: ShortcutAction, combo: string | undefined): void => {
    // 检查冲突
    if (combo) {
      // 按被编辑动作自身的 scope 判冲突：终端键与全局键可以同名共存
      const conflict = checkSingleConflict(
        combo,
        action,
        settings.shortcuts,
        SHORTCUT_SCOPE[action]
      )
      if (conflict) {
        setPendingCombo(combo)
        setConflictWarning({ action, conflict: conflict.label })
        return
      }
    }

    const next = { ...settings.shortcuts }
    if (combo === undefined) delete next[action]
    else next[action] = combo
    void update({ shortcuts: next })
    setRecording(null)
    setPendingCombo('')
  }

  const forceCommit = (): void => {
    if (!conflictWarning || !pendingCombo) return
    const next = { ...settings.shortcuts }
    next[conflictWarning.action as ShortcutAction] = pendingCombo
    void update({ shortcuts: next })
    setRecording(null)
    setPendingCombo('')
    setConflictWarning(null)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    /*
     * 冲突弹窗弹出期间必须完全让路。
     * recording 这时还没清（用户是在上一次录制里撞的冲突），只要还拦着键盘，
     * 弹窗里的 Enter / Space / Tab 全被这里吞掉 —— 用户点不了「仍然使用」，
     * 只能靠鼠标，而 Esc 又会被当成「取消录制」把整个流程关掉。
     */
    if (!recording || conflictWarning) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setRecording(null)
      return
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      commit(recording, undefined)
      return
    }
    // 只接受「修饰键 + 单键」
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      // Tab 需配合修饰键才有意义
      if (e.key === 'Tab') return
      return
    }
    const key = e.key.toLowerCase()
    // 单独按修饰键不提交
    if (['control', 'shift', 'alt', 'meta'].includes(key)) return
    const combo = [
      e.ctrlKey || e.metaKey ? 'Ctrl' : '',
      e.altKey ? 'Alt' : '',
      e.shiftKey ? 'Shift' : '',
      key === ',' ? ',' : key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key
    ]
      .filter(Boolean)
      .join('+')
    commit(recording, combo)
  }

  return (
    /*
     * 用 capture 挂在这里：录制态下要先于任何内层元素拿到按键。
     * App 那个 window 上的全局分发由弹层栈负责让路（见 lib/overlayKeys.ts），
     * 设置面板本身就是一个 Modal，所以录制时它不会抢键。
     */
    <div className="space-y-1.5" onKeyDownCapture={onKeyDown}>
      <div className="mb-1 text-2xs leading-relaxed text-ink-3">
        {t('settings.ext.shortcuts.introBeforeEsc')}
        <kbd className="kbd">Esc</kbd>
        {t('settings.ext.shortcuts.introBetween')}
        <kbd className="kbd">Backspace</kbd>
        {t('settings.ext.shortcuts.introAfterBackspace')}
      </div>

      {conflicts.length > 0 && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1 text-2xs leading-relaxed text-ink-2">
            {t('settings.ext.shortcuts.conflictsFound', { count: conflicts.length })}
            {conflicts.map((c, i) => (
              <div key={i} className="mt-1">
                <code className="text-warning">{c.combo}</code>
                {t('settings.ext.shortcuts.assignedTo')}
                {c.actions.map((a) => a.label).join(t('settings.ext.shortcuts.listSep'))}
              </div>
            ))}
          </div>
          <button
            className="btn shrink-0 whitespace-nowrap px-2 py-0.5 text-2xs"
            title={t('settings.ext.shortcuts.resetConflictsTitle')}
            onClick={resetConflicts}
          >
            <RotateCcw size={10} />
            {t('settings.ext.shortcuts.resetAll')}
          </button>
        </div>
      )}

      {SHORTCUT_ACTIONS.map((action) => {
        const value = current[action.id]
        const isRecording = recording === action.id
        const isDefault = !settings.shortcuts?.[action.id]
        return (
          <div
            key={action.id}
            className="flex items-center justify-between gap-3 rounded-md border border-edge-soft bg-panel px-2.5 py-1.5"
          >
            <div className="min-w-0">
              <div className="text-xs text-ink-2">{action.label}</div>
              {isDefault && (
                <div className="text-3xs text-ink-3/70">
                  {t('settings.ext.shortcuts.defaultBadge')}
                </div>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {!isDefault && (
                <button
                  className="btn-icon h-6 w-6 hover:text-warning"
                  title={t('settings.ext.shortcuts.resetOneTitle', { combo: action.default })}
                  onClick={() => commit(action.id, undefined)}
                >
                  <RotateCcw size={11} />
                </button>
              )}
              <button
                className={cn(
                  'flex h-7 min-w-[72px] items-center justify-center gap-1 rounded-md border px-2 font-mono text-xs transition-colors',
                  isRecording
                    ? 'border-accent bg-accent/15 text-accent'
                    : 'border-edge bg-raised text-ink-2 hover:border-accent/50'
                )}
                onClick={() => setRecording(isRecording ? null : action.id)}
              >
                <Keyboard size={11} />
                {isRecording ? t('settings.ext.shortcuts.pressKey') : value}
              </button>
            </div>
          </div>
        )
      })}
      <div className="pt-1 text-3xs leading-relaxed text-ink-3/70">
        {t('settings.ext.shortcuts.terminalTip')}
      </div>

      {conflictWarning && (
        <Modal
          open
          title={t('settings.ext.shortcuts.conflictModalTitle')}
          onClose={() => {
            setConflictWarning(null)
            setPendingCombo('')
            setRecording(null)
          }}
        >
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
              <div className="text-xs text-ink-2">
                {t('settings.ext.shortcuts.conflictUsedBefore')}
                <code className="rounded-sm bg-raised px-1 py-0.5 font-mono text-warning">
                  {pendingCombo}
                </code>
                {t('settings.ext.shortcuts.conflictUsedAfter', {
                  conflict: conflictWarning.conflict
                })}
              </div>
            </div>
            <div className="text-2xs text-ink-3">
              {t('settings.ext.shortcuts.conflictModalHint')}
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                className="btn"
                onClick={() => {
                  setConflictWarning(null)
                  setPendingCombo('')
                  setRecording(null)
                }}
              >
                {t('settings.ext.shortcuts.cancel')}
              </button>
              <button className="btn btn-danger" onClick={forceCommit}>
                {t('settings.ext.shortcuts.forceSave')}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
