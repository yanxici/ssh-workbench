import { useEffect, useState, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Keyboard,
  Monitor,
  Moon,
  RotateCcw,
  Sun,
  Trash2
} from 'lucide-react'
import type { ShortcutAction, ThemeMode } from '@shared/types'
import { SHORTCUT_ACTIONS, resolveShortcuts } from '@/lib/shortcuts'
import { useSettingsStore } from '@/stores/settingsStore'
import { useToastStore } from '@/stores/toastStore'
import { call } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { Modal, Toggle } from '@/components/ui'

interface KnownHost {
  host: string
  port: number
  fingerprint: string
  addedAt: number
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

/** 快捷键设置：点击后按下新组合键即可录制；Esc 取消、Backspace 清空 */
function ShortcutRows(): JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const current = resolveShortcuts(settings.shortcuts)
  const [recording, setRecording] = useState<ShortcutAction | null>(null)

  const commit = (action: ShortcutAction, combo: string | undefined): void => {
    const next = { ...settings.shortcuts }
    if (combo === undefined) delete next[action]
    else next[action] = combo
    void update({ shortcuts: next })
    setRecording(null)
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
              {isDefault && <div className="text-[10px] text-ink-3/70">使用默认值</div>}
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
      <div className="pt-1 text-[10px] leading-relaxed text-ink-3/70">
        提示：终端内「搜索 / 复制 / 粘贴」的组合键（Ctrl+F / Ctrl+Shift+C / Ctrl+Shift+V）在此配置后，
        在终端聚焦时同样生效；避免与系统/浏览器快捷键冲突。
      </div>
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

  useEffect(() => {
    if (!open) return
    void call(window.api.knownHosts.list(), { silent: true }).then((l) => setKnownHosts(l ?? []))
    void call(window.api.settings.paths(), { silent: true }).then((p) => setPaths(p))
    setDangerText(useSettingsStore.getState().settings.dangerPatterns.join('\n'))
  }, [open])

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

  return (
    <Modal open={open} title="设置" onClose={onClose} width="max-w-xl" footer={
      <button className="btn" onClick={onClose}>完成</button>
    }>
      <Section id="appearance" title="外观" defaultOpen>
        <Row label="主题" hint="暗色为默认，跟随系统会实时响应系统深浅色">
          <Segmented
            value={settings.theme}
            options={THEME_OPTIONS}
            onChange={(v) => void update({ theme: v })}
          />
        </Row>
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

      <Section id="behavior" title="行为" hint="延迟探测 / 自动录像 / 指纹校验 / 面板位置">
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
          label="严格主机指纹校验"
          hint="首次连接记录指纹；指纹变化（如重装系统/换固件）时拒绝连接并告警"
        >
          <Toggle
            checked={settings.strictHostKey}
            onChange={(v) => void update({ strictHostKey: v })}
          />
        </Row>
        <Row label="常用命令面板位置" hint="右侧栏 / 底部横条（分组横向排列）">
          <Segmented
            value={settings.commandPanelPosition === 'bottom' ? 'bottom' : 'right'}
            options={[
              { value: 'right' as const, label: '右侧栏' },
              { value: 'bottom' as const, label: '底部' }
            ]}
            onChange={(v) => void update({ commandPanelPosition: v })}
          />
        </Row>
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

      <Section id="knownhosts" title="已知主机指纹" hint={knownHosts.length > 0 ? `${knownHosts.length} 条` : undefined}>
        {knownHosts.length === 0 ? (
          <div className="text-2xs text-ink-3">暂无记录。连接过的设备会在严格校验开启时自动记录。</div>
        ) : (
          <div className="space-y-1.5">
            {knownHosts.map((h) => (
              <div
                key={`${h.host}:${h.port}`}
                className="flex items-center gap-2 rounded-md border border-edge-soft bg-panel px-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-2xs text-ink-2">
                    {h.host}:{h.port}
                  </div>
                  <div className="selectable truncate font-mono text-[10px] text-ink-3">
                    {h.fingerprint}
                  </div>
                </div>
                <button
                  className="btn-icon h-6 w-6 shrink-0 hover:text-danger"
                  title="删除该记录（设备重装后需要）"
                  onClick={() => {
                    void call(window.api.knownHosts.remove(`${h.host}:${h.port}`), {
                      silent: true
                    }).then(() => {
                      setKnownHosts((prev) =>
                        prev.filter((x) => !(x.host === h.host && x.port === h.port))
                      )
                      useToastStore.getState().push({ kind: 'success', title: '已删除主机指纹记录' })
                    })
                  }}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
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
