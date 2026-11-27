import type * as React from 'react'
import { useEffect, useState } from 'react'
import type { DiagSection, DiagSectionInput } from '@shared/types'
import { useI18n } from '@/i18n'
import { Combobox, Field, Modal } from '@/components/ui'
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

function emptyForm(defaultGroup: string): FormState {
  return {
    name: '',
    group: defaultGroup,
    command: '',
    timeoutMs: '12000',
    description: ''
  }
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
}): React.JSX.Element {
  const { t } = useI18n()
  const sections = useDiagStore((s) => s.sections)
  const [form, setForm] = useState<FormState>(() => emptyForm(t('panel.diagEditor.defaultGroup')))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setForm(initial ? fromSection(initial) : emptyForm(t('panel.diagEditor.defaultGroup')))
    setError(null)
    setSaving(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((f) => ({ ...f, [key]: value }))
  }

  const groups = [...new Set(sections.map((s) => s.group))]

  const submit = async (): Promise<void> => {
    if (!form.name.trim()) return setError(t('panel.diagEditor.errName'))
    if (!form.command.trim()) return setError(t('panel.diagEditor.errCommand'))
    const timeout = Number(form.timeoutMs)
    if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 120000) {
      return setError(t('panel.diagEditor.errTimeout'))
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
      title={
        initial && !initial.builtin
          ? t('panel.diagEditor.titleEdit')
          : initial
            ? t('panel.diagEditor.titleCopy')
            : t('panel.diagEditor.titleNew')
      }
      onClose={onClose}
      footer={
        <>
          <button className="btn h-7 px-3 text-xs" onClick={onClose}>
            {t('panel.diagEditor.cancel')}
          </button>
          <button
            className="btn btn-primary h-7 px-3.5 text-xs"
            disabled={saving}
            onClick={() => void submit()}
          >
            {saving ? t('panel.diagEditor.saving') : t('panel.diagEditor.save')}
          </button>
        </>
      }
    >
      <div className="space-y-3.5">
        <div className="grid grid-cols-2 gap-x-3">
          <Field label={t('panel.diagEditor.fieldName')}>
            <input
              className="input selectable"
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder={t('panel.diagEditor.fieldNamePlaceholder')}
              autoFocus
            />
          </Field>
          <Field label={t('panel.diagEditor.fieldGroup')}>
            <Combobox
              value={form.group}
              onChange={(v) => set('group', v)}
              options={groups}
              placeholder={t('panel.diagEditor.defaultGroup')}
            />
          </Field>
        </div>

        <Field label={t('panel.diagEditor.fieldCommand')}>
          <textarea
            className="textarea selectable min-h-[72px] font-mono text-2xs leading-relaxed"
            value={form.command}
            onChange={(e) => set('command', e.target.value)}
            placeholder={t('panel.diagEditor.fieldCommandPlaceholder')}
          />
        </Field>

        <div className="grid grid-cols-2 gap-x-3">
          <Field label={t('panel.diagEditor.fieldTimeout')}>
            <input
              className="input selectable font-mono"
              value={form.timeoutMs}
              onChange={(e) => set('timeoutMs', e.target.value.replace(/[^\d]/g, ''))}
              placeholder="12000"
            />
          </Field>
          <Field label={t('panel.diagEditor.fieldDesc')}>
            <input
              className="input selectable"
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder={t('panel.diagEditor.fieldDescPlaceholder')}
            />
          </Field>
        </div>

        <div className="rounded-md border border-edge-soft bg-raised/50 px-2.5 py-2 text-2xs leading-relaxed text-ink-3">
          {t('panel.diagEditor.tip')}
        </div>

        {error && <div className="text-2xs text-danger">{error}</div>}
      </div>
    </Modal>
  )
}
