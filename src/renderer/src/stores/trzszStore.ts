import { create } from 'zustand'
import type { TrzszTransferState } from '@shared/types'

/**
 * trzsz 传输状态的渲染层镜像（只用于状态条与提示）。
 *
 * 为什么不复用 sftpStore.transfers：SFTP 那套是本地发起的字节级任务（有 total、
 * 能暂停续传、断了还能重试），而 trzsz 的进度是远端打字打出来的，我们只能从
 * 进度条文本里抠百分比。把它们塞进同一张表，状态条要么显示假数据（total=0 导致
 * 百分比永远 0%），要么到处都是判空分支。
 *
 * 这里刻意只存「当前有没有在传、传什么、多少」，不留历史 —— 传输结束后
 * 状态条那一段直接消失，用户不需要一个"已完成但还挂着"的条目。
 */
interface TrzszState {
  /** sessionId -> 该会话当前的传输状态（active=false 时也会保留一小会儿用于收尾文案） */
  bySession: Record<string, TrzszTransferState>
  apply: (sessionId: string, state: TrzszTransferState) => void
  clear: (sessionId: string) => void
}

export const useTrzszStore = create<TrzszState>((set) => ({
  bySession: {},

  apply: (sessionId, state) =>
    set((s) => {
      /*
       * active=false 且没有文件名时直接删键，而不是存一条「不活跃」记录：
       * 状态条按 Object.values 判空，留着会让「传输中」那一段永远显示成 0%。
       */
      if (!state.active && !state.file && state.percent === undefined) {
        if (!(sessionId in s.bySession)) return s
        const next = { ...s.bySession }
        delete next[sessionId]
        return { bySession: next }
      }
      return { bySession: { ...s.bySession, [sessionId]: state } }
    }),

  clear: (sessionId) =>
    set((s) => {
      if (!(sessionId in s.bySession)) return s
      const next = { ...s.bySession }
      delete next[sessionId]
      return { bySession: next }
    })
}))

/** 取某个会话的传输状态（没有则 undefined） */
export function useTrzszOf(sessionId: string | null): TrzszTransferState | undefined {
  return useTrzszStore((s) => (sessionId ? s.bySession[sessionId] : undefined))
}
