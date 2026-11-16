import { useSettingsStore } from '@/stores/settingsStore'
import type { TokenPanel } from '@shared/types'

/**
 * 设计 token 的面板级灰度开关。
 *
 * 为什么是 hook 而不是一个常量：
 *   flag 存在 settings 里，切换后要**立即**重渲染受影响的面板。
 *   写成 hook 才能让 React 订阅到变化；写成模块级常量就只能在重启后生效。
 *
 * 为什么订阅的是单个布尔而不是整个 experimental 对象：
 *   订阅整个对象会让「任一面板的 flag 变了」都触发全部面板重渲染。
 *   这里每个面板只关心自己那一位。
 */
export function useTokenFlag(panel: TokenPanel): boolean {
  return useSettingsStore((s) => s.settings.experimental?.tokens?.[panel] === true)
}
/** 面板无关的全局开关（预留：将来若需要「全部面板一起开」的快捷键） */
export function useAnyTokenFlag(): boolean {
  return useSettingsStore((s) => {
    const t = s.settings.experimental?.tokens
    return Boolean(t && (t.terminal || t.sftp || t.connections || t.commandPanel || t.statusBar))
  })
}
