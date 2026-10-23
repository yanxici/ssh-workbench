import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { X, Plus, Pencil, XCircle, CircleSlash2, RefreshCw, SquarePlus } from 'lucide-react'
import type { ConnStatus } from '@shared/types'
import { useSessionStore } from '@/stores/sessionStore'
import { useUiStore } from '@/stores/uiStore'
import { cn } from '@/lib/utils'
import { ContextMenu, useContextMenu, type MenuEntry } from '@/components/ui'

const STATUS_DOT: Record<ConnStatus, string> = {
  connecting: 'bg-warning animate-pulse-soft',
  connected: 'bg-success',
  disconnected: 'bg-ink-3',
  error: 'bg-danger'
}

/** 横向滚动条滑块最小宽度（px）。太窄会点不中，24 是能用鼠标拖住的下限。 */
const MIN_THUMB = 24

/**
 * 顶部标签栏（位于 TitleBar 里，同时是窗口拖拽区）。
 * 支持：切换、关闭、双击重命名、右键菜单、拖拽排序、横向滚动。
 *
 * 视觉约定（品牌绿底上的白色标签）：
 * - 标签**满高**（撑满 44px 标题栏），不做上下留边。留 6px 绿边时标签像悬在
 *   绿条中间的一张小卡片，上下两道绿边把标题栏切成三条横向色带，看着「不满格」。
 * - 满高之后不再需要圆角：四角圆角在满高状态下会顶到窗口上沿、并和下方内容
 *   边缘撞在一起。改直边 + 1px 绿色缝，读起来就是一条真正的标签条。
 * - 激活标签 = 纯白底 + 深色文字；未激活 = 半透明白底 + 半透明白字，hover 提亮。
 * - 全程不用 transform / box-shadow：绿底本身视觉重心已经很高，再加位移会晃。
 *
 * 滚动条为什么不能用（历史 bug，2026-10 修复）：
 * 1) 原来滚动容器本身就挂着 `drag-region`（`-webkit-app-region: drag`）。Electron 把
 *    拖拽区内的鼠标事件交给窗口管理器，滚动条的 thumb 收不到 mousedown，于是「看得见、
 *    拖不动、点了也没反应」。→ 拖拽区挪到外层包装，滚动容器改 `no-drag`。
 * 2) 原生横向滚动条要占掉 8px 高度（非 overlay），44px 的标题栏只剩 36px 给标签，
 *    满高约定直接破功。→ 隐藏原生滚动条，自绘一条 5px 的悬浮滑块，只在溢出时出现，
 *    并且可以真正拖动。
 * 3) 只有 wheel 事件按 deltaY 映射成横向位移，鼠标滚轮才能在标签条上滚动（触控板
 *    原生就支持横向，两种都给）。
 */
export function TabBar(): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeId)
  const setActive = useSessionStore((s) => s.setActive)
  const close = useSessionStore((s) => s.close)
  const closeOthers = useSessionStore((s) => s.closeOthers)
  const setTitle = useSessionStore((s) => s.setTitle)
  const reorder = useSessionStore((s) => s.reorder)
  const reconnect = useSessionStore((s) => s.reconnect)
  const openTerminal = useSessionStore((s) => s.openTerminal)
  const openConnEditor = useUiStore((s) => s.openConnEditor)
  const activeSession = sessions.find((x) => x.id === activeId)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  const { menu, openMenu, closeMenu } = useContextMenu<string>()

  /* ---------------- 横向滚动：原生条隐藏，改为自绘滑块 ---------------- */
  const stripRef = useRef<HTMLDivElement | null>(null)
  const [scroll, setScroll] = useState({ left: 0, width: 0, view: 0 })

  const syncScroll = useCallback((): void => {
    const el = stripRef.current
    if (!el) return
    setScroll({ left: el.scrollLeft, width: el.clientWidth, view: el.scrollWidth })
  }, [])

  /* 标签增减、窗口缩放都会改变溢出状态，两个都监听 */
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    syncScroll()
    el.addEventListener('scroll', syncScroll, { passive: true })
    const ro = new ResizeObserver(syncScroll)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', syncScroll)
      ro.disconnect()
    }
  }, [syncScroll, sessions.length])

  /*
   * 滚轮 → 横向滚动。
   * 必须用原生监听器：React 的 onWheel 走的是非 passive 绑定的上层委托，
   * 在部分 Chromium 版本上与滚动链路抢时序，preventDefault 会失效并连带页面抖动。
   */
  useEffect(() => {
    const el = stripRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      const max = el.scrollWidth - el.clientWidth
      if (max <= 0) return
      const delta = Math.abs(e.deltaY) > Math.abs(e.deltaX) ? e.deltaY : e.deltaX
      if (!delta) return
      const next = Math.min(max, Math.max(0, el.scrollLeft + delta))
      if (next === el.scrollLeft) return
      e.preventDefault()
      el.scrollLeft = next
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const maxScroll = Math.max(0, scroll.view - scroll.width)
  const overflow = maxScroll > 1
  const trackW = scroll.width
  const thumbW = overflow
    ? Math.max(MIN_THUMB, Math.round((scroll.width / scroll.view) * trackW))
    : 0
  const thumbX = overflow && trackW > thumbW ? (scroll.left / maxScroll) * (trackW - thumbW) : 0

  /* 拖 thumb：按位移比例换算成 scrollLeft，同时把 thumb 的拖拽与窗口拖拽隔离 */
  const startThumbDrag = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const el = stripRef.current
    if (!el || !overflow) return
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startLeft = el.scrollLeft
    const travel = trackW - thumbW
    if (travel <= 0) return
    const onMove = (ev: MouseEvent): void => {
      const ratio = (ev.clientX - startX) / travel
      el.scrollLeft = Math.min(maxScroll, Math.max(0, startLeft + ratio * maxScroll))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  /* 点击轨道空白处：翻页 */
  const onTrackDown = (e: ReactMouseEvent<HTMLDivElement>): void => {
    const el = stripRef.current
    if (!el || !overflow) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - rect.left
    if (x >= thumbX && x <= thumbX + thumbW) return
    el.scrollLeft = Math.min(maxScroll, Math.max(0, el.scrollLeft + (x < thumbX ? -1 : 1) * trackW * 0.8))
  }

  const startRename = (id: string, current: string): void => {
    setEditingId(id)
    setEditText(current)
  }

  const commitRename = (): void => {
    if (editingId && editText.trim()) setTitle(editingId, editText.trim())
    setEditingId(null)
  }

  const menuItems = (id: string): MenuEntry[] => {
    const s = sessions.find((x) => x.id === id)
    const canReconnect = s && (s.status === 'disconnected' || s.status === 'error')
    return [
      ...(canReconnect
        ? [{ label: '重新连接', icon: <RefreshCw size={12} />, onClick: () => reconnect(id) }]
        : []),
      {
        label: '新建终端（复用此连接）',
        icon: <SquarePlus size={12} />,
        disabled: s?.status !== 'connected',
        onClick: () => openTerminal(id)
      },
      {
        label: '重命名',
        icon: <Pencil size={12} />,
        onClick: () => {
          if (s) startRename(id, s.title)
        }
      },
      { label: '关闭', icon: <XCircle size={12} />, onClick: () => close(id) },
      {
        label: '关闭其他标签',
        icon: <CircleSlash2 size={12} />,
        disabled: sessions.length <= 1,
        onClick: () => closeOthers(id)
      }
    ]
  }

  return (
    /*
     * `h-full` 不能省。
     * 外层 `<div className="min-w-0 flex-1 self-stretch overflow-hidden">` 是块级元素，
     * 它的高度靠父级 align-items:stretch 撑到 44px；但块级子元素的 height 默认是 auto，
     * 于是这个 flex 容器只有「内容高度」（≈28px），标签上下各留一条绿边 ——
     * 就是用户说的「连接在标题绿栏里不满格」。之前注释写着「满高」，实际没生效。
     */
    <div className="drag-region relative flex h-full min-w-0 flex-1 items-stretch gap-px">
      {/*
       * 滚动容器：`no-drag` 是关键。挂在 drag-region 里时原生滚动条收不到鼠标事件，
       * 引擎把这里的按下动作当成拖窗口 —— 这就是「滚动条无法使用」的直接原因。
       * 不用 `flex-1`：标签不满一行时容器应当只有内容宽度，剩下的空白留给右边
       * 那个 `flex-1` 的 span 继续当窗口拖拽区；溢出时靠 min-w-0 + shrink 收窄。
       */}
      <div
        ref={stripRef}
        data-tab-strip=""
        className="tabs-scroll no-drag flex h-full min-w-0 shrink items-stretch gap-px"
      >
        {sessions.map((s, i) => {
          const isActive = s.id === activeId
          return (
            <div
              key={s.id}
              data-tab-id={s.id}
              draggable={editingId !== s.id}
              onDragStart={(e) => {
                setDragIndex(i)
                e.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(e) => {
                e.preventDefault()
                setDropTarget(i)
              }}
              onDragLeave={() => setDropTarget((t) => (t === i ? null : t))}
              onDrop={(e) => {
                e.preventDefault()
                if (dragIndex !== null && dragIndex !== i) reorder(dragIndex, i)
                setDragIndex(null)
                setDropTarget(null)
              }}
              onDragEnd={() => {
                setDragIndex(null)
                setDropTarget(null)
              }}
              className={cn(
                'no-drag group relative flex min-w-[128px] max-w-[220px] shrink-0',
                'cursor-default select-none items-center gap-1.5 px-2.5 text-xs',
                'transition-colors duration-150',
                isActive
                  ? 'bg-app text-ink'
                  : 'bg-on-brand/15 text-on-brand/85 hover:bg-on-brand/25 hover:text-on-brand',
                dropTarget === i && dragIndex !== null && dragIndex !== i && 'bg-on-brand/35'
              )}
              onMouseDown={(e) => {
                if (e.button === 0) setActive(s.id)
              }}
              onDoubleClick={() => startRename(s.id, s.title)}
              onContextMenu={(e) => openMenu(e, s.id)}
              title={editingId === s.id ? undefined : `${s.username}@${s.host}`}
            >
              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[s.status])} />

              {editingId === s.id ? (
                <input
                  autoFocus
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  className="h-5 min-w-0 flex-1 rounded border border-accent/60 bg-app px-1 text-xs text-ink outline-none"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
              )}

              {(s.status === 'disconnected' || s.status === 'error') && (
                <button
                  className={cn(
                    'flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors duration-150',
                    isActive ? 'text-warning hover:bg-hover' : 'text-on-brand hover:bg-on-brand/20'
                  )}
                  title="重新连接"
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation()
                    reconnect(s.id)
                  }}
                >
                  <RefreshCw size={11} />
                </button>
              )}

              <button
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors duration-150',
                  isActive
                    ? 'text-ink-3 hover:bg-hover hover:text-ink'
                    : 'text-on-brand/70 hover:bg-on-brand/20 hover:text-on-brand'
                )}
                title="关闭标签"
                onClick={(e) => {
                  e.stopPropagation()
                  close(s.id)
                }}
              >
                <X size={12} />
              </button>
            </div>
          )
        })}
      </div>

      {/* 在当前会话上新建终端（复用 SSH 连接，免重新登录） */}
      {activeSession && (
        <button
          className="no-drag titlebar-btn ml-0.5 h-6 w-6 shrink-0 self-center"
          title="在当前会话新建终端 (Ctrl+Shift+T)"
          disabled={activeSession.status !== 'connected'}
          onClick={() => openTerminal(activeSession.id)}
        >
          <SquarePlus size={14} />
        </button>
      )}

      {/* 新建连接 */}
      <button
        className="no-drag titlebar-btn ml-0.5 h-6 w-6 shrink-0 self-center"
        title="新建连接 (Ctrl+N)"
        onClick={() => openConnEditor(null)}
      >
        <Plus size={14} />
      </button>

      {/* 标签右侧的空白仍是拖拽区，方便拖动窗口 */}
      <span className="min-w-[16px] flex-1" />

      {/*
       * 自绘横向滚动条：只在溢出时出现，5px 高贴在标题栏最下沿。
       * 用 absolute 定位，不参与 flex 布局，因此不会压缩标签高度（原生条会吃掉 8px）。
       * 宽度锁在滚动容器自身宽度上 —— 右侧还有「新建终端 / 新建连接」按钮，
       * 轨道铺满整条标题栏会让滑块与标签的位移对不上。
       */}
      {overflow && (
        <div
          className="tabs-scrollbar no-drag"
          style={{ width: trackW }}
          onMouseDown={onTrackDown}
          title="拖动或点击可横向滚动标签"
        >
          <div
            className="tabs-scrollbar-thumb"
            style={{ width: thumbW, left: thumbX }}
            onMouseDown={startThumbDrag}
          />
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={closeMenu} />
      )}
    </div>
  )
}
