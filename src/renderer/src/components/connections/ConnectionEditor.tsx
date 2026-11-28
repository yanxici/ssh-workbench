import type * as React from 'react'
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
import {
  SERIAL_MAX_CHAR_DELAY_MS,
  SERIAL_MAX_LINE_DELAY_MS,
  describeSerialPacing,
  normalizeCharDelayMs,
  normalizeLineDelayMs
} from '@shared/serialTiming'
import { useConnectionStore } from '@/stores/connectionStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useToastStore } from '@/stores/toastStore'
import { COLORS } from '@/lib/icons'
import { cn } from '@/lib/utils'
import { call } from '@/lib/ipc'
import { useI18n, type I18nKey } from '@/i18n'
import { Combobox, Field, FieldRow, Modal, Segmented, Toggle } from '@/components/ui'

/** 未分组连接的内部数据分组名（与主进程/JSON 存储一致，不随界面语言改变） */
const DEFAULT_GROUP = '\u9ed8\u8ba4'

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
  /**
   * 兼容老旧设备算法（P0-1）。默认关：它会把 3des-cbc / group1-sha1 这类
   * 已废弃算法追加到候选列表末尾，只有对端不支持现代算法时才会真正用上。
   * 串口连接没有这个概念，保存时恒为 undefined。
   */
  legacyAlgorithms: boolean

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
   * 逐字符发送间隔（毫秒）与换行后间隔，存字符串。
   *
   * 和波特率同理：输入过程中会出现空串，Number('') 是 0 而不是 NaN，
   * 直接存 number 会让「删空再输入」变得不可能（值被立刻钉成 0）。
   */
  serialCharDelay: string
  serialLineDelay: string
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
  group: DEFAULT_GROUP,
  tags: '',
  color: '',
  remark: '',
  proxyType: 'none',
  proxyHost: '',
  proxyPort: '1080',
  proxyUsername: '',
  proxyPassword: '',
  legacyAlgorithms: false,
  serialPath: '',
  serialBaud: '115200',
  serialDataBits: 8,
  serialStopBits: 1,
  serialParity: 'none',
  serialFlow: 'none',
  serialCharset: 'utf-8',
  serialNewline: 'cr',
  serialAutoReset: false,
  serialCharDelay: '0',
  serialLineDelay: '0',
  serialSn: '',
  serialPnp: ''
}

const AUTH_OPTIONS: Array<{ value: AuthType; labelKey: I18nKey }> = [
  { value: 'password', labelKey: 'conn.ui.editor.auth.password' },
  { value: 'privateKey', labelKey: 'conn.ui.editor.auth.privateKey' },
  { value: 'agent', labelKey: 'conn.ui.editor.auth.agent' }
]

/** 常用波特率。Console 口绝大多数是 115200 或 9600，其余留着能手输 */
const BAUD_PRESETS = ['9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600']

/**
 * 串口一键预设。
 *
 * 只有「7628 U-Boot 控制台」这一条，因为它是唯一有明确文档参数的场景：
 * 过道盘点 7628 板子的刷机说明写死了 57600 8N1、无流控、CR 换行。
 * 其余设备没有权威参数，与其猜一堆预设不如让人手填 —— 猜错一个数据位，
 * 现场看到的是乱码，比没预设更难排查。
 */
const SERIAL_PRESETS: Array<{
  labelKey: I18nKey
  hintKey: I18nKey
  apply: Pick<
    FormState,
    | 'serialBaud'
    | 'serialDataBits'
    | 'serialStopBits'
    | 'serialParity'
    | 'serialFlow'
    | 'serialCharset'
    | 'serialNewline'
  >
}> = [
  {
    labelKey: 'conn.ui.editor.serialPreset.7628.label',
    hintKey: 'conn.ui.editor.serialPreset.7628.hint',
    apply: {
      serialBaud: '57600',
      serialDataBits: 8,
      serialStopBits: 1,
      serialParity: 'none',
      serialFlow: 'none',
      serialCharset: 'utf-8',
      serialNewline: 'cr'
    }
  }
]

const DATA_BITS_OPTIONS: SerialDataBits[] = [5, 6, 7, 8]

const STOP_BITS_OPTIONS: Array<{ value: SerialStopBits; label: string }> = [
  { value: 1, label: '1' },
  { value: 1.5, label: '1.5' },
  { value: 2, label: '2' }
]

const PARITY_OPTIONS: Array<{ value: SerialParity; labelKey: I18nKey }> = [
  { value: 'none', labelKey: 'conn.ui.editor.parity.none' },
  { value: 'even', labelKey: 'conn.ui.editor.parity.even' },
  { value: 'odd', labelKey: 'conn.ui.editor.parity.odd' },
  { value: 'mark', labelKey: 'conn.ui.editor.parity.mark' },
  { value: 'space', labelKey: 'conn.ui.editor.parity.space' }
]

const FLOW_OPTIONS: Array<{ value: SerialFlowControl; labelKey: I18nKey }> = [
  { value: 'none', labelKey: 'conn.ui.editor.flow.none' },
  { value: 'hardware', labelKey: 'conn.ui.editor.flow.hardware' },
  { value: 'software', labelKey: 'conn.ui.editor.flow.software' }
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

const PROXY_OPTIONS: Array<{ value: FormState['proxyType']; labelKey: I18nKey }> = [
  { value: 'none', labelKey: 'conn.ui.editor.proxy.none' },
  { value: 'socks5', labelKey: 'conn.ui.editor.proxy.socks5' },
  { value: 'http', labelKey: 'conn.ui.editor.proxy.http' }
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
}): React.JSX.Element {
  const save = useConnectionStore((s) => s.save)
  const connections = useConnectionStore((s) => s.connections)
  const { t } = useI18n()

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
        // 老 JSON 里没有这个字段，Boolean(undefined) 即 false，不必补默认值
        legacyAlgorithms: Boolean(initial.legacyAlgorithms),
        serialPath: initial.serial?.path ?? '',
        serialBaud: initial.serial ? String(initial.serial.baudRate) : EMPTY.serialBaud,
        serialDataBits: initial.serial?.dataBits ?? EMPTY.serialDataBits,
        serialStopBits: initial.serial?.stopBits ?? EMPTY.serialStopBits,
        serialParity: initial.serial?.parity ?? EMPTY.serialParity,
        serialFlow: initial.serial?.flowControl ?? EMPTY.serialFlow,
        serialCharset: initial.serial?.charset ?? EMPTY.serialCharset,
        serialNewline: initial.serial?.newline ?? EMPTY.serialNewline,
        serialAutoReset: initial.serial?.autoReset ?? false,
        serialCharDelay: String(initial.serial?.charDelayMs ?? 0),
        serialLineDelay: String(initial.serial?.lineDelayMs ?? 0),
        serialSn: initial.serial?.usbSerialNumber ?? '',
        serialPnp: initial.serial?.usbPnpId ?? ''
      })
      void call(window.api.conn.hasSecret(initial.id), { silent: true }).then((has) =>
        setHasSecret(has ?? false)
      )
    } else {
      setForm({
        ...EMPTY,
        // 预设类型：欢迎页「新建串口」直接把编辑器开到串口页签，省掉用户切 Tab
        kind: preset?.kind ?? EMPTY.kind,
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
    const res = await call(window.api.conn.pickPrivateKey(), {
      errorTitle: t('conn.ui.editor.pickKeyFailed')
    })
    setPicking(false)
    if (!res || res.canceled || !res.path) return
    set('privateKeyPath', res.path)
    setTestResult(null)
    useToastStore.getState().push({
      kind: 'success',
      title: t('conn.ui.editor.keyImported', { type: res.type ?? '' }),
      detail: res.encrypted ? t('conn.ui.editor.keyEncrypted') : t('conn.ui.editor.keyUnencrypted')
    })
  }

  /* ---------- 校验与保存 ---------- */
  const validate = (): string | null => {
    if (!form.name.trim()) return t('conn.ui.editor.errName')

    if (form.kind === 'serial') {
      if (!form.serialPath.trim()) return t('conn.ui.editor.errSerialPath')
      const baud = Number(form.serialBaud)
      if (!Number.isInteger(baud) || baud <= 0) return t('conn.ui.editor.errBaudInt')
      // 上限不是协议要求，只是防手滑（输成 1152000 会 open 失败且报错很难懂）
      if (baud > 4000000) return t('conn.ui.editor.errBaudMax')
      return null
    }

    if (!form.host.trim()) return t('conn.ui.editor.errHost')
    if (!form.username.trim()) return t('conn.ui.editor.errUsername')
    const port = Number(form.port)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return t('conn.ui.editor.errPort')
    if (form.authType === 'privateKey' && !form.privateKeyPath.trim()) {
      return t('conn.ui.editor.errKeyPath')
    }
    if (form.proxyType !== 'none') {
      if (!form.proxyHost.trim()) return t('conn.ui.editor.errProxyHost')
      const proxyPort = Number(form.proxyPort)
      if (!Number.isInteger(proxyPort) || proxyPort <= 0 || proxyPort > 65535) {
        return t('conn.ui.editor.errProxyPort')
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
      // 收敛放在共享模块里：界面允许填错（空串、负数、超出上限），
      // 落库和传输层拿到的一定是合法值
      charDelayMs: normalizeCharDelayMs(form.serialCharDelay),
      lineDelayMs: normalizeLineDelayMs(form.serialLineDelay),
      usbSerialNumber: form.serialSn.trim() || undefined,
      usbPnpId: form.serialPnp.trim() || undefined
    }
  }

  /*
   * 发送节奏的预览文案。算一次就够 —— 里面两个 normalize 各要跑一遍，
   * 直接写在 JSX 里会为了「判断非空」和「显示」调用两次。
   * 没选端口时不显示：那时整块预览还是占位文案，节奏信息没有落点。
   */
  const pacingPreview = form.serialPath.trim()
    ? describeSerialPacing({
        charDelayMs: normalizeCharDelayMs(form.serialCharDelay),
        lineDelayMs: normalizeLineDelayMs(form.serialLineDelay)
      })
    : ''

  const buildInput = (forceClearSecret = false, asNew = false): ConnectionInput => ({
    id: asNew ? undefined : initial?.id,
    /*
     * 另存为新设备时告诉主进程「凭据从原连接复制一份」。
     * 新记录是新 id，保险箱里没有它的条目，不带这个字段就会出现
     * 「另存并连接」后立刻又要输密码的割裂感。用户本次填了密码时
     * 主进程仍以填写的为准（见 saveConnection 里的优先级）。
     */
    reuseSecretFrom: asNew ? initial?.id : undefined,
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
    group: form.group.trim() || DEFAULT_GROUP,
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
    /*
     * 只写 true，关闭时写 undefined：主进程 saveConnection 对 undefined 的处理是
     * 「不覆盖」以外的显式清空（见那里 base 展开的注释），这里保持同一语义。
     */
    legacyAlgorithms: form.kind === 'serial' ? undefined : form.legacyAlgorithms || undefined,
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
          t('conn.ui.editor.saveAsConfirm', { name: form.name.trim() })
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
        title: asNew
          ? t('conn.ui.editor.savedAsAndConnect', { name: saved.name })
          : t('conn.ui.editor.connectingTo', { name: saved.name }),
        detail: asNew
          ? t('conn.ui.editor.originUnchanged', { name: initial?.name ?? '' }) +
            (hasSecret ? t('conn.ui.editor.secretReused') : '')
          : undefined
      })
      onClose()
      return
    }

    useToastStore.getState().push({
      kind: 'success',
      title:
        initial && !asNew
          ? t('conn.ui.editor.updated', { name: saved.name })
          : t('conn.ui.editor.created', { name: saved.name })
    })
    onClose()
  }

  const clearSecret = async (): Promise<void> => {
    if (!initial) return
    /*
     * 清凭据也是一次落库，必须先过校验。
     * 旧实现不校验就写：表单里主机被清空、端口填错时，点「清除凭据」会
     * 静默失败或存进一条坏记录。
     * 而且旧实现用 buildInput(true)，第一参会让 buildProxy 也把代理密码清掉 ——
     * 按钮只承诺清登录凭据，不能顺手带走代理密码。这里按正常规则组装，
     * 再单独把 password/passphrase 置为 ''（'' 的语义就是清除）。
     */
    const problem = validate()
    if (problem) {
      useToastStore.getState().push({ kind: 'warning', title: problem })
      return
    }
    const input = buildInput()
    input.password = ''
    input.passphrase = ''
    const saved = await save(input)
    if (saved) {
      setHasSecret(false)
      set('password', '')
      set('passphrase', '')
      useToastStore.getState().push({
        kind: 'success',
        title: t('conn.ui.editor.secretCleared')
      })
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
      proxy: buildProxy(),
      legacyAlgorithms: form.legacyAlgorithms || undefined
    }
    const res = await call(window.api.conn.test(input), {
      errorTitle: t('conn.ui.editor.testError')
    })
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
        { errorTitle: t('conn.ui.editor.updateHostKeyFailed') }
      )
      if (!saved) return
      useToastStore.getState().push({
        kind: 'success',
        title: t('conn.ui.editor.hostKeyUpdated'),
        detail: t('conn.ui.editor.hostKeyNextHint', { fp: mismatch.actual.slice(0, 24) })
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
        { errorTitle: t('conn.ui.editor.updateHostKeyFailed') }
      )
      if (saved) {
        useToastStore.getState().push({
          kind: 'success',
          title: t('conn.ui.editor.hostKeySynced')
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
          ? form.kind === 'serial'
            ? t('conn.ui.editor.titleEditSerial', { name: initial.name })
            : t('conn.ui.editor.titleEditSsh', { name: initial.name })
          : form.kind === 'serial'
            ? t('conn.ui.editor.titleNewSerial')
            : t('conn.ui.editor.titleNewSsh')
      }
      onClose={onClose}
      width="max-w-xl"
      footer={
        <>
          <div className="mr-auto flex items-center gap-2">
            {/*
             * 串口没有"测试连接"这回事：open 一次端口就等于连上了，
             * 而反复开关端口会触发 DTR 电平变化（接 EN 脚的板子会重启）。
             * 想验就保存后直接连，断开再改。
             */}
            {form.kind === 'ssh' && (
              <button className="btn" onClick={() => void runTest()} disabled={testing}>
                {testing ? (
                  <Loader2 size={13} className="animate-spin" />
                ) : (
                  <FlaskConical size={13} />
                )}
                {t('conn.ui.editor.testBtn')}
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
                    <CheckCircle2 size={12} />{' '}
                    {t('conn.ui.editor.testSuccess', { ms: testResult.durationMs })}
                  </>
                ) : (
                  <span className="max-w-[300px] truncate">{testResult.error}</span>
                )}
              </span>
            )}
          </div>
          <button className="btn" onClick={onClose}>
            {t('conn.ui.cancel')}
          </button>
          {initial && (
            <button
              className="btn"
              title={t('conn.ui.editor.saveAsTitle')}
              onClick={() => void submit({ asNew: true, connect: true })}
              disabled={saving}
            >
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />}
              {t('conn.ui.editor.saveAsBtn')}
            </button>
          )}
          <button
            className="btn btn-primary"
            title={initial ? t('conn.ui.editor.connectTitleEdit') : t('conn.ui.editor.connectTitleNew')}
            onClick={() => void submit({ connect: true })}
            disabled={saving}
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />}
            {t('conn.ui.editor.connectBtn')}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-x-3 gap-y-3.5">
        {initial && (
          <div className="col-span-2 flex items-start gap-2 rounded-lg border border-edge-soft bg-app/60 px-3 py-2 text-2xs leading-relaxed text-ink-3">
            <Plug size={12} className="mt-0.5 shrink-0" />
            <span>{t('conn.ui.editor.editTip')}</span>
          </div>
        )}

        <Field label={t('conn.ui.editor.name')} className="col-span-2">
          <input
            className="input selectable"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder={t('conn.ui.editor.namePlaceholder')}
          />
        </Field>

        {/*
         * 连接类型。只在新建时可自由切换：已有连接改了 kind 等于换了台设备，
         * 在编辑器里"顺手改一下"会让原设备的凭据/档案挂到新记录上，
         * 真要从串口改成 SSH，删掉重建更清楚。
         */}
        <Field
          label={t('conn.ui.editor.kind')}
          hint={initial ? t('conn.ui.editor.kindHintEdit') : undefined}
          className="col-span-2"
        >
          <Segmented
            disabled={Boolean(initial)}
            value={form.kind}
            onChange={(v) => set('kind', v)}
            options={[
              { value: 'ssh', label: t('conn.ui.editor.kindSsh') },
              { value: 'serial', label: t('conn.ui.editor.kindSerial') }
            ]}
          />
        </Field>

        {
          /* SSH 专属字段：串口连接不需要主机/端口/账号/认证/代理，它们以空串落库 */
        }
        {isSsh && (
          <>
            <Field label={t('conn.ui.editor.host')}>
              <input
                className="input selectable"
                value={form.host}
                onChange={(e) => set('host', e.target.value)}
                placeholder={t('conn.ui.editor.hostPlaceholder')}
              />
            </Field>

            <Field label={t('conn.ui.editor.port')}>
              <input
                className="input selectable"
                type="number"
                min={1}
                max={65535}
                value={form.port}
                onChange={(e) => set('port', e.target.value)}
              />
            </Field>

            <Field label={t('conn.ui.editor.username')}>
              <input
                className="input selectable"
                value={form.username}
                onChange={(e) => set('username', e.target.value)}
              />
            </Field>

            <Field label={t('conn.ui.editor.authType')}>
              <Segmented
                value={form.authType}
                onChange={(v) => set('authType', v)}
                options={AUTH_OPTIONS.map((opt) => ({ value: opt.value, label: t(opt.labelKey) }))}
              />
            </Field>

            {form.authType === 'password' && (
              <>
                <Field
                  label={t('conn.ui.editor.password')}
                  hint={initial && hasSecret ? t('conn.ui.editor.keepSecretHint') : undefined}
                  className="col-span-2"
                >
                  <div className="flex gap-1.5">
                    <input
                      className="input selectable flex-1"
                      type={showPassword ? 'text' : 'password'}
                      value={form.password}
                      onChange={(e) => set('password', e.target.value)}
                      placeholder={
                        initial && hasSecret
                          ? t('conn.ui.editor.passwordKeepPlaceholder')
                          : t('conn.ui.editor.passwordPlaceholder')
                      }
                      autoComplete="new-password"
                    />
                    <button
                      type="button"
                      className="btn shrink-0"
                      onClick={() => setShowPassword((v) => !v)}
                    >
                      {showPassword ? t('conn.ui.editor.hide') : t('conn.ui.editor.show')}
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
                    {t('conn.ui.editor.clearSecret')}
                  </button>
                )}
              </>
            )}

            {form.authType === 'privateKey' && (
              <>
                <Field
                  label={t('conn.ui.editor.keyPath')}
                  hint={t('conn.ui.editor.keyPathHint')}
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
                      {t('conn.ui.editor.pickFile')}
                    </button>
                  </div>
                </Field>
                <Field
                  label={t('conn.ui.editor.passphrase')}
                  hint={
                    initial && hasSecret
                      ? t('conn.ui.editor.keepSecretHint')
                      : t('conn.ui.editor.passphraseHintNew')
                  }
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
                <span>{t('conn.ui.editor.agentHint')}</span>
              </div>
            )}

            <Field
              label={t('conn.ui.editor.proxy')}
              hint={t('conn.ui.editor.proxyHint')}
              className="col-span-2"
            >
              <div className="space-y-2">
                <Segmented
                  value={form.proxyType}
                  onChange={(v) => set('proxyType', v)}
                  options={PROXY_OPTIONS.map((opt) => ({
                    value: opt.value,
                    label: t(opt.labelKey)
                  }))}
                />
                {form.proxyType !== 'none' && (
                  <div className="grid grid-cols-2 gap-x-3 gap-y-2">
                    <input
                      className="input selectable"
                      value={form.proxyHost}
                      onChange={(e) => set('proxyHost', e.target.value)}
                      placeholder={t('conn.ui.editor.proxyHostPlaceholder')}
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
                      placeholder={t('conn.ui.editor.proxyUserPlaceholder')}
                    />
                    <input
                      className="input selectable"
                      type="password"
                      value={form.proxyPassword}
                      onChange={(e) => set('proxyPassword', e.target.value)}
                      placeholder={t('conn.ui.editor.proxyPassPlaceholder')}
                    />
                  </div>
                )}
              </div>
            </Field>

            {/*
             * 老设备兼容算法：只在 SSH 分支出现，串口没有算法协商这回事。
             * 说明文案走词表（见 i18n/index.ts），开关本身不带副标题 ——
             * Field 的 hint 已经占了一行，再加一行状态文字只是噪音。
             */}
            <Field
              label={t('conn.legacyAlgo.label')}
              hint={t('conn.legacyAlgo.hint')}
              className="col-span-2"
            >
              <div className="flex items-center gap-2 pt-0.5">
                <Toggle
                  checked={form.legacyAlgorithms}
                  onChange={(v) => set('legacyAlgorithms', v)}
                />
                <span className="font-mono text-2xs text-ink-3">3des-cbc / group1-sha1</span>
              </div>
            </Field>
          </>
        )}

        {
          /* 串口专属字段：只有 Console 救急需要的几个参数，其余 SSH 字段不显示 */
        }
        {!isSsh && (
          <>
            <Field
              label={t('conn.ui.editor.serialPort')}
              hint={
                ports.length === 0
                  ? portsLoading
                    ? t('conn.ui.editor.serialEnumerating')
                    : t('conn.ui.editor.serialNone')
                  : t('conn.ui.editor.serialCount', { count: ports.length })
              }
              className="col-span-2"
            >
              <div className="flex gap-1.5">
                <Combobox
                  value={form.serialPath}
                  onChange={pickPort}
                  options={portOptions}
                  placeholder={
                    portsLoading
                      ? t('conn.ui.editor.serialEnumerating')
                      : t('conn.ui.editor.serialPortPlaceholder')
                  }
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
                  {t('conn.ui.editor.refresh')}
                </button>
              </div>
            </Field>

            {
              /* 选中端口的身份信息：热插拔后靠它把连接找回同一台设备，值得让人看见 */
            }
            {selectedPort && (
              <div className="col-span-2 -mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-3xs text-ink-3">
                {selectedPort.manufacturer && <span>{selectedPort.manufacturer}</span>}
                {selectedPort.serialNumber && <span>SN {selectedPort.serialNumber}</span>}
                {selectedPort.pnpId && <span className="truncate">{selectedPort.pnpId}</span>}
                {!selectedPort.serialNumber && !selectedPort.pnpId && (
                  <span className="text-warning">{t('conn.ui.editor.noUsbIdentity')}</span>
                )}
              </div>
            )}

            {/*
             * 端口待确认：导入别人的连接、或设备拔掉后按 USB 身份找不回来时置位。
             * 不说清楚的话，用户点「连接」只会看到一句原生层的 open failed，
             * 完全不知道是端口号对不上。
             */}
            {initial?.serial?.pathPending && (
              <div className="col-span-2 -mt-1 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2">
                <AlertTriangle size={13} className="mt-0.5 shrink-0 text-warning" />
                <div className="text-2xs leading-relaxed text-ink-2">
                  {t('conn.ui.editor.pathPendingPrefix')}
                  <span className="mx-0.5 font-mono">
                    {form.serialPath || t('conn.ui.editor.pathPendingFallback')}
                  </span>
                  {t('conn.ui.editor.pathPendingSuffix')}
                </div>
              </div>
            )}

            {
              /* 一键套用已知设备的串口参数：省掉"57600 还是 115200"的试错 */
            }
            <div className="col-span-2 -mb-1 flex flex-wrap items-center gap-1.5">
              <span className="text-2xs text-ink-3">{t('conn.ui.editor.presets')}</span>
              {SERIAL_PRESETS.map((preset) => (
                <button
                  key={preset.labelKey}
                  type="button"
                  className="btn h-6 px-2 text-2xs"
                  onClick={() => setForm((f) => ({ ...f, ...preset.apply }))}
                  title={t('conn.ui.editor.applyPresetTitle', { hint: t(preset.hintKey) })}
                >
                  {t(preset.labelKey)}
                </button>
              ))}
              <span className="text-3xs text-ink-3">{t('conn.ui.editor.presetEditableHint')}</span>
            </div>

            {/*
             * 布局：波特率独占一行（hint 长，半栏必折行）；数据位 + 停止位并排（选项都短）；
             * 校验位、流控独占一行 —— 流控标签「硬件 (RTS/CTS)」在半栏里每个按钮只剩 ~86px，
             * 折成两行撑破 h-7 按钮。带 hint 的成对字段用 FieldRow，保证两栏控件对齐。
             */}
            <Field
              label={t('conn.ui.editor.baudRate')}
              hint={t('conn.ui.editor.baudRateHint')}
              className="col-span-2"
            >
              <Combobox
                value={form.serialBaud}
                onChange={(v) => set('serialBaud', v)}
                options={BAUD_PRESETS}
                placeholder="115200"
              />
            </Field>

            <Field label={t('conn.ui.editor.dataBits')}>
              <Segmented
                options={DATA_BITS_OPTIONS.map((bits) => ({ value: bits, label: String(bits) }))}
                value={form.serialDataBits}
                onChange={(v) => set('serialDataBits', v)}
              />
            </Field>

            <Field label={t('conn.ui.editor.stopBits')}>
              <Segmented
                options={STOP_BITS_OPTIONS}
                value={form.serialStopBits}
                onChange={(v) => set('serialStopBits', v)}
              />
            </Field>

            <Field label={t('conn.ui.editor.parity')} className="col-span-2">
              <Segmented
                options={PARITY_OPTIONS.map((opt) => ({ value: opt.value, label: t(opt.labelKey) }))}
                value={form.serialParity}
                onChange={(v) => set('serialParity', v)}
              />
            </Field>

            <Field label={t('conn.ui.editor.flowControl')} className="col-span-2">
              <Segmented
                options={FLOW_OPTIONS.map((opt) => ({ value: opt.value, label: t(opt.labelKey) }))}
                value={form.serialFlow}
                onChange={(v) => set('serialFlow', v)}
              />
            </Field>

            <FieldRow>
              <Field label={t('editor.encoding')} hint={t('conn.ui.editor.charsetHint')}>
                <Segmented
                  options={CHARSET_OPTIONS}
                  value={form.serialCharset}
                  onChange={(v) => set('serialCharset', v)}
                />
              </Field>

              <Field label={t('conn.ui.editor.newline')} hint={t('conn.ui.editor.newlineHint')}>
                <Segmented
                  options={NEWLINE_OPTIONS.map((opt) => ({
                    value: opt.value,
                    label: opt.label,
                    title: opt.hint
                  }))}
                  value={form.serialNewline}
                  onChange={(v) => set('serialNewline', v)}
                />
              </Field>
            </FieldRow>

            <Field
              label={t('conn.ui.editor.autoReset')}
              hint={t('conn.ui.editor.autoResetHint')}
              className="col-span-2"
            >
              <div className="flex items-center gap-2 pt-0.5">
                <Toggle
                  checked={form.serialAutoReset}
                  onChange={(v) => set('serialAutoReset', v)}
                />
                <span className="text-2xs text-ink-3">
                  {form.serialAutoReset
                    ? t('conn.ui.editor.autoResetOn')
                    : t('conn.ui.editor.autoResetOff')}
                </span>
              </div>
            </Field>

            <FieldRow>
              <Field label={t('conn.ui.editor.charDelay')} hint={t('conn.ui.editor.charDelayHint')}>
                <div className="flex items-center gap-1.5">
                  <input
                    className="input w-16 text-center"
                    type="number"
                    min={0}
                    max={SERIAL_MAX_CHAR_DELAY_MS}
                    step={1}
                    value={form.serialCharDelay}
                    onChange={(e) => set('serialCharDelay', e.target.value)}
                  />
                  <span className="text-2xs text-ink-3">ms</span>
                </div>
              </Field>

              <Field label={t('conn.ui.editor.lineDelay')} hint={t('conn.ui.editor.lineDelayHint')}>
                <div className="flex items-center gap-1.5">
                  <input
                    className="input w-16 text-center"
                    type="number"
                    min={0}
                    max={SERIAL_MAX_LINE_DELAY_MS}
                    step={10}
                    value={form.serialLineDelay}
                    onChange={(e) => set('serialLineDelay', e.target.value)}
                  />
                  <span className="text-2xs text-ink-3">ms</span>
                </div>
              </Field>
            </FieldRow>

            <div className="col-span-2 rounded-lg border border-edge-soft bg-app/60 px-3 py-2 font-mono text-2xs text-ink-3">
              <div>
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
                  : t('conn.ui.editor.serialPreviewEmpty')}
              </div>
              {/*
               * 发送节奏是「隐性行为」，标签上看不出来。放在这里让用户保存前
               * 就确认自己确实加上了延迟 —— 否则下次粘贴命令还是被吞。
               */}
              {pacingPreview !== '' && <div className="mt-0.5 text-warning">{pacingPreview}</div>}
            </div>
          </>
        )}

        <Field label={t('conn.ui.editor.group')} hint={t('conn.ui.editor.groupHint')}>
          <Combobox
            value={form.group}
            onChange={(v) => set('group', v)}
            options={groupOptions}
            placeholder={t('conn.ui.defaultGroup')}
          />
        </Field>

        <Field label={t('conn.ui.editor.tags')} hint={t('conn.ui.editor.tagsHint')}>
          <input
            className="input selectable"
            value={form.tags}
            onChange={(e) => set('tags', e.target.value)}
            placeholder={t('conn.ui.editor.tagsPlaceholder')}
          />
        </Field>

        <Field label={t('conn.ui.editor.color')} className="col-span-2">
          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              title={t('conn.ui.editor.noColor')}
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

        <Field label={t('conn.ui.editor.remark')} className="col-span-2">
          <textarea
            className="input scroll-thin h-16 resize-none selectable py-1.5"
            value={form.remark}
            onChange={(e) => set('remark', e.target.value)}
            placeholder={t('conn.ui.editor.remarkPlaceholder')}
          />
        </Field>

        {testResult && !testResult.ok && (
          <div className="col-span-2 selectable rounded-lg border border-danger/30 bg-danger/5 px-3 py-2 text-2xs leading-relaxed text-danger">
            <div className="whitespace-pre-line">{testResult.error}</div>
            {testResult.hostKeyMismatch && (
              <div className="mt-2 space-y-1.5 border-t border-danger/20 pt-2">
                <div className="font-mono text-3xs text-ink-3">
                  {t('conn.ui.editor.knownKey', {
                    value: testResult.hostKeyMismatch.known ?? t('conn.ui.editor.knownKeyNone')
                  })}
                </div>
                <div className="selectable break-all font-mono text-3xs text-ink-2">
                  {t('conn.ui.editor.actualKey', { value: testResult.hostKeyMismatch.actual })}
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
                  {t('conn.ui.editor.trustHostKey')}
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
                title={t('conn.ui.editor.syncHostKeyTitle')}
                onClick={() => void syncCurrentHostKey()}
              >
                {updatingKey ? (
                  <Loader2 size={10} className="animate-spin" />
                ) : (
                  <Fingerprint size={10} />
                )}
                {t('conn.ui.editor.syncHostKey')}
              </button>
            )}
          </div>
        )}
      </div>
    </Modal>
  )
}
