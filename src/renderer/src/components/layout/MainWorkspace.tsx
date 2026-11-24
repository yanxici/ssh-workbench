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
  type PaneNode
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
      aria-label="调整分屏比例"
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
 *  一格标签的内容
 * ------------------------------------------------------------------ */

function PaneGrid({
  ownerId,
  node,
  sessions,
  activeId
}: {
  ownerId: string
  node: PaneNode
  sessions: SessionUi[]
  activeId: string | null
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null)
  const { t } = useI18n()
  const { rects, dividers } = layoutPaneTree(node)
  const multi = rects.size > 1
  const byId = new Map(sessions.map((s) => [s.id, s]))
  const syncOn = useSplitStore((s) => s.syncByTab[ownerId] === true)
  const toggleSync = useSplitStore((s) => s.toggleSync)

  /*
   * 同步输入条只在多窗格时出现，且只占一条 28px —— 单窗格标签什么都不多。
   *
   * 开启态必须足够刺眼：之后在这屏里敲的每一个字都会进到所有已连接的窗格，
   * 包括那台正在跑 rm -rf 的机器。一条安静的灰色小开关不够，用琥珀色整条铺满
   * 再加一个实心点，扫一眼就知道自己在「同时指挥多台」。
   */
  const bar = multi ? (
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
          'flex h-5 shrink-0 items-center gap-1 rounded-sm border px-1.5 text-2xs transition-colors duration-150',
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
  ) : null

  return (
    /*
     * 同步条走普通流式布局，不盖在格子上。
     * 用 absolute 压在顶上会正好吃掉每格终端 28px 的顶部（第一条输出、
     * 以及贴在顶部的 tmux/htop 标题行），看起来像终端被裁了一条。
     * 柱状布局里格子高度自动减去条高，layoutPaneTree 的百分比仍然按
     * 剩余区域算 —— 分屏比例不受影响。
     */
    <div className="absolute inset-0 flex flex-col">
      {bar}
      {/**
       * 这一层才是分屏容器：布局比例、分隔条热区都按它的 rect 算。
       * 条本身不参与，所以「有同步条时格子被压扁」不会影响分隔条命中。
       */}
      <div ref={ref} className="relative min-h-0 flex-1">
        {[...rects].map(([sessionId, r]) => {
          const s = byId.get(sessionId)
          // 会话已被关掉但树还没 reconcile：先留空，下一次 reconcile 会把它摘掉
          if (!s) return null
          const focused = sessionId === activeId
          return (
            <div
              key={sessionId}
              data-pane-id={sessionId}
              className="absolute p-[2px]"
              style={{ left: `${r.x}%`, top: `${r.y}%`, width: `${r.w}%`, height: `${r.h}%` }}
            >
              <div
                className={cn(
                  'relative h-full w-full overflow-hidden rounded',
                  // 焦点格描边：分屏之后「命令会落到哪一格」必须是看一眼就知道的
                  multi && focused && 'ring-1 ring-accent/45',
                  multi && !focused && 'ring-1 ring-edge/70'
                )}
              >
                <TerminalView session={s} active={focused} />
              </div>
            </div>
          )
        })}
        {dividers.map((d) => (
          <SplitDivider key={d.id} divider={d} ownerId={ownerId} containerRef={ref} />
        ))}
      </div>
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
  /*
   * 标签 = 顶层的那些会话。嵌套格不单独成为标签，否则标签栏里会出现
   * 「同一连接开了 3 个标签」的错觉 —— 它们本来就在同一屏里。
   */
  const tabs = sessions.filter((s) => !isNestedPane(s.id))

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
        tabs.map((s) => {
          const tree: PaneNode = trees[s.id] ?? { type: 'leaf', sessionId: s.id }
          /*
           * 显隐判据是「焦点是否在这棵树里」，不是「焦点是否等于标签 id」——
           * 分屏后焦点会落在非主人格上，按后者判断整棵树会瞬间消失。
           */
          const visible = activeId !== null && leafIds(tree).includes(activeId)
          return (
            <div
              key={s.id}
              className="absolute inset-0"
              style={{ display: visible ? 'block' : 'none' }}
            >
              <PaneGrid ownerId={s.id} node={tree} sessions={sessions} activeId={activeId} />
            </div>
          )
        })
      )}

      {/* ZMODEM 传输确认与进度（跟随当前活动会话） */}
      <ZmodemOverlay />
    </main>
  )
}
