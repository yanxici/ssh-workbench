import { useEffect, useRef, useState, type DragEvent } from 'react'
import {
  Activity,
  Archive,
  BookUser,
  Boxes,
  Cable,
  FolderTree,
  Gauge,
  History,
  Minus,
  Moon,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Radar,
  Rocket,
  ScrollText,
  Settings as SettingsIcon,
  Square,
  SquareTerminal,
  Sun,
  TerminalSquare,
  X
} from 'lucide-react'
import type { Command } from '@shared/types'
import { useIsDark, useSettingsStore } from '@/stores/settingsStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { useCommandStore } from '@/stores/commandStore'
import { feedZmodem, isZmodemAttached } from '@/lib/zmodem'
import { terminalRegistry, useSessionStore, type SidebarView } from '@/stores/sessionStore'
import { runCommand } from '@/stores/executionStore'
import { useSftpStore } from '@/stores/sftpStore'
import { useToastStore } from '@/stores/toastStore'
import { cn } from '@/lib/utils'
import { TabBar } from '@/components/layout/TabBar'
import { StatusBar } from '@/components/layout/StatusBar'
import { ConnectionSidebar } from '@/components/connections/ConnectionSidebar'
import { ConnectionEditor } from '@/components/connections/ConnectionEditor'
import { CommandPanel } from '@/components/commands/CommandPanel'
import { CommandEditor } from '@/components/commands/CommandEditor'
import { RemoteEditorDialog } from '@/components/files/RemoteEditorDialog'
import { SessionFileTree } from '@/components/files/SessionFileTree'
import { TerminalView } from '@/components/terminal/TerminalView'
import { ZmodemOverlay } from '@/components/terminal/ZmodemOverlay'
import { HistoryPanel } from '@/components/panels/HistoryPanel'
import { SessionLogsPanel } from '@/components/panels/SessionLogsPanel'
import { TunnelPanel } from '@/components/panels/TunnelPanel'
import { lazy, Suspense } from 'react'
import { useTunnelStore } from '@/stores/tunnelStore'
import { useDiagStore } from '@/stores/diagStore'
import { useBatchStore } from '@/stores/batchStore'
import { useProfileStore } from '@/stores/profileStore'
import { useMetricsStore } from '@/stores/metricsStore'
import { useFirmwareStore } from '@/stores/firmwareStore'
import { useDiscoveryStore } from '@/stores/discoveryStore'
import { useBackupStore } from '@/stores/backupStore'
import { useUiStore } from '@/stores/uiStore'
import { matchShortcut, resolveShortcuts } from '@/lib/shortcuts'
import { isCommandDrag, readDraggedCommandId, stripDragPayload } from '@/lib/commandDrag'
import { SettingsPanel } from '@/components/settings/SettingsPanel'
import { DangerConfirmDialog, VariablePromptDialog } from '@/components/execution/ExecutionDialogs'
import { EmptyState, ToastHost, ContextMenu } from '@/components/ui'

/**
 * 重量级功能面板改为按需加载。
 *
 * 这些面板原本被静态 import，即使都自带 `if (!open) return null` 守卫、
 * 不产生渲染开销，代码本身仍会全部打进首包并在启动时求值。
 * 拆出去之后，只有用户真正打开某个面板时才去取对应 chunk。
 *
 * 注意：面板的挂载条件必须与自身的守卫一致（见下方各 store 的 open 状态），
 * 否则会破坏它们在首次打开时执行的数据加载副作用（如 diag 的 loadSections）。
 */
const FileManagerPanel = lazy(() =>
  import('@/components/files/FileManagerPanel').then((m) => ({ default: m.FileManagerPanel }))
)
const DiagnosticsPanel = lazy(() =>
  import('@/components/diagnostics/DiagnosticsPanel').then((m) => ({ default: m.DiagnosticsPanel }))
)
const BatchPanel = lazy(() =>
  import('@/components/batch/BatchPanel').then((m) => ({ default: m.BatchPanel }))
)
const ProfilesPanel = lazy(() =>
  import('@/components/profiles/ProfilesPanel').then((m) => ({ default: m.ProfilesPanel }))
)
const MetricsPanel = lazy(() =>
  import('@/components/metrics/MetricsPanel').then((m) => ({ default: m.MetricsPanel }))
)
const FirmwarePanel = lazy(() =>
  import('@/components/firmware/FirmwarePanel').then((m) => ({ default: m.FirmwarePanel }))
)
const DiscoveryPanel = lazy(() =>
  import('@/components/discovery/DiscoveryPanel').then((m) => ({ default: m.DiscoveryPanel }))
)
const BackupPanel = lazy(() =>
  import('@/components/backup/BackupPanel').then((m) => ({ default: m.BackupPanel }))
)

const SIDEBAR_TABS: Array<{ key: SidebarView; label: string; icon: typeof History }> = [
  { key: 'connections', label: '连接', icon: TerminalSquare },
  { key: 'history', label: '历史', icon: History },
  { key: 'logs', label: '日志', icon: ScrollText },
  { key: 'tunnels', label: '隧道', icon: Cable }
]

/** 命令面板折叠后的窄条：点一下即可展开，Ctrl+B 同样可用 */
function CommandRail({
  collapsed,
  onClick
}: {
  /** 纵向窄条（右侧栏模式） */
  collapsed?: boolean
  onClick: () => void
}): JSX.Element {
  if (collapsed) {
    return (
      <button
        className="flex w-[26px] shrink-0 flex-col items-center gap-2 border-l border-edge bg-panel py-2 text-ink-3 transition-colors hover:bg-hover hover:text-ink"
        title="展开命令面板 (Ctrl+B)"
        onClick={onClick}
      >
        <Play size={12} className="shrink-0" />
        <span className="text-2xs [writing-mode:vertical-rl]">常用命令</span>
      </button>
    )
  }
  return (
    <button
      className="flex h-[26px] shrink-0 items-center gap-2 border-t border-edge bg-panel px-2 text-ink-3 transition-colors hover:bg-hover hover:text-ink"
      title="展开命令面板 (Ctrl+B)"
      onClick={onClick}
    >
      <Play size={12} className="shrink-0" />
      <span className="text-2xs">常用命令</span>
    </button>
  )
}

export function App(): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeId)
  const panelVisible = useSessionStore((s) => s.panelVisible)
  const fileTreeVisible = useSessionStore((s) => s.fileTreeVisible)
  const togglePanel = useSessionStore((s) => s.togglePanel)
  const sidebarView = useSessionStore((s) => s.sidebarView)
  const setSidebarView = useSessionStore((s) => s.setSidebarView)

  const loadSettings = useSettingsStore((s) => s.load)
  const updateSettings = useSettingsStore((s) => s.update)
  const settings = useSettingsStore((s) => s.settings)
  const isDark = useIsDark()
  const loadConnections = useConnectionStore((s) => s.load)
  const loadCommands = useCommandStore((s) => s.load)

  // 按需加载面板的「是否挂载」条件。这些状态本身很轻（布尔），
  // 放在 App 顶层订阅即可，真正的面板模块要等打开时才加载。
  const sftpOpen = useSftpStore((s) => s.open)
  const diagOpen = useDiagStore((s) => s.panelOpen)
  const batchOpen = useBatchStore((s) => s.panelOpen)
  const profileOpen = useProfileStore((s) => s.panelOpen)
  const metricsOpen = useMetricsStore((s) => s.panelOpen)
  const firmwareOpen = useFirmwareStore((s) => s.panelOpen)
  const discoveryOpen = useDiscoveryStore((s) => s.panelOpen)
  const backupOpen = useBackupStore((s) => s.panelOpen)

  const connEditorOpen = useUiStore((s) => s.connEditorOpen)
  const editingConn = useUiStore((s) => s.editingConn)
  const connPreset = useUiStore((s) => s.connPreset)
  const openConnEditor = useUiStore((s) => s.openConnEditor)
  const closeConnEditor = useUiStore((s) => s.closeConnEditor)
  const [cmdEditorOpen, setCmdEditorOpen] = useState(false)
  const [editingCmd, setEditingCmd] = useState<Command | null>(null)
  const [cmdPresetGroup, setCmdPresetGroup] = useState<string | undefined>(undefined)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [dragOverTerminal, setDragOverTerminal] = useState(false)
  /** 顶栏「更多功能」菜单锚点；窗口变窄时用于收纳功能按钮 */
  const [moreMenu, setMoreMenu] = useState<{ x: number; y: number } | null>(null)
  /** 窗口是否窄到需要把功能按钮收进「更多」菜单 */
  const [narrowToolbar, setNarrowToolbar] = useState(false)
  /** 拖拽期间记录命令 id：dragOver 阶段会清空 dataTransfer，drop 时只能靠它兜底 */
  const dragCommandIdRef = useRef<string | null>(null)

  const editing = useSftpStore((s) => s.editing)
  const closeEditor = useSftpStore((s) => s.closeEditor)
  const saveEditor = useSftpStore((s) => s.saveEditor)

  const activeSessionInfo = sessions.find((s) => s.id === activeId) ?? null

  const openNewConnection = (): void => {
    openConnEditor(null)
  }

  const openFileManager = (): void => {
    const state = useSessionStore.getState()
    const current = state.sessions.find((x) => x.id === state.activeId)
    if (!current) {
      useToastStore.getState().push({
        kind: 'warning',
        title: '请先打开一个 SSH 连接',
        detail: '文件管理需要先连接到远端设备'
      })
      return
    }
    if (current.status !== 'connected') {
      useToastStore.getState().push({
        kind: 'warning',
        title: '当前会话尚未连接',
        detail: `「${current.title}」状态：${current.status}`
      })
      return
    }
    void useSftpStore.getState().openFor(current.id, current.title)
  }

  /* ---------- 启动加载 ---------- */
  useEffect(() => {
    void loadSettings()
    void loadConnections()
    void loadCommands()
    void useTunnelStore.getState().load()
    // 渲染层重载后，主进程可能仍在采样：对齐监控状态
    void useMetricsStore.getState().syncStates()
  }, [loadSettings, loadConnections, loadCommands])

  /* ---------- 顶栏自适应：窗口过窄时把功能按钮收进「更多」菜单 ---------- */
  useEffect(() => {
    // 阈值 = 品牌区 + 窗口控制 + 常用按钮所需的最小宽度；低于它就切换为收纳模式
    const THRESHOLD = 1100
    const apply = (): void => setNarrowToolbar(window.innerWidth < THRESHOLD)
    apply()
    window.addEventListener('resize', apply)
    return () => window.removeEventListener('resize', apply)
  }, [])

  /* ---------- 主进程事件 -> 终端写入 / 会话状态 ---------- */
  useEffect(() => {
    const offData = window.api.on.sessionData(({ sessionId, data, raw }) => {
      // ZMODEM 的 Sentry 挂在每个会话上（见 ensureZmodem），
      // 它的 to_terminal 负责把「非协议字节」写进终端；
      // 因此这里只把原始字节交给 Sentry，不再直接写终端，避免重复输出。
      if (isZmodemAttached(sessionId)) {
        feedZmodem(sessionId, raw, data)
        return
      }
      terminalRegistry.get(sessionId)?.term.write(data)
    })
    const offStatus = window.api.on.sessionStatus(({ sessionId, status, error }) => {
      useSessionStore.getState().updateStatus(sessionId, status, error)
    })
    const offLatency = window.api.on.sessionLatency(({ sessionId, ms }) => {
      useSessionStore.getState().updateLatency(sessionId, ms)
    })
    const offTunnel = window.api.on.tunnelStatus((info) => {
      useTunnelStore.getState().applyRuntime(info)
    })
    const offDiag = window.api.on.diagProgress((e) => {
      useDiagStore.getState().applyProgress(e)
    })
    const offBatch = window.api.on.batchProgress((e) => {
      useBatchStore.getState().applyProgress(e)
    })
    const offMetrics = window.api.on.metrics((e) => {
      useMetricsStore.getState().applyEvent(e)
    })
    const offFwLog = window.api.on.fwLog((e) => {
      useFirmwareStore.getState().applyLog(e)
    })
    const offDiscover = window.api.on.discoverProgress((e) => {
      useDiscoveryStore.getState().applyProgress(e)
    })
    return () => {
      offData()
      offStatus()
      offLatency()
      offTunnel()
      offDiag()
      offBatch()
      offMetrics()
      offFwLog()
      offDiscover()
    }
  }, [])

  /* ---------- 全局快捷键（capture 阶段，避免被终端吞掉；组合键可自定义） ---------- */
  useEffect(() => {
    const map = resolveShortcuts(settings.shortcuts)
    const onKey = (e: KeyboardEvent): void => {
      const consume = (): void => {
        e.preventDefault()
        e.stopPropagation()
      }

      if (matchShortcut(e, map.newConnection)) {
        consume()
        openConnEditor(null)
      } else if (matchShortcut(e, map.settings)) {
        consume()
        setSettingsOpen(true)
      } else if (matchShortcut(e, map.togglePanel)) {
        consume()
        useSessionStore.getState().togglePanel()
      } else if (matchShortcut(e, map.nextTab)) {
        consume()
        useSessionStore.getState().cycle(e.shiftKey ? -1 : 1)
      } else if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 't') {
        consume()
        const { activeId: current, openTerminal } = useSessionStore.getState()
        if (current) openTerminal(current)
      } else if (matchShortcut(e, map.closeTab)) {
        consume()
        const { activeId: current, close } = useSessionStore.getState()
        if (current) close(current)
      }
    }
    window.addEventListener('keydown', onKey, { capture: true })
    return () => window.removeEventListener('keydown', onKey, { capture: true })
  }, [settings.shortcuts, openConnEditor])

  /* ---------- 常用命令拖到终端执行 ---------- */
  // 命令面板拖拽会把 id 写进 text/plain：这里抓住它，drop 阶段即使载荷被清空也能还原
  useEffect(() => {
    const onStart = (e: globalThis.DragEvent): void => {
      const t = e.target
      if (!(t instanceof HTMLElement)) return
      const item = t.closest('[data-cmd-id]')
      dragCommandIdRef.current = item?.getAttribute('data-cmd-id') ?? null
    }
    window.addEventListener('dragstart', onStart, { capture: true })
    return () => window.removeEventListener('dragstart', onStart, { capture: true })
  }, [])

  const handleTerminalDragOver = (e: DragEvent<HTMLDivElement>): void => {
    if (!isCommandDrag(e.dataTransfer.types)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    // 摘掉载荷：既避免终端把 id 当文本插入，也避免后续 dragover/drop 被 xterm 抢走
    stripDragPayload(e.dataTransfer)
    setDragOverTerminal(true)
  }

  const handleTerminalDrop = (e: DragEvent<HTMLDivElement>): void => {
    if (!dragOverTerminal) return
    setDragOverTerminal(false)
    e.preventDefault()
    const id = readDraggedCommandId(e.dataTransfer, dragCommandIdRef.current)
    dragCommandIdRef.current = null
    if (!id) return
    if (useSessionStore.getState().sessions.length === 0) {
      useToastStore.getState().push({
        kind: 'warning',
        title: '请先打开一个 SSH 连接',
        detail: '然后再把常用命令拖进终端执行'
      })
      return
    }
    const cmd = useCommandStore.getState().commands.find((c) => c.id === id)
    if (cmd) runCommand(cmd)
  }

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-app text-ink">
      {/* ================= 顶栏：品牌 + 标签 + 工具 + 窗口控制 ================= */}
      <div className="flex h-[38px] shrink-0 items-stretch border-b border-edge bg-panel">
        <div className="drag-region flex shrink-0 items-center gap-1.5 border-r border-edge-soft pl-3 pr-2.5">
          <TerminalSquare size={14} className="text-accent" />
          <span className="text-xs font-semibold tracking-wide text-ink-2">SSH Workbench</span>
        </div>

        <div className="flex min-w-0 flex-1 items-stretch overflow-hidden">
          <TabBar onNewConnection={openNewConnection} />
        </div>

        {/* 工具条：窄窗口下优先保留窗口控制与设置，其余功能收进「更多」菜单 */}
        <div className="no-drag flex shrink-0 items-center gap-0.5 border-l border-edge-soft px-1">
          <div
            className={cn(
              'items-center gap-0.5',
              narrowToolbar ? 'hidden' : 'flex'
            )}
          >
            <button
              className="btn-icon"
              title={fileTreeVisible ? '收起文件面板' : '展开文件面板（连接后自动打开）'}
              aria-label={fileTreeVisible ? '收起文件面板' : '展开文件面板'}
              onClick={() => useSessionStore.getState().toggleFileTree()}
            >
              <FolderTree size={14} />
            </button>
            <button
              className="btn-icon"
              title="一键诊断巡检（采集设备信息并生成报告）"
              aria-label="一键诊断巡检"
              onClick={() => useDiagStore.getState().togglePanel()}
            >
              <Activity size={14} />
            </button>
            <button
              className="btn-icon"
              title="批量执行（多设备广播命令）"
              aria-label="批量执行"
              onClick={() => useBatchStore.getState().togglePanel()}
            >
              <Boxes size={14} />
            </button>
            <button
              className="btn-icon"
              title="客户 / 设备档案"
              aria-label="客户与设备档案"
              onClick={() => useProfileStore.getState().togglePanel()}
            >
              <BookUser size={14} />
            </button>
            <button
              className="btn-icon"
              title="资源仪表盘（实时监控）"
              aria-label="资源仪表盘"
              onClick={() => useMetricsStore.getState().togglePanel()}
            >
              <Gauge size={14} />
            </button>

            <div className="mx-0.5 h-4 w-px bg-edge-soft" />

            <button
              className="btn-icon"
              title="固件升级助手（上传/校验/升级/重启监控）"
              aria-label="固件升级助手"
              onClick={() => useFirmwareStore.getState().togglePanel()}
            >
              <Rocket size={14} />
            </button>
            <button
              className="btn-icon"
              title="设备发现（网段扫描 / mDNS）"
              aria-label="设备发现"
              onClick={() => useDiscoveryStore.getState().togglePanel()}
            >
              <Radar size={14} />
            </button>
            <button
              className="btn-icon"
              title="配置备份对比（备份 / diff / 还原）"
              aria-label="配置备份对比"
              onClick={() => useBackupStore.getState().togglePanel()}
            >
              <Archive size={14} />
            </button>
          </div>

          {/* 窄窗口：以上功能收进此菜单，保持入口可达而不是直接消失 */}
          {narrowToolbar && (
            <button
              className="btn-icon"
              title="更多功能"
              aria-label="更多功能"
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect()
                setMoreMenu({ x: Math.round(r.right), y: Math.round(r.bottom) })
              }}
            >
              <MoreHorizontal size={14} />
            </button>
          )}

          <button
            className="btn-icon"
            title={panelVisible ? '折叠命令面板 (Ctrl+B)' : '展开命令面板 (Ctrl+B)'}
            aria-label={panelVisible ? '折叠命令面板' : '展开命令面板'}
            onClick={togglePanel}
          >
            {panelVisible ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
          </button>
          <button
            className="btn-icon"
            title={isDark ? '切换到亮色主题' : '切换到暗色主题'}
            aria-label={isDark ? '切换到亮色主题' : '切换到暗色主题'}
            onClick={() => void updateSettings({ theme: isDark ? 'light' : 'dark' })}
          >
            {isDark ? <Sun size={14} /> : <Moon size={14} />}
          </button>
          <button
            className="btn-icon"
            title="设置 (Ctrl+,)"
            aria-label="设置"
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsIcon size={14} />
          </button>

          <div className="mx-1 h-4 w-px bg-edge-soft" />

          <button
            className="btn-icon"
            title="最小化"
            aria-label="最小化"
            onClick={() => void window.api.win.minimize()}
          >
            <Minus size={14} />
          </button>
          <button
            className="btn-icon"
            title="最大化 / 还原"
            aria-label="最大化或还原"
            onClick={() => void window.api.win.toggleMax()}
          >
            <Square size={11} />
          </button>
          <button
            className="btn-icon hover:bg-danger/85 hover:text-white"
            title="关闭"
            aria-label="关闭"
            onClick={() => void window.api.win.close()}
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* ================= 主体三栏 ================= */}
      <div className="flex min-h-0 flex-1">
        {/* 左：连接 / 历史 */}
        <div className="flex w-[250px] shrink-0 flex-col border-r border-edge bg-panel">
          <div className="flex shrink-0 items-stretch border-b border-edge-soft">
            {SIDEBAR_TABS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                className={cn(
                  'relative flex flex-1 items-center justify-center gap-1.5 py-1.5 text-2xs transition-colors',
                  sidebarView === key ? 'text-ink' : 'text-ink-3 hover:text-ink-2'
                )}
                onClick={() => setSidebarView(key)}
              >
                <Icon size={12} />
                {label}
                {sidebarView === key && (
                  <span className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-accent" />
                )}
              </button>
            ))}
          </div>

          <div className="min-h-0 flex-1">
            {sidebarView === 'connections' && (
              <ConnectionSidebar onEdit={(initial, preset) => openConnEditor(initial, preset)} />
            )}
            {sidebarView === 'history' && <HistoryPanel />}
            {sidebarView === 'logs' && <SessionLogsPanel />}
            {sidebarView === 'tunnels' && <TunnelPanel />}
          </div>
        </div>

        {/* 中：文件树 + 终端区 */}
        <div className="flex min-w-0 flex-1">
          {/* 会话文件树（连接后自动展开，与 XTerminal 习惯一致） */}
          {fileTreeVisible && activeSessionInfo && (
            <div className="w-[250px] shrink-0 border-r border-edge">
              <SessionFileTree
                key={activeSessionInfo.id}
                sessionId={activeSessionInfo.id}
                title={activeSessionInfo.title}
                onClose={() => useSessionStore.getState().toggleFileTree()}
                onOpenTransfer={openFileManager}
              />
            </div>
          )}

          <div
            className={cn(
              'relative min-w-0 flex-1 bg-app',
              dragOverTerminal && 'ring-2 ring-inset ring-accent/50'
            )}
            onDragOver={handleTerminalDragOver}
            onDragLeave={(e) => {
              if (e.currentTarget === e.target) setDragOverTerminal(false)
            }}
            onDrop={handleTerminalDrop}
          >
            {sessions.length === 0 ? (
              <EmptyState
                icon={<SquareTerminal size={34} />}
                title="还没有打开任何终端"
                hint="双击左侧连接打开会话，文件树会自动出现在终端旁边；也可以把右侧的常用命令直接拖到这里执行"
                action={
                  <button className="btn btn-primary h-8 px-3.5 text-xs" onClick={openNewConnection}>
                    <Plus size={13} />
                    新建连接
                  </button>
                }
              />
            ) : (
              // 所有会话保持挂载，仅切换可见性 —— 保留终端状态与滚动位置
              sessions.map((s) => (
                <div
                  key={s.id}
                  className="absolute inset-0"
                  style={{ display: s.id === activeId ? 'block' : 'none' }}
                >
                  <TerminalView session={s} active={s.id === activeId} />
                </div>
              ))
            )}
            {/* ZMODEM 传输确认与进度（跟随当前活动会话） */}
            <ZmodemOverlay />
          </div>
        </div>

        {/* 右：常用命令面板（可折叠成窄条） */}
        {settings.commandPanelPosition !== 'bottom' &&
          (panelVisible ? (
            <div className="flex w-[232px] shrink-0 flex-col border-l border-edge bg-panel">
              <CommandPanel
                onCollapse={togglePanel}
                onEdit={(initial, presetGroup) => {
                  setEditingCmd(initial)
                  setCmdPresetGroup(presetGroup)
                  setCmdEditorOpen(true)
                }}
              />
            </div>
          ) : (
            <CommandRail collapsed onClick={togglePanel} />
          ))}
      </div>

      {/* 底部：常用命令面板（横向分组，可折叠成窄条） */}
      {settings.commandPanelPosition === 'bottom' &&
        (panelVisible ? (
          <div className="h-[136px] shrink-0 border-t border-edge bg-panel">
            <CommandPanel
              layout="horizontal"
              onCollapse={togglePanel}
              onEdit={(initial, presetGroup) => {
                setEditingCmd(initial)
                setCmdPresetGroup(presetGroup)
                setCmdEditorOpen(true)
              }}
            />
          </div>
        ) : (
          <CommandRail onClick={togglePanel} />
        ))}

      {/* ================= 状态栏 ================= */}
      <StatusBar />

      {/* 顶栏「更多功能」菜单（窄窗口下的功能入口） */}      {moreMenu && (
        <ContextMenu
          x={moreMenu.x}
          y={moreMenu.y}
          onClose={() => setMoreMenu(null)}
          items={[
            {
              label: fileTreeVisible ? '收起文件面板' : '展开文件面板',
              onClick: () => useSessionStore.getState().toggleFileTree()
            },
            {
              label: '一键诊断巡检',
              onClick: () => useDiagStore.getState().togglePanel()
            },
            { label: '批量执行', onClick: () => useBatchStore.getState().togglePanel() },
            { label: '客户 / 设备档案', onClick: () => useProfileStore.getState().togglePanel() },
            { label: '资源仪表盘', onClick: () => useMetricsStore.getState().togglePanel() },
            {
              label: '固件升级助手',
              separatorBefore: true,
              onClick: () => useFirmwareStore.getState().togglePanel()
            },
            { label: '设备发现', onClick: () => useDiscoveryStore.getState().togglePanel() },
            { label: '配置备份对比', onClick: () => useBackupStore.getState().togglePanel() }
          ]}
        />
      )}

      {/* ================= 弹窗层 ================= */}
      <ConnectionEditor
        open={connEditorOpen}
        initial={editingConn}
        preset={connPreset}
        onClose={closeConnEditor}
      />
      <CommandEditor
        open={cmdEditorOpen}
        initial={editingCmd}
        presetGroup={cmdPresetGroup}
        onClose={() => setCmdEditorOpen(false)}
      />
      {/* 按需加载的功能面板：只有对应开关打开时才挂载并拉取 chunk。
          挂载条件与面板自身的守卫保持一致，确保首次打开时的数据加载副作用照常触发。 */}
      <Suspense fallback={null}>
        {sftpOpen && <FileManagerPanel />}
        {diagOpen && <DiagnosticsPanel />}
        {batchOpen && <BatchPanel />}
        {profileOpen && <ProfilesPanel />}
        {metricsOpen && <MetricsPanel />}
        {firmwareOpen && <FirmwarePanel />}
        {discoveryOpen && <DiscoveryPanel />}
        {backupOpen && <BackupPanel />}
      </Suspense>
      {/* 远程文件编辑器（文件树与双栏面板共用） */}
      {editing && (
        <RemoteEditorDialog
          path={editing.path}
          content={editing.content}
          onClose={closeEditor}
          onSave={(content) => void saveEditor(content)}
        />
      )}
      <SettingsPanel open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <VariablePromptDialog />
      <DangerConfirmDialog />
      <ToastHost />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  自动化测试钩子（仅在 ZM_TEST=1 的验证构建里挂载，见 electron.vite.config.ts）
 *  用于无头验证懒加载面板能否正常打开并触发首屏数据加载。
 * ------------------------------------------------------------------ */
if (__ZM_TEST__ && typeof window !== 'undefined') {
  ;(window as unknown as { __lazy_test?: unknown }).__lazy_test = {
    stores: {
      sftp: useSftpStore,
      diag: useDiagStore,
      batch: useBatchStore,
      profile: useProfileStore,
      metrics: useMetricsStore,
      firmware: useFirmwareStore,
      discovery: useDiscoveryStore,
      backup: useBackupStore
    },
    setters: {
      sftpSet: (v: boolean) => useSftpStore.setState({ open: v }),
      diagSet: (v: boolean) => useDiagStore.setState({ panelOpen: v }),
      batchSet: (v: boolean) => useBatchStore.setState({ panelOpen: v }),
      profileSet: (v: boolean) => useProfileStore.setState({ panelOpen: v }),
      metricsSet: (v: boolean) => useMetricsStore.setState({ panelOpen: v }),
      firmwareSet: (v: boolean) => useFirmwareStore.setState({ panelOpen: v }),
      discoverySet: (v: boolean) => useDiscoveryStore.setState({ panelOpen: v }),
      backupSet: (v: boolean) => useBackupStore.setState({ panelOpen: v })
    },
    /**
     * 面板模块是否已在启动时被求值。
     * 懒加载生效时这些标识都应为 false —— 它们只在面板 chunk 被拉取后才存在。
     * 注意不能靠性能资源记录判断：本应用走 file:// 加载，resource timing 恒为空。
     */
    probeStartup: () => ({
      // 各面板模块里的独有函数/常量名，由打包器在对应 chunk 内定义
      panelModulesEvaluated: (window as unknown as { __panelModules?: string[] }).__panelModules ?? [],
      hasAnyPanelGlobals: typeof (window as unknown as { __panelLoaded?: unknown }).__panelLoaded !== 'undefined'
    })
  }
}

