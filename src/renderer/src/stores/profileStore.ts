import { create } from 'zustand'
import type { DeviceProfile, DeviceProfileInput } from '@shared/types'
import { call } from '@/lib/ipc'
import { useToastStore } from './toastStore'

/**
 * 客户 / 设备档案状态。
 * 档案与连接（connectionIds）、常用命令（commandGroup）、诊断报告（按连接名反查）相关联。
 */

interface ProfileState {
  panelOpen: boolean
  profiles: DeviceProfile[]
  loaded: boolean
  keyword: string
  selectedId: string | null

  togglePanel: () => void
  load: () => Promise<void>
  save: (input: DeviceProfileInput) => Promise<DeviceProfile | null>
  remove: (id: string) => Promise<void>
  setKeyword: (kw: string) => void
  select: (id: string | null) => void
}

export const useProfileStore = create<ProfileState>()((set, get) => ({
  panelOpen: false,
  profiles: [],
  loaded: false,
  keyword: '',
  selectedId: null,

  togglePanel: () => {
    const next = !get().panelOpen
    set({ panelOpen: next })
    if (next) void get().load()
  },

  load: async () => {
    const list = await call(window.api.profiles.list(), { errorTitle: '加载档案失败' })
    set((s) => {
      const profiles = list ?? []
      const selectedId =
        s.selectedId && profiles.some((p) => p.id === s.selectedId) ? s.selectedId : null
      return { profiles, loaded: true, selectedId }
    })
  },

  save: async (input) => {
    const saved = await call(window.api.profiles.save(input), { errorTitle: '保存档案失败' })
    if (saved) {
      await get().load()
      set({ selectedId: saved.id })
      useToastStore.getState().push({
        kind: 'success',
        title: input.id ? '档案已更新' : '档案已创建'
      })
    }
    return saved
  },

  remove: async (id) => {
    const ok = await call(window.api.profiles.remove(id), { errorTitle: '删除档案失败' })
    if (ok !== null) {
      set((s) => ({
        profiles: s.profiles.filter((p) => p.id !== id),
        selectedId: s.selectedId === id ? null : s.selectedId
      }))
    }
  },

  setKeyword: (keyword) => set({ keyword }),
  select: (selectedId) => set({ selectedId })
}))
