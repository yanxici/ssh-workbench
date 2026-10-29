import { useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 设置面板的 UI 地基：可折叠分组 / 一行设置 / 分段控件。
 *
 * 从 SettingsPanel.tsx 拆出来，是因为拆分后的各个 *Section.tsx 都要用它们；
 * 留在原文件里会让 6 个 section 反向依赖 SettingsPanel（循环 import）。
 */

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
export function Section({
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

export function Row({
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
export function Segmented<T extends string>({
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
