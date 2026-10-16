import { create } from 'zustand'
import type { Connection, ConnectionInput } from '@shared/types'

/**
 * 轻量 UI 全局状态：目前用于「连接编辑器」的跨面板呼出
 * （例如设备发现里点"新建连接"、剪贴板解析等处，任意面板都能带预设打开编辑器）。
 */

interface UiState {
  connEditorOpen: boolean
  editingConn: Connection | null
  connPreset?: Partial<ConnectionInput>

  openConnEditor: (initial?: Connection | null, preset?: Partial<ConnectionInput>) => void
  closeConnEditor: () => void
}

export const useUiStore = create<UiState>()((set) => ({
  connEditorOpen: false,
  editingConn: null,
  connPreset: undefined,

  openConnEditor: (initial = null, preset = undefined) =>
    set({ connEditorOpen: true, editingConn: initial, connPreset: preset }),

  closeConnEditor: () => set({ connEditorOpen: false })
}))
