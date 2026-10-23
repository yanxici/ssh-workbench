import { create } from 'zustand'

/**
 * 界面外壳的布局状态。
 *
 * 为什么从 sessionStore 拆出来：会话（连了哪些机器、状态如何）和
 * 「哪个面板现在开着」是两件事。放在一起会出现「关掉一个标签导致侧栏
 * 布局重渲染」这类无关耦合，也让布局状态无法在无会话时独立恢复。
 *
 * 结构对齐新版外观：
 *   TitleBar 44px  →  ActivityBar 48px  →  左侧栏（可折叠）  →  主工作区  →  右侧命令栏（可折叠）
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

  setActivityView: (view: ActivityView) => void
  /** 点活动栏图标：同一个视图再点一次就收起侧栏（VS Code 的行为） */
  toggleActivityView: (view: ActivityView) => void
  toggleSidebar: () => void
  toggleCommandRail: () => void
  setCommandRailVisible: (visible: boolean) => void
  setSettingsOpen: (open: boolean) => void
}

export const useLayoutStore = create<LayoutState>()((set, get) => ({
  activityView: 'connections',
  sidebarVisible: true,
  commandRailVisible: true,
  settingsOpen: false,

  setActivityView: (activityView) => set({ activityView, sidebarVisible: true }),

  toggleActivityView: (view) => {
    const { activityView, sidebarVisible } = get()
    // 点当前已激活的条目 = 收起/展开侧栏；点别的条目 = 切过去并展开
    if (activityView === view) set({ sidebarVisible: !sidebarVisible })
    else set({ activityView: view, sidebarVisible: true })
  },

  toggleSidebar: () => set((s) => ({ sidebarVisible: !s.sidebarVisible })),

  toggleCommandRail: () => set((s) => ({ commandRailVisible: !s.commandRailVisible })),

  setCommandRailVisible: (commandRailVisible) => set({ commandRailVisible }),

  setSettingsOpen: (settingsOpen) => set({ settingsOpen })
}))
