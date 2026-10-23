import { create } from 'zustand'
import type { Connection, ConnectionInput } from '@shared/types'

/**
 * 轻量 UI 全局状态：
 *   - 连接编辑器跨面板呼出（设备发现 / 剪贴板解析等处带预设打开）
 *   - 命令中心（Ctrl+K）浮层，键盘与任意面板都能唤起
 */

interface UiState {
  connEditorOpen: boolean
  editingConn: Connection | null
  connPreset?: Partial<ConnectionInput>

  /** 命令中心浮层是否打开 */
  commandCenterOpen: boolean
  /** 打开时预填的搜索词（右键「在命令中心中查找」用） */
  commandCenterQuery: string

  openConnEditor: (initial?: Connection | null, preset?: Partial<ConnectionInput>) => void
  closeConnEditor: () => void

  openCommandCenter: (query?: string) => void
  closeCommandCenter: () => void
  toggleCommandCenter: () => void
}

export const useUiStore = create<UiState>()((set, get) => ({
  connEditorOpen: false,
  editingConn: null,
  connPreset: undefined,

  commandCenterOpen: false,
  commandCenterQuery: '',

  openConnEditor: (initial = null, preset = undefined) =>
    set({ connEditorOpen: true, editingConn: initial, connPreset: preset }),

  closeConnEditor: () => set({ connEditorOpen: false }),

  openCommandCenter: (query = '') => set({ commandCenterOpen: true, commandCenterQuery: query }),

  closeCommandCenter: () => set({ commandCenterOpen: false, commandCenterQuery: '' }),

  toggleCommandCenter: () => {
    const open = get().commandCenterOpen
    set(open ? { commandCenterOpen: false, commandCenterQuery: '' } : { commandCenterOpen: true })
  }
}))
