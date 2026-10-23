import {
  Archive,
  BookUser,
  Boxes,
  Cable,
  FolderTree,
  Gauge,
  History,
  Play,
  Radar,
  Rocket,
  Settings,
  ScrollText,
  TerminalSquare,
  Wrench
} from 'lucide-react'
import { useLayoutStore, type ActivityView } from '@/stores/layoutStore'
import { useDiagStore } from '@/stores/diagStore'
import { useBatchStore } from '@/stores/batchStore'
import { useProfileStore } from '@/stores/profileStore'
import { useMetricsStore } from '@/stores/metricsStore'
import { useFirmwareStore } from '@/stores/firmwareStore'
import { useDiscoveryStore } from '@/stores/discoveryStore'
import { useBackupStore } from '@/stores/backupStore'
import { cn } from '@/lib/utils'

/**
 * 左侧活动栏（48px，图标竖排）。
 *
 * 交互：点已激活的条目 = 收起/展开侧栏；点其它条目 = 切换视图并展开。
 * 视觉：激活项左侧 2px 品牌绿指示线 + 文字色提亮，**不改 box-shadow、不做缩放**，
 * 因为指示线本身已经足够表达状态，加阴影会在浅色底上显脏。
 *
 * 为什么没有「常用命令」这一项：命令栏已经常驻在窗口右侧了。
 * 再从活动栏切一个「常用命令」视图出来，等于同一个东西两个入口，
 * 而且切过去会让左侧的连接列表消失 —— 执行命令时最常做的正是
 * 「瞄一眼主机名」，不该为此多切一次。
 *
 * 为什么把「工具」单列一个：诊断 / 批量 / 固件这些是重面板，用底部图标
 * 会跟主视图混在一起；放进一个 Wrench 入口，点开后是一列弹层入口，
 * 活动栏就能保持 5 个主视图 + 1 个工具入口的克制数量。
 */

const MAIN_ITEMS: Array<{ view: ActivityView; label: string; icon: typeof FolderTree }> = [
  { view: 'connections', label: '连接', icon: TerminalSquare },
  { view: 'files', label: '文件', icon: FolderTree },
  { view: 'history', label: '命令历史', icon: History },
  { view: 'logs', label: '会话日志', icon: ScrollText },
  { view: 'tunnels', label: '端口隧道', icon: Cable }
]

export function ActivityBar(): JSX.Element {
  const activityView = useLayoutStore((s) => s.activityView)
  const sidebarVisible = useLayoutStore((s) => s.sidebarVisible)
  const commandRailVisible = useLayoutStore((s) => s.commandRailVisible)
  const toggleActivityView = useLayoutStore((s) => s.toggleActivityView)
  const toggleCommandRail = useLayoutStore((s) => s.toggleCommandRail)
  const setSettingsOpen = useLayoutStore((s) => s.setSettingsOpen)

  const diagOpen = useDiagStore((s) => s.panelOpen)
  const batchOpen = useBatchStore((s) => s.panelOpen)
  const profileOpen = useProfileStore((s) => s.panelOpen)
  const metricsOpen = useMetricsStore((s) => s.panelOpen)
  const firmwareOpen = useFirmwareStore((s) => s.panelOpen)
  const discoveryOpen = useDiscoveryStore((s) => s.panelOpen)
  const backupOpen = useBackupStore((s) => s.panelOpen)

  /** 任一工具面板打开时，「工具」入口也要点亮 */
  const toolsActive =
    diagOpen || batchOpen || profileOpen || metricsOpen || firmwareOpen || discoveryOpen || backupOpen

  return (
    <nav
      aria-label="活动栏"
      className="flex w-12 shrink-0 flex-col items-stretch border-r border-edge bg-panel"
    >
      {MAIN_ITEMS.map(({ view, label, icon: Icon }) => {
        const active = activityView === view && sidebarVisible
        return (
          <button
            key={view}
            data-activity={view}
            className={cn('activity-item', active && 'activity-item-active')}
            title={active ? `${label}（再次点击收起侧栏）` : label}
            aria-label={label}
            aria-pressed={active}
            onClick={() => toggleActivityView(view)}
          >
            {/* 激活指示线：2px 品牌绿，绝对定位贴在左沿（不占布局宽度） */}
            {active && (
              <span className="pointer-events-none absolute inset-y-1.5 left-0 w-0.5 rounded-r bg-brand" />
            )}
            <Icon size={19} strokeWidth={active ? 2.1 : 1.7} />
          </button>
        )
      })}

      <span className="mx-3 my-1 h-px shrink-0 bg-edge-soft" />

      {/* 工具：点开是弹层入口列表，而不是又一屏内容 */}
      <ToolsButton active={toolsActive} />

      <div className="flex-1" />

      {/* 命令栏开关：命令栏有自己头部的关闭按钮，但收起之后那个按钮也跟着没了，
          所以活动栏底部必须留一个常驻入口，否则收起后无法再打开。 */}
      <button
        data-activity="command-rail"
        className={cn('activity-item', commandRailVisible && 'activity-item-active')}
        title={commandRailVisible ? '收起常用命令栏' : '展开常用命令栏'}
        aria-label="常用命令栏"
        aria-pressed={commandRailVisible}
        onClick={() => toggleCommandRail()}
      >
        {commandRailVisible && (
          <span className="pointer-events-none absolute inset-y-1.5 left-0 w-0.5 rounded-r bg-brand" />
        )}
        <Play size={19} strokeWidth={commandRailVisible ? 2.1 : 1.7} />
      </button>

      <button
        className="activity-item"
        title="设置 (Ctrl+,)"
        aria-label="设置"
        onClick={() => setSettingsOpen(true)}
      >
        <Settings size={19} strokeWidth={1.7} />
      </button>
    </nav>
  )
}

/** 工具入口：悬浮出列表，避免在 48px 宽的竖条里塞二级菜单 */
function ToolsButton({ active }: { active: boolean }): JSX.Element {
  const items: Array<{ label: string; icon: JSX.Element; onClick: () => void }> = [
    {
      label: '一键诊断巡检',
      icon: <Wrench size={14} />,
      onClick: () => useDiagStore.getState().togglePanel()
    },
    {
      label: '批量执行',
      icon: <Boxes size={14} />,
      onClick: () => useBatchStore.getState().togglePanel()
    },
    {
      label: '客户 / 设备档案',
      icon: <BookUser size={14} />,
      onClick: () => useProfileStore.getState().togglePanel()
    },
    {
      label: '资源仪表盘',
      icon: <Gauge size={14} />,
      onClick: () => useMetricsStore.getState().togglePanel()
    },
    {
      label: '固件升级助手',
      icon: <Rocket size={14} />,
      onClick: () => useFirmwareStore.getState().togglePanel()
    },
    {
      label: '设备发现',
      icon: <Radar size={14} />,
      onClick: () => useDiscoveryStore.getState().togglePanel()
    },
    {
      label: '配置备份对比',
      icon: <Archive size={14} />,
      onClick: () => useBackupStore.getState().togglePanel()
    }
  ]

  return (
    <div className="group/tools relative">
      <button
        data-activity="tools"
        className={cn('activity-item', active && 'activity-item-active')}
        title="工具"
        aria-label="工具"
        aria-haspopup="menu"
      >
        {active && (
          <span className="pointer-events-none absolute inset-y-1.5 left-0 w-0.5 rounded-r bg-brand" />
        )}
        <Wrench size={19} strokeWidth={active ? 2.1 : 1.7} />
      </button>

      {/*
        hover 展开的浮层用纯色底（不能 backdrop-blur：终端容器父级禁止该属性；
        虽然这里不在终端链路上，但统一规则更容易守）。
        用 left-full 贴住活动栏右沿，不留缝隙 —— 有缝就会「鼠标移过去菜单先关」。
      */}
      <div
        role="menu"
        className="invisible absolute left-full top-0 z-50 w-44 rounded-md border border-edge bg-panel p-1 opacity-0 shadow-pop transition-opacity duration-150 group-hover/tools:visible group-hover/tools:opacity-100"
      >
        {items.map((it) => (
          <button key={it.label} role="menuitem" className="menu-item" onClick={it.onClick}>
            {it.icon}
            {it.label}
          </button>
        ))}
      </div>
    </div>
  )
}
