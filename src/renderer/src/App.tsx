import { useEffect, useRef, useState, type DragEvent } from 'react'
import { installErrorReporter } from '@/lib/errorReporter'
import { lazy, Suspense } from 'react'
import type { Command, ConnectionInput } from '@shared/types'
import { useSettingsStore } from '@/stores/settingsStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { useCommandStore } from '@/stores/commandStore'
import { feedZmodem, isZmodemAttached } from '@/lib/zmodem'
import { terminalRegistry, useSessionStore } from '@/stores/sessionStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { runCommand } from '@/stores/executionStore'
import { useSftpStore } from '@/stores/sftpStore'
import { useToastStore } from '@/stores/toastStore'
import { TitleBar } from '@/components/layout/TitleBar'
import { ActivityBar } from '@/components/layout/ActivityBar'
import { SideNav } from '@/components/layout/SideNav'
import { CommandRail } from '@/components/layout/CommandRail'
import { PaneResizer, usePaneSizes } from '@/components/layout/PaneResizer'
import { MainWorkspace } from '@/components/layout/MainWorkspace'
import { StatusBar } from '@/components/layout/StatusBar'
import { ConnectionEditor } from '@/components/connections/ConnectionEditor'
import { CommandCenter } from '@/components/commands/CommandCenter'
import { CommandEditor } from '@/components/commands/CommandEditor'
import { RemoteEditorDialog } from '@/components/files/RemoteEditorDialog'
import { TransferProgressDock } from '@/components/files/TransferProgressDock'
import { useTunnelStore } from '@/stores/tunnelStore'
import { useDiagStore } from '@/stores/diagStore'
import { useBatchStore } from '@/stores/batchStore'
import { useProfileStore } from '@/stores/profileStore'
import { useMetricsStore } from '@/stores/metricsStore'
import { useFirmwareStore } from '@/stores/firmwareStore'
import { useDiscoveryStore } from '@/stores/discoveryStore'
import { useBackupStore } from '@/stores/backupStore'
import { useUpdateStore } from '@/stores/updateStore'
import { useUiStore } from '@/stores/uiStore'
import { matchShortcut, resolveShortcuts } from '@/lib/shortcuts'
import { isCommandDrag, readDraggedCommandId, stripDragPayload } from '@/lib/commandDrag'
import { SettingsPanel } from '@/components/settings/SettingsPanel'
import { DangerConfirmDialog, VariablePromptDialog } from '@/components/execution/ExecutionDialogs'
import { ToastHost } from '@/components/ui'

/**
 * 重量级功能面板改为按需加载。
 *
 * 这些面板即使都自带 `if (!open) return null` 守卫、不产生渲染开销，
 * 代码本身仍会全部打进首包并在启动时求值。拆出去之后只有真正打开时才取 chunk。
 * 注意：挂载条件必须与面板自身的守卫一致，否则会破坏它们首次打开时的
 * 数据加载副作用（如 diag 的 loadSections）。
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

/**
 * 应用外壳。
 *
 * 新版结构（严格按视觉规范落地）：
 *   TitleBar 44px（品牌绿底）
 *   ├─ ActivityBar 48px │ SideNav 280px（可折叠）│ MainWorkspace（终端）│ CommandRail 380px（可折叠）
 *   StatusBar 28px
 *
 * 与旧版的差别不只是配色：旧版把「连接 / 文件树 / 命令」三栏同时铺开，
 * 1280 宽的窗口里终端只剩 500px 出头；中间那版把三者收进同一个侧栏位置，
 * 终端宽了但「边看主机名边点命令」要来回切视图。现在左侧只留一个可切换的
 * 导航栏，命令栏常驻右侧 —— 两者本来就是并行信息。
 */
export function App(): JSX.Element {
  // 全局错误上报只需装一次；放在最外层组件的挂载期
  useEffect(() => {
    installErrorReporter()
  }, [])

  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeId)

  const loadSettings = useSettingsStore((s) => s.load)
  const settings = useSettingsStore((s) => s.settings)
  const loadConnections = useConnectionStore((s) => s.load)
  const loadCommands = useCommandStore((s) => s.load)

  const sidebarVisible = useLayoutStore((s) => s.sidebarVisible)
  const commandRailVisible = useLayoutStore((s) => s.commandRailVisible)
  const settingsOpen = useLayoutStore((s) => s.settingsOpen)
  const setSettingsOpen = useLayoutStore((s) => s.setSettingsOpen)
  const { sizes: paneSizes, setLive: setPaneLive, commit: commitPane } = usePaneSizes()

  // 按需加载面板的挂载条件（这些都是轻量布尔，真正的模块等打开时才拉）
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
  const [dragOverTerminal, setDragOverTerminal] = useState(false)
  /** 拖拽期间记录命令 id：dragOver 阶段会清空 dataTransfer，drop 时只能靠它兜底 */
  const dragCommandIdRef = useRef<string | null>(null)

  const editing = useSftpStore((s) => s.editing)
  const closeEditor = useSftpStore((s) => s.closeEditor)
  const saveEditor = useSftpStore((s) => s.saveEditor)

  const openCommandEditor = (initial: Command | null, presetGroup?: string): void => {
    setEditingCmd(initial)
    setCmdPresetGroup(presetGroup)
    setCmdEditorOpen(true)
  }

  const openNewConnection = (): void => openConnEditor(null)

  /* ---------- 启动加载 ---------- */
  useEffect(() => {
    void loadSettings()
    void loadConnections()
    void loadCommands()
    void useTunnelStore.getState().load()
    // 渲染层重载后主进程可能仍在采样：对齐监控状态
    void useMetricsStore.getState().syncStates()
    /*
     * 更新状态对齐。
     *
     * 事件订阅是「订阅之后才收得到」，而主进程的初始化与首轮检查
     * 可能发生在渲染层订阅之前（窗口建好后主进程立刻 initUpdater）。
     * 少了这一步，最快的一次检测结果就白丢了 —— 表现为「明明有新版，
     * 标题栏却一直是空的，得等下次检查」。
     */
    void useUpdateStore.getState().sync()
  }, [loadSettings, loadConnections, loadCommands])

  /* ---------- 会话恢复：启动时自动打开上次退出时的连接 ---------- */
  const restoredRef = useRef(false)
  useEffect(() => {
    // 确保settings和connections都已加载，且只恢复一次
    if (restoredRef.current || !settings || !settings.restoreSessions) return
    
    const connections = useConnectionStore.getState().connections
    const lastSessions = settings.lastOpenSessions
    if (!lastSessions || lastSessions.length === 0 || connections.length === 0) return
    
    restoredRef.current = true
    const openSession = useSessionStore.getState().open
    
    // 延迟恢复，避免在初始化期间阻塞
    setTimeout(() => {
      lastSessions.forEach(({ connectionId, connectionName }) => {
        const conn = connections.find((c) => c.id === connectionId)
        if (conn) {
          openSession({ id: conn.id, name: conn.name, host: conn.host, username: conn.username })
        } else {
          // 连接已被删除，跳过
          console.warn(`会话恢复：连接 ${connectionName} (${connectionId}) 不存在`)
        }
      })
    }, 300)
  }, [settings])

  /* ---------- 退出时保存打开的会话列表 ---------- */
  useEffect(() => {
    if (!settings.restoreSessions) return
    
    const handleBeforeUnload = (): void => {
      const activeSessions = sessions
        .filter((s) => s.status === 'connected' || s.status === 'connecting')
        .map((s) => ({
          connectionId: s.connectionId,
          connectionName: s.connectionName
        }))
      
      // 最多保存 10 个会话避免文件膨胀
      const toSave = activeSessions.slice(0, 10)
      
      if (toSave.length > 0) {
        void useSettingsStore.getState().update({ lastOpenSessions: toSave })
      }
    }
    
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [sessions, settings.restoreSessions])

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
    // 自动重连进度：标签栏据此显示「N 秒后重连 / 第 x 次」
    const offReconnect = window.api.on.reconnect((e) => {
      useSessionStore.getState().applyReconnect(e)
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
    // SFTP 上传/下载进度：这是进度条的数据入口，缺失时任务永远停在 pending
    const offTransfer = window.api.on.transferProgress((e) => {
      useSftpStore.getState().applyProgress(e)
    })
    // 应用更新状态：主进程每次推全量快照，这里直接覆盖
    const offUpdate = window.api.on.updateStatus((e) => {
      useUpdateStore.getState().applyEvent(e)
    })
    return () => {
      offData()
      offStatus()
      offLatency()
      offTunnel()
      offReconnect()
      offDiag()
      offBatch()
      offMetrics()
      offFwLog()
      offDiscover()
      offTransfer()
      offUpdate()
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

      if (matchShortcut(e, map.commandCenter)) {
        consume()
        useUiStore.getState().toggleCommandCenter()
      } else if (matchShortcut(e, map.newConnection)) {
        consume()
        openConnEditor(null)
      } else if (matchShortcut(e, map.settings)) {
        consume()
        setSettingsOpen(true)
      } else if (matchShortcut(e, map.togglePanel)) {
        consume()
        // Ctrl+B：折叠/展开左侧边栏
        useLayoutStore.getState().toggleSidebar()
      } else if (matchShortcut(e, map.toggleCommandRail)) {
        consume()
        // Ctrl+Alt+B：折叠/展开右侧命令栏（与侧边栏分开，各管一块）
        useLayoutStore.getState().toggleCommandRail()
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
  }, [settings.shortcuts, openConnEditor, setSettingsOpen])

  /* ---------- 常用命令拖到终端执行 ---------- */
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

  /** 侧栏里的「连接」编辑器回调（类型由 ConnectionSidebar 决定） */
  const handleEditConnection = (
    initial: Parameters<typeof openConnEditor>[0],
    preset?: ConnectionInput
  ): void => openConnEditor(initial, preset)

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-app text-ink-2">
      {/* ================= 顶部标题栏（44px，品牌绿） ================= */}
      <TitleBar />

      {/* ================= 主体：活动栏 + 侧栏 + 工作区 ================= */}
      <div className="flex min-h-0 flex-1">
        <ActivityBar />
        <SideNav width={paneSizes.sidebar} onEditConnection={handleEditConnection as never} />
        {/* 分隔条只在侧栏可见时存在；收起时它会把 6px 热区留在窗口边缘，
            拖拽会「拖出」一个看不见的侧栏宽度，非常困惑。 */}
        {sidebarVisible && (
          <PaneResizer
            pane="sidebar"
            value={paneSizes.sidebar}
            onChange={(next) => setPaneLive('sidebar', next)}
            onCommit={(next) => commitPane('sidebar', next)}
          />
        )}
        <MainWorkspace
          sessions={sessions}
          activeId={activeId}
          dragOver={dragOverTerminal}
          onDragOver={handleTerminalDragOver}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDragOverTerminal(false)
          }}
          onDrop={handleTerminalDrop}
          onNewConnection={openNewConnection}
        />
        {/* 命令栏分隔条：与左侧同理，收起时不渲染（否则 6px 热区留在窗口边缘） */}
        {commandRailVisible && (
          <PaneResizer
            pane="commandRail"
            value={paneSizes.commandRail}
            onChange={(next) => setPaneLive('commandRail', next)}
            onCommit={(next) => commitPane('commandRail', next)}
          />
        )}
        <CommandRail width={paneSizes.commandRail} onEdit={openCommandEditor} />
      </div>

      {/* ================= 状态栏（28px） ================= */}
      <StatusBar />

      {/* 全局传输进度浮层：不依赖文件管理面板，长文件下载也能随时看到进度 */}
      <TransferProgressDock />

      {/* ================= 弹窗层 ================= */}
      <CommandCenter onEdit={openCommandEditor} />
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
      {/* 按需加载的功能面板：只有对应开关打开时才挂载并拉取 chunk */}
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
 *  自动化测试钩子（仅在 ZM_TEST=1 的验证构建里挂载）
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
      backup: useBackupStore,
      /* 压测要高频开关命令中心、切活动栏视图，直接在 store 层驱动最省事件开销 */
      ui: useUiStore,
      layout: useLayoutStore
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
    probeStartup: () => ({
      panelModulesEvaluated: (window as unknown as { __panelModules?: string[] })?.__panelModules ?? [],
      hasAnyPanelGlobals:
        typeof (window as unknown as { __panelLoaded?: unknown }).__panelLoaded !== 'undefined'
    }),
    /*
     * 造几个假会话，只为量标签条几何。
     *
     * 冒烟环境没有真实 SSH 服务器，标签栏永远是空的 —— 而「标签在绿栏里不满格」
     * 恰恰只有在有标签时才看得见。所以这里直接往 store 里塞几条已连接状态的会话，
     * 标签就会照常渲染。不写数据库、不发 IPC，纯内存。
     */
    seedTabs: (n = 3) =>
      useSessionStore.setState({
        sessions: Array.from({ length: n }, (_, i) => ({
          id: `smoke-tab-${i}`,
          connectionId: `smoke-conn-${i}`,
          connectionName: `设备 ${i + 1}`,
          host: `192.168.1.${10 + i}`,
          username: 'root',
          title: `设备 ${i + 1}`,
          status: 'connected' as const,
          cols: 120,
          rows: 32,
          createdAt: Date.now()
        })),
        activeId: 'smoke-tab-0'
      })
  }
}
