import { create } from 'zustand'
import type { DeviceProfile, DeviceProfileInput } from '@shared/types'
import { tNow } from '@/i18n/core'
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

/** load() 的请求序号（见 load 里的守卫） */
let loadSeq = 0

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
    /*
     * 序号守卫：togglePanel 与 save/remove 都会触发 load，慢请求后到会盖掉新结果。
     * 典型症状是保存后列表回到保存前（新档案「消失」），过几秒又自己回来。
     */
    const seq = ++loadSeq
    const list = await call(window.api.profiles.list(), {
      errorTitle: tNow('panel.profiles.loadError')
    })
    if (seq !== loadSeq) return
    set((s) => {
      const profiles = list ?? []
      const selectedId =
        s.selectedId && profiles.some((p) => p.id === s.selectedId) ? s.selectedId : null
      return { profiles, loaded: true, selectedId }
    })
  },

  save: async (input) => {
    const saved = await call(window.api.profiles.save(input), {
      errorTitle: tNow('panel.profiles.saveError')
    })
    if (saved) {
      await get().load()
      set({ selectedId: saved.id })
      useToastStore.getState().push({
        kind: 'success',
        title: input.id ? tNow('panel.profiles.updated') : tNow('panel.profiles.created')
      })
    }
    return saved
  },

  remove: async (id) => {
    const ok = await call(window.api.profiles.remove(id), {
      errorTitle: tNow('panel.profiles.removeError')
    })
    if (ok !== null) {
      /*
       * 删除后列表是本地摘的，不重新 load。
       * 但如果此刻有一个更早发出的 load() 还在路上，它回来的旧列表里仍有这条档案 ——
       * 序号推进一位就让那次结果作废，否则被删的档案几秒后又「复活」。
       */
      loadSeq++
      set((s) => ({
        profiles: s.profiles.filter((p) => p.id !== id),
        selectedId: s.selectedId === id ? null : s.selectedId
      }))
    }
  },

  setKeyword: (keyword) => set({ keyword }),
  select: (selectedId) => set({ selectedId })
}))
