import { useEffect, useRef, useState } from 'react'
import type { Connection, ConnectionInput } from '@shared/types'
import { useLayoutStore, type ActivityView } from '@/stores/layoutStore'
import { useSessionById, useSessionStore } from '@/stores/sessionStore'
import { ConnectionSidebar } from '@/components/connections/ConnectionSidebar'
import { HistoryPanel } from '@/components/panels/HistoryPanel'
import { SessionLogsPanel } from '@/components/panels/SessionLogsPanel'
import { TunnelPanel } from '@/components/panels/TunnelPanel'
import { FileExplorer } from '@/components/files/FileExplorer'

/**
 * 左侧导航面板（默认 280px，可折叠、可拖拽改宽）。
 *
 * 它承载 ActivityBar 选中的视图 —— 这一点很关键：如果每个视图各占一栏，
 * 屏幕上会同时出现连接、文件、历史、日志四条竖栏，横向空间瞬间被吃掉。
 * 收成一个「活动栏 + 一个侧栏」之后，280px 足够放下内容，主工作区拿到
 * 剩下的全部宽度，终端列数明显变多。
 *
 * **常用命令不在这里**：命令栏是窗口右侧常驻的一块（见 `CommandRail`）。
 * 执行命令与「看主机名 / 看文件」是并行的高频动作，塞进同一个切换位
 * 会互相挤走 —— 想边看连接边点命令就得来回切两次。
 *
 * 宽度由父组件传入（`layoutStore` 之外的地方拖拽改宽后写入 settings.layout），
 * 这里不自己持有状态 —— 否则拖拽时的实时值和落盘值会出现两份真相。
 *
 * ---- 为什么不是「切一个就卸载一个」----
 * 卸载会让面板内部状态全部丢失：连接列表滚到「37 號」再切去文件、切回来又
 * 回到顶部；文件树展开的目录同样全没。用户抱怨的「不方便」有一半来自这种
 * 「回来了却不是刚才那样」。
 *
 * 所以改成「首次访问才挂载，之后常驻，靠 display 切换」：
 * - 没访问过的面板不挂载 —— 不付初始渲染成本（连接 2929 条不是小数目，
 *   5 个面板全挂会白白多出上千个 DOM 节点）；
 * - 访问过的常驻 —— 滚动位置、折叠状态、搜索词原样保留；
 * - 用 `display: none` 而不是 `visible/invisible`，隐藏的面板不参与布局、
 *   也不触发滚动重算，代价只是那点 DOM 内存。
 */
export function SideNav({
  width,
  onEditConnection
}: {
  width: number
  onEditConnection: (initial: Connection | null, preset?: Partial<ConnectionInput>) => void
}): JSX.Element | null {
  const sidebarVisible = useLayoutStore((s) => s.sidebarVisible)
  const activityView = useLayoutStore((s) => s.activityView)
  const setActivityView = useLayoutStore((s) => s.setActivityView)

  const activeId = useSessionStore((s) => s.activeId)
  const activeSession = useSessionById(activeId)

  /* 已挂载过的视图集合：首次进入才加进去，之后不再移除 */
  const [mounted, setMounted] = useState<ActivityView[]>([activityView])
  const mountedRef = useRef(mounted)
  mountedRef.current = mounted

  useEffect(() => {
    if (!mountedRef.current.includes(activityView)) {
      setMounted((prev) => (prev.includes(activityView) ? prev : [...prev, activityView]))
    }
  }, [activityView])

  if (!sidebarVisible) return null

  /** 每个视图都包一层：非当前项 display:none，但仍保持挂载 */
  const pane = (view: ActivityView, node: JSX.Element): JSX.Element => (
    <div
      key={view}
      data-pane={view}
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
      style={{ display: activityView === view ? 'flex' : 'none' }}
    >
      {node}
    </div>
  )

  return (
    <aside
      aria-label="侧边栏"
      style={{ width }}
      className="flex min-w-0 shrink-0 flex-col overflow-hidden border-r border-edge bg-panel"
    >
      {mounted.includes('connections') &&
        pane('connections', <ConnectionSidebar onEdit={onEditConnection} />)}

      {mounted.includes('files') &&
        pane(
          'files',
          <FileExplorer
            session={activeSession}
            onOpenTransfer={() => void 0}
            onBrowseSessions={() => setActivityView('connections')}
          />
        )}

      {mounted.includes('history') && pane('history', <HistoryPanel />)}
      {mounted.includes('logs') && pane('logs', <SessionLogsPanel />)}
      {mounted.includes('tunnels') && pane('tunnels', <TunnelPanel />)}
    </aside>
  )
}
