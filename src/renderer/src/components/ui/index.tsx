import type * as React from 'react'
import {
  Fragment,
  useCallback,
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
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'
import { useToastStore } from '@/stores/toastStore'
import { isImeComposing } from '@/lib/ime'
import { useOverlayEscape } from '@/lib/overlayKeys'
import { useExitTransition } from '@/lib/useExitTransition'
import { useI18n } from '@/i18n'

/* ------------------------------------------------------------------ *
 *  Modal
 * ------------------------------------------------------------------ */

export { BrandMark } from './BrandMark'

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width,
  bodyClassName
}: {
  open: boolean
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: string
  bodyClassName?: string
}): React.JSX.Element | null {
  const { t } = useI18n()
  const { mounted, exiting } = useExitTransition(open, 120)
  useOverlayEscape(open, onClose)

  if (!mounted) return null

  return (
    <div
      className={cn('modal-overlay', exiting && 'modal-overlay-exit')}
      onMouseDown={(e) => {
        if (!exiting && e.target === e.currentTarget) onClose()
      }}
    >
      <div className={cn('modal', width ?? 'max-w-lg', exiting && 'modal-exit')}>
        <div className="modal-header">
          <div className="modal-title">{title}</div>
          <button className="btn-icon h-6 w-6" onClick={onClose} title={t('common.ui.close')}>
            <X size={13} />
          </button>
        </div>
        <div className={bodyClassName ?? 'modal-body scroll-thin'}>{children}</div>
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
}): React.JSX.Element {
  return (
    <div className={cn('field min-w-0', className)}>
      <div className="field-label">
        {label}
        {hint && <span className="ml-1.5 font-normal text-ink-3/80">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

/**
 * 并排两个 Field：标签行与控件行分别对齐（subgrid）。
 *
 * 两栏的 hint 长度不同时，一边标签折两行、一边一行，控件就会上下错位。
 * 用 FieldRow 包起来后，两栏共享「标签行高 = 较高者」，控件永远落在同一条线上。
 * 必须放在外层 grid-cols-2 里（自身占满两列）。
 */
export function FieldRow({
  children,
  className
}: {
  children: ReactNode
  className?: string
}): React.JSX.Element {
  return <div className={cn('field-grid col-span-2', className)}>{children}</div>
}

/**
 * 分段选择器（单选按钮组）。
 *
 * 固定 h-7，所以文字绝不允许换行：truncate（自带 overflow-hidden + ellipsis + whitespace-nowrap），
 * 放不下时显示省略号并用 title 补全 —— 宁可截断也不能撑破按钮。
 * 真放不下时应该给它更宽的容器（col-span-2），而不是让文字折行。
 */
export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  disabled,
  className
}: {
  options: ReadonlyArray<{ value: T; label: string; title?: string }>
  value: T
  onChange: (next: T) => void
  disabled?: boolean
  className?: string
}): React.JSX.Element {
  return (
    <div className={cn('flex gap-1', className)} role="radiogroup">
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={String(opt.value)}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            title={opt.title ?? opt.label}
            onClick={() => onChange(opt.value)}
            className={cn(
              'h-7 min-w-0 flex-1 truncate rounded-md border px-2 text-xs transition-colors',
              active
                ? 'border-accent/60 bg-accent/15 text-accent'
                : 'border-edge bg-raised text-ink-3 hover:text-ink-2',
              disabled && 'cursor-not-allowed opacity-60'
            )}
          >
            {opt.label}
          </button>
        )
      })}
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
}): React.JSX.Element {
  const { t } = useI18n()
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
          title={t('common.ui.expandOptions')}
          className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-sm text-ink-3 transition-colors hover:text-ink"
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
              {value.trim()
                ? t('common.ui.pressEnterToUse', { value: value.trim() })
                : t('common.ui.noOptions')}
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
}): React.JSX.Element {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'relative inline-block h-5 w-9 shrink-0 rounded-full border p-0 align-middle transition-colors duration-150',
        checked ? 'border-accent/60 bg-accent/90' : 'border-edge bg-edge/70 dark:bg-raised',
        disabled && 'pointer-events-none opacity-45'
      )}
    >
      {/*
       * 轨道 20×36（内径 18×34），旋钮 16×16 留 1px 四周内距，
       * 行程恰好 16px（translate-x-4），走 GPU 合成通道避免重排。
       */}
      <span
        className={cn(
          'absolute left-px top-px h-4 w-4 rounded-full bg-white shadow-sm transition-transform duration-150',
          checked ? 'translate-x-4' : 'translate-x-0'
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
  confirmText,
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
}): React.JSX.Element | null {
  const { t } = useI18n()
  const { mounted, exiting } = useExitTransition(open, 120)
  useOverlayEscape(open, onCancel)

  if (!mounted) return null

  return (
    <div
      className={cn('modal-overlay items-center pt-0', exiting && 'modal-overlay-exit')}
      style={{ zIndex: 55 }}
      onMouseDown={(e) => {
        if (!exiting && e.target === e.currentTarget) onCancel()
      }}
    >
      <div className={cn('modal max-w-sm', exiting && 'modal-exit')}>
        <div className="modal-header">
          <div className="modal-title">{title}</div>
        </div>
        <div className="modal-body text-xs leading-relaxed text-ink-2">{message}</div>
        <div className="modal-footer">
          <button className="btn" onClick={onCancel}>
            {t('common.ui.cancel')}
          </button>
          <button
            className={cn('btn', danger ? 'btn-danger' : 'btn-primary')}
            onClick={onConfirm}
          >
            {confirmText ?? t('common.ui.confirm')}
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
  confirmText,
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
}): React.JSX.Element | null {
  const { t } = useI18n()
  const [value, setValue] = useState(defaultValue)

  useEffect(() => {
    if (open) setValue(defaultValue)
  }, [open, defaultValue])

  const { mounted, exiting } = useExitTransition(open, 120)

  useOverlayEscape(open, onCancel)

  if (!mounted) return null

  const submit = (): void => {
    if (!value.trim()) return
    onConfirm(value.trim())
  }

  return (
    <div
      className={cn('modal-overlay items-center pt-0', exiting && 'modal-overlay-exit')}
      style={{ zIndex: 57 }}
      onMouseDown={(e) => {
        if (!exiting && e.target === e.currentTarget) onCancel()
      }}
    >
      <div className={cn('modal max-w-sm', exiting && 'modal-exit')}>
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
            {t('common.ui.cancel')}
          </button>
          <button className="btn btn-primary" onClick={submit}>
            {confirmText ?? t('common.ui.ok')}
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
}): React.JSX.Element {
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
}): React.JSX.Element {
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
    window.addEventListener('mousedown', close)
    window.addEventListener('blur', close)
    return () => {
      window.removeEventListener('mousedown', close)
      window.removeEventListener('blur', close)
    }
  }, [onClose])
  // Esc 走统一弹层栈：菜单开着时只关菜单，不会顺手把下层弹窗也关掉
  useOverlayEscape(true, onClose)

  /*
   * 必须 portal 到 body，直接原地渲染是"菜单能弹出但点了没反应"的根因。
   *
   * 这个组件的绝大多数调用点都在标题栏里（标签右键、连接右键、终端右键……），
   * 而标题栏挂着 `-webkit-app-region: drag`。Chromium 会把 drag 区内的鼠标消息
   * 交给窗口管理器做拖窗，子元素只有显式声明 `no-drag` 才收得到。`position: fixed`
   * 只改绘制位置、不改 DOM 归属 —— 菜单在视觉上飞出了标题栏，DOM 上仍是 drag 区的
   * 后代，于是每一颗按钮的 mouseup 都被吞掉：hover 有反馈，点击零效果。
   * （TabBar.tsx 顶部的历史注释记录过同一个坑：滚动条挂在 drag-region 里拖不动。）
   *
   * portal 到 body 之后，整棵菜单彻底脱离任何 drag 子树；再叠一层 `no-drag` 是给
   * 万一将来有调用点把 body 自身设成 drag 的兜底，代价为零。
   */
  return createPortal(
    <div
      ref={ref}
      className="menu no-drag"
      style={{ left: pos.x, top: pos.y }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => (
        <Fragment key={i}>
          {item.separatorBefore && <div className="menu-sep" />}
          <button
            type="button"
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
    </div>,
    document.body
  )
}

/** 右键菜单状态管理 */
export function useContextMenu<T>(): {
  menu: { x: number; y: number; target: T } | null
  openMenu: (e: MouseEvent, target: T) => void
  closeMenu: () => void
} {
  const [menu, setMenu] = useState<{ x: number; y: number; target: T } | null>(null)
  /*
   * 回调必须定住身份：菜单状态每天都挂在 effect 的依赖里（换会话要 closeMenu），
   * 每次都新建函数会让那个 effect 每渲染一次就重跑一遍，等于把状态反复重置。
   */
  const openMenu = useCallback((e: MouseEvent, target: T) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, target })
  }, [])
  const closeMenu = useCallback(() => setMenu(null), [])
  return { menu, openMenu, closeMenu }
}

/* ------------------------------------------------------------------ *
 *  Toast
 * ------------------------------------------------------------------ */

const TOAST_ICON: Record<string, { icon: React.JSX.Element; cls: string }> = {
  success: { icon: <CheckCircle2 size={14} />, cls: 'text-success' },
  warning: { icon: <AlertTriangle size={14} />, cls: 'text-warning' },
  error: { icon: <XCircle size={14} />, cls: 'text-danger' },
  info: { icon: <Info size={14} />, cls: 'text-accent' }
}

export function ToastHost(): React.JSX.Element {
  const toasts = useToastStore((s) => s.toasts)
  const dismiss = useToastStore((s) => s.dismiss)

  return (
    // 右上角通知：避开左下传输进度浮层与状态栏，避免长任务进行时被通知遮挡
    <div className="pointer-events-none fixed right-3 top-[calc(var(--size-titlebar)+12px)] z-[70] flex w-[340px] flex-col gap-2">
      {toasts.map((t) => {
        const cfg = TOAST_ICON[t.kind] ?? TOAST_ICON.info
        return (
          <div
            key={t.id}
            className={cn(
              'rounded-lg border border-edge bg-panel p-3 shadow-pop',
              t.leaving ? 'pointer-events-none animate-slide-out' : 'pointer-events-auto animate-slide-up'
            )}
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
