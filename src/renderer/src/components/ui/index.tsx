import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode
} from 'react'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronDown,
  Info,
  X,
  XCircle
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToastStore } from '@/stores/toastStore'
import { isImeComposing } from '@/lib/ime'

/* ------------------------------------------------------------------ *
 *  Modal
 * ------------------------------------------------------------------ */

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width
}: {
  open: boolean
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: string
}): JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={cn('modal', width ?? 'max-w-lg')}>
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button className="btn-icon h-6 w-6" onClick={onClose} title="关闭">
            <X size={13} />
          </button>
        </div>
        <div className="modal-body scroll-thin">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  表单零件
 * ------------------------------------------------------------------ */

export function Field({
  label,
  hint,
  children,
  className
}: {
  label: string
  hint?: string
  children: ReactNode
  className?: string
}): JSX.Element {
  return (
    <div className={className}>
      <div className="field-label">
        {label}
        {hint && <span className="ml-1.5 font-normal text-ink-3/80">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

/**
 * 可输入的组合框：输入框 + 直接画在 React 里的候选列表。
 *
 * 为什么不用 <datalist>：原生 datalist 会拿输入框的**当前值**做子串过滤，
 * 而这类字段（分组、标签）几乎总是预填了旧值（如「默认」）。用户点开下拉时
 * 看到的只剩与「默认」匹配的 1 条，视觉上就是「选不了其他分组」。
 * 浏览器不给任何控制过滤行为的开关，所以自带一层列表：
 * - 未输入（只是聚焦/点箭头）→ 全量候选
 * - 已输入 → 子串过滤，且允许输入全新值
 */
export function Combobox({
  value,
  onChange,
  options,
  placeholder,
  className,
  inputClassName
}: {
  value: string
  onChange: (next: string) => void
  options: string[]
  placeholder?: string
  className?: string
  inputClassName?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  /** null = 用户还没打字，显示全量；非 null = 当前输入串，按它过滤 */
  const [typed, setTyped] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  /** 浮层用 fixed 定位：modal 祖先带 overflow-hidden，absolute 会被裁掉 */
  const [rect, setRect] = useState<{ left: number; top: number; width: number } | null>(null)
  const boxRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  const unique = options.filter((o, i) => o && options.indexOf(o) === i)
  const keyword = (typed ?? '').trim().toLowerCase()
  const shown = keyword === '' ? unique : unique.filter((o) => o.toLowerCase().includes(keyword))

  const measure = (): void => {
    const el = boxRef.current?.querySelector('input')
    if (!el) return
    const r = el.getBoundingClientRect()
    // 下方空间不足时向上翻
    const spaceBelow = window.innerHeight - r.bottom
    const top = spaceBelow < 200 ? Math.max(8, r.top - 8 - 180) : r.bottom + 3
    setRect({ left: r.left, top, width: r.width })
  }

  // 点外部关闭
  useEffect(() => {
    if (!open) return
    const onDown = (e: globalThis.MouseEvent): void => {
      const t = e.target as Node
      if (!boxRef.current?.contains(t) && !listRef.current?.contains(t)) setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])

  // 打开时跟随滚动/缩放重新定位
  useEffect(() => {
    if (!open) return
    measure()
    const onScroll = (): void => measure()
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open])

  // 打开时把高亮项滚进可视区
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.children[active] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const commit = (next: string): void => {
    onChange(next)
    setTyped(null)
    setOpen(false)
    setActive(0)
  }

  const openList = (): void => {
    setTyped(null)
    measure()
    setOpen(true)
    const idx = unique.indexOf(value)
    setActive(idx >= 0 ? idx : 0)
  }

  return (
    <div ref={boxRef} className={cn('relative', className)}>
      <div className="relative">
        <input
          className={cn('input selectable pr-7', inputClassName)}
          value={value}
          placeholder={placeholder}
          autoComplete="off"
          onChange={(e) => {
            onChange(e.target.value)
            setTyped(e.target.value)
            setOpen(true)
            measure()
            setActive(0)
          }}
          onFocus={openList}
          onClick={() => {
            if (!open) openList()
          }}
          onKeyDown={(e) => {
            // 输入法组合态：Enter/↑↓ 属于候选词选择，不能当列表导航
            if (isImeComposing(e)) return
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              if (!open) openList()
              else setActive((i) => Math.min(i + 1, shown.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              if (open && shown[active] !== undefined) {
                e.preventDefault()
                commit(shown[active])
              }
            } else if (e.key === 'Escape' && open) {
              e.preventDefault()
              e.stopPropagation()
              setOpen(false)
            }
          }}
        />
        <button
          type="button"
          tabIndex={-1}
          title="展开候选"
          className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-ink-3 transition-colors hover:text-ink"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => (open ? setOpen(false) : openList())}
        >
          <ChevronDown size={12} />
        </button>
      </div>

      {open && rect && (
        <div
          ref={listRef}
          className="scroll-thin fixed z-[60] max-h-44 overflow-y-auto rounded-md border border-edge bg-panel p-1 shadow-pop"
          style={{ left: rect.left, top: rect.top, width: rect.width }}
        >
          {shown.length === 0 ? (
            <div className="px-2 py-1.5 text-2xs text-ink-3">
              {value.trim() ? `回车使用「${value.trim()}」` : '暂无候选'}
            </div>
          ) : (
            shown.map((o, i) => (
              <button
                key={o}
                type="button"
                className={cn(
                  'flex w-full cursor-default items-center gap-1.5 rounded px-2 py-1 text-left text-xs transition-colors',
                  i === active ? 'bg-hover text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink'
                )}
                onMouseEnter={() => setActive(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => commit(o)}
              >
                <span className="min-w-0 flex-1 truncate">{o}</span>
                {o === value && <Check size={11} className="shrink-0 text-accent" />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  disabled
}: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
}): JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-block h-[18px] w-[32px] shrink-0 rounded-full border p-0 align-middle transition-colors duration-150',
        checked ? 'border-accent/60 bg-accent/90' : 'border-edge bg-raised',
        disabled && 'pointer-events-none opacity-45'
      )}
    >
      {/* 用 left 定位而非纯 translate：轨道 32px = 2 边框 + 28 内容，
          14px 旋钮的合法区间是 left 0~14px，取 1px / 14px 保证两端都不越界。 */}
      <span
        className={cn(
          'absolute top-[1px] h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-[left] duration-150',
          checked ? 'left-[14px]' : 'left-[1px]'
        )}
      />
    </button>
  )
}

/* ------------------------------------------------------------------ *
 *  确认对话框
 * ------------------------------------------------------------------ */

export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = '确认',
  danger,
  onConfirm,
  onCancel
}: {
  open: boolean
  title: string
  message: ReactNode
  confirmText?: string
  danger?: boolean
  onConfirm: () => void
  onCancel: () => void
}): JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  return (
    <div
      className="modal-overlay items-center pt-0"
      style={{ zIndex: 55 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="modal max-w-sm">
        <div className="modal-header">
          <div className="modal-title">{title}</div>
        </div>
        <div className="modal-body text-xs leading-relaxed text-ink-2">{message}</div>
        <div className="modal-footer">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button
            className={cn('btn', danger ? 'btn-danger' : 'btn-primary')}
            onClick={onConfirm}
          >
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  单行输入弹窗（新建文件夹 / 重命名 / 权限等场景复用）
 * ------------------------------------------------------------------ */

export function PromptDialog({
  open,
  title,
  label,
  defaultValue = '',
  placeholder,
  confirmText = '确定',
  onConfirm,
  onCancel
}: {
  open: boolean
  title: string
  label: string
  defaultValue?: string
  placeholder?: string
  confirmText?: string
  onConfirm: (value: string) => void
  onCancel: () => void
}): JSX.Element | null {
  const [value, setValue] = useState(defaultValue)

  useEffect(() => {
    if (open) setValue(defaultValue)
  }, [open, defaultValue])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  if (!open) return null

  const submit = (): void => {
    if (!value.trim()) return
    onConfirm(value.trim())
  }

  return (
    <div
      className="modal-overlay items-center pt-0"
      style={{ zIndex: 57 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="modal max-w-sm">
        <div className="modal-header">
          <div className="modal-title">{title}</div>
        </div>
        <div className="modal-body">
          <Field label={label}>
            <input
              autoFocus
              className="input selectable"
              value={value}
              placeholder={placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (isImeComposing(e)) return
                if (e.key === 'Enter') submit()
              }}
            />
          </Field>
        </div>
        <div className="modal-footer">
          <button className="btn" onClick={onCancel}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit}>
            {confirmText}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  空状态
 * ------------------------------------------------------------------ */

export function EmptyState({
  icon,
  title,
  hint,
  action
}: {
  icon: ReactNode
  title: string
  hint?: string
  action?: ReactNode
}): JSX.Element {
  /*
   * 空态观感取舍：
   * 原来图标外面套了一个 56px 圆角描边方块（border + bg-panel），远看像个
   * 加载骨架占位，而且描边色与周围边框叠在一起，整块显得「有一团脏东西」。
   * 现在把图标本身降到 45% 透明直接放出去，靠留白和字号层级建立秩序 ——
   * 空态是「没有内容」的状态，不该比有内容时更抢眼。
   */
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <span className="mb-1 text-ink-3/45">{icon}</span>
      <div className="text-sm font-medium text-ink-2">{title}</div>
      {hint && <div className="max-w-[340px] text-xs leading-relaxed text-ink-3">{hint}</div>}
      {action && <div className="mt-1.5">{action}</div>}
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  右键菜单
 * ------------------------------------------------------------------ */

export interface MenuEntry {
  label: string
  icon?: ReactNode
  danger?: boolean
  disabled?: boolean
  separatorBefore?: boolean
  onClick: () => void
}

export function ContextMenu({
  x,
  y,
  items,
  onClose
}: {
  x: number
  y: number
  items: MenuEntry[]
  onClose: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ x, y })

  // 越界修正：贴边时向内翻转
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    let nx = x
    let ny = y
    if (nx + rect.width > window.innerWidth - 8) nx = Math.max(8, window.innerWidth - rect.width - 8)
    if (ny + rect.height > window.innerHeight - 8)
      ny = Math.max(8, window.innerHeight - rect.height - 8)
    setPos({ x: nx, y: ny })
  }, [x, y])

  useEffect(() => {
    const close = (): void => onClose()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <div
      ref={ref}
      className="menu"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <Fragment key={i}>
          {item.separatorBefore && <div className="menu-sep" />}
          <button
            className={cn('menu-item', item.danger && 'menu-item-danger')}
            disabled={item.disabled}
            onClick={() => {
              onClose()
              item.onClick()
            }}
          >
            <span className="flex h-3.5 w-3.5 items-center justify-center text-ink-3">
              {item.icon}
            </span>
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  )
}

/** 右键菜单状态管理 */
export function useContextMenu<T>(): {
  menu: { x: number; y: number; target: T } | null
  openMenu: (e: MouseEvent, target: T) => void
  closeMenu: () => void
} {
  const [menu, setMenu] = useState<{ x: number; y: number; target: T } | null>(null)
  return {
    menu,
    openMenu: (e, target) => {
      e.preventDefault()
      e.stopPropagation()
      setMenu({ x: e.clientX, y: e.clientY, target })
    },
    closeMenu: () => setMenu(null)
  }
}

/* ------------------------------------------------------------------ *
 *  Toast
 * ------------------------------------------------------------------ */

const TOAST_ICON: Record<string, { icon: JSX.Element; cls: string }> = {
  success: { icon: <CheckCircle2 size={14} />, cls: 'text-success' },
  warning: { icon: <AlertTriangle size={14} />, cls: 'text-warning' },
  error: { icon: <XCircle size={14} />, cls: 'text-danger' },
  info: { icon: <Info size={14} />, cls: 'text-accent' }
}

export function ToastHost(): JSX.Element {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  return (
    // 右上角通知：避开左下传输进度浮层与状态栏，避免长任务进行时被通知遮挡
    <div className="pointer-events-none fixed right-3 top-[46px] z-[70] flex w-[340px] flex-col gap-2">
      {toasts.map((t) => {
        const cfg = TOAST_ICON[t.kind] ?? TOAST_ICON.info
        return (
          <div
            key={t.id}
            className="pointer-events-auto animate-slide-up rounded-lg border border-edge bg-panel p-3 shadow-pop"
          >
            <div className="flex items-start gap-2.5">
              <span className={cn('mt-0.5 shrink-0', cfg.cls)}>{cfg.icon}</span>
              <div className="min-w-0 flex-1">
                <div className="text-xs font-medium leading-snug text-ink">{t.title}</div>
                {t.detail && (
                  <div className="mt-1 selectable break-all text-2xs leading-relaxed text-ink-3">
                    {t.detail}
                  </div>
                )}
              </div>
              <button className="btn-icon h-5 w-5 shrink-0" onClick={() => dismiss(t.id)}>
                <X size={11} />
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}
