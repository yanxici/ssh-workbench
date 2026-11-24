import type * as React from 'react'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent
} from 'react'
import {
  BellOff,
  BellRing,
  Columns2,
  Rows2,
  X,
  Plus,
  Pencil,
  XCircle,
  CircleSlash2,
  Loader2,
  RefreshCw,
  SquarePlus
} from 'lucide-react'
import type { ConnStatus } from '@shared/types'
import { useSessionStore } from '@/stores/sessionStore'
import { useUiStore } from '@/stores/uiStore'
import { cn } from '@/lib/utils'
import { ContextMenu, useContextMenu, type MenuEntry } from '@/components/ui'
import { isImeComposing } from '@/lib/ime'
import { useSettingsStore } from '@/stores/settingsStore'
import { useI18n } from '@/i18n'
import { takeFlashTarget, toggleMuteConnection, watchFlash, clearFlashTarget } from '@/lib/taskNotify'
import { isMuted, normalizeNotifyPrefs } from '@/lib/notifyPlan'
import { useSplitStore } from '@/stores/splitStore'
import { isNestedPane } from '@/lib/paneRegistry'
import { MAX_PANES, countLeaves, leafIds } from '@/lib/paneTree'

/** 「刚跑完」的标签高亮持续时间。0.6s 的动画 + 一次停顿，太短会看不见 */
const FLASH_MS = 1200

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
 * 视觉约定（中性面板底上的标签）：
 * - 标签**满高**（撑满 36px 标题栏），不做上下留边。留边时标签像悬在
 *   标题栏中间的一张小卡片，上下两道缝把标题栏切成三条横向色带，看着「不满格」。
 * - 满高之后不再需要圆角：四角圆角在满高状态下会顶到窗口上沿、并和下方内容
 *   边缘撞在一起。改直边 + 1px 面板缝，读起来就是一条真正的标签条。
 * - 激活标签 = 画布底（bg-app）+ 正文色，并在**顶部**画一条 2px 品牌色指示线，
 *   与下方工作区连成一片 —— 这是「标签属于内容」的唯一表达；
 *   未激活 = 透明底 + ink-3，hover 只提亮到面板的 hover 层。
 * - 全程不用 transform / box-shadow：标题栏本身视觉重心已经很高，再加位移会晃。
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
export function TabBar(): React.JSX.Element {
  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeId)
  const setActive = useSessionStore((s) => s.setActive)
  const setTitle = useSessionStore((s) => s.setTitle)
  const reorder = useSessionStore((s) => s.reorder)
  const reconnect = useSessionStore((s) => s.reconnect)
  const openTerminal = useSessionStore((s) => s.openTerminal)
  const openConnEditor = useUiStore((s) => s.openConnEditor)
  /*
   * 旧实现每个标签各 find 一次，标签一多就是 O(n²)；
   * 且每次会话状态变化都要重扫。改成一次建索引 + 复用。
   */
  /*
   * 标签硬上限（阶段 3，Q11=a）。
   *
   * 会话标签此前无上限：开 40 个 SSH 会话就挂 40 个标签节点，每个都带闭包、
   * 拖拽监听与状态订阅，且标签条本身横向滚动 —— 这是「打开很多会话后 UI 变钝」
   * 的来源之一。20 是「同时比对多台现场设备」的常见上限。
   *
   * 超出的会话不会被「丢掉」：它们仍在侧栏连接列表里，只是不占标签位；
   * 下方会提示还有几个未显示，避免「标签凭空消失」的困惑。
   */
  const MAX_TABS = 20
  /*
   * 标签 = 顶层的那些会话。分屏格不单独成为标签 —— 它们本来就在同一屏里，
   * 各占一个标签位会让标签条多出「同一连接开了三个」的错觉。
   * 过滤放在 slice 之前，否则 20 个上限会被隐藏的格子白白吃掉名额。
   */
  const tabs = sessions.filter((x) => !isNestedPane(x.id))
  const hiddenTabs = Math.max(0, tabs.length - MAX_TABS)

  const sessionById = useMemo(() => new Map(sessions.map((x) => [x.id, x])), [sessions])
  const reconnectById = useSessionStore((s) => s.reconnectById)
  const unreadById = useSessionStore((s) => s.unreadById)
  const { t } = useI18n()
  const activeSession = activeId ? sessionById.get(activeId) : undefined

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

  /*
   * 任务完成后在对应标签上闪一下。
   *
   * 为什么不是「高亮直到用户看一眼」：那会变成一个需要手动消除的状态，
   * 而用户点通知回来时已经盯着那个标签了 —— 只需要一次提示性闪烁，
   * 而且它必须自己消失，否则这个标记会永远挂在那里失去意义。
   */
  const [flashId, setFlashId] = useState<string | null>(null)
  useEffect(() => {
    let timer: number | null = null
    const sync = (): void => {
      const t = takeFlashTarget()
      if (!t) return
      clearFlashTarget()
      setFlashId(t.sessionId)
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        setFlashId(null)
        timer = null
      }, FLASH_MS)
    }
    const off = watchFlash(sync)
    // 挂载时先把遗留请求吃掉：通知点击可能发生在组件挂载之前
    sync()
    return () => {
      off()
      if (timer !== null) window.clearTimeout(timer)
    }
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

  /*
   * 静音按**连接**记，不按会话记。
   *
   * 用户在"这台设备又在刷日志"的时刻点静音，意图是"这台机器别烦我"，
   * 而会话 id 每次启动都会变（重连也会换），按会话记等于下次启动就失效。
   * 代价是同一连接开多个标签会一起静音 —— 这恰好也是用户期望的。
   */
  const notifyPrefs = normalizeNotifyPrefs(useSettingsStore((s) => s.settings.taskNotify))
  const muted = (connectionId?: string): boolean => isMuted(notifyPrefs.mutedConnectionIds, connectionId)

  const trees = useSplitStore((s) => s.trees)
  const splitPane = useSplitStore((s) => s.splitPane)
  const closePane = useSplitStore((s) => s.closePane)
  const closeOtherTabsOf = useSplitStore((s) => s.closeOtherTabs)
  /** 该标签的分屏格数；1 = 没分屏 */
  const paneCount = (id: string): number => (trees[id] ? countLeaves(trees[id]) : 1)
  /** 右键的目标可能是一个嵌套格（从终端右键进来的场景）；分屏一律按标签主人算 */
  const ownerOf = (id: string): string => {
    for (const [ownerId, node] of Object.entries(trees)) {
      if (leafIds(node).includes(id)) return ownerId
    }
    return id
  }

  const menuItems = (id: string): MenuEntry[] => {
    const s = sessionById.get(id)
    const canReconnect = s && (s.status === 'disconnected' || s.status === 'error')
    const connId = s?.connectionId
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
      /*
       * 文案随状态切换，不用勾选态：MenuEntry 没有 checked 字段，而
       * 「本连接不弹通知」/「恢复本连接通知」两句本身就说明了当前状态，
       * 比一个需要眼睛去对齐的小方框更快读懂。
       */
      {
        label: muted(connId) ? '恢复本连接通知' : '本连接不弹通知',
        icon: muted(connId) ? <BellRing size={12} /> : <BellOff size={12} />,
        disabled: !connId || !notifyPrefs.enabled,
        onClick: () => {
          if (!connId) return
          toggleMuteConnection(connId, !muted(connId))
        }
      },
      /*
       * 分屏入口放在标签右键里，不做「把标签拖到边缘」。
       * 拖拽已经有「调整标签顺序」这一层含义，再加落点分屏要在
       * 拖拽悬停时判断落在左/右/上/下哪个 1/4 区，误触率很高；
       * 右键两步点到，行为可预期。
       */
      {
        label: '向右分屏',
        icon: <Columns2 size={12} />,
        disabled: s?.status !== 'connected' || paneCount(ownerOf(id)) >= MAX_PANES,
        onClick: () => splitPane(id, 'row')
      },
      {
        label: '向下分屏',
        icon: <Rows2 size={12} />,
        disabled: s?.status !== 'connected' || paneCount(ownerOf(id)) >= MAX_PANES,
        onClick: () => splitPane(id, 'col')
      },
      /*
       * 「关闭」按分屏状态分两种语义：
       *   有分屏时 = 只关这一格（标签留着，剩下几格还能用）；
       *   没分屏时 = 关标签。
       * 不用两个菜单项 —— 用户看到的那块只有一个「x」，语义跟着它走最自然。
       */
      {
        label: paneCount(ownerOf(id)) > 1 ? '关闭此分屏' : '关闭',
        icon: <XCircle size={12} />,
        onClick: () => closePane(id)
      },
      {
        label: '关闭其他标签',
        icon: <CircleSlash2 size={12} />,
        disabled: paneCount(ownerOf(id)) < 1 || tabs.length <= 1,
        onClick: () => closeOtherTabsOf(ownerOf(id))
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
        {tabs.slice(0, MAX_TABS).map((s, i) => {
          // 该标签的自动重连进度（有就说明正在自动恢复）
          const rc = reconnectById[s.id]
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
                  : 'bg-transparent text-ink-3 hover:bg-hover/70 hover:text-ink-2',
                dropTarget === i && dragIndex !== null && dragIndex !== i && 'bg-hover',
                // 闪一下：品牌色底光 0.6s 内淡出，非激活标签也看得见
                flashId === s.id && 'animate-flash-ok'
              )}
              onMouseDown={(e) => {
                if (e.button === 0) setActive(s.id)
              }}
              onDoubleClick={() => startRename(s.id, s.title)}
              onContextMenu={(e) => openMenu(e, s.id)}
              title={editingId === s.id ? undefined : s.target}
            >
              {/*
                激活指示线：2px 品牌色画在标签顶部，紧贴窗口上沿。
                用绝对定位而不是 border-top —— border 会占掉 2px 高度，标签
                就不再是「满高」，另外几个标签会跟着上移 2px。
              */}
              {isActive && (
                <span className="pointer-events-none absolute inset-x-0 top-0 h-0.5 bg-brand" />
              )}

              <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[s.status])} />

              {editingId === s.id ? (
                <input
                  autoFocus
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={(e) => {
                    if (isImeComposing(e)) return
                    if (e.key === 'Enter') commitRename()
                    if (e.key === 'Escape') setEditingId(null)
                  }}
                  className="h-5 min-w-0 flex-1 rounded border border-accent/60 bg-app px-1 text-xs text-ink outline-none"
                />
              ) : (
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
              )}

              {/**
               * 后台标签的未读圆点：静态实心点，不做脉冲动画 —— 十几个标签同时跳会一直触发合成。
               * 只在标签非激活时出现，切回即被 setActive 清掉。
               */}
              {!isActive && unreadById[s.id] === true && (
                <span
                  title={t('tab.unread')}
                  aria-label={t('tab.unread')}
                  className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                />
              )}

              {/*
                * 自动重连进行中：显示脉冲点而不是重连按钮，
                * 让用户知道「正在自己恢复，别急着手动点」。
                */}
              {rc && (s.status === 'disconnected' || s.status === 'error') ? (
                <span
                  className={cn(
                    'flex h-4 shrink-0 items-center justify-center',
                    isActive ? 'text-warning' : 'text-ink-3'
                  )}
                  title={rc.message}
                >
                  <Loader2 size={11} className="animate-spin" />
                </span>
              ) : (
                (s.status === 'disconnected' || s.status === 'error') && (
                  <button
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors duration-150',
                      isActive ? 'text-warning hover:bg-hover' : 'text-ink-3 hover:bg-hover hover:text-ink'
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
                )
              )}

              <button
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded transition-[color,background-color,opacity] duration-150',
                  isActive
                    ? 'text-ink-3 hover:bg-hover hover:text-ink'
                    : /*
                       * 未激活标签的关闭按钮常驻会把整条标签栏点亮成一排 ×。
                       * 靠透明度淡入而不是挂载/卸载：hover 穿进穿出时不会闪，
                       * 也保留了 focus-visible 路径（键盘用户不需要 hover 也能看到它）。
                       * 只用 opacity，不用 transform —— TabBar 有几何禁令（见文件头注释）。
                       */
                      'text-ink-3 opacity-0 group-hover:opacity-100 hover:bg-hover hover:text-ink focus-visible:opacity-100'
                )}
                title={paneCount(s.id) > 1 ? '关闭此分屏' : '关闭标签'}
                onClick={(e) => {
                  e.stopPropagation()
                  /*
                   * 走 closePane 而不是 sessionStore.close：
                   * 有分屏时它只摘掉这一格把树收缩，标签整体还在；
                   * 没分屏时它内部就是 close(id)，语义完全一致。
                   */
                  closePane(s.id)
                }}
              >
                <X size={12} />
              </button>
              {hiddenTabs > 0 && (
          <div
            className="flex shrink-0 items-center px-2 text-2xs text-ink-3"
            title={`另有 ${hiddenTabs} 个会话未显示标签（超过上限 ${MAX_TABS}），可在左侧连接列表切换`}
          >
            +{hiddenTabs}
          </div>
        )}
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