import { useEffect, useState } from 'react'
import type { TunnelConfig, TunnelInput, TunnelType } from '@shared/types'
import { cn } from '@/lib/utils'
import { Field, Modal } from '@/components/ui'
import { useConnectionStore } from '@/stores/connectionStore'
import { useTunnelStore } from '@/stores/tunnelStore'

/**
 * 隧道编辑器：新建 / 修改一条端口转发配置。
 * 字段随类型（-L / -R / -D）动态调整，保存后立即可启动。
 */

const TYPE_OPTIONS: Array<{ value: TunnelType; label: string; hint: string }> = [
  {
    value: 'local',
    label: '本地 -L',
    hint: '把「从设备侧可达的服务」映射到本机端口 —— 最常见：访问设备 Web 界面或内网服务'
  },
  {
    value: 'remote',
    label: '远程 -R',
    hint: '把「从本机可达的服务」临时暴露到设备侧 —— 设备通过它的端口反向访问你电脑'
  },
  {
    value: 'dynamic',
    label: '动态 -D',
    hint: '在本机开启一个 SOCKS5 代理，浏览器等工具把它当代理即可让流量经设备出去'
  }
]

interface FormState {
  name: string
  type: TunnelType
  connectionId: string
  bindHost: string
  bindPort: string
  targetHost: string
  targetPort: string
  remark: string
}

const EMPTY: FormState = {
  name: '',
  type: 'local',
  connectionId: '',
  bindHost: '127.0.0.1',
  bindPort: '8080',
  targetHost: '127.0.0.1',
  targetPort: '80',
  remark: ''
}

function fromConfig(t: TunnelConfig): FormState {
  return {
    name: t.name,
    type: t.type,
    connectionId: t.connectionId ?? '',
    bindHost: t.bindHost,
    bindPort: String(t.bindPort),
    targetHost: t.targetHost ?? '',
    targetPort: t.targetPort !== undefined ? String(t.targetPort) : '',
    remark: t.remark ?? ''
  }
}

export function TunnelEditor({
  open,
  initial,
  onClose
}: {
  open: boolean
  /** 传入表示编辑，null 表示新建 */
  initial: TunnelConfig | null
  onClose: () => void
}): JSX.Element {
  const connections = useConnectionStore((s) => s.connections)
  const [form, setForm] = useState<FormState>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setForm(initial ? fromConfig(initial) : EMPTY)
    setError(null)
    setSaving(false)
  }, [open, initial])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((f) => ({ ...f, [key]: value }))
  }

  const typeHint = TYPE_OPTIONS.find((o) => o.value === form.type)?.hint ?? ''

  const validate = (): string | null => {
    if (!form.name.trim()) return '请填写隧道名称'
    const bindPort = Number(form.bindPort)
    if (!Number.isInteger(bindPort) || bindPort < 0 || bindPort > 65535) {
      return '监听端口需为 0-65535 的整数'
    }
    if (form.type === 'remote' && bindPort === 0) {
      // 允许：由远端服务端自动分配
    } else if (bindPort === 0) {
      return '监听端口不能为 0（仅远程转发支持 0 = 自动分配）'
    }
    if (!form.bindHost.trim()) return '请填写监听地址'
    if (form.type !== 'dynamic') {
      if (!form.targetHost.trim()) return '请填写目标地址'
      const targetPort = Number(form.targetPort)
      if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
        return '目标端口需为 1-65535 的整数'
      }
    }
    return null
  }

  const submit = async (): Promise<void> => {
    const message = validate()
    if (message) {
      setError(message)
      return
    }
    setSaving(true)
    setError(null)
    const input: TunnelInput = {
      id: initial?.id,
      name: form.name,
      type: form.type,
      bindHost: form.bindHost,
      bindPort: Number(form.bindPort),
      targetHost: form.type === 'dynamic' ? undefined : form.targetHost,
      targetPort: form.type === 'dynamic' ? undefined : Number(form.targetPort),
      connectionId: form.connectionId || undefined,
      remark: form.remark
    }
    const saved = await useTunnelStore.getState().save(input)
    setSaving(false)
    if (saved) onClose()
  }

  return (
    <Modal
      open={open}
      title={initial ? '编辑隧道' : '新建隧道'}
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
        <Field label="名称">
          <input
            className="input selectable"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="例如：设备 Web 界面"
            autoFocus
          />
        </Field>

        <Field label="转发类型">
          <div className="flex gap-1.5">
            {TYPE_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => set('type', opt.value)}
                className={cn(
                  'h-7 flex-1 rounded-md border text-xs transition-colors',
                  form.type === opt.value
                    ? 'border-accent/60 bg-accent/15 text-accent'
                    : 'border-edge bg-raised text-ink-3 hover:text-ink-2'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="mt-1 text-2xs leading-relaxed text-ink-3">{typeHint}</div>
        </Field>

        <Field label="关联连接" hint="启动时优先使用该连接的在线会话；留空则使用当前活动会话">
          <select
            className="input selectable"
            value={form.connectionId}
            onChange={(e) => set('connectionId', e.target.value)}
          >
            <option value="">自动（当前活动会话）</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}（{c.username}@{c.host}）
              </option>
            ))}
          </select>
        </Field>

        <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
          <Field
            label={
              form.type === 'remote' ? '远端监听地址' : '本机监听地址'
            }
          >
            <input
              className="input selectable"
              value={form.bindHost}
              onChange={(e) => set('bindHost', e.target.value)}
              placeholder="127.0.0.1"
            />
          </Field>
          <Field
            label={form.type === 'remote' ? '远端监听端口（0=自动）' : '本机监听端口'}
          >
            <input
              className="input selectable font-mono"
              value={form.bindPort}
              onChange={(e) => set('bindPort', e.target.value.replace(/[^\d]/g, ''))}
              placeholder="8080"
            />
          </Field>
        </div>

        {form.type !== 'dynamic' && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
            <Field
              label={form.type === 'local' ? '目标地址（从设备侧可达）' : '目标地址（本机）'}
            >
              <input
                className="input selectable"
                value={form.targetHost}
                onChange={(e) => set('targetHost', e.target.value)}
                placeholder="127.0.0.1 或内网 IP"
              />
            </Field>
            <Field label="目标端口">
              <input
                className="input selectable font-mono"
                value={form.targetPort}
                onChange={(e) => set('targetPort', e.target.value.replace(/[^\d]/g, ''))}
                placeholder="80"
              />
            </Field>
          </div>
        )}

        <Field label="备注">
          <input
            className="input selectable"
            value={form.remark}
            onChange={(e) => set('remark', e.target.value)}
            placeholder="可选"
          />
        </Field>

        {error && <div className="text-2xs text-danger">{error}</div>}
      </div>
    </Modal>
  )
}
