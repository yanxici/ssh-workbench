import type * as React from 'react'
import { useEffect, useRef, useState, type DragEvent } from 'react'
import { installErrorReporter } from '@/lib/errorReporter'
import { lazy, Suspense } from 'react'
import type { Command, ConnectionInput } from '@shared/types'
import { useSettingsStore } from '@/stores/settingsStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { useCommandStore } from '@/stores/commandStore'
import { feedZmodem, isZmodemAttached } from '@/lib/zmodem'
import { clearSession as clearHighlight, writeSessionData } from '@/lib/highlightRuntime'
import {
  flashSession,
  noteSessionOutput,
  startHeuristicSweep,
  stopHeuristicSweep
} from '@/lib/taskNotify'
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
import { useTftpStore } from '@/stores/tftpStore'
import { useUiStore } from '@/stores/uiStore'
import { matchShortcut, matchShortcutIgnoringShift, resolveShortcuts } from '@/lib/shortcuts'
import { isCommandDrag, readDraggedCommandId, stripDragPayload } from '@/lib/commandDrag'
import { SettingsPanel } from '@/components/settings/SettingsPanel'
import { DangerConfirmDialog, VariablePromptDialog } from '@/components/execution/ExecutionDialogs'
import { ToastHost } from '@/components/ui'
import { useSplitStore } from '@/stores/splitStore'
import { useTrzszStore } from '@/stores/trzszStore'
import { layoutPaneTree, leafIds, neighbor } from '@/lib/paneTree'

/**
 * 重量级功能面板改为按需加载。
 *
 * 这些面板即使都自带 `if (!open) return null` 守卫、不产生渲染开销，
 * 代码本身仍会全部打进首包并在启动时求值。拆出去之后只有真正打开时才取 chunk。
 * 注意：挂载条件必须与面板自身的守卫一致，否则会破坏它们首次打开时的
 * 数据加载副作用（如 diag 的 loadSections）。
 */
/**
 * 面板 chunk 的空闲预加载与骨架兜底（阶段 2）。
 *
 * lazy() 本身不变 —— 它负责「按需拆包」；本阶段补的是「切换时不该白屏」：
 *   - 启动后空闲时把其余面板的 chunk 逐步拉下来（prefetchPanelsIdle）；
 *   - 真没加载完时才用 PanelSkeleton 兜底，骨架尺寸与真实面板一致。
 */
import { PanelSkeleton } from './components/panels/PanelSkeleton'
import { panelIdFor, prefetchPanelsIdle } from './lib/panelPrefetch'

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
 * 把焦点移到当前分屏格的相邻格。
 *
 * 完全没有分屏时返回 false —— 调用方据此决定**不吃掉**这次按键：
 * Ctrl+Alt+←/→ 在没有分屏的终端里本来就是「按词移动光标」的常见绑定，
 * 单格时拦下来会莫名其妙没反应。
 * 相邻格的计算放在 paneTree 里按矩形算，不读 DOM rect ——
 * 隐藏标签 display:none 时量不到尺寸，读 DOM 会立刻退化。
 */
function focusSiblingPane(dir: 'left' | 'right' | 'up' | 'down'): boolean {
  const { activeId, setActive } = useSessionStore.getState()
  if (!activeId) return false
  const { trees } = useSplitStore.getState()
  for (const node of Object.values(trees)) {
    if (!leafIds(node).includes(activeId)) continue
    const target = neighbor(layoutPaneTree(node).rects, activeId, dir)
    if (!target) return false
    setActive(target)
    return true
  }
  return false
}

/**
 * 应用外壳。
 *
 * 新版结构（严格按视觉规范落地）：
 *   TitleBar 44px（品牌绿底）
 *   ├─ ActivityBar 48px │ SideNav 280px（可折叠）│ MainWorkspace（终端）│ CommandRail 400px（可折叠）
 *   StatusBar 28px
 *
 * 与旧版的差别不只是配色：旧版把「连接 / 文件树 / 命令」三栏同时铺开，
 * 1280 宽的窗口里终端只剩 500px 出头；中间那版把三者收进同一个侧栏位置，
 * 终端宽了但「边看主机名边点命令」要来回切视图。现在左侧只留一个可切换的
 * 导航栏，命令栏常驻右侧 —— 两者本来就是并行信息。
 */
export function App(): React.JSX.Element {
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
  /*
   * 骨架标题：从「当前打开的面板」反推，让兜底时不出现「加载中…」这种无信息文案。
   * 用 panelIdFor 而不是自己判断顺序，保证与下面的挂载顺序是同一份真相。
   */
  const openMap = {
    sftp: sftpOpen,
    diag: diagOpen,
    batch: batchOpen,
    profile: profileOpen,
    metrics: metricsOpen,
    firmware: firmwareOpen,
    discovery: discoveryOpen,
    backup: backupOpen
  }
  const currentPanel = panelIdFor(openMap)
  const PANEL_TITLES: Record<string, string> = {
    sftp: '文件',
    diag: '一键诊断巡检',
    batch: '批量执行',
    profile: '客户 / 设备档案',
    metrics: '资源仪表盘',
    firmware: '固件升级助手',
    discovery: '设备发现',
    backup: '配置备份对比'
  }
  const panelSkeletonTitle = currentPanel ? PANEL_TITLES[currentPanel] : undefined

  /*
   * 空闲预加载：启动后把尚未加载的面板 chunk 逐步拉下来，并排除当前面板
   * （它正在加载，不该再排一次队）。切换面板时重跑一次，把「刚用的这个」排除掉。
   *
   * 依赖 currentPanel：用户切面板说明带宽/CPU 该优先给这个新面板，
   * 预加载队列要重新排。cancel 在清理里调用，避免多条队列并行。
   */
  useEffect(() => {
    const handle = prefetchPanelsIdle(currentPanel)
    return () => handle.cancel()
  }, [currentPanel])



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

  /* ---------- 分屏树：会话连上后按连接恢复，会话消失后摘格 ---------- */
  useEffect(() => {
    /*
     * 两件事合在一个 effect 里，因为它们看的是同一份数据（会话列表）：
     *
     *   reconcile   会话被关掉（断线后手动关、批量执行后清理）时，
     *               树里留下的空叶子要摘掉；否则那一格永远是一块黑。
     *               它自己判「有没有变化」，没变化直接 return，不会触发重渲染。
     *
     *   restoreFor  会话进入 connected 才有必要补开 shell；
     *               restoreSessions 关掉时不恢复 —— 用户的意思就是「别记账」。
     */
    useSplitStore.getState().reconcile()
    if (!settings?.restoreSessions) return
    const layout = settings.splitLayout
    if (!layout || Object.keys(layout).length === 0) return
    for (const s of sessions) {
      if (s.status !== 'connected') continue
      if (!layout[s.connectionId]) continue
      useSplitStore.getState().restoreFor(s.id)
    }
  }, [sessions, settings?.restoreSessions, settings?.splitLayout])

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

  /*
   * 启发式通知的巡检定时器。
   *
   * 挂在 mounted 上而不是跟设置走：定时器内部每轮自己读一次偏好，
   * 关掉启发式时那个 tick 直接 return —— 比"开关变化时启停定时器"少一条
   * 容易漏写的同步路径（比如用户从设置面板里关掉，这里没收到通知）。
   */
  useEffect(() => {
    startHeuristicSweep()
    return () => stopHeuristicSweep()
  }, [])

  /* ---------- 主进程事件 -> 终端写入 / 会话状态 ---------- */
  useEffect(() => {
    const offData = window.api.on.sessionData(({ sessionId, data, raw }) => {
      /*
       * 先记账再写终端：启发式"终端静默即疑似结束"靠这个时间戳判定。
       * 放在最前面是因为 ZMODEM 分支会 return —— 传输期间的字节同样说明
       * "设备还活着、还在干活"，不该被当成静默。
       */
      noteSessionOutput(sessionId)
      // ZMODEM 的 Sentry 挂在每个会话上（见 ensureZmodem），
      // 它的 to_terminal 负责把「非协议字节」写进终端；
      // 因此这里只把原始字节交给 Sentry，不再直接写终端，避免重复输出。
      if (isZmodemAttached(sessionId)) {
        feedZmodem(sessionId, raw, data)
        return
      }
      /*
       * 走 writeSessionData 而不是直接 term.write：
       * 它内部先跑高亮规则（剥 ANSI、切行、匹配），命中行再挂 xterm 装饰，
       * 最后统一写终端。写与染色共用同一次 write 的回调，marker 偏移才不会错行。
       */
      writeSessionData(sessionId, terminalRegistry.get(sessionId)?.term, data)
    })
    const offStatus = window.api.on.sessionStatus(({ sessionId, status, error, phase }) => {
      useSessionStore.getState().updateStatus(sessionId, status, error, phase)
      /*
       * 断开时清掉该会话的染色。
       *
       * 断线遮罩是半透明的（bg-app/88），底下的染色行会透出来 ——
       * 用户看到的是「已经断了，还在报错」，实际上那些红行是断之前的历史输出。
       * 重连成功后的新行会照常重新染色。
       */
      if (status === 'disconnected' || status === 'error') clearHighlight(sessionId)
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
    // 内置 TFTP 服务端日志：串口刷机引导条靠它显示 RRQ / 重传 / 完成
    const offTftpLog = window.api.on.tftpLog((e) => {
      useTftpStore.getState().applyLog(e)
    })
    // SFTP 上传/下载进度：这是进度条的数据入口，缺失时任务永远停在 pending
    const offTransfer = window.api.on.transferProgress((e) => {
      useSftpStore.getState().applyProgress(e)
    })
    // 应用更新状态：主进程每次推全量快照，这里直接覆盖
    const offUpdate = window.api.on.updateStatus((e) => {
      useUpdateStore.getState().applyEvent(e)
    })
    /*
     * 用户点了系统通知：主进程已经把窗口提到前台，这里只做两件事 ——
     * 切到那个会话，并在标签上闪一下。
     *
     * 闪一下不是装饰：窗口被提到前台时用户的眼睛还在操作中心那一侧，
     * 切标签只是"内容变了"，闪一下才是"就是这一台"。
     */
    const offNotifyClick = window.api.on.notifyClick(({ sessionId }) => {
      useSessionStore.getState().setActive(sessionId)
      flashSession(sessionId)
    })
    /*
     * trzsz 传输状态：只喂状态条。
     *
     * 进度条本身不在这里 —— 它是普通终端文本，主进程已经把 writeToTerminal 的内容
     * 混进会话数据下发了（回滚、搜索、录制都能看到它）。这条通道只送「有没有在传、
     * 传哪个文件、多少」，避免渲染层再去解析那串带 \r 重绘的文本。
     */
    const offTrzszState = window.api.on.trzszState(({ sessionId, ...state }) => {
      useTrzszStore.getState().apply(sessionId, state)
      /*
       * 远端没装 trz/tsz：只在真的尝试过之后才提示（notice 由主进程判定，
       * 依据是 shell 报 command not found 或 uploadFiles 三秒没起来）。
       * 不主动探测是有意的 —— 每连一台机器多半秒，换一条几乎用不到的提示，不划算。
       */
      if (state.notice === 'no-remote-trz') {
        useToastStore.getState().push({
          kind: 'warning',
          title: '远端没有 trz / tsz',
          detail: '这台机器的 trzsz 没装或不在 PATH 上：apt install trzsz（Debian/Ubuntu）或 brew install trzsz'
        })
      }
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
      offTftpLog()
      offTransfer()
      offUpdate()
      offNotifyClick()
      offTrzszState()
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
      } else if (matchShortcut(e, map.paneLeft) && focusSiblingPane('left')) {
        consume()
      } else if (matchShortcut(e, map.paneRight) && focusSiblingPane('right')) {
        consume()
      } else if (matchShortcut(e, map.paneUp) && focusSiblingPane('up')) {
        consume()
      } else if (matchShortcut(e, map.paneDown) && focusSiblingPane('down')) {
        consume()
      } else if (matchShortcut(e, map.nextTab)) {
        consume()
        useSessionStore.getState().cycle(e.shiftKey ? -1 : 1)
      } else if (matchShortcutIgnoringShift(e, map.nextTab)) {
        /*
         * Ctrl+Shift+Tab = 上一个标签。
         * 上面分支的精确比对要求 shift 一致，nextTab 默认是 Ctrl+Tab（无 shift），
         * 所以 Ctrl+Shift+Tab 根本命中不了 —— 那个 `? -1 : 1` 的反向分支是死代码。
         * 这里补一个忽略 shift 的兜底，专门承接反向切换。
         */
        consume()
        useSessionStore.getState().cycle(-1)
      } else if (e.ctrlKey && e.shiftKey && !e.altKey && e.key.toLowerCase() === 't') {
        consume()
        const { activeId: current, openTerminal } = useSessionStore.getState()
        if (current) openTerminal(current)
      } else if (matchShortcut(e, map.closeTab)) {
        consume()
        /*
         * 走 splitStore.closePane：有分屏时只关焦点那一格（树收缩），
         * 没分屏时它内部直接 close(id)。用户按 Ctrl+Shift+W 想看的是
         * 「关掉我正在看的这个」，而不是「连带另三格一起关」。
         */
        const { activeId: current } = useSessionStore.getState()
        if (current) useSplitStore.getState().closePane(current)
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
      {/*
        * 按需加载的功能面板：只有对应开关打开时才挂载并拉取 chunk。
        *
        * fallback 从 null 换成了 PanelSkeleton：null 会让「首次切换」直接白屏，
        * 而白屏正是本阶段要消灭的现象。骨架只在预加载没赶上时才出现。
        */}
      <div
        data-panel-current={currentPanel ?? ''}
        className="contents"
      >
      <Suspense fallback={<PanelSkeleton title={panelSkeletonTitle} />}>
        {sftpOpen && <FileManagerPanel />}
        {diagOpen && <DiagnosticsPanel />}
        {batchOpen && <BatchPanel />}
        {profileOpen && <ProfilesPanel />}
        {metricsOpen && <MetricsPanel />}
        {firmwareOpen && <FirmwarePanel />}
        {discoveryOpen && <DiscoveryPanel />}
        {backupOpen && <BackupPanel />}
      </Suspense>
      </div>
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
    /* 终端实例注册表：让验证脚本能读到 xterm 的 buffer 文本。
       仅在 ZM_TEST 构建里挂载，生产构建没有这个全局。 */
    terminals: terminalRegistry,
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
          kind: 'ssh' as const,
          target: `root@192.168.1.${10 + i}`,
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