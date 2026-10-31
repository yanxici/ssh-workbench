import { useState } from 'react'
import { AlertTriangle, Keyboard, RotateCcw } from 'lucide-react'
import type { ShortcutAction } from '@shared/types'
import { SHORTCUT_ACTIONS, resolveShortcuts } from '@/lib/shortcuts'
import { detectShortcutConflicts, checkSingleConflict } from '@/lib/shortcutConflict'
import { useSettingsStore } from '@/stores/settingsStore'
import { cn } from '@/lib/utils'
import { Modal } from '@/components/ui'

/**
 * 设置 → 快捷键：点击后按下新组合键即可录制；Esc 取消、Backspace 清空。
 *
 * 冲突处理是这里的重点：录入一个已被占用的组合键时不能直接覆盖，
 * 先弹窗告诉用户「被谁占了」，由他决定取消还是强制保存。
 */
export function ShortcutSection(): JSX.Element {
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
      const conflict = checkSingleConflict(combo, action, settings.shortcuts)
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
    if (!recording) return
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
      if (e.key === 'Tab') return // Tab 需配合修饰键才有意义
      return
    }
    const key = e.key.toLowerCase()
    if (['control', 'shift', 'alt', 'meta'].includes(key)) return // 单独按修饰键不提交
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
    <div className="space-y-1.5" onKeyDown={onKeyDown}>
      <div className="mb-1 text-2xs leading-relaxed text-ink-3">
        点击右侧键位进入录制，按下新组合键即保存；<kbd className="kbd">Esc</kbd> 取消、
        <kbd className="kbd">Backspace</kbd> 清除该项。
      </div>

      {/* 冲突警告 */}
      {conflicts.length > 0 && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1 text-2xs leading-relaxed text-ink-2">
            检测到 {conflicts.length} 个快捷键冲突：
            {conflicts.map((c, i) => (
              <div key={i} className="mt-1">
                <code className="text-warning">{c.combo}</code> 被分配给：
                {c.actions.map((a) => a.label).join('、')}
              </div>
            ))}
          </div>
          <button
            className="btn shrink-0 whitespace-nowrap px-2 py-0.5 text-2xs"
            title="把上面这些冲突项全部恢复默认（不影响其它已自定义的键）"
            onClick={resetConflicts}
          >
            <RotateCcw size={10} />
            全部恢复默认
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
              {isDefault && <div className="text-3xs text-ink-3/70">使用默认值</div>}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {!isDefault && (
                <button
                  className="btn-icon h-6 w-6 hover:text-warning"
                  title={`恢复默认：${action.default}`}
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
                {isRecording ? '按下键…' : value}
              </button>
            </div>
          </div>
        )
      })}
      <div className="pt-1 text-3xs leading-relaxed text-ink-3/70">
        提示：终端内「搜索 / 复制 / 粘贴」的组合键（Ctrl+F / Ctrl+Shift+C / Ctrl+Shift+V）在此配置后，
        在终端聚焦时同样生效；避免与系统/浏览器快捷键冲突。
      </div>

      {/* 快捷键冲突确认弹窗 */}
      {conflictWarning && (
        <Modal
          open
          title="快捷键冲突"
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
                快捷键{' '}
                <code className="rounded bg-raised px-1 py-0.5 font-mono text-warning">
                  {pendingCombo}
                </code>{' '}
                已被「{conflictWarning.conflict}」使用。
              </div>
            </div>
            <div className="text-2xs text-ink-3">
              继续保存将覆盖原有快捷键，建议选择不同的组合键避免冲突。
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
                取消
              </button>
              <button className="btn btn-danger" onClick={forceCommit}>
                强制保存
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
