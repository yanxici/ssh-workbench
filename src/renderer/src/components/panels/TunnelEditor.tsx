import { useEffect, useState } from 'react'
import type { TunnelConfig, TunnelInput, TunnelType } from '@shared/types'
import { isWildcardHost, needsLanGrant } from '@shared/bindHost'
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
  /** 允许监听非回环地址（后端 needsLanGrant 为真时才有意义） */
  allowLan: boolean
}

const EMPTY: FormState = {
  name: '',
  type: 'local',
  connectionId: '',
  bindHost: '127.0.0.1',
  bindPort: '8080',
  targetHost: '127.0.0.1',
  targetPort: '80',
  remark: '',
  allowLan: false
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
    remark: t.remark ?? '',
    /*
     * 存量配置兼容：v1.6.6 之前没有 allowLan 字段，但 bindHost 可能已经是
     * 0.0.0.0（那时没有任何校验）。按当前 bindHost 反推初值，
     * 否则用户打开老隧道不重新勾选直接保存，会被后端拒绝 —— 改个名字都存不了。
     */
    allowLan: t.allowLan ?? needsLanGrant(t.bindHost)
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
      remark: form.remark,
      allowLan: form.allowLan
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

        {/*
          局域网监听授权。
          只在监听地址非回环时出现 —— 回环地址本来就不需要授权，
          常显这个开关反而让人以为「默认就对外暴露」。
          后端 saveTunnel 会再校验一次，这里提前给出可行动的解释，
          而不是等保存失败才报错。
        */}
        {needsLanGrant(form.bindHost) && (
          <div
            className={cn(
              'rounded-md border px-3 py-2 text-2xs leading-relaxed',
              form.allowLan
                ? 'border-warning/40 bg-warning/5 text-warning'
                : 'border-edge bg-hover/40 text-ink-2'
            )}
          >
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={form.allowLan}
                onChange={(e) => set('allowLan', e.target.checked)}
              />
              <span>
                允许局域网访问
                <span className="block text-ink-3">
                  {isWildcardHost(form.bindHost)
                    ? `当前监听 ${form.bindHost} 表示所有网卡。动态代理无认证，开启后同网段的任何机器都能借你的网络上外网。`
                    : `当前监听 ${form.bindHost}，不在本机回环范围内。开启后同网段可访问该端口。`}
                  {!form.allowLan && ' 不勾选将无法保存。'}
                </span>
              </span>
            </label>
          </div>
        )}

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
