import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Braces, Loader2 } from 'lucide-react'
import type { Command, CommandInput, CommandVariable } from '@shared/types'
import { useCommandStore } from '@/stores/commandStore'
import { useToastStore } from '@/stores/toastStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { COLORS, COMMAND_ICONS, DynamicIcon } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { Combobox, Field, Modal, Toggle } from '@/components/ui'

const VAR_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

/**
 * 命令编辑器：命令文本中写 {{变量名}} 会自动生成变量表，
 * 可在表中为每个变量设置默认值与是否必填。
 */
export function CommandEditor({
  open,
  initial,
  presetGroup,
  onClose
}: {
  open: boolean
  initial: Command | null
  /** 新建时预填分组（从分组头的 + 进入） */
  presetGroup?: string
  onClose: () => void
}): JSX.Element {
  const save = useCommandStore((s) => s.save)
  const commands = useCommandStore((s) => s.commands)

  const [name, setName] = useState('')
  const [command, setCommand] = useState('')
  const [description, setDescription] = useState('')
  const [group, setGroup] = useState('默认')
  const [icon, setIcon] = useState('Terminal')
  const [color, setColor] = useState('')
  const [confirmRequired, setConfirmRequired] = useState(false)
  const [variables, setVariables] = useState<CommandVariable[]>([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    setName(initial?.name ?? '')
    setCommand(initial?.command ?? '')
    setDescription(initial?.description ?? '')
    setGroup(initial?.group ?? presetGroup ?? '默认')
    setIcon(initial?.icon ?? 'Terminal')
    setColor(initial?.color ?? '')
    setConfirmRequired(initial?.confirmRequired ?? false)
    setVariables(initial?.variables ?? [])
    setSaving(false)
  }, [open, initial, presetGroup])

  /** 从命令文本提取变量名（按出现顺序去重） */
  const detectedNames = useMemo(() => {
    const found: string[] = []
    for (const m of command.matchAll(VAR_RE)) {
      if (!found.includes(m[1])) found.push(m[1])
    }
    return found
  }, [command])

  // 命令文本变化时同步变量表：保留已配置项，补新增、去移除
  const detectedKey = detectedNames.join('\u0000')
  useEffect(() => {
    setVariables((prev) => {
      const byName = new Map(prev.map((v) => [v.name, v]))
      return detectedNames.map(
        (n) => byName.get(n) ?? { name: n, type: 'text' as const, required: false }
      )
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detectedKey])

  const updateVar = (varName: string, patch: Partial<CommandVariable>): void => {
    setVariables((prev) => prev.map((v) => (v.name === varName ? { ...v, ...patch } : v)))
  }

  const submit = async (): Promise<void> => {
    if (!name.trim()) {
      useToastStore.getState().push({ kind: 'warning', title: '请填写命令名称' })
      return
    }
    if (!command.trim()) {
      useToastStore.getState().push({ kind: 'warning', title: '请填写命令内容' })
      return
    }
    setSaving(true)
    const input: CommandInput = {
      id: initial?.id,
      name: name.trim(),
      command,
      description: description.trim() || undefined,
      group: group.trim() || '默认',
      icon,
      color: color || undefined,
      confirmRequired,
      variables
    }
    const saved = await save(input)
    setSaving(false)
    if (saved) {
      useToastStore.getState().push({
        kind: 'success',
        title: initial ? `已更新「${saved.name}」` : `已创建「${saved.name}」`
      })
      onClose()
    }
  }

  const extraGroups = useSettingsStore((s) => s.settings.commandGroups)
  const groupOptions = [
    ...new Set([...commands.map((c) => c.group), ...(extraGroups ?? [])].filter(Boolean))
  ]

  return (
    <Modal
      open={open}
      title={initial ? `编辑命令 · ${initial.name}` : '新建常用命令'}
      onClose={onClose}
      width="max-w-xl"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => void submit()} disabled={saving}>
            {saving ? <Loader2 size={13} className="animate-spin" /> : null}
            保存
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
        <Field label="名称">
          <input
            className="input selectable"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：查看 CPU 温度"
          />
        </Field>

        <Field label="分组" hint="可用 / 分层">
          <Combobox
            value={group}
            onChange={setGroup}
            options={groupOptions}
            placeholder="默认"
          />
        </Field>

        <Field label="命令内容" hint="用 {{变量名}} 声明占位符" className="col-span-2">
          <textarea
            className="input scroll-thin h-20 resize-none selectable py-2 font-mono text-xs leading-relaxed"
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder={'例如：cd {{path}} && ls -la'}
            spellCheck={false}
          />
        </Field>

        <Field label="描述" className="col-span-2">
          <input
            className="input selectable"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="这条命令是做什么的（显示在名称下方）"
          />
        </Field>

        {/* 变量表 */}
        {variables.length > 0 && (
          <div className="col-span-2">
            <div className="field-label flex items-center gap-1">
              <Braces size={11} className="text-accent" />
              变量（{variables.length}）
            </div>
            <div className="space-y-1.5">
              {variables.map((v) => (
                <div
                  key={v.name}
                  className="flex items-center gap-2 rounded-md border border-edge-soft bg-app px-2 py-1.5"
                >
                  <span className="shrink-0 font-mono text-2xs text-accent">{`{{${v.name}}}`}</span>
                  <input
                    className="input h-6 flex-1 text-2xs"
                    placeholder="默认值（可留空）"
                    value={v.defaultValue ?? ''}
                    onChange={(e) => updateVar(v.name, { defaultValue: e.target.value })}
                  />
                  <label className="flex shrink-0 cursor-pointer items-center gap-1 text-2xs text-ink-3">
                    <input
                      type="checkbox"
                      className="h-3 w-3 accent-[rgb(var(--c-accent))]"
                      checked={Boolean(v.required)}
                      onChange={(e) => updateVar(v.name, { required: e.target.checked })}
                    />
                    必填
                  </label>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* 图标 */}
        <Field label="图标" className="col-span-2">
          <div className="flex flex-wrap gap-1 pt-0.5">
            {COMMAND_ICONS.map((ic) => (
              <button
                key={ic}
                type="button"
                title={ic}
                onClick={() => setIcon(ic)}
                className={cn(
                  'flex h-6 w-6 items-center justify-center rounded border transition-colors',
                  icon === ic
                    ? 'border-accent bg-accent/15 text-accent'
                    : 'border-edge-soft text-ink-3 hover:border-edge hover:text-ink'
                )}
              >
                <DynamicIcon name={ic} size={13} />
              </button>
            ))}
          </div>
        </Field>

        {/* 颜色 */}
        <Field label="色点" className="col-span-2">
          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              title="不使用颜色"
              onClick={() => setColor('')}
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-full border text-2xs text-ink-3',
                color === '' ? 'border-accent text-accent' : 'border-edge'
              )}
            >
              ∅
            </button>
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setColor(c)}
                className={cn(
                  'h-5 w-5 rounded-full border-2 transition-transform hover:scale-110',
                  color === c ? 'border-ink' : 'border-transparent'
                )}
                style={{ background: c }}
              />
            ))}
          </div>
        </Field>

        {/* 危险标记 */}
        <div className="col-span-2 flex items-center justify-between rounded-lg border border-edge-soft bg-app px-3 py-2.5">
          <div className="flex items-start gap-2">
            <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
            <div>
              <div className="text-xs text-ink-2">危险命令</div>
              <div className="mt-0.5 text-2xs text-ink-3">
                开启后每次执行都会先弹出二次确认；命中全局危险关键词的命令也会被拦截确认
              </div>
            </div>
          </div>
          <Toggle checked={confirmRequired} onChange={setConfirmRequired} />
        </div>
      </div>
    </Modal>
  )
}
