import { AlertTriangle, Braces, Send } from 'lucide-react'
import { activeSession } from '@/stores/sessionStore'
import { renderTemplate, useExecutionStore } from '@/stores/executionStore'
import { Field } from '@/components/ui'
import { isImeComposing } from '@/lib/ime'

/**
 * 执行流水线配套弹窗：
 * 1. VariablePromptDialog —— 填写 {{变量}}（实时预览替换结果）
 * 2. DangerConfirmDialog —— 危险命令二次确认
 */

export function VariablePromptDialog(): JSX.Element | null {
  const pending = useExecutionStore((s) => s.pending)
  const values = useExecutionStore((s) => s.pendingValues)
  const setValue = useExecutionStore((s) => s.setPendingValue)
  const submit = useExecutionStore((s) => s.submitVariables)
  const cancel = useExecutionStore((s) => s.cancelVariables)

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
            填写变量 · {pending.name}
          </div>
        </div>

        <div className="modal-body space-y-3">
          {pending.variables.map((v, i) => (
            <Field
              key={v.name}
              label={v.label ?? v.name}
              hint={v.required ? '必填' : undefined}
            >
              {v.type === 'select' && v.options && v.options.length > 0 ? (
                <select
                  className="input"
                  value={values[v.name] ?? ''}
                  onChange={(e) => setValue(v.name, e.target.value)}
                >
                  <option value="">请选择…</option>
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
                  placeholder={v.placeholder ?? `输入 ${v.name}`}
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
            <div className="field-label">将发送</div>
            <div className="selectable rounded-md border border-edge-soft bg-app px-2.5 py-2 font-mono text-2xs leading-relaxed text-ink-2">
              {renderTemplate(pending.template, values)}
            </div>
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={cancel}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit}>
            <Send size={12} />
            发送到终端
          </button>
        </div>
      </div>
    </div>
  )
}

export function DangerConfirmDialog(): JSX.Element | null {
  const danger = useExecutionStore((s) => s.danger)
  const confirm = useExecutionStore((s) => s.confirmDanger)
  const cancel = useExecutionStore((s) => s.cancelDanger)

  if (!danger) return null
  const session = activeSession()

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
            危险操作二次确认
          </div>
        </div>

        <div className="modal-body space-y-3">
          <div className="text-xs leading-relaxed text-ink-2">
            即将在
            <span className="mx-1 font-medium text-ink">
              {session ? session.title : '当前终端'}
            </span>
            执行以下命令：
          </div>

          <div className="selectable rounded-md border border-warning/30 bg-warning/5 px-3 py-2.5 font-mono text-xs leading-relaxed text-warning">
            {danger.finalText}
          </div>

          <div className="text-2xs leading-relaxed text-ink-3">
            该命令可能不可逆地改变设备状态。请再次确认目标设备、路径与参数无误后再执行。
          </div>
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={cancel}>
            取消
          </button>
          <button
            className="btn border-transparent bg-warning text-black hover:bg-warning/90 hover:text-black"
            onClick={confirm}
          >
            确认执行
          </button>
        </div>
      </div>
    </div>
  )
}
