import { useEffect, useState, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Keyboard,
  Monitor,
  Moon,
  Palette,
  RotateCcw,
  Sun,
  Trash2,
  AlertTriangle,
  RefreshCw,
  Fingerprint,
  Loader2
} from 'lucide-react'
import type { ColorThemeId, LayoutSizes, ShortcutAction, ThemeMode } from '@shared/types'
import { SHORTCUT_ACTIONS, resolveShortcuts } from '@/lib/shortcuts'
import { detectShortcutConflicts, checkSingleConflict } from '@/lib/shortcutConflict'
import { KEYS, PANE_LABEL, PANE_SPECS, clampPane } from '@/lib/layout'
import { COLOR_THEMES } from '@/theme/colorThemes'
import { useIsDark, useSettingsStore } from '@/stores/settingsStore'
import { useToastStore } from '@/stores/toastStore'
import { call } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { ConfirmDialog, Modal, Toggle } from '@/components/ui'
import { ErrorLogSection } from './ErrorLogSection'
import { UpdateSection } from './UpdateSection'

interface KnownHost {
  host: string
  port: number
  fingerprint: string
  addedAt: number
}

/** 「旧指纹 → 新指纹」的待确认更新 */
interface FingerprintUpdate {
  host: string
  port: number
  from: string
  to: string
}

const THEME_OPTIONS: Array<{ value: ThemeMode; label: string; icon: JSX.Element }> = [
  { value: 'dark', label: '暗色', icon: <Moon size={13} /> },
  { value: 'light', label: '亮色', icon: <Sun size={13} /> },
  { value: 'system', label: '跟随系统', icon: <Monitor size={13} /> }
]

const SECTION_KEY = 'sshwb.settings.sections'

function readOpenSections(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(SECTION_KEY)
    return raw ? (JSON.parse(raw) as Record<string, boolean>) : {}
  } catch {
    return {}
  }
}

function writeOpenSection(id: string, open: boolean): void {
  try {
    localStorage.setItem(SECTION_KEY, JSON.stringify({ ...readOpenSections(), [id]: open }))
  } catch {
    /* 隐私模式下 localStorage 不可用：忽略即可，仅影响记忆功能 */
  }
}

/**
 * 设置分组：可折叠 + 记忆展开状态（存本地，下次打开保持一致）。
 * 默认只展开「外观」「终端」，其余收起 —— 设置面板不再一屏铺满。
 */
function Section({
  id,
  title,
  hint,
  defaultOpen = false,
  children
}: {
  id: string
  title: string
  hint?: string
  defaultOpen?: boolean
  children: ReactNode
}): JSX.Element {
  const [open, setOpen] = useState(() => readOpenSections()[id] ?? defaultOpen)

  const toggle = (): void => {
    setOpen((v) => {
      writeOpenSection(id, !v)
      return !v
    })
  }

  return (
    <div className="mb-2 overflow-hidden rounded-lg border border-edge-soft bg-app/50">
      <button
        className="flex w-full cursor-default items-center gap-1.5 px-2.5 py-1.5 text-left transition-colors hover:bg-hover/50"
        onClick={toggle}
        title={open ? '收起该分组' : '展开该分组'}
      >
        {open ? (
          <ChevronDown size={12} className="shrink-0 text-ink-3" />
        ) : (
          <ChevronRight size={12} className="shrink-0 text-ink-3" />
        )}
        <span className="text-2xs font-semibold uppercase tracking-wider text-ink-2">{title}</span>
        {hint && <span className="ml-1 truncate text-2xs text-ink-3/80">{hint}</span>}
      </button>
      {open && <div className="space-y-2.5 border-t border-edge-soft px-2.5 py-2.5">{children}</div>}
    </div>
  )
}

function Row({
  label,
  hint,
  children
}: {
  label: string
  hint?: string
  children: ReactNode
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-ink-2">{label}</div>
        {hint && <div className="mt-0.5 text-2xs leading-snug text-ink-3">{hint}</div>}
      </div>
      {/* 控件区固定宽度、允许换行压缩：开关不再被右侧裁切 */}
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-1">{children}</div>
    </div>
  )
}

/** 设置面板里的分段控件（主题 / 光标样式 / 面板位置） */
function Segmented<T extends string>({
  value,
  options,
  onChange
}: {
  value: T
  options: Array<{ value: T; label: string; icon?: ReactNode }>
  onChange: (next: T) => void
}): JSX.Element {
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {options.map((opt) => (
        <button
          key={opt.value}
          type="button"
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs transition-colors',
            value === opt.value
              ? 'border-accent/60 bg-accent/15 text-accent'
              : 'border-edge bg-raised text-ink-3 hover:text-ink-2'
          )}
          onClick={() => onChange(opt.value)}
        >
          {opt.icon}
          {opt.label}
        </button>
      ))}
    </div>
  )
}

/**
 * 配色主题画廊：每个主题给出一张色板预览（背景 / 强调色 / 成功色），
 * 点击即用，切换无需重载。颜色取自主题定义本身，因此预览必然与真实配色一致。
 */
function ColorThemeGallery({
  value,
  dark,
  onChange
}: {
  value: ColorThemeId
  dark: boolean
  onChange: (next: ColorThemeId) => void
}): JSX.Element {
  return (
    <div className="grid grid-cols-3 gap-2">
      {COLOR_THEMES.map((t) => {
        const variant = dark ? t.dark : t.light
        const active = t.id === value
        return (
          <button
            key={t.id}
            type="button"
            title={t.name}
            aria-label={`配色主题 ${t.name}`}
            aria-pressed={active}
            className={cn(
              'group flex flex-col gap-1.5 rounded-lg border p-2 text-left transition-colors',
              active
                ? 'border-accent bg-accent/10'
                : 'border-edge bg-raised hover:border-accent/40 hover:bg-hover'
            )}
            onClick={() => onChange(t.id)}
          >
            {/* 色板预览：用主题自己的变量着色，所见即所得 */}
            <div
              className="flex h-7 items-center gap-1 overflow-hidden rounded-md border border-edge-soft px-1.5"
              style={{ background: `rgb(${variant.vars.app})` }}
            >
              <span
                className="h-3 w-3 rounded-full"
                style={{ background: `rgb(${variant.vars.accent})` }}
              />
              <span
                className="h-3 w-3 rounded-full"
                style={{ background: `rgb(${variant.vars.success})` }}
              />
              <span
                className="h-3 w-3 rounded-full"
                style={{ background: `rgb(${variant.vars.danger})` }}
              />
              <span
                className="ml-auto h-4 w-8 rounded-sm"
                style={{ background: `rgb(${variant.vars.panel})` }}
              />
            </div>
            <div className="flex items-center gap-1">
              <span
                className={cn(
                  'truncate text-2xs',
                  active ? 'font-medium text-accent' : 'text-ink-2 group-hover:text-ink'
                )}
              >
                {t.name}
              </span>
              {active && (
                <span className="ml-auto shrink-0 text-3xs text-accent" aria-hidden>
                  ✓
                </span>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}

/** 快捷键设置：点击后按下新组合键即可录制；Esc 取消、Backspace 清空 */
function ShortcutRows(): JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const current = resolveShortcuts(settings.shortcuts)
  const [recording, setRecording] = useState<ShortcutAction | null>(null)
  const [pendingCombo, setPendingCombo] = useState<string>('')
  const [conflictWarning, setConflictWarning] = useState<{ action: string; conflict: string } | null>(null)

  // 检测当前快捷键映射中的冲突
  const conflicts = detectShortcutConflicts(settings.shortcuts)

  const commit = (action: ShortcutAction, combo: string | undefined): void => {
    // 检查冲突
    if (combo) {
      const conflict = checkSingleConflict(combo, action, settings.shortcuts)
      if (conflict) {
        setPendingCombo(combo)
        setConflictWarning({
          action,
          conflict: conflict.label
        })
        return
      }
    }
    
    const next = { ...settings.shortcuts }
    if (combo === undefined) delete next[action]
    else next[action] = combo
    void update({ shortcuts: next })
    setRecording(null)
    setPendingCombo('')
  }
  
  const forceCommit = (): void => {
    if (!conflictWarning || !pendingCombo) return
    const next = { ...settings.shortcuts }
    next[conflictWarning.action as ShortcutAction] = pendingCombo
    void update({ shortcuts: next })
    setRecording(null)
    setPendingCombo('')
    setConflictWarning(null)
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!recording) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      setRecording(null)
      return
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      commit(recording, undefined)
      return
    }
    // 只接受「修饰键 + 单键」
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      if (e.key === 'Tab') return // Tab 需配合修饰键才有意义
      return
    }
    const key = e.key.toLowerCase()
    if (['control', 'shift', 'alt', 'meta'].includes(key)) return // 单独按修饰键不提交
    const combo = [
      e.ctrlKey || e.metaKey ? 'Ctrl' : '',
      e.altKey ? 'Alt' : '',
      e.shiftKey ? 'Shift' : '',
      key === ',' ? ',' : key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key
    ]
      .filter(Boolean)
      .join('+')
    commit(recording, combo)
  }

  return (
    <div className="space-y-1.5" onKeyDown={onKeyDown}>
      <div className="mb-1 text-2xs leading-relaxed text-ink-3">
        点击右侧键位进入录制，按下新组合键即保存；<kbd className="kbd">Esc</kbd> 取消、
        <kbd className="kbd">Backspace</kbd> 清除该项。
      </div>
      
      {/* 冲突警告 */}
      {conflicts.length > 0 && (
        <div className="mb-2 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
          <AlertTriangle size={14} className="mt-0.5 shrink-0 text-warning" />
          <div className="min-w-0 flex-1 text-2xs leading-relaxed text-ink-2">
            检测到 {conflicts.length} 个快捷键冲突：
            {conflicts.map((c, i) => (
              <div key={i} className="mt-1">
                <code className="text-warning">{c.combo}</code> 被分配给：
                {c.actions.map((a) => a.label).join('、')}
              </div>
            ))}
          </div>
        </div>
      )}
      
      {SHORTCUT_ACTIONS.map((action) => {
        const value = current[action.id]
        const isRecording = recording === action.id
        const isDefault = !settings.shortcuts?.[action.id]
        return (
          <div
            key={action.id}
            className="flex items-center justify-between gap-3 rounded-md border border-edge-soft bg-panel px-2.5 py-1.5"
          >
            <div className="min-w-0">
              <div className="text-xs text-ink-2">{action.label}</div>
              {isDefault && <div className="text-3xs text-ink-3/70">使用默认值</div>}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              {!isDefault && (
                <button
                  className="btn-icon h-6 w-6 hover:text-warning"
                  title={`恢复默认：${action.default}`}
                  onClick={() => commit(action.id, undefined)}
                >
                  <RotateCcw size={11} />
                </button>
              )}
              <button
                className={cn(
                  'flex h-7 min-w-[72px] items-center justify-center gap-1 rounded-md border px-2 text-xs font-mono transition-colors',
                  isRecording
                    ? 'border-accent bg-accent/15 text-accent'
                    : 'border-edge bg-raised text-ink-2 hover:border-accent/50'
                )}
                onClick={() => setRecording(isRecording ? null : action.id)}
              >
                <Keyboard size={11} />
                {isRecording ? '按下键…' : value}
              </button>
            </div>
          </div>
        )
      })}
      <div className="pt-1 text-3xs leading-relaxed text-ink-3/70">
        提示：终端内「搜索 / 复制 / 粘贴」的组合键（Ctrl+F / Ctrl+Shift+C / Ctrl+Shift+V）在此配置后，
        在终端聚焦时同样生效；避免与系统/浏览器快捷键冲突。
      </div>
      
      {/* 快捷键冲突确认弹窗 */}
      {conflictWarning && (
        <Modal
          open
          title="快捷键冲突"
          onClose={() => {
            setConflictWarning(null)
            setPendingCombo('')
            setRecording(null)
          }}
        >
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
              <AlertTriangle size={16} className="mt-0.5 shrink-0 text-warning" />
              <div className="text-xs text-ink-2">
                快捷键 <code className="rounded bg-raised px-1 py-0.5 font-mono text-warning">{pendingCombo}</code> 
                {' '}已被「{conflictWarning.conflict}」使用。
              </div>
            </div>
            <div className="text-2xs text-ink-3">
              继续保存将覆盖原有快捷键，建议选择不同的组合键避免冲突。
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button 
                className="btn" 
                onClick={() => {
                  setConflictWarning(null)
                  setPendingCombo('')
                  setRecording(null)
                }}
              >
                取消
              </button>
              <button className="btn btn-danger" onClick={forceCommit}>
                强制保存
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}

/** 设置面板：主题 / 终端 / 行为 / 危险关键词 / 已知主机 / 数据目录 */
export function SettingsPanel({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)

  const [knownHosts, setKnownHosts] = useState<KnownHost[]>([])
  const [paths, setPaths] = useState<{ dataDir: string; userData: string } | null>(null)
  const [dangerText, setDangerText] = useState('')
  /** 正在探测/更新指纹的 host:port（按钮转圈） */
  const [probeBusy, setProbeBusy] = useState<string | null>(null)
  /** 待确认的指纹更新（旧 → 新 需要用户点头）；批量刷新时会有多条 */
  const [fpUpdates, setFpUpdates] = useState<FingerprintUpdate[]>([])
  const [fpError, setFpError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    void call(window.api.knownHosts.list(), { silent: true }).then((l) => setKnownHosts(l ?? []))
    void call(window.api.settings.paths(), { silent: true }).then((p) => setPaths(p))
    setDangerText(useSettingsStore.getState().settings.dangerPatterns.join('\n'))
  }, [open])

  /**
   * 更新某台设备的指纹。
   *
   * 设备重装 / 固件升级 / 换 sshd host key 之后，旧记录会让所有连接被拒。
   * 直接改库太危险（等于静默信任未知主机），所以先探测现状、把「旧 → 新」
   * 摆到用户面前确认，确认后才写回。
   */
  /**
   * 探测设备当前指纹。
   *
   * 刻意不用 call()：silent 模式下失败只会返回 null，把「端口不通 / 超时」
   * 这种必须让用户看见的原因一起吞掉；这里保留 IpcResult 里的 error 原文。
   */
  const probeHost = async (
    host: string,
    port: number
  ): Promise<{ ok: true; fingerprint: string } | { ok: false; error: string }> => {
    try {
      const res = await window.api.knownHosts.probe(host, port)
      if (res.ok) return { ok: true, fingerprint: res.data.fingerprint }
      return { ok: false, error: res.error }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  const updateFingerprint = async (h: KnownHost): Promise<void> => {
    const key = `${h.host}:${h.port}`
    setProbeBusy(key)
    setFpError(null)
    try {
      const probe = await probeHost(h.host, h.port)
      if (!probe.ok) {
        // 失败原因必须落到界面上：silent 的 call() 会把原因吞掉，用户只会看到按钮转一圈
        setFpError(`${key} 探测失败：${probe.error}`)
        return
      }
      if (probe.fingerprint === h.fingerprint) {
        useToastStore.getState().push({
          kind: 'success',
          title: '指纹无需更新',
          detail: `${key} 与设备当前一致`
        })
        return
      }
      setFpUpdates([{ host: h.host, port: h.port, from: h.fingerprint, to: probe.fingerprint }])
    } finally {
      setProbeBusy(null)
    }
  }

  const applyFingerprintUpdates = async (): Promise<void> => {
    const targets = fpUpdates
    setFpUpdates([])
    if (targets.length === 0) return
    let done = 0
    let failed = 0
    for (const t of targets) {
      const res = await call(window.api.knownHosts.refresh(t.host, t.port, t.to), { silent: true })
      if (res) {
        done += 1
        setKnownHosts((prev) =>
          prev.map((x) =>
            x.host === t.host && x.port === t.port
              ? { ...x, fingerprint: t.to, addedAt: Date.now() }
              : x
          )
        )
      } else {
        failed += 1
      }
    }
    useToastStore.getState().push({
      kind: failed > 0 ? 'warning' : 'success',
      title: failed > 0 ? `已更新 ${done} 条，${failed} 条失败` : `已更新 ${done} 条指纹`,
      detail: '下次连接会按新指纹校验'
    })
  }

  /** 一次性刷新全部记录：每台都探测一次，只列出真的变了的 */
  const refreshAllFingerprints = async (): Promise<void> => {
    if (knownHosts.length === 0) return
    setProbeBusy('*')
    setFpError(null)
    let changed = 0
    let failed = 0
    const updates: FingerprintUpdate[] = []
    for (const h of knownHosts) {
      const probe = await probeHost(h.host, h.port)
      if (!probe.ok) {
        failed += 1
        continue
      }
      if (probe.fingerprint !== h.fingerprint) {
        changed += 1
        updates.push({ host: h.host, port: h.port, from: h.fingerprint, to: probe.fingerprint })
      }
    }
    setProbeBusy(null)
    if (updates.length === 0) {
      useToastStore.getState().push({
        kind: failed > 0 ? 'warning' : 'success',
        title: failed > 0 ? `刷新完成，${failed} 台探测失败` : '全部指纹均与设备一致',
        detail: failed > 0 ? '离线设备/端口不通会探测失败，可单独重试' : undefined
      })
      return
    }
    // 统一弹一次确认框（列出每台的旧→新），不静默信任任何一台
    setFpUpdates(updates)
    useToastStore.getState().push({
      kind: 'warning',
      title: `有 ${changed} 台设备的指纹已变化`,
      detail: '请逐条确认后再更新'
    })
  }

  const commitDanger = (): void => {
    const patterns = dangerText
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    void update({ dangerPatterns: patterns })
  }

  const setTerminal = (patch: Partial<typeof settings.terminal>): void => {
    void update({ terminal: { ...settings.terminal, ...patch } })
  }

  /** 当前栏宽（缺项按默认值补齐），设置面板里可精确定值 */
  const layoutSizes: Required<LayoutSizes> = {
    sidebar: clampPane('sidebar', settings.layout?.sidebar),
    commandRail: clampPane('commandRail', settings.layout?.commandRail)
  }

  const setPane = (key: (typeof KEYS)[number], value: number): void => {
    void update({ layout: { ...layoutSizes, [key]: clampPane(key, value) } })
  }

  return (
    <Modal open={open} title="设置" onClose={onClose} width="max-w-xl" footer={
      <button className="btn" onClick={onClose}>完成</button>
    }>
      <Section id="appearance" title="外观" defaultOpen>
        <Row label="主题" hint="浅色为默认，跟随系统会实时响应系统深浅色">
          <Segmented
            value={settings.theme}
            options={THEME_OPTIONS}
            onChange={(v) => void update({ theme: v })}
          />
        </Row>
        <div className="mt-3 border-t border-edge-soft pt-3">
          <div className="mb-2 flex items-center gap-1.5">
            <Palette size={13} className="text-ink-3" />
            <span className="text-xs font-medium text-ink-2">配色主题</span>
            <span className="text-2xs text-ink-3">· 界面与终端配色联动</span>
          </div>
          <ColorThemeGallery
            value={settings.colorTheme ?? 'vscode'}
            dark={useIsDark()}
            onChange={(v) => void update({ colorTheme: v })}
          />
        </div>
      </Section>

      <Section id="terminal" title="终端" defaultOpen>
        <div className="grid grid-cols-2 gap-2.5">
          <Row label="字号">
            <input
              className="input w-16 text-center"
              type="number"
              min={8}
              max={28}
              step={0.5}
              value={settings.terminal.fontSize}
              onChange={(e) => setTerminal({ fontSize: Number(e.target.value) || 13 })}
            />
          </Row>
          <Row label="行高">
            <input
              className="input w-16 text-center"
              type="number"
              min={1}
              max={2.2}
              step={0.05}
              value={settings.terminal.lineHeight}
              onChange={(e) => setTerminal({ lineHeight: Number(e.target.value) || 1.35 })}
            />
          </Row>
        </div>
        <Row label="光标样式">
          <Segmented
            value={settings.terminal.cursorStyle}
            options={[
              { value: 'block' as const, label: '方块' },
              { value: 'underline' as const, label: '下划线' },
              { value: 'bar' as const, label: '竖线' }
            ]}
            onChange={(v) => setTerminal({ cursorStyle: v })}
          />
        </Row>
        <Row label="光标闪烁">
          <Toggle
            checked={settings.terminal.cursorBlink}
            onChange={(v) => setTerminal({ cursorBlink: v })}
          />
        </Row>
        <Row label="回滚缓冲行数" hint="终端可向上滚动的历史行数">
          <input
            className="input w-20 text-center"
            type="number"
            min={500}
            max={50000}
            step={500}
            value={settings.terminal.scrollback}
            onChange={(e) => setTerminal({ scrollback: Number(e.target.value) || 5000 })}
          />
        </Row>
      </Section>

      <Section id="behavior" title="行为" hint="延迟探测 / 自动录像 / 跟随终端 / 指纹校验 / 面板位置">
        <Row label="延迟探测" hint="每 5 秒向设备发送一次轻量探测，用于状态栏延迟显示">
          <Toggle
            checked={settings.latencyProbe}
            onChange={(v) => void update({ latencyProbe: v })}
          />
        </Row>
        <Row
          label="自动记录会话日志"
          hint="连接后的终端输入输出自动录制为 cast 文件（单会话上限 50MB），可在侧栏「日志」中回放与导出"
        >
          <Toggle checked={settings.autoLog} onChange={(v) => void update({ autoLog: v })} />
        </Row>
        <Row
          label="断线自动重连"
          hint="网络抖动断开后在后台按 1/2/4/8/16 秒退避重试，标签上显示进度；用户主动关闭标签则不重连"
        >
          <Toggle
            checked={settings.autoReconnect !== false}
            onChange={(v) => void update({ autoReconnect: v })}
          />
        </Row>
        {settings.autoReconnect !== false && (
          <Row label="最多重试次数" hint="用尽后停止并提示，可手动重连（1~20 次）">
            <input
              type="number"
              min={1}
              max={20}
              className="input h-7 w-16 px-2 text-xs"
              value={settings.autoReconnectMax ?? 5}
              onChange={(e) => {
                const n = Math.max(1, Math.min(20, Number(e.target.value) || 5))
                void update({ autoReconnectMax: n })
              }}
            />
          </Row>
        )}
        <Row
          label="跟随终端目录"
          hint="在终端里 cd 到某个目录时，侧栏「文件」面板自动跳到该位置；面板标题栏的链状图标也能一键开关"
        >
          <Toggle
            checked={settings.filesFollowTerminalCwd !== false}
            onChange={(v) => void update({ filesFollowTerminalCwd: v })}
          />
        </Row>
        <Row
          label="严格主机指纹校验"
          hint="首次连接记录指纹；指纹变化（如重装系统/换固件）时拒绝连接并告警"
        >
          <Toggle
            checked={settings.strictHostKey}
            onChange={(v) => void update({ strictHostKey: v })}
          />
        </Row>
        <Row
          label="会话恢复"
          hint="启动时自动恢复上次退出时打开的连接（最多 10 个）"
        >
          <Toggle
            checked={settings.restoreSessions ?? false}
            onChange={(v) => void update({ restoreSessions: v })}
          />
        </Row>
        {/* 原来这里有个「常用命令面板位置：右侧栏 / 底部横条」的开关。
            新外壳把命令面板收进侧栏，位置由活动栏决定，那个开关点了没有
            任何效果 —— 一个点了没反应的开关比没有这个开关更糟，所以删掉。 */}
      </Section>

      <Section
        id="layout"
        title="侧栏宽度"
        hint="拖动侧栏右侧的分隔条即可调整；双击分隔条恢复默认"
      >
        <div className="space-y-1.5">
          {KEYS.map((key) => {
            const spec = PANE_SPECS[key]
            const value = layoutSizes[key]
            return (
              <div key={key} className="flex items-center gap-2">
                <span className="w-24 shrink-0 text-xs text-ink-2">{PANE_LABEL[key]}</span>
                <input
                  className="input h-6 w-16 text-center font-mono text-2xs"
                  type="number"
                  min={spec.min}
                  max={spec.max}
                  step={2}
                  value={value}
                  onChange={(e) => setPane(key, Number(e.target.value) || spec.default)}
                />
                <span className="text-2xs text-ink-3">px</span>
                <span className="flex-1" />
                {/* 被拖窄到极限时给出提示，避免误以为卡住 */}
                <span className="shrink-0 text-2xs text-ink-3/70">
                  {spec.min}–{spec.max}
                </span>
                <button
                  className="btn-icon h-6 w-6 shrink-0"
                  title={`${PANE_LABEL[key]}恢复默认 ${spec.default}px`}
                  disabled={value === spec.default}
                  onClick={() => setPane(key, spec.default)}
                >
                  <RotateCcw size={11} />
                </button>
              </div>
            )
          })}
        </div>
        <button
          className="btn h-7 w-full justify-center text-2xs"
          onClick={() => {
            for (const key of KEYS) setPane(key, PANE_SPECS[key].default)
            useToastStore.getState().push({ kind: 'success', title: '栏宽已全部恢复默认' })
          }}
        >
          <RotateCcw size={11} />
          全部恢复默认
        </button>
      </Section>

      <Section id="shortcuts" title="快捷键" hint="点击键位进入录制">
        <ShortcutRows />
      </Section>

      <Section id="danger" title="危险命令关键词" hint={`${settings.dangerPatterns.length} 条`}>
        <div className="text-2xs leading-relaxed text-ink-3">
          每行一个关键词；任何命令文本命中这些关键词都会触发二次确认（与命令自身的危险标记相互独立）。
        </div>
        <textarea
          className="input scroll-thin h-24 resize-none selectable py-2 font-mono text-xs leading-relaxed"
          value={dangerText}
          onChange={(e) => setDangerText(e.target.value)}
          onBlur={commitDanger}
          spellCheck={false}
        />
      </Section>

      <Section
        id="knownhosts"
        title="已知主机指纹"
        hint={knownHosts.length > 0 ? `${knownHosts.length} 条` : undefined}
      >
        {knownHosts.length === 0 ? (
          <div className="text-2xs text-ink-3">暂无记录。连接过的设备会在严格校验开启时自动记录。</div>
        ) : (
          <>
            <div className="mb-2 flex items-center gap-1.5">
              <button
                className="btn h-6 px-2 text-2xs"
                disabled={probeBusy !== null}
                title="逐台探测设备当前的主机指纹，只列出真的发生变化的"
                onClick={() => void refreshAllFingerprints()}
              >
                {probeBusy === '*' ? (
                  <Loader2 size={11} className="animate-spin" />
                ) : (
                  <RefreshCw size={11} />
                )}
                检查全部更新
              </button>
              <span className="text-3xs leading-relaxed text-ink-3">
                设备重装或固件升级后指纹会变，连接被拒时在这里更新即可
              </span>
            </div>
            {fpError && (
              <div className="mb-2 selectable rounded border border-danger/30 bg-danger/5 px-2 py-1 text-2xs text-danger">
                {fpError}
              </div>
            )}
            <div className="space-y-1.5">
              {knownHosts.map((h) => {
                const key = `${h.host}:${h.port}`
                return (
                  <div
                    key={key}
                    className="flex items-center gap-2 rounded-md border border-edge-soft bg-panel px-2 py-1.5"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-mono text-2xs text-ink-2">
                        {h.host}:{h.port}
                      </div>
                      <div className="selectable truncate font-mono text-3xs text-ink-3">
                        {h.fingerprint}
                      </div>
                    </div>
                    <button
                      className="btn-icon h-6 w-6 shrink-0 hover:text-accent"
                      title="探测设备当前指纹并更新（会先展示旧值与新值对比）"
                      disabled={probeBusy !== null}
                      onClick={() => void updateFingerprint(h)}
                    >
                      {probeBusy === key ? (
                        <Loader2 size={12} className="animate-spin" />
                      ) : (
                        <Fingerprint size={12} />
                      )}
                    </button>
                    <button
                      className="btn-icon h-6 w-6 shrink-0 hover:text-danger"
                      title="删除该记录（设备重装后需要）"
                      onClick={() => {
                        void call(window.api.knownHosts.remove(key), {
                          silent: true
                        }).then(() => {
                          setKnownHosts((prev) =>
                            prev.filter((x) => !(x.host === h.host && x.port === h.port))
                          )
                          useToastStore
                            .getState()
                            .push({ kind: 'success', title: '已删除主机指纹记录' })
                        })
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </Section>

      {/* 指纹更新确认：必须让用户看到「旧 → 新」，不能静默信任 */}
      <ConfirmDialog
        open={fpUpdates.length > 0}
        title="更新主机指纹"
        confirmText="确认更新"
        message={
          <div className="space-y-2">
            <div className="text-2xs leading-relaxed text-ink-3">
              以下设备的指纹与本地记录不一致。如果设备确实重装过系统或升级过固件，可以确认更新；
              否则说明连接可能被中间人劫持，请先核实。
            </div>
            <div className="scroll-thin max-h-52 space-y-1.5 overflow-y-auto">
              {fpUpdates.map((u) => (
                <div
                  key={`${u.host}:${u.port}`}
                  className="rounded border border-edge-soft bg-app/60 px-2 py-1.5"
                >
                  <div className="font-mono text-2xs text-ink-2">
                    {u.host}:{u.port}
                  </div>
                  <div className="selectable break-all font-mono text-3xs text-danger/90">
                    - {u.from}
                  </div>
                  <div className="selectable break-all font-mono text-3xs text-success">
                    + {u.to}
                  </div>
                </div>
              ))}
            </div>
          </div>
        }
        onCancel={() => setFpUpdates([])}
        onConfirm={() => void applyFingerprintUpdates()}
      />

      <Section
        id="errorlog"
        title="错误日志"
        hint="运行期异常自动收集，可搜索、复制、导出给同事排查"
      >
        <ErrorLogSection />
      </Section>

      <Section id="update" title="软件更新" hint="检查更新 / 自动下载 / 更新代理">
        <UpdateSection />
      </Section>

      <Section id="datadir" title="数据目录">
        <div className="flex items-center gap-2 text-2xs text-ink-3">
          <FolderOpen size={12} className="shrink-0" />
          <span className="selectable break-all font-mono">{paths?.dataDir ?? '加载中…'}</span>
        </div>
        <div className="text-2xs leading-relaxed text-ink-3">
          连接、常用命令、历史、设置均以 JSON 保存在该目录；密码 / 私钥口令单独加密存储（系统凭据保护），永不落明文。
        </div>
      </Section>
    </Modal>
  )
}
