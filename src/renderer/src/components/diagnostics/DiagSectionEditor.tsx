import { useEffect, useState } from 'react'
import type { DiagSection, DiagSectionInput } from '@shared/types'
import { Field, Modal } from '@/components/ui'
import { useDiagStore } from '@/stores/diagStore'

/**
 * 自定义诊断项编辑器（新建 / 修改 / 从内置项复制）。
 * 内置项不可直接编辑 —— 面板上提供「复制为自定义」后在此修改，避免升级时被覆盖。
 */

interface FormState {
  name: string
  group: string
  command: string
  timeoutMs: string
  description: string
}

const EMPTY: FormState = {
  name: '',
  group: '自定义',
  command: '',
  timeoutMs: '12000',
  description: ''
}

function fromSection(s: DiagSection): FormState {
  return {
    name: s.name,
    group: s.group,
    command: s.command,
    timeoutMs: String(s.timeoutMs),
    description: s.description ?? ''
  }
}

export function DiagSectionEditor({
  open,
  initial,
  onClose
}: {
  open: boolean
  /** 传入表示编辑/复制已有项（复制时 id 置空——由调用方处理） */
  initial: DiagSection | null
  onClose: () => void
}): JSX.Element {
  const sections = useDiagStore((s) => s.sections)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setForm(initial ? fromSection(initial) : EMPTY)
    setError(null)
    setSaving(false)
  }, [open, initial])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((f) => ({ ...f, [key]: value }))
  }

  const groups = [...new Set(sections.map((s) => s.group))]

  const submit = async (): Promise<void> => {
    if (!form.name.trim()) return setError('请填写诊断项名称')
    if (!form.command.trim()) return setError('请填写要执行的命令')
    const timeout = Number(form.timeoutMs)
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) {
      return setError('超时需为 1000-120000 毫秒')
    }

    setSaving(true)
    setError(null)
    const input: DiagSectionInput = {
      // 复制场景：内置项 id 不传 → 生成新的自定义项
      id: initial && !initial.builtin ? initial.id : undefined,
      name: form.name,
      group: form.group,
      command: form.command,
      timeoutMs: timeout,
      description: form.description
    }
    const saved = await useDiagStore.getState().saveSection(input)
    setSaving(false)
    if (saved) {
      // 新建/复制后自动勾选，方便直接运行
      const { selected, toggleSection } = useDiagStore.getState()
      if (!selected.includes(saved.id)) toggleSection(saved.id)
      onClose()
    }
  }

  return (
    <Modal
      open={open}
      title={initial && !initial.builtin ? '编辑诊断项' : initial ? '复制为自定义诊断项' : '新建自定义诊断项'}
      onClose={onClose}
      footer={
        <>
          <button className="btn h-7 px-3 text-xs" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary h-7 px-3.5 text-xs"
            disabled={saving}
            onClick={() => void submit()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div className="grid grid-cols-2 gap-x-3">
          <Field label="名称">
            <input
              className="input selectable"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="例如：串口设备枚举"
              autoFocus
            />
          </Field>
          <Field label="分组">
            <input
              className="input selectable"
              value={form.group}
              onChange={(e) => set('group', e.target.value)}
              list="diag-groups"
              placeholder="自定义"
            />
          </Field>
        </div>
        <datalist id="diag-groups">
          {groups.map((g) => (
            <option key={g} value={g} />
          ))}
        </datalist>

        <Field label="采集命令（在设备侧执行，支持 ; || 组合与重定向）">
          <textarea
            className="textarea selectable min-h-[72px] font-mono text-[11px] leading-relaxed"
            value={form.command}
            onChange={(e) => set('command', e.target.value)}
            placeholder="例如：ls -l /dev/tty* 2>/dev/null; cat /proc/tty/drivers 2>/dev/null"
          />
        </Field>

        <div className="grid grid-cols-2 gap-x-3">
          <Field label="超时（毫秒）">
            <input
              className="input selectable font-mono"
              value={form.timeoutMs}
              onChange={(e) => set('timeoutMs', e.target.value.replace(/[^\d]/g, ''))}
              placeholder="12000"
            />
          </Field>
          <Field label="说明（可选）">
            <input
              className="input selectable"
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="这项检查是干什么的"
            />
          </Field>
        </div>

        <div className="rounded-md border border-edge-soft bg-raised/50 px-2.5 py-2 text-2xs leading-relaxed text-ink-3">
          提示：命令的输出会原样进入诊断报告。命令不存在或权限不足不算失败——会在报告里显示 stderr
          原文，便于判断设备环境。
        </div>

        {error && <div className="text-2xs text-danger">{error}</div>}
      </div>
    </Modal>
  )
}
