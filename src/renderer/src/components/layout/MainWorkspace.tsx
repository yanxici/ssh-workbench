import type * as React from 'react'
import { useRef, type DragEvent } from 'react'
import type { SessionUi } from '@/stores/sessionStore'
import { cn } from '@/lib/utils'
import { TerminalView } from '@/components/terminal/TerminalView'
import { ZmodemOverlay } from '@/components/terminal/ZmodemOverlay'
import { useSplitStore } from '@/stores/splitStore'
import { WelcomeQuickLaunch } from './WelcomeQuickLaunch'
import { isNestedPane } from '@/lib/paneRegistry'
import { useI18n } from '@/i18n'
import {
  layoutPaneTree,
  leafIds,
  type PaneDivider,
  type PaneNode,
  type PaneRect
} from '@/lib/paneTree'

/**
 * 主工作区：终端 / 编辑器的容器。
 *
 * 性能红线（必须守住，改代码时别踩）：
 * - 容器及其所有父级**不许** `backdrop-filter`。xterm.js 每帧都在 canvas 上重绘，
 *   上层一旦有毛玻璃，合成器要额外做一次离屏采样，输出流快的时候直接掉帧；
 *   在 Windows 上还会出现「关掉浮层后整窗发虚」的残留。
 * - 容器**不许**有会持续变化的 CSS 动画背景。纯色 `bg-app` 是最省的做法。
 * - 所有会话保持挂载、只切 `display` —— 这样切标签不会重建 xterm 实例，
 *   回滚缓冲、滚动位置、正在跑的进程全都保留。
 *
 * 分屏是「一个标签 = 一棵 pane 树」：标签只切一次 display，标签内部按树
 * 算出每格的百分比矩形。所有格子仍然常挂，只是切 display —— 同一条红线。
 */

/* ------------------------------------------------------------------ *
 *  分隔条
 * ------------------------------------------------------------------ */

/**
 * 分屏分隔条。
 *
 * 拖拽时只写内存里的 ratio（splitStore.setSplitRatio 不落盘），
 * 松手才 setDragging(false) 触发一次 fit + 一次落盘。
 * 拖拽期间 TerminalView 的 fit 被 draggingSplit 旁路掉 —— 否则每帧重排整屏，
 * 画面抖得没法看（这一条踩过）。
 */
function SplitDivider({
  divider,
  ownerId,
  containerRef
}: {
  divider: PaneDivider
  ownerId: string
  containerRef: React.RefObject<HTMLDivElement | null>
}): React.JSX.Element {
  const { t } = useI18n()
  const row = divider.dir === 'row'

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = containerRef.current
    if (!el) return
    const box = el.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return

    const store = useSplitStore.getState()
    store.setDragging(true)
    const basePct = row ? divider.splitRect.x : divider.splitRect.y
    const spanPct = row ? divider.splitRect.w : divider.splitRect.h

    const move = (ev: PointerEvent): void => {
      /*
       * 换算必须用**该 split 自己的矩形**，不能用整个容器：
       * 嵌套时分隔条只管其中一小块，按容器换算会把指针位移放大一倍，
       * 拖起来像「飞出去」。
       */
      const pct = ((row ? ev.clientX - box.left : ev.clientY - box.top) / (row ? box.width : box.height)) * 100
      const ratio = spanPct > 0 ? (pct - basePct) / spanPct : 0.5
      store.setSplitRatio(ownerId, divider.id, ratio)
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
      // 松手：解除旁路 + refitTick+1 + 落盘
      useSplitStore.getState().setDragging(false)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
  }

  return (
    <div
      role="separator"
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-label={t('common.workspace.splitDivider')}
      className={cn(
        'group/sd absolute z-20',
        row ? 'w-[6px] cursor-col-resize' : 'h-[6px] cursor-row-resize'
      )}
      style={{
        // 热区 6px 盖在分割线上，用负偏移让视觉中线对齐计算出的边界
        left: `${divider.rect.x}%`,
        top: `${divider.rect.y}%`,
        width: row ? 6 : `${divider.rect.w}%`,
        height: row ? `${divider.rect.h}%` : 6,
        marginLeft: row ? -3 : 0,
        marginTop: row ? 0 : -3
      }}
      onPointerDown={onPointerDown}
    >
      <span
        className={cn(
          'pointer-events-none absolute bg-edge transition-colors duration-150 group-hover/sd:bg-accent/70',
          row
            ? 'inset-y-0 left-1/2 w-px -translate-x-1/2'
            : 'inset-x-0 top-1/2 h-px -translate-y-1/2'
        )}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  同步输入条
 * ------------------------------------------------------------------ */

/**
 * 同步输入条只在多窗格时出现，且只占一条 28px —— 单窗格标签什么都不多。
 *
 * 开启态必须足够刺眼：之后在这屏里敲的每一个字都会进到所有已连接的窗格，
 * 包括那台正在跑 rm -rf 的机器。一条安静的灰色小开关不够，用琥珀色整条铺满
 * 再加一个实心点，扫一眼就知道自己在「同时指挥多台」。
 */
function SyncBar({ ownerId, syncOn }: { ownerId: string; syncOn: boolean }): React.JSX.Element {
  const { t } = useI18n()
  const toggleSync = useSplitStore((s) => s.toggleSync)
  return (
    <div
      className={cn(
        'z-30 flex h-7 shrink-0 items-center gap-2 border-b px-2.5',
        syncOn
          ? 'border-warning/50 bg-warning/15 text-warning'
          : 'border-edge-soft bg-panel/80 text-ink-3'
      )}
    >
      <button
        type="button"
        onClick={() => toggleSync(ownerId)}
        title={syncOn ? t('workspace.sync.on') : t('workspace.sync.off')}
        className={cn(
          'flex h-5 shrink-0 items-center gap-1 rounded border px-1.5 text-2xs transition-colors duration-150',
          syncOn
            ? 'border-warning/60 bg-warning/20 text-warning hover:bg-warning/30'
            : 'border-edge bg-raised text-ink-3 hover:text-ink-2'
        )}
      >
        <span
          className={cn('h-1.5 w-1.5 rounded-full', syncOn ? 'bg-warning' : 'bg-ink-3/60')}
        />
        {syncOn ? t('workspace.sync.active') : t('workspace.sync.label')}
      </button>
      <span className="min-w-0 flex-1 truncate text-2xs">
        {syncOn ? t('workspace.sync.on') : t('workspace.sync.off')}
      </span>
    </div>
  )
}

export function MainWorkspace({
  sessions,
  activeId,
  dragOver,
  onDragOver,
  onDragLeave,
  onDrop,
  onNewConnection
}: {
  sessions: SessionUi[]
  activeId: string | null
  dragOver: boolean
  onDragOver: (e: DragEvent<HTMLDivElement>) => void
  onDragLeave: (e: DragEvent<HTMLDivElement>) => void
  onDrop: (e: DragEvent<HTMLDivElement>) => void
  onNewConnection: () => void
}): React.JSX.Element {
  const trees = useSplitStore((s) => s.trees)
  const syncByTab = useSplitStore((s) => s.syncByTab)
  const stageRef = useRef<HTMLDivElement | null>(null)
  /*
   * 标签 = 顶层的那些会话。嵌套格不单独成为标签，否则标签栏里会出现
   * 「同一连接开了 3 个标签」的错觉 —— 它们本来就在同一屏里。
   */
  const tabs = sessions.filter((s) => !isNestedPane(s.id))
  const byId = new Map(sessions.map((s) => [s.id, s]))

  /*
   * 摊平成「所有窗格」的单一列表。
   *
   * 为什么不能按标签分别包一层 key={ownerId} 渲染：owner 会在「关掉原来的主窗格、
   * 树根迁给兄弟格」时从 s1 变成 s2。那个 key 一变，React 认为旧子树整体被替换，
   * 于是卸载并销毁 s2/s3 里**还活着**的 <TerminalView> —— xterm 实例、回滚缓冲、
   * ZMODEM、搜索态全没了，只剩一块刚建好的空白终端。
   * 摊平之后每个终端在 React 树里的父路径固定为「舞台 > 自己的 div」，
   * key 永远是自己的 sessionId，活多久实例就活多久；关哪个标签、怎么迁根都不影响。
   */
  const panes: {
    sessionId: string
    rect: PaneRect
    visible: boolean
    focused: boolean
    multi: boolean
  }[] = []
  let activeOwnerId: string | null = null
  let activeTree: PaneNode | null = null
  for (const s of tabs) {
    const tree: PaneNode = trees[s.id] ?? { type: 'leaf', sessionId: s.id }
    /*
     * 显隐判据是「焦点是否在这棵树里」，不是「焦点是否等于标签 id」——
     * 分屏后焦点会落在非主人格上，按后者判断整棵树会瞬间消失。
     */
    const visible = activeId !== null && leafIds(tree).includes(activeId)
    if (visible) {
      activeOwnerId = s.id
      activeTree = tree
    }
    const { rects } = layoutPaneTree(tree)
    const multi = rects.size > 1
    for (const [sessionId, rect] of rects) {
      // 会话已被关掉但树还没 reconcile：先留空，下一次 reconcile 会把它摘掉
      if (!byId.has(sessionId)) continue
      panes.push({ sessionId, rect, visible, focused: sessionId === activeId, multi })
    }
  }
  /*
   * 分隔条与同步条只按**当前可见的那个标签**渲染。
   * 它们本来就只服务一屏，摊平后同一个舞台里再叠上隐藏标签的分隔条，
   * 会变成一屏两套热区互相抢指针。
   */
  const activeLayout = activeTree ? layoutPaneTree(activeTree) : null
  const activeMulti = activeLayout !== null && activeLayout.rects.size > 1
  const syncOn = activeOwnerId !== null && syncByTab[activeOwnerId] === true

  return (
    <main
      className={cn(
        'relative min-w-0 flex-1 overflow-hidden bg-app',
        // 拖拽命令到终端时的落点提示：用 inset ring 而不是改变布局
        dragOver && 'ring-2 ring-inset ring-accent/50'
      )}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {tabs.length === 0 ? (
        /*
         * 空态不再是一句「双击左侧连接」的提示语，而是一个能直接动手的启动页：
         * 上半部给四个动作入口，下半部给最近连接。用户盯着的是一块空白区，
         * 他要的是「怎么让它有东西」，所以这里铺的是按钮和可点的行，不是文案。
         */
        <WelcomeQuickLaunch onNewConnection={onNewConnection} />
      ) : (
        /*
         * 同步条走普通流式布局，不盖在格子上。
         * 用 absolute 压在顶上会正好吃掉每格终端 28px 的顶部（第一条输出、
         * 以及贴在顶部的 tmux/htop 标题行），看起来像终端被裁了一条。
         * 柱状布局里格子高度自动减去条高，layoutPaneTree 的百分比仍然按
         * 剩余区域算 —— 分屏比例不受影响。
         */
        <div className="absolute inset-0 flex flex-col">
          {activeOwnerId !== null && activeMulti ? (
            <SyncBar ownerId={activeOwnerId} syncOn={syncOn} />
          ) : null}
          {/**
           * 这一层才是分屏容器：布局比例、分隔条热区都按它的 rect 算。
           * 条本身不参与，所以「有同步条时格子被压扁」不会影响分隔条命中。
           */}
          <div ref={stageRef} className="relative min-h-0 flex-1">
            {panes.map((p) => {
              const s = byId.get(p.sessionId)
              if (!s) return null
              return (
                <div
                  key={p.sessionId}
                  data-pane-id={p.sessionId}
                  className="absolute p-[2px]"
                  style={{
                    display: p.visible ? 'block' : 'none',
                    left: `${p.rect.x}%`,
                    top: `${p.rect.y}%`,
                    width: `${p.rect.w}%`,
                    height: `${p.rect.h}%`
                  }}
                >
                  <div
                    className={cn(
                      'relative h-full w-full overflow-hidden rounded',
                      // 焦点格描边：分屏之后「命令会落到哪一格」必须是看一眼就知道的
                      p.multi && p.focused && 'ring-1 ring-accent/45',
                      p.multi && !p.focused && 'ring-1 ring-edge/70'
                    )}
                  >
                    <TerminalView session={s} active={p.focused} />
                  </div>
                </div>
              )
            })}
            {activeOwnerId !== null && activeLayout
              ? activeLayout.dividers.map((d) => (
                  <SplitDivider key={d.id} divider={d} ownerId={activeOwnerId} containerRef={stageRef} />
                ))
              : null}
          </div>
        </div>
      )}

      {/*
        * ZMODEM 传输确认与进度（跟随当前活动会话）
        */}
      <ZmodemOverlay />
    </main>
  )
}
