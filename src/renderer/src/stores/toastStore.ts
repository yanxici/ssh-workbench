import { create } from 'zustand'
import { uid } from '@/lib/utils'

export type ToastKind = 'info' | 'success' | 'warning' | 'error'

export interface Toast {
  id: string
  kind: ToastKind
  title: string
  detail?: string
  leaving?: boolean
}

interface ToastState {
  toasts: Toast[]
  push: (t: Omit<Toast, 'id'>) => void
  dismiss: (id: string) => void
}

const TOAST_EXIT_MS = 140

const AUTO_DISMISS: Record<ToastKind, number> = {
  info: 4000,
  success: 3000,
  warning: 6000,
  error: 8000
}

export const useToastStore = create<ToastState>((set, get) => ({
  toasts: [],

  push: (t) => {
    const id = uid()
    const toast: Toast = { ...t, id }
    set((s) => ({ toasts: [...s.toasts, toast] }))
    setTimeout(() => get().dismiss(id), AUTO_DISMISS[t.kind])
  },

  dismiss: (id) => {
    const cur = get().toasts.find((t) => t.id === id)
    if (!cur || cur.leaving) return
    if (
      typeof document !== 'undefined' &&
      document.documentElement.classList.contains('motion-off')
    ) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
      return
    }
    set((s) => ({
      toasts: s.toasts.map((t) => (t.id === id ? { ...t, leaving: true } : t))
    }))
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
    }, TOAST_EXIT_MS)
  }
}))
