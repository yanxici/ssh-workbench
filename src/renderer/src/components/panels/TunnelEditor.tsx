import type * as React from 'react'
import { useEffect, useMemo, useState } from 'react'
import type { TunnelConfig, TunnelInput, TunnelType } from '@shared/types'
import { isWildcardHost, needsLanGrant } from '@shared/bindHost'
import { connectionTarget } from '@shared/serialDisplay'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { Field, Modal, Segmented } from '@/components/ui'
import { useConnectionStore } from '@/stores/connectionStore'
import { useTunnelStore } from '@/stores/tunnelStore'

/**
 * 隧道编辑器：新建 / 修改一条端口转发配置。
 * 字段随类型（-L / -R / -D）动态调整，保存后立即可启动。
 */

const TYPE_OPTIONS = [
  {
    value: 'local' as TunnelType,
    labelKey: 'panel.tunnel.type.local' as const,
    hintKey: 'panel.tunnel.type.localHint' as const
  },
  {
    value: 'remote' as TunnelType,
    labelKey: 'panel.tunnel.type.remote' as const,
    hintKey: 'panel.tunnel.type.remoteHint' as const
  },
  {
    value: 'dynamic' as TunnelType,
    labelKey: 'panel.tunnel.type.dynamic' as const,
    hintKey: 'panel.tunnel.type.dynamicHint' as const
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
  /** 该连接建立会话时自动启动（仅关联连接后有意义） */
  autoStart: boolean
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
  allowLan: false,
  autoStart: false
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
    allowLan: t.allowLan ?? needsLanGrant(t.bindHost),
    autoStart: t.autoStart === true
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
}): React.JSX.Element {
  const { t } = useI18n()
  /*
   * 隧道只对 SSH 连接有意义：串口连接既没有 ssh2 通道，也没有可转发的远端端口。
   * 后端本来就会拒绝，但下拉里仍然列出来，用户选完保存才被打回来 ——
   * 顺手还能把「随连接自启」挂到串口上，结果那条永远不可能启动。
   */
  /*
   * 选择器必须返回**原始引用**：Zustand 5 底层是 useSyncExternalStore，
   * 在 selector 里 .filter() 每次都产生新数组，Object.is 恒为 false →
   * React 立刻报 "The result of getSnapshot should be cached" 并无限重渲染。
   * 过滤放在 useMemo 里，store 引用不变就不重算。
   */
  const allConnections = useConnectionStore((s) => s.connections)
  const connections = useMemo(
    () => allConnections.filter((c) => c.kind !== 'serial'),
    [allConnections]
  )
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

  const typeOpt = TYPE_OPTIONS.find((o) => o.value === form.type)
  const typeHint = typeOpt ? t(typeOpt.hintKey) : ''

  const validate = (): string | null => {
    if (!form.name.trim()) return t('panel.tunnel.errName')
    const bindPort = Number(form.bindPort)
    if (!Number.isInteger(bindPort) || bindPort < 0 || bindPort > 65535) {
      return t('panel.tunnel.errBindPortRange')
    }
    if (form.type === 'remote' && bindPort === 0) {
      // 允许：由远端服务端自动分配
    } else if (bindPort === 0) {
      return t('panel.tunnel.errBindPortZero')
    }
    if (!form.bindHost.trim()) return t('panel.tunnel.errBindHost')
    if (form.type !== 'dynamic') {
      if (!form.targetHost.trim()) return t('panel.tunnel.errTargetHost')
      const targetPort = Number(form.targetPort)
      if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
        return t('panel.tunnel.errTargetPortRange')
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
      allowLan: form.allowLan,
      // 没关联连接就没有「随连接自启」可言，后端也只在这种情况下持久化
      autoStart: form.connectionId ? form.autoStart : false
    }
    const saved = await useTunnelStore.getState().save(input)
    setSaving(false)
    if (saved) onClose()
  }

  return (
    <Modal
      open={open}
      title={initial ? t('panel.tunnel.editTitle') : t('panel.tunnel.newTitle')}
      onClose={onClose}
      footer={
        <>
          <button className="btn h-7 px-3 text-xs" onClick={onClose}>
            {t('panel.tunnel.cancel')}
          </button>
          <button
            className="btn btn-primary h-7 px-3.5 text-xs"
            disabled={saving}
            onClick={() => void submit()}
          >
            {saving ? t('panel.tunnel.saving') : t('panel.tunnel.save')}
          </button>
        </>
      }
    >
      <div className="space-y-3.5">
        <Field label={t('panel.tunnel.fieldName')}>
          <input
            className="input selectable"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder={t('panel.tunnel.fieldNamePlaceholder')}
            autoFocus
          />
        </Field>

        <Field label={t('panel.tunnel.fieldType')}>
          <Segmented
            value={form.type}
            onChange={(v) => set('type', v)}
            options={TYPE_OPTIONS.map((opt) => ({ value: opt.value, label: t(opt.labelKey) }))}
          />
          <div className="mt-1 text-2xs leading-relaxed text-ink-3">{typeHint}</div>
        </Field>

        <Field label={t('panel.tunnel.fieldConn')} hint={t('panel.tunnel.fieldConnHint')}>
          <select
            className="input selectable"
            value={form.connectionId}
            onChange={(e) => set('connectionId', e.target.value)}
          >
            <option value="">{t('panel.tunnel.connAuto')}</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {t('panel.tunnel.connOption', { name: c.name, target: connectionTarget(c) })}
              </option>
            ))}
          </select>
        </Field>

        <label
          className={cn(
            'flex items-start gap-2 rounded-md border px-3 py-2 text-2xs leading-relaxed',
            form.connectionId
              ? 'border-edge bg-hover/40 text-ink-2'
              : 'border-edge-soft bg-hover/20 text-ink-3'
          )}
        >
          <input
            type="checkbox"
            className="mt-0.5"
            disabled={!form.connectionId}
            checked={form.connectionId ? form.autoStart : false}
            onChange={(e) => set('autoStart', e.target.checked)}
          />
          <span>
            {t('tunnel.editor.autoStart')}
            <span className="block text-ink-3">
              {form.connectionId
                ? t('tunnel.editor.autoStartHint')
                : t('tunnel.editor.autoStartOff')}
            </span>
          </span>
        </label>

        <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
          <Field
            label={
              form.type === 'remote'
                ? t('panel.tunnel.fieldRemoteBindHost')
                : t('panel.tunnel.fieldLocalBindHost')
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
            label={
              form.type === 'remote'
                ? t('panel.tunnel.fieldRemoteBindPort')
                : t('panel.tunnel.fieldLocalBindPort')
            }
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
         * 局域网监听授权。
         * 只在监听地址非回环时出现 —— 回环地址本来就不需要授权，
         * 常显这个开关反而让人以为「默认就对外暴露」。
         * 后端 saveTunnel 会再校验一次，这里提前给出可行动的解释，
         * 而不是等保存失败才报错。
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
                {t('panel.tunnel.allowLan')}
                <span className="block text-ink-3">
                  {isWildcardHost(form.bindHost)
                    ? t('panel.tunnel.lanWildcard', { host: form.bindHost })
                    : t('panel.tunnel.lanNonLoopback', { host: form.bindHost })}
                  {!form.allowLan && t('panel.tunnel.lanRequired')}
                </span>
              </span>
            </label>
          </div>
        )}

        {form.type !== 'dynamic' && (
          <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
            <Field
              label={
                form.type === 'local'
                  ? t('panel.tunnel.fieldTargetHostLocal')
                  : t('panel.tunnel.fieldTargetHostRemote')
              }
            >
              <input
                className="input selectable"
                value={form.targetHost}
                onChange={(e) => set('targetHost', e.target.value)}
                placeholder={t('panel.tunnel.fieldTargetHostPlaceholder')}
              />
            </Field>
            <Field label={t('panel.tunnel.fieldTargetPort')}>
              <input
                className="input selectable font-mono"
                value={form.targetPort}
                onChange={(e) => set('targetPort', e.target.value.replace(/[^\d]/g, ''))}
                placeholder="80"
              />
            </Field>
          </div>
        )}

        <Field label={t('panel.tunnel.fieldRemark')}>
          <input
            className="input selectable"
            value={form.remark}
            onChange={(e) => set('remark', e.target.value)}
            placeholder={t('panel.tunnel.fieldRemarkPlaceholder')}
          />
        </Field>

        {error && <div className="text-2xs text-danger">{error}</div>}
      </div>
    </Modal>
  )
}
