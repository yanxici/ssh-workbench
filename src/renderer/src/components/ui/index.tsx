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
  CheckCircle2,
  Info,
  X,
  XCircle
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { useToastStore } from '@/stores/toastStore'

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
          'absolute top-[1px] h-[14px] w-[14px] rounded-full bg-white shadow-sm transition-all duration-150',
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
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <div className="mb-1 flex h-14 w-14 items-center justify-center rounded-2xl border border-edge-soft bg-panel text-ink-3">
        {icon}
      </div>
      <div className="text-[13px] font-medium text-ink-2">{title}</div>
      {hint && <div className="max-w-[320px] text-xs leading-relaxed text-ink-3">{hint}</div>}
      {action && <div className="mt-2">{action}</div>}
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
    <div className="pointer-events-none fixed bottom-10 right-3 z-[70] flex w-[340px] flex-col gap-2">
      {toasts.map((t) => {
        const cfg = TOAST_ICON[t.kind] ?? TOAST_ICON.info
        return (
          <div
            key={t.id}
            className="pointer-events-auto animate-slide-up rounded-lg border border-edge bg-panel/95 p-3 shadow-pop backdrop-blur-xl"
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
