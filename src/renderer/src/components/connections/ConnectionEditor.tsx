import { useEffect, useState } from 'react'
import { CheckCircle2, Loader2, FlaskConical, FolderOpen, KeyRound, Plug, Trash2 } from 'lucide-react'
import type {
  AuthType,
  Connection,
  ConnectionInput,
  TestConnectionInput,
  TestConnectionResult
} from '@shared/types'
import { useConnectionStore } from '@/stores/connectionStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useToastStore } from '@/stores/toastStore'
import { COLORS } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { call } from '@/lib/ipc'
import { Field, Modal } from '@/components/ui'

interface FormState {
  name: string
  host: string
  port: string
  username: string
  authType: AuthType
  password: string
  privateKeyPath: string
  passphrase: string
  group: string
  tags: string
  color: string
  remark: string
  /** 代理类型：none = 直连；socks5 / http = 经代理建连 */
  proxyType: 'none' | 'socks5' | 'http'
  proxyHost: string
  proxyPort: string
  proxyUsername: string
  proxyPassword: string
}

const EMPTY: FormState = {
  name: '',
  host: '',
  port: '22',
  username: 'root',
  authType: 'password',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  group: '默认',
  tags: '',
  color: '',
  remark: '',
  proxyType: 'none',
  proxyHost: '',
  proxyPort: '1080',
  proxyUsername: '',
  proxyPassword: ''
}

const AUTH_OPTIONS: Array<{ value: AuthType; label: string }> = [
  { value: 'password', label: '密码' },
  { value: 'privateKey', label: '私钥文件' },
  { value: 'agent', label: 'SSH Agent' }
]

const PROXY_OPTIONS: Array<{ value: FormState['proxyType']; label: string }> = [
  { value: 'none', label: '不使用代理' },
  { value: 'socks5', label: 'SOCKS5' },
  { value: 'http', label: 'HTTP CONNECT' }
]

/**
 * 连接编辑器：新建 / 编辑连接，支持保存前测试连接。
 * 密码语义：留空 = 保持已保存的凭据不变（新建时即为不设置）。
 */
export function ConnectionEditor({
  open,
  initial,
  preset,
  onClose
}: {
  open: boolean
  initial: Connection | null
  preset?: Partial<ConnectionInput>
  onClose: () => void
}): JSX.Element {
  const save = useConnectionStore((s) => s.save)
  const connections = useConnectionStore((s) => s.connections)

  const [form, setForm] = useState<FormState>(EMPTY)
  const [showPassword, setShowPassword] = useState(false)
  const [hasSecret, setHasSecret] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null)
  const [saving, setSaving] = useState(false)

  /* ---------- 打开时初始化 ---------- */
  useEffect(() => {
    if (!open) return
    setTestResult(null)
    setShowPassword(false)
    setSaving(false)

    if (initial) {
      setForm({
        name: initial.name,
        host: initial.host,
        port: String(initial.port),
        username: initial.username,
        authType: initial.authType,
        password: '',
        privateKeyPath: initial.privateKeyPath ?? '',
        passphrase: '',
        group: initial.group,
        tags: initial.tags.join(', '),
        color: initial.color ?? '',
        remark: initial.remark ?? '',
        proxyType: initial.proxy?.type ?? 'none',
        proxyHost: initial.proxy?.host ?? '',
        proxyPort: initial.proxy?.port !== undefined ? String(initial.proxy.port) : '1080',
        proxyUsername: initial.proxy?.username ?? '',
        proxyPassword: ''
      })
      void call(window.api.conn.hasSecret(initial.id), { silent: true }).then((has) =>
        setHasSecret(has ?? false)
      )
    } else {
      setForm({
        ...EMPTY,
        name: preset?.name ?? '',
        host: preset?.host ?? '',
        port: preset?.port !== undefined ? String(preset.port) : EMPTY.port,
        username: preset?.username ?? EMPTY.username,
        authType: preset?.authType ?? EMPTY.authType,
        privateKeyPath: preset?.privateKeyPath ?? '',
        group: preset?.group ?? EMPTY.group
      })
      setHasSecret(false)
    }
  }, [open, initial, preset])

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void =>
    setForm((f) => ({ ...f, [key]: value }))

  /** 从本地选择私钥：主进程校验格式并复制到应用数据目录，回填路径 */
  const [picking, setPicking] = useState(false)
  const pickKey = async (): Promise<void> => {
    setPicking(true)
    const res = await call(window.api.conn.pickPrivateKey(), { errorTitle: '导入私钥失败' })
    setPicking(false)
    if (!res || res.canceled || !res.path) return
    set('privateKeyPath', res.path)
    setTestResult(null)
    useToastStore.getState().push({
      kind: 'success',
      title: `已导入私钥（${res.type}）`,
      detail: res.encrypted ? '该私钥已加密，请在下方填写私钥口令' : '私钥未加密，口令留空即可'
    })
  }

  /* ---------- 校验与保存 ---------- */
  const validate = (): string | null => {
    if (!form.name.trim()) return '请填写连接名称'
    if (!form.host.trim()) return '请填写主机地址'
    if (!form.username.trim()) return '请填写用户名'
    const port = Number(form.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return '端口无效（1-65535）'
    if (form.authType === 'privateKey' && !form.privateKeyPath.trim()) return '请指定私钥文件路径'
    if (form.proxyType !== 'none') {
      if (!form.proxyHost.trim()) return '请填写代理服务器地址'
      const proxyPort = Number(form.proxyPort)
      if (!Number.isInteger(proxyPort) || proxyPort <= 0 || proxyPort > 65535) {
        return '代理端口无效（1-65535）'
      }
    }
    return null
  }

  /** 组装代理配置（密码语义：编辑时留空 = 保持已保存的代理密码） */
  const buildProxy = (forceClear = false): ConnectionInput['proxy'] => {
    if (form.proxyType === 'none') return undefined
    return {
      type: form.proxyType,
      host: form.proxyHost.trim(),
      port: Number(form.proxyPort),
      username: form.proxyUsername.trim() || undefined,
      password: forceClear ? '' : form.proxyPassword === '' ? undefined : form.proxyPassword
    }
  }

  const buildInput = (forceClearSecret = false, asNew = false): ConnectionInput => ({
    id: asNew ? undefined : initial?.id,
    name: form.name.trim(),
    host: form.host.trim(),
    port: Number(form.port),
    username: form.username.trim(),
    authType: form.authType,
    privateKeyPath: form.privateKeyPath.trim() || undefined,
    group: form.group.trim() || '默认',
    tags: form.tags
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter(Boolean),
    color: form.color || undefined,
    remark: form.remark.trim() || undefined,
    // 密码语义：编辑时留空 = 不修改；'' = 清除
    password: forceClearSecret ? '' : form.password === '' ? undefined : form.password,
    passphrase: forceClearSecret ? '' : form.passphrase === '' ? undefined : form.passphrase,
    proxy: buildProxy(forceClearSecret),
    // 编辑器不编辑跳板链，但保存时必须原样保留，避免"编辑一次就丢"
    proxyJump: initial?.proxyJump
  })

  /**
   * 保存并可选地立即发起连接。
   * - asNew：忽略 initial.id，落库为一条新连接（原连接不受影响，凭据也独立保存）
   * - connect：保存成功后直接打开会话；新建的会话标签用表单里的名称
   */
  const submit = async (opts: { asNew?: boolean; connect?: boolean } = {}): Promise<void> => {
    const { asNew = false, connect = false } = opts
    const problem = validate()
    if (problem) {
      useToastStore.getState().push({ kind: 'warning', title: problem })
      return
    }
    if (asNew) {
      const sameName = connections.some(
        (c) => c.name === form.name.trim() && c.id !== initial?.id
      )
      if (sameName) {
        const ok = window.confirm(
          `已存在名为「${form.name.trim()}」的连接。\n仍要另存为新设备吗？（两条连接同名，可稍后重命名区分）`
        )
        if (!ok) return
      }
    }

    setSaving(true)
    const saved = await save(buildInput(false, asNew))
    setSaving(false)
    if (!saved) return

    if (connect) {
      useSessionStore.getState().open({
        id: saved.id,
        name: saved.name,
        host: saved.host,
        username: saved.username
      })
      useToastStore.getState().push({
        kind: 'success',
        title: asNew ? `已另存为新设备「${saved.name}」并连接` : `正在连接「${saved.name}」`,
        detail: asNew ? `原连接「${initial?.name ?? ''}」保持不变` : undefined
      })
      onClose()
      return
    }

    useToastStore.getState().push({
      kind: 'success',
      title: initial && !asNew ? `已更新「${saved.name}」` : `已创建「${saved.name}」`
    })
    onClose()
  }

  const clearSecret = async (): Promise<void> => {
    if (!initial) return
    const saved = await save(buildInput(true))
    if (saved) {
      setHasSecret(false)
      set('password', '')
      set('passphrase', '')
      useToastStore.getState().push({ kind: 'success', title: '已清除该连接保存的凭据' })
    }
  }

  /* ---------- 测试连接 ---------- */
  const runTest = async (): Promise<void> => {
    const problem = validate()
    if (problem) {
      useToastStore.getState().push({ kind: 'warning', title: problem })
      return
    }
    setTesting(true)
    setTestResult(null)
    const input: TestConnectionInput = {
      connectionId: initial?.id,
      host: form.host.trim(),
      port: Number(form.port),
      username: form.username.trim(),
      authType: form.authType,
      password: form.password || undefined,
      privateKeyPath: form.privateKeyPath.trim() || undefined,
      passphrase: form.passphrase || undefined,
      proxy: buildProxy()
    }
    const res = await call(window.api.conn.test(input), { errorTitle: '测试连接异常' })
    if (res) setTestResult(res)
    setTesting(false)
  }

  const groupOptions = [...new Set(connections.map((c) => c.group).filter(Boolean))]

  return (
    <Modal
      open={open}
      title={initial ? `编辑连接 · ${initial.name}` : '新建连接'}
      onClose={onClose}
      width="max-w-xl"
      footer={
        <>
          <div className="mr-auto flex items-center gap-2">
            <button className="btn" onClick={() => void runTest()} disabled={testing}>
              {testing ? (
                <Loader2 size={13} className="animate-spin" />
              ) : (
                <FlaskConical size={13} />
              )}
              测试连接
            </button>
            {testResult && (
              <span
                className={cn(
                  'flex items-center gap-1 text-2xs',
                  testResult.ok ? 'text-success' : 'text-danger'
                )}
              >
                {testResult.ok ? (
                  <>
                    <CheckCircle2 size={12} /> 成功 · {testResult.durationMs} ms
                  </>
                ) : (
                  <span className="max-w-[300px] truncate">{testResult.error}</span>
                )}
              </span>
            )}
          </div>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          {initial && (
            <button
              className="btn"
              title="保留原连接不动，把当前填写的信息另存为一条新设备并立即连接"
              onClick={() => void submit({ asNew: true, connect: true })}
              disabled={saving}
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />}
              另存为新设备并连接
            </button>
          )}
          <button
            className="btn btn-primary"
            title={initial ? '保存修改并连接该设备' : '保存后立即连接该设备'}
            onClick={() => void submit({ connect: true })}
            disabled={saving}
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />}
            连接设备
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
        {initial && (
          <div className="col-span-2 flex items-start gap-2 rounded-lg border border-edge-soft bg-app/60 px-3 py-2 text-2xs leading-relaxed text-ink-3">
            <Plug size={12} className="mt-0.5 shrink-0" />
            <span>
              「连接设备」＝保存修改后立即连接；若只是想把这台设备的地址/账号另存一份（原连接保持不动），
              用「另存为新设备并连接」。
            </span>
          </div>
        )}

        <Field label="名称" className="col-span-2">
          <input
            className="input selectable"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="例如：A机房-边缘网关"
          />
        </Field>

        <Field label="主机地址">
          <input
            className="input selectable"
            value={form.host}
            onChange={(e) => set('host', e.target.value)}
            placeholder="192.168.1.10 或 hostname"
          />
        </Field>

        <Field label="端口">
          <input
            className="input selectable"
            type="number"
            min={1}
            max={65535}
            value={form.port}
            onChange={(e) => set('port', e.target.value)}
          />
        </Field>

        <Field label="用户名">
          <input
            className="input selectable"
            value={form.username}
            onChange={(e) => set('username', e.target.value)}
          />
        </Field>

        <Field label="认证方式">
          <div className="flex gap-1">
            {AUTH_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => set('authType', opt.value)}
                className={cn(
                  'h-7 flex-1 rounded-md border text-xs transition-colors',
                  form.authType === opt.value
                    ? 'border-accent/60 bg-accent/15 text-accent'
                    : 'border-edge bg-raised text-ink-3 hover:text-ink-2'
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </Field>

        {form.authType === 'password' && (
          <>
            <Field
              label="密码"
              hint={initial && hasSecret ? '已保存，留空则不修改' : undefined}
              className="col-span-2"
            >
              <div className="flex gap-1.5">
                <input
                  className="input selectable flex-1"
                  type={showPassword ? 'text' : 'password'}
                  value={form.password}
                  onChange={(e) => set('password', e.target.value)}
                  placeholder={initial && hasSecret ? '••••••••（留空保持原密码）' : '登录密码'}
                  autoComplete="new-password"
                />
                <button
                  type="button"
                  className="btn shrink-0"
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? '隐藏' : '显示'}
                </button>
              </div>
            </Field>
            {initial && hasSecret && (
              <button
                type="button"
                className="col-span-2 -mt-2 flex items-center gap-1 self-start text-2xs text-ink-3 transition-colors hover:text-danger"
                onClick={() => void clearSecret()}
              >
                <Trash2 size={11} />
                清除已保存的凭据
              </button>
            )}
          </>
        )}

        {form.authType === 'privateKey' && (
          <>
            <Field
              label="私钥文件路径"
              hint="可手动填写，或点「选择文件」从本地导入"
              className="col-span-2"
            >
              <div className="flex gap-2">
                <input
                  className="input selectable min-w-0 flex-1 font-mono text-2xs"
                  value={form.privateKeyPath}
                  onChange={(e) => set('privateKeyPath', e.target.value)}
                  placeholder="~/.ssh/id_rsa"
                />
                <button
                  type="button"
                  className="btn shrink-0"
                  onClick={() => void pickKey()}
                  disabled={picking}
                >
                  {picking ? <Loader2 size={13} className="animate-spin" /> : <FolderOpen size={13} />}
                  选择文件
                </button>
              </div>
            </Field>
            <Field
              label="私钥口令"
              hint={initial && hasSecret ? '已保存，留空则不修改' : '私钥未加密则留空'}
              className="col-span-2"
            >
              <input
                className="input selectable"
                type="password"
                value={form.passphrase}
                onChange={(e) => set('passphrase', e.target.value)}
                autoComplete="new-password"
              />
            </Field>
          </>
        )}

        {form.authType === 'agent' && (
          <div className="col-span-2 flex items-start gap-2 rounded-lg border border-edge-soft bg-app px-3 py-2.5 text-2xs leading-relaxed text-ink-3">
            <KeyRound size={13} className="mt-0.5 shrink-0" />
            <span>
              使用系统 SSH Agent 中的密钥认证。Windows 需启用 OpenSSH Authentication
              Agent 服务并已 ssh-add 导入密钥；Linux/macOS 需保证 SSH_AUTH_SOCK 可用。
            </span>
          </div>
        )}

        <Field
          label="代理"
          hint="经 SOCKS5 / HTTP 代理建立连接（配置了跳板链时作用于第一跳）"
          className="col-span-2"
        >
          <div className="space-y-2">
            <div className="flex gap-1.5">
              {PROXY_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => set('proxyType', opt.value)}
                  className={cn(
                    'h-7 flex-1 rounded-md border text-xs transition-colors',
                    form.proxyType === opt.value
                      ? 'border-accent/60 bg-accent/15 text-accent'
                      : 'border-edge bg-raised text-ink-3 hover:text-ink-2'
                  )}
                >
                  {opt.label}
                </button>
              ))}
            </div>
            {form.proxyType !== 'none' && (
              <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                <input
                  className="input selectable"
                  value={form.proxyHost}
                  onChange={(e) => set('proxyHost', e.target.value)}
                  placeholder="代理地址，如 192.168.1.2"
                />
                <input
                  className="input selectable font-mono"
                  value={form.proxyPort}
                  onChange={(e) => set('proxyPort', e.target.value.replace(/[^\d]/g, ''))}
                  placeholder={form.proxyType === 'socks5' ? '1080' : '8080'}
                />
                <input
                  className="input selectable"
                  value={form.proxyUsername}
                  onChange={(e) => set('proxyUsername', e.target.value)}
                  placeholder="用户名（可选）"
                />
                <input
                  className="input selectable"
                  type="password"
                  value={form.proxyPassword}
                  onChange={(e) => set('proxyPassword', e.target.value)}
                  placeholder="密码（编辑时留空 = 保持不变）"
                />
              </div>
            )}
          </div>
        </Field>

        <Field label="分组" hint="用于左侧列表归类">
          <>
            <input
              className="input selectable"
              list="conn-group-options"
              value={form.group}
              onChange={(e) => set('group', e.target.value)}
              placeholder="默认"
            />
            <datalist id="conn-group-options">
              {groupOptions.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </>
        </Field>

        <Field label="标签" hint="逗号分隔，用于搜索">
          <input
            className="input selectable"
            value={form.tags}
            onChange={(e) => set('tags', e.target.value)}
            placeholder="A机房, 网关, arm64"
          />
        </Field>

        <Field label="色标" className="col-span-2">
          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              title="不使用色标"
              onClick={() => set('color', '')}
              className={cn(
                'flex h-5 w-5 items-center justify-center rounded-full border text-2xs text-ink-3',
                form.color === '' ? 'border-accent text-accent' : 'border-edge'
              )}
            >
              ∅
            </button>
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => set('color', c)}
                className={cn(
                  'h-5 w-5 rounded-full border-2 transition-transform hover:scale-110',
                  form.color === c ? 'border-ink' : 'border-transparent'
                )}
                style={{ background: c }}
              />
            ))}
          </div>
        </Field>

        <Field label="备注" className="col-span-2">
          <textarea
            className="input scroll-thin h-16 resize-none selectable py-1.5"
            value={form.remark}
            onChange={(e) => set('remark', e.target.value)}
            placeholder="现场联系人、设备用途、注意事项…"
          />
        </Field>

        {testResult && !testResult.ok && (
          <div className="col-span-2 selectable rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-2xs leading-relaxed text-danger">
            {testResult.error}
          </div>
        )}
        {testResult?.ok && (testResult.banner || testResult.fingerprint) && (
          <div className="col-span-2 selectable space-y-0.5 rounded-lg border border-success/25 bg-success/5 px-3 py-2 font-mono text-2xs leading-relaxed text-ink-3">
            {testResult.banner && <div>{testResult.banner}</div>}
            {testResult.fingerprint && <div>Host key: {testResult.fingerprint}</div>}
          </div>
        )}
      </div>
    </Modal>
  )
}
