/**
 * 「哪个会话是别的标签里的分屏格」的共享索引。
 *
 * 为什么单独一个零依赖模块：TabBar 要据它把嵌套 pane 从标签栏里过滤掉，
 * sessionStore.cycle 要据它跳过嵌套 pane（否则 Ctrl+Tab 会在同一屏的两格里
 * 反复横跳，看起来像卡住了），而这两处都不能去 import splitStore ——
 * splitStore 反过来要 import sessionStore（分屏时要开新 shell），
 * 直接互相 import 会形成循环依赖，zustand 的 store 初始化顺序会踩空。
 *
 * 索引只由 splitStore 写，其他地方只读。值语义在 splitStore.reindex() 里统一刷新。
 */

const owner = new Map<string, string>()

export function resetPaneIndex(): void {
  owner.clear()
}

export function setPaneOwner(sessionId: string, ownerId: string): void {
  owner.set(sessionId, ownerId)
}

/** 该会话是否是某个标签里的嵌套分屏格（不含标签自身那一格） */
export function isNestedPane(sessionId: string): boolean {
  const o = owner.get(sessionId)
  return o !== undefined && o !== sessionId
}

/** 该会话所属标签的 id；独立标签返回自己 */
export function paneOwnerOf(sessionId: string): string {
  return owner.get(sessionId) ?? sessionId
}

export function nestedPaneIds(): string[] {
  return [...owner.entries()].filter(([id, o]) => id !== o).map(([id]) => id)
}
