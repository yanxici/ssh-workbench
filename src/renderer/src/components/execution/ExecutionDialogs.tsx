import type * as React from 'react'
import { AlertTriangle, Braces, Send } from 'lucide-react'
import { useSessionStore } from '@/stores/sessionStore'
import { renderTemplate, useExecutionStore } from '@/stores/executionStore'
import { Field } from '@/components/ui'
import { isImeComposing } from '@/lib/ime'
import { useOverlayEscape } from '@/lib/overlayKeys'
import { useI18n } from '@/i18n'

/**
 * 执行流水线配套弹窗：
 * 1. VariablePromptDialog —— 填写 {{变量}}（实时预览替换结果）
 * 2. DangerConfirmDialog —— 危险命令二次确认
 */

export function VariablePromptDialog(): React.JSX.Element | null {
  const { t } = useI18n()
  const pending = useExecutionStore((s) => s.pending)
  const values = useExecutionStore((s) => s.pendingValues)
  // 目标主机：填变量期间用户可能切了标签，必须让他看见命令到底发往哪台
  const pendingSessionId = useExecutionStore((s) => s.pendingSessionId)
  const targetLabel = useSessionStore(
    (s) => s.sessions.find((x) => x.id === pendingSessionId)?.connectionName ?? ''
  )
  const setValue = useExecutionStore((s) => s.setPendingValue)
  const submit = useExecutionStore((s) => s.submitVariables)
  const cancel = useExecutionStore((s) => s.cancelVariables)

  // 入弹层栈：App 的全局快捷键在 capture 阶段跑，不让路会抢走输入框里的组合键
  useOverlayEscape(Boolean(pending), cancel)

  if (!pending) return null

  return (
    <div
      className="modal-overlay items-center pt-0"
      style={{ zIndex: 45 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel()
      }}
    >
      <div className="modal max-w-md">
        <div className="modal-header">
          <div className="modal-title flex items-center gap-2">
            <Braces size={13} className="text-accent" />
            {t('cmd.varDialog.title', { name: pending.name })}
          </div>
          {targetLabel ? (
            <div className="modal-subtitle truncate">{t('cmd.varDialog.target', { target: targetLabel })}</div>
          ) : null}
        </div>

        <div className="modal-body space-y-3">
          {pending.variables.map((v, i) => (
            <Field
              key={v.name}
              label={v.label ?? v.name}
              hint={v.required ? t('cmd.varDialog.required') : undefined}
            >
              {v.type === 'select' && v.options && v.options.length > 0 ? (
                <select
                  className="input"
                  value={values[v.name] ?? ''}
                  onChange={(e) => setValue(v.name, e.target.value)}
                >
                  <option value="">{t('cmd.varDialog.selectPlaceholder')}</option>
                  {v.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  autoFocus={i === 0}
                  className="input selectable font-mono text-xs"
                  placeholder={v.placeholder ?? t('cmd.varDialog.inputPlaceholder', { name: v.name })}
                  value={values[v.name] ?? ''}
                  onChange={(e) => setValue(v.name, e.target.value)}
                  onKeyDown={(e) => {
                    if (isImeComposing(e)) return
                    if (e.key === 'Enter') submit()
                  }}
                />
              )}
            </Field>
          ))}

          <div>
            <div className="field-label">{t('cmd.varDialog.preview')}</div>
            <div className="selectable rounded-md border border-edge-soft bg-app px-2.5 py-2 font-mono text-2xs leading-relaxed text-ink-2">
              {renderTemplate(pending.template, values)}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={cancel}>
            {t('cmd.common.cancel')}
          </button>
          <button className="btn btn-primary" onClick={submit}>
            <Send size={12} />
            {t('cmd.varDialog.send')}
          </button>
        </div>
      </div>
    </div>
  )
}

export function DangerConfirmDialog(): React.JSX.Element | null {
  const { t } = useI18n()
  const danger = useExecutionStore((s) => s.danger)
  const confirm = useExecutionStore((s) => s.confirmDanger)
  const cancel = useExecutionStore((s) => s.cancelDanger)

  /*
   * 名字必须来自弹窗锁定的会话，不能用 activeSession()：
   * 那是非响应式取值 + 实时活动标签，弹窗期间切标签会出现
   * 「显示 A 主机，实际打到 B 主机」。与 confirmDanger 用的是同一个 id。
   * hook 必须在提前 return 之前调用，否则 hooks 顺序会随弹窗开关变化。
   */
  const session = useSessionStore((s) =>
    danger ? s.sessions.find((x) => x.id === danger.sessionId) : undefined
  ) ?? null

  // 同上：入栈后 Esc 只关栈顶，且 App 的全局分发会让路
  useOverlayEscape(danger !== null, cancel)

  if (!danger) return null

  return (
    <div
      className="modal-overlay items-center pt-0"
      style={{ zIndex: 50 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel()
      }}
    >
      <div className="modal max-w-md border-warning/40">
        <div className="modal-header border-warning/25">
          <div className="modal-title flex items-center gap-2 text-warning">
            <AlertTriangle size={14} />
            {t('cmd.dangerDialog.title')}
          </div>
        </div>

        <div className="modal-body space-y-3">
          <div className="text-xs leading-relaxed text-ink-2">
            {t('cmd.dangerDialog.willRunPrefix')}
            <span className="mx-1 font-medium text-ink">
              {session ? session.title : t('cmd.dangerDialog.currentTerminal')}
            </span>
            {t('cmd.dangerDialog.willRunSuffix')}
          </div>

          <div className="selectable rounded-md border border-warning/30 bg-warning/5 px-3 py-2.5 font-mono text-xs leading-relaxed text-warning">
            {danger.finalText}
          </div>

          <div className="text-2xs leading-relaxed text-ink-3">
            {t('cmd.dangerDialog.warning')}
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={cancel}>
            {t('cmd.common.cancel')}
          </button>
          <button
            className="btn border-transparent bg-warning text-black hover:bg-warning/90 hover:text-black"
            onClick={confirm}
          >
            {t('cmd.dangerDialog.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
