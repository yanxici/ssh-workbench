import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  FlaskConical,
  FolderOpen,
  Fingerprint,
  KeyRound,
  Plug,
  RefreshCw,
  Trash2
} from 'lucide-react'
import type {
  AuthType,
  ConnKind,
  Connection,
  ConnectionInput,
  SerialCharset,
  SerialDataBits,
  SerialFlowControl,
  SerialNewline,
  SerialParity,
  SerialPortInfo,
  SerialStopBits,
  TestConnectionInput,
  TestConnectionResult
} from '@shared/types'
import { describeSerialTarget } from '@shared/serialDisplay'
import { useConnectionStore } from '@/stores/connectionStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useToastStore } from '@/stores/toastStore'
import { COLORS } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { call } from '@/lib/ipc'
import { Combobox, Field, Modal, Toggle } from '@/components/ui'

interface FormState {
  /**
   * 连接类型。SSH 与串口共用同一条 Connection 记录（见 types.ts 里的
   * 说明），编辑器按这个字段切换表单分支：串口不显示主机/端口/用户名/
   * 认证/代理这些 SSH 专属字段，它们会以空串落库。
   */
  kind: ConnKind
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

  /* ---------------- 串口参数 ---------------- */

  /** 端口路径：Windows 是 COM3，Linux 是 /dev/ttyUSB0 */
  serialPath: string
  /** 波特率存字符串：输入过程中会出现空串，Number('') 是 0，不能直接存 number */
  serialBaud: string
  serialDataBits: SerialDataBits
  serialStopBits: SerialStopBits
  serialParity: SerialParity
  serialFlow: SerialFlowControl
  serialCharset: SerialCharset
  serialNewline: SerialNewline
  /** 打开端口时拉 DTR 复位设备（默认关，见 types.ts 里的事故说明） */
  serialAutoReset: boolean
  /**
   * 选中端口时记下的 USB 身份，保存时一并落库。
   *
   * 它的用途不是"显示"，而是热插拔后把连接找回同一台设备：COM 号会漂，
   * 插到别的 USB 口也可能是另一个号。三级退化见 serialResolve.ts。
   */
  serialSn: string
  serialPnp: string
}

const EMPTY: FormState = {
  kind: 'ssh',
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
  proxyPassword: '',
  serialPath: '',
  serialBaud: '115200',
  serialDataBits: 8,
  serialStopBits: 1,
  serialParity: 'none',
  serialFlow: 'none',
  serialCharset: 'utf-8',
  serialNewline: 'cr',
  serialAutoReset: false,
  serialSn: '',
  serialPnp: ''
}

const AUTH_OPTIONS: Array<{ value: AuthType; label: string }> = [
  { value: 'password', label: '密码' },
  { value: 'privateKey', label: '私钥文件' },
  { value: 'agent', label: 'SSH Agent' }
]

/** 常用波特率。Console 口绝大多数是 115200 或 9600，其余留着能手输 */
const BAUD_PRESETS = ['9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600']

const DATA_BITS_OPTIONS: SerialDataBits[] = [5, 6, 7, 8]

const STOP_BITS_OPTIONS: Array<{ value: SerialStopBits; label: string }> = [
  { value: 1, label: '1' },
  { value: 1.5, label: '1.5' },
  { value: 2, label: '2' }
]

const PARITY_OPTIONS: Array<{ value: SerialParity; label: string }> = [
  { value: 'none', label: '无 (N)' },
  { value: 'even', label: '偶 (E)' },
  { value: 'odd', label: '奇 (O)' },
  { value: 'mark', label: '标记 (M)' },
  { value: 'space', label: '空格 (S)' }
]

const FLOW_OPTIONS: Array<{ value: SerialFlowControl; label: string }> = [
  { value: 'none', label: '无' },
  { value: 'hardware', label: '硬件 (RTS/CTS)' },
  { value: 'software', label: '软件 (XON/XOFF)' }
]

const CHARSET_OPTIONS: Array<{ value: SerialCharset; label: string }> = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'gbk', label: 'GBK' },
  { value: 'gb18030', label: 'GB18030' }
]

const NEWLINE_OPTIONS: Array<{ value: SerialNewline; label: string; hint: string }> = [
  { value: 'cr', label: 'CR', hint: '\\r' },
  { value: 'lf', label: 'LF', hint: '\\n' },
  { value: 'crlf', label: 'CRLF', hint: '\\r\\n' }
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
  /** 正在更新主机指纹 */
  const [updatingKey, setUpdatingKey] = useState(false)

  /* ---------- 串口端口列表 ---------- */
  /**
   * 端口列表不缓存在 store 里，每次打开编辑器现取。
   * USB 转串口随时可能被拔掉或换口，缓存一份旧列表只会让人选到已消失的端口。
   * 插拔变化另走 window.api.on.serialPorts 推送（这里也订阅，面板开着时自动更新）。
   */
  const [ports, setPorts] = useState<SerialPortInfo[]>([])
  const [portsLoading, setPortsLoading] = useState(false)

  const loadPorts = async (): Promise<void> => {
    setPortsLoading(true)
    const list = await call(window.api.serial.list(), { silent: true })
    setPortsLoading(false)
    if (list) setPorts(list)
  }

  /* ---------- 打开时初始化 ---------- */
  useEffect(() => {
    if (!open) return
    setTestResult(null)
    setShowPassword(false)
    setSaving(false)

    if (initial) {
      setForm({
        kind: initial.kind ?? 'ssh',
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
        proxyPassword: '',
        serialPath: initial.serial?.path ?? '',
        serialBaud: initial.serial ? String(initial.serial.baudRate) : EMPTY.serialBaud,
        serialDataBits: initial.serial?.dataBits ?? EMPTY.serialDataBits,
        serialStopBits: initial.serial?.stopBits ?? EMPTY.serialStopBits,
        serialParity: initial.serial?.parity ?? EMPTY.serialParity,
        serialFlow: initial.serial?.flowControl ?? EMPTY.serialFlow,
        serialCharset: initial.serial?.charset ?? EMPTY.serialCharset,
        serialNewline: initial.serial?.newline ?? EMPTY.serialNewline,
        serialAutoReset: initial.serial?.autoReset ?? false,
        serialSn: initial.serial?.usbSerialNumber ?? '',
        serialPnp: initial.serial?.usbPnpId ?? ''
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
    void loadPorts()
  }, [open, initial, preset])

  /*
   * 面板开着时跟随热插拔：插上设备立刻出现在下拉里，拔掉就消失。
   * 只更新列表、不动 form.serialPath —— 用户正在填的表单不该被外部事件改写。
   */
  useEffect(() => {
    if (!open) return
    const off = window.api.on.serialPorts((list) => setPorts(list))
    return off
  }, [open])

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

    if (form.kind === 'serial') {
      if (!form.serialPath.trim()) return '请选择串口端口'
      const baud = Number(form.serialBaud)
      if (!Number.isInteger(baud) || baud <= 0) return '波特率必须是正整数'
      // 上限不是协议要求，只是防手滑（输成 1152000 会 open 失败且报错很难懂）
      if (baud > 4000000) return '波特率过大（上限 4000000）'
      return null
    }

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

  /**
   * 组装串口配置。
   *
   * 端口身份（sn/pnp）跟着走：只存 COM 号的话，用户换一个 USB 口重插，
   * 或者同一台机器插两台同型号 CH340，下次连接就会连到错的设备上。
   */
  const buildSerial = (): ConnectionInput['serial'] => {
    if (form.kind !== 'serial') return undefined
    return {
      path: form.serialPath.trim(),
      baudRate: Number(form.serialBaud) || 115200,
      dataBits: form.serialDataBits,
      stopBits: form.serialStopBits,
      parity: form.serialParity,
      flowControl: form.serialFlow,
      charset: form.serialCharset,
      newline: form.serialNewline,
      autoReset: form.serialAutoReset,
      usbSerialNumber: form.serialSn.trim() || undefined,
      usbPnpId: form.serialPnp.trim() || undefined
    }
  }

  const buildInput = (forceClearSecret = false, asNew = false): ConnectionInput => ({
    id: asNew ? undefined : initial?.id,
    kind: form.kind,
    name: form.name.trim(),
    /*
     * 串口连接也走 Connection 这条记录，但 host/port/username/authType 在
     * types.ts 里是必填（见那里的取舍说明）。串口没有这些概念，统一落空串/0，
     * 主进程 saveConnection 里还会再兜一层，两边都写是为了让这里读起来不困惑。
     */
    host: form.kind === 'serial' ? '' : form.host.trim(),
    port: form.kind === 'serial' ? 0 : Number(form.port),
    username: form.kind === 'serial' ? '' : form.username.trim(),
    authType: form.kind === 'serial' ? 'password' : form.authType,
    privateKeyPath: form.kind === 'serial' ? undefined : form.privateKeyPath.trim() || undefined,
    serial: buildSerial(),
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
    proxy: form.kind === 'serial' ? undefined : buildProxy(forceClearSecret),
    // 编辑器不编辑跳板链，但保存时必须原样保留，避免"编辑一次就丢"
    proxyJump: form.kind === 'serial' ? undefined : initial?.proxyJump
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
        username: saved.username,
        kind: saved.kind,
        serial: saved.serial
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

  /**
   * 就地把「设备当前指纹」写入已知主机记录，然后自动重测一次。
   * 设备重装 / 固件升级后的标准动作，用户不必再去设置里翻。
   */
  const trustCurrentHostKey = async (): Promise<void> => {
    const mismatch = testResult?.hostKeyMismatch
    if (!mismatch) return
    setUpdatingKey(true)
    try {
      const saved = await call(
        window.api.knownHosts.refresh(form.host.trim(), Number(form.port), mismatch.actual),
        { errorTitle: '更新主机指纹失败' }
      )
      if (!saved) return
      useToastStore.getState().push({
        kind: 'success',
        title: '已更新主机指纹',
        detail: `下次连接按新指纹校验：${mismatch.actual.slice(0, 24)}…`
      })
      await runTest()
    } finally {
      setUpdatingKey(false)
    }
  }

  /** 测试通过后，把「设备当前指纹」同步进本地记录（设备换过 key 时用） */
  const syncCurrentHostKey = async (): Promise<void> => {
    const fp = testResult?.fingerprint
    if (!fp) return
    setUpdatingKey(true)
    try {
      const saved = await call(
        window.api.knownHosts.refresh(form.host.trim(), Number(form.port), fp),
        { errorTitle: '更新主机指纹失败' }
      )
      if (saved) {
        useToastStore.getState().push({
          kind: 'success',
          title: '本地指纹记录已对齐设备当前密钥'
        })
      }
    } finally {
      setUpdatingKey(false)
    }
  }

  const groupOptions = [...new Set(connections.map((c) => c.group).filter(Boolean))]

  const isSsh = form.kind === 'ssh'

  /*
   * 端口下拉的选项串：`COM3`，能带上厂商名就带上（`COM3 · Silicon Labs CP210x`）。
   * 用户选完后 pickPort 再从同一份 ports 里反查身份，所以选项串必须是能唯一
   * 反解的形式 —— 用 path 做前缀正好。
   */
  const portOptions = ports.map((p) =>
    p.manufacturer ? `${p.path} · ${p.manufacturer}` : p.path
  )

  /** 当前选中端口对应的完整信息（拿 manufacturer / sn / pnpId 用） */
  const selectedPort = ports.find((p) => p.path === form.serialPath)

  /**
   * 选中端口：路径 + USB 身份一起写进表单。
   *
   * 只存 path 的话，用户把线换到另一个 USB 口（COM3 → COM7）再插回来，
   * 或者同型号两台设备同时插着，下次连接就会连错设备。
   * 身份三级退化（serialNumber → pnpId → COM 号）见 serialResolve.ts。
   */
  const pickPort = (value: string): void => {
    const path = value.split(' · ')[0].trim()
    const hit = ports.find((p) => p.path === path)
    setForm((f) => ({
      ...f,
      serialPath: path,
      serialSn: hit?.serialNumber ?? '',
      serialPnp: hit?.pnpId ?? ''
    }))
  }

  return (
    <Modal
      open={open}
      title={
        initial
          ? `编辑${form.kind === 'serial' ? '串口' : ''}连接 · ${initial.name}`
          : `新建${form.kind === 'serial' ? '串口' : ''}连接`
      }
      onClose={onClose}
      width="max-w-xl"
      footer={
        <>
          <div className="mr-auto flex items-center gap-2">
            {/*
              串口没有"测试连接"这回事：open 一次端口就等于连上了，
              而反复开关端口会触发 DTR 电平变化（接 EN 脚的板子会重启）。
              想验就保存后直接连，断开再改。
            */}
            {form.kind === 'ssh' && (
              <button className="btn" onClick={() => void runTest()} disabled={testing}>
                {testing ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <FlaskConical size={13} />
                )}
                测试连接
              </button>
            )}
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

        {/*
          连接类型。只在新建时可自由切换：已有连接改了 kind 等于换了台设备，
          在编辑器里"顺手改一下"会让原设备的凭据/档案挂到新记录上，
          真要从串口改成 SSH，删掉重建更清楚。
        */}
        <Field
          label="类型"
          hint={initial ? '已保存的连接不能改类型，请新建一条' : undefined}
          className="col-span-2"
        >
          <div className="flex gap-1">
            <button
              type="button"
              disabled={Boolean(initial)}
              onClick={() => set('kind', 'ssh')}
              className={cn(
                'h-7 flex-1 rounded-md border text-xs transition-colors',
                form.kind === 'ssh'
                  ? 'border-accent/60 bg-accent/15 text-accent'
                  : 'border-edge bg-raised text-ink-3 hover:text-ink-2',
                initial && 'cursor-not-allowed opacity-60'
              )}
            >
              SSH 远程登录
            </button>
            <button
              type="button"
              disabled={Boolean(initial)}
              onClick={() => set('kind', 'serial')}
              className={cn(
                'h-7 flex-1 rounded-md border text-xs transition-colors',
                form.kind === 'serial'
                  ? 'border-accent/60 bg-accent/15 text-accent'
                  : 'border-edge bg-raised text-ink-3 hover:text-ink-2',
                initial && 'cursor-not-allowed opacity-60'
              )}
            >
              串口 Console
            </button>
          </div>
        </Field>

        {/* SSH 专属字段：串口连接不需要主机/端口/账号/认证/代理，它们以空串落库 */}
        {isSsh && (
          <>
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
          </>
        )}

        {/* 串口专属字段：只有 Console 救急需要的几个参数，其余 SSH 字段不显示 */}
        {!isSsh && (
          <>
            <Field
              label="串口端口"
              hint={
                ports.length === 0
                  ? portsLoading
                    ? '正在枚举…'
                    : '没有检测到串口设备，插上 USB 转串口后点「刷新」'
                  : `已检测到 ${ports.length} 个端口`
              }
              className="col-span-2"
            >
              <div className="flex gap-1.5">
                <Combobox
                  value={form.serialPath}
                  onChange={pickPort}
                  options={portOptions}
                  placeholder={portsLoading ? '正在枚举…' : 'COM3 或 /dev/ttyUSB0'}
                  className="min-w-0 flex-1"
                />
                <button
                  type="button"
                  className="btn shrink-0"
                  onClick={() => void loadPorts()}
                  disabled={portsLoading}
                >
                  {portsLoading ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <RefreshCw size={13} />
                  )}
                  刷新
                </button>
              </div>
            </Field>

            {/* 选中端口的身份信息：热插拔后靠它把连接找回同一台设备，值得让人看见 */}
            {selectedPort && (
              <div className="col-span-2 -mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-3xs text-ink-3">
                {selectedPort.manufacturer && <span>{selectedPort.manufacturer}</span>}
                {selectedPort.serialNumber && <span>SN {selectedPort.serialNumber}</span>}
                {selectedPort.pnpId && <span className="truncate">{selectedPort.pnpId}</span>}
                {!selectedPort.serialNumber && !selectedPort.pnpId && (
                  <span className="text-warning">
                    该设备没有 USB 身份信息，拔插后只能按端口号找回
                  </span>
                )}
              </div>
            )}

            {/*
              端口待确认：导入别人的连接、或设备拔掉后按 USB 身份找不回来时置位。
              不说清楚的话，用户点「连接」只会看到一句原生层的 open failed，
              完全不知道是端口号对不上。
            */}
            {initial?.serial?.pathPending && (
              <div className="col-span-2 -mt-1 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2">
                <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
                <div className="text-2xs leading-relaxed text-ink-2">
                  端口待确认：这条连接的端口来自别的机器（或设备已拔走），本机没有
                  <span className="mx-0.5 font-mono">{form.serialPath || '该端口'}</span>。
                  插好设备后点「刷新」，从上面重新选一次端口再保存。
                </div>
              </div>
            )}

            <Field label="波特率" hint="多数 Console 口是 115200，老设备常见 9600">
              <Combobox
                value={form.serialBaud}
                onChange={(v) => set('serialBaud', v)}
                options={BAUD_PRESETS}
                placeholder="115200"
              />
            </Field>

            <Field label="数据位">
              <div className="flex gap-1">
                {DATA_BITS_OPTIONS.map((bits) => (
                  <button
                    key={bits}
                    type="button"
                    onClick={() => set('serialDataBits', bits)}
                    className={cn(
                      'h-7 flex-1 rounded-md border text-xs transition-colors',
                      form.serialDataBits === bits
                        ? 'border-accent/60 bg-accent/15 text-accent'
                        : 'border-edge bg-raised text-ink-3 hover:text-ink-2'
                    )}
                  >
                    {bits}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="校验位" className="col-span-2">
              <div className="flex gap-1">
                {PARITY_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => set('serialParity', opt.value)}
                    className={cn(
                      'h-7 flex-1 rounded-md border text-xs transition-colors',
                      form.serialParity === opt.value
                        ? 'border-accent/60 bg-accent/15 text-accent'
                        : 'border-edge bg-raised text-ink-3 hover:text-ink-2'
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="停止位">
              <div className="flex gap-1">
                {STOP_BITS_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => set('serialStopBits', opt.value)}
                    className={cn(
                      'h-7 flex-1 rounded-md border text-xs transition-colors',
                      form.serialStopBits === opt.value
                        ? 'border-accent/60 bg-accent/15 text-accent'
                        : 'border-edge bg-raised text-ink-3 hover:text-ink-2'
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="流控">
              <div className="flex gap-1">
                {FLOW_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => set('serialFlow', opt.value)}
                    className={cn(
                      'h-7 flex-1 rounded-md border text-xs transition-colors',
                      form.serialFlow === opt.value
                        ? 'border-accent/60 bg-accent/15 text-accent'
                        : 'border-edge bg-raised text-ink-3 hover:text-ink-2'
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </Field>

            <Field
              label="编码"
              hint="设备输出是 GBK 时选 GBK，否则中文会是乱码"
            >
              <div className="flex gap-1">
                {CHARSET_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => set('serialCharset', opt.value)}
                    className={cn(
                      'h-7 flex-1 rounded-md border text-xs transition-colors',
                      form.serialCharset === opt.value
                        ? 'border-accent/60 bg-accent/15 text-accent'
                        : 'border-edge bg-raised text-ink-3 hover:text-ink-2'
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </Field>

            <Field label="换行符" hint="回车键发出的换行，选错设备会把一条命令执行两遍">
              <div className="flex gap-1">
                {NEWLINE_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => set('serialNewline', opt.value)}
                    title={opt.hint}
                    className={cn(
                      'h-7 flex-1 rounded-md border text-xs transition-colors',
                      form.serialNewline === opt.value
                        ? 'border-accent/60 bg-accent/15 text-accent'
                        : 'border-edge bg-raised text-ink-3 hover:text-ink-2'
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </Field>

            <Field
              label="打开时复位设备（DTR）"
              hint="拉低 DTR 会让 ESP32/STM32 重启。只是看日志时保持关闭"
              className="col-span-2"
            >
              <div className="flex items-center gap-2 pt-0.5">
                <Toggle
                  checked={form.serialAutoReset}
                  onChange={(v) => set('serialAutoReset', v)}
                />
                <span className="text-2xs text-ink-3">
                  {form.serialAutoReset ? '连接时发送一次复位脉冲' : '不碰 DTR，设备保持当前状态'}
                </span>
              </div>
            </Field>

            {/* 让用户看清保存后标签上会显示什么 */}
            <div className="col-span-2 rounded-lg border border-edge-soft bg-app/60 px-3 py-2 font-mono text-2xs text-ink-3">
              {form.serialPath.trim()
                ? describeSerialTarget({
                    path: form.serialPath.trim(),
                    baudRate: Number(form.serialBaud) || 115200,
                    dataBits: form.serialDataBits,
                    stopBits: form.serialStopBits,
                    parity: form.serialParity,
                    flowControl: form.serialFlow,
                    charset: form.serialCharset,
                    newline: form.serialNewline
                  })
                : '选择端口后这里显示会话名称'}
            </div>
          </>
        )}

        <Field label="分组" hint="用于左侧列表归类">
          <Combobox
            value={form.group}
            onChange={(v) => set('group', v)}
            options={groupOptions}
            placeholder="默认"
          />
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
            <div className="whitespace-pre-line">{testResult.error}</div>
            {testResult.hostKeyMismatch && (
              <div className="mt-2 space-y-1.5 border-t border-danger/20 pt-2">
                <div className="font-mono text-3xs text-ink-3">
                  记录中：{testResult.hostKeyMismatch.known ?? '（无记录）'}
                </div>
                <div className="selectable break-all font-mono text-3xs text-ink-2">
                  设备当前：{testResult.hostKeyMismatch.actual}
                </div>
                <button
                  className="btn h-6 px-2 text-2xs"
                  disabled={updatingKey}
                  onClick={() => void trustCurrentHostKey()}
                >
                  {updatingKey ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <Fingerprint size={11} />
                  )}
                  更新主机指纹并重测
                </button>
              </div>
            )}
          </div>
        )}
        {testResult?.ok && (testResult.banner || testResult.fingerprint) && (
          <div className="col-span-2 selectable space-y-0.5 rounded-lg border border-success/25 bg-success/5 px-3 py-2 font-mono text-2xs leading-relaxed text-ink-3">
            {testResult.banner && <div>{testResult.banner}</div>}
            {testResult.fingerprint && <div>Host key: {testResult.fingerprint}</div>}
            {testResult.fingerprint && (
              <button
                className="mt-1 flex items-center gap-1 font-sans text-2xs text-accent transition-colors hover:text-ink"
                disabled={updatingKey}
                title="把该设备当前的指纹写进已知主机记录（设备重装/固件升级后用它对齐）"
                onClick={() => void syncCurrentHostKey()}
              >
                {updatingKey ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  <Fingerprint size={10} />
                )}
                用此指纹更新本地记录
              </button>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
