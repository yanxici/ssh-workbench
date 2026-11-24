/**
 * Zen 专注模式的纯状态机。
 *
 * 为什么单独放一个文件而不是塞进 layoutStore：
 * 1. 这段逻辑是**纯函数**（输入旧状态、输出新状态），不碰 zustand、不碰 React，
 *    所以 verify-p2-theme-zen.cjs 能直接 bundle 出来断言，不需要起 Electron；
 * 2. 进入/退出/Pane 联动的规则集中在一处，store 只负责「把结果 set 进去」，
 *    避免同一条规则在 toggleSidebar / setSidebarVisible / toggleZenMode 里各抄一遍
 *    （抄三遍必然有一遍漏掉，漏掉的那次就是「Zen 里点了侧栏，界面开了但状态还停在 Zen」）。
 *
 * 不落盘：zenMode 是会话级的临时视图，重启后回到双栏常态。
 */

/** 进入 Zen 前那一瞬的双栏状态 —— 退出时按它原样还原 */
export interface ZenSnapshot {
  sidebarVisible: boolean
  commandRailVisible: boolean
}

/** 与布局 store 共享的那几个字段 */
export interface ZenLayoutState extends ZenSnapshot {
  zenMode: boolean
  zenSnapshot: ZenSnapshot | null
}

/**
 * 进入 Zen：把当前双栏状态记进快照，然后双双收起。
 *
 * 快照必须存「开启前」的值而不是写死 true：用户可能本来就收着命令栏，
 * 写死 true 会在他退出 Zen 时凭空多开一栏。
 */
export function enterZen(cur: ZenSnapshot): ZenLayoutState {
  return {
    sidebarVisible: false,
    commandRailVisible: false,
    zenMode: true,
    zenSnapshot: { sidebarVisible: cur.sidebarVisible, commandRailVisible: cur.commandRailVisible }
  }
}

/**
 * 退出 Zen：按快照还原双栏并清空快照。
 *
 * 快照为空时（正常路径不会发生，防手动改 store 的脏状态）退回双栏常开，
 * 总好过把界面留在两栏都收着的「假 Zen」里。
 */
export function exitZen(snapshot: ZenSnapshot | null): ZenLayoutState {
  return {
    sidebarVisible: snapshot ? snapshot.sidebarVisible : true,
    commandRailVisible: snapshot ? snapshot.commandRailVisible : true,
    zenMode: false,
    zenSnapshot: null
  }
}

/**
 * 手动改任一栏可见性时的联动。
 *
 * 「手动展开」说明用户此刻想看的正是那一栏 —— 那就不该继续假装专注，
 * 于是自动退出 Zen。**只有展开才触发**：Zen 里再收起（本来就已经收着）
 * 不该被当成退出信号。
 *
 * 退出时先按快照还原再叠加用户这次的动作：退出 Zen 的语义是「回到常态」，
 * 而不是「把另一栏也留在我刚才藏起来的样子」。
 */
export function reconcileZenOnPaneToggle<T extends ZenLayoutState>(
  cur: T,
  patch: Partial<ZenSnapshot>
): T & ZenLayoutState {
  const opens = patch.sidebarVisible === true || patch.commandRailVisible === true
  if (cur.zenMode && opens) {
    return { ...cur, ...exitZen(cur.zenSnapshot), ...patch }
  }
  return { ...cur, ...patch }
}
