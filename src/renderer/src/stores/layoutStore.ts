import { create } from 'zustand'
import { enterZen, exitZen, reconcileZenOnPaneToggle, type ZenSnapshot } from '@/lib/zenState'

/**
 * 界面外壳的布局状态。
 *
 * 为什么从 sessionStore 拆出来：会话（连了哪些机器、状态如何）和
 * 「哪个面板现在开着」是两件事。放在一起会出现「关掉一个标签导致侧栏
 * 布局重渲染」这类无关耦合，也让布局状态无法在无会话时独立恢复。
 *
 * 结构对齐新版外观：
 *   TitleBar 36px  →  ActivityBar 44px  →  左侧栏（可折叠）  →  主工作区  →  右侧命令栏（可折叠）
 *
 * 左侧栏内容由 activityView 决定（连接 / 文件 / 历史 / 日志 / 隧道），
 * 右侧命令栏是**独立常驻**的一块 —— 执行命令和「看主机名 / 看文件」是
 * 两种并行的高频动作，放进同一个切换位会互相挤走。
 */

export type ActivityView = 'connections' | 'files' | 'history' | 'logs' | 'tunnels' | 'tools'

interface LayoutState {
  /** 当前激活的活动栏条目（决定左侧栏显示什么） */
  activityView: ActivityView
  /** 左侧栏是否展开（折叠后只剩活动栏） */
  sidebarVisible: boolean
  /** 右侧命令栏是否展开 */
  commandRailVisible: boolean
  /** 设置浮层 */
  settingsOpen: boolean
  /**
   * 专注模式：双栏一起收起，只留工作区。
   * 纯内存态（不写 settings、重启即失效）—— 它是「临时看一眼全屏」的动作，
   * 不是需要跨会话记住的偏好。
   */
  zenMode: boolean
  /** 进 Zen 前那一瞬的双栏状态，退出时按它原样还原 */
  zenSnapshot: ZenSnapshot | null

  setActivityView: (view: ActivityView) => void
  /** 点活动栏图标：同一个视图再点一次就收起侧栏（VS Code 的行为） */
  toggleActivityView: (view: ActivityView) => void
  toggleSidebar: () => void
  setSidebarVisible: (visible: boolean) => void
  toggleCommandRail: () => void
  setCommandRailVisible: (visible: boolean) => void
  setSettingsOpen: (open: boolean) => void
  /** 一键进/出专注模式 */
  toggleZenMode: () => void
}

/**
 * 所有「改某一栏可见性」的入口都从这里出去，而不是各写一遍 set。
 *
 * 收口的原因：Zen 里手动展栏要自动退出 Zen，这条规则一旦散落在
 * toggleSidebar / setSidebarVisible / toggleCommandRail / setCommandRailVisible
 * 四处，必然有一处漏调用，表现就是「栏开了但 zenMode 还亮着」。
 */
function panePatch(
  s: LayoutState,
  patch: Partial<ZenSnapshot>
): Pick<LayoutState, 'sidebarVisible' | 'commandRailVisible' | 'zenMode' | 'zenSnapshot'> {
  const next = reconcileZenOnPaneToggle(
    {
      sidebarVisible: s.sidebarVisible,
      commandRailVisible: s.commandRailVisible,
      zenMode: s.zenMode,
      zenSnapshot: s.zenSnapshot
    },
    patch
  )
  return {
    sidebarVisible: next.sidebarVisible,
    commandRailVisible: next.commandRailVisible,
    zenMode: next.zenMode,
    zenSnapshot: next.zenSnapshot
  }
}

export const useLayoutStore = create<LayoutState>()((set, get) => ({
  activityView: 'connections',
  sidebarVisible: true,
  commandRailVisible: true,
  settingsOpen: false,
  zenMode: false,
  zenSnapshot: null,

  setActivityView: (activityView) =>
    set((s) => ({ activityView, ...panePatch(s, { sidebarVisible: true }) })),

  toggleActivityView: (view) => {
    const { activityView, sidebarVisible } = get()
    /*
     * 点当前已激活的条目 = 收起/展开侧栏；点别的条目 = 切过去并展开。
     *
     * 两条分支都必须走 panePatch：活动栏是 Zen 里唯一还露在外面的入口，
     * 用户在这儿点图标就是要展栏，此时不退出 Zen 就会出现
     * 「侧栏开了、zenMode 还亮着、快照也还留着」的半开状态。
     */
    const nextVisible = activityView === view ? !sidebarVisible : true
    set((s) => ({ activityView: view, ...panePatch(s, { sidebarVisible: nextVisible }) }))
  },

  toggleSidebar: () => set((s) => panePatch(s, { sidebarVisible: !s.sidebarVisible })),

  setSidebarVisible: (sidebarVisible) => set((s) => panePatch(s, { sidebarVisible })),

  toggleCommandRail: () => set((s) => panePatch(s, { commandRailVisible: !s.commandRailVisible })),

  setCommandRailVisible: (commandRailVisible) => set((s) => panePatch(s, { commandRailVisible })),

  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),

  toggleZenMode: () => set((s) => (s.zenMode ? exitZen(s.zenSnapshot) : enterZen(s)))
}))
