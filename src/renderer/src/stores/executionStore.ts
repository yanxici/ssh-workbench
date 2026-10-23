import { create } from 'zustand'
import type { Command, CommandVariable } from '@shared/types'
import { call } from '@/lib/ipc'
import { useCommandStore } from './commandStore'
import { useSessionStore } from './sessionStore'
import { useSettingsStore } from './settingsStore'
import { useToastStore } from './toastStore'

/**
 * 执行流水线（常用命令模块的核心）：
 *
 *   单击命令 → 无活动终端？提示先连接
 *            → 含变量？弹窗填写
 *            → 危险命令（标记 或 命中全局关键词）？二次确认
 *            → 发送命令 + 回车，并写入历史
 */

export interface ExecutionRequest {
  name: string
  /** 命令模板，支持 {{var}} */
  template: string
  variables: CommandVariable[]
  snippetId?: string
  confirmRequired: boolean
  source: 'snippet' | 'manual'
}

interface ExecutionState {
  /** 等待变量填写 */
  pending: ExecutionRequest | null
  pendingValues: Record<string, string>
  /** 等待危险确认 */
  danger: { request: ExecutionRequest; finalText: string; values: Record<string, string> } | null

  requestRun: (request: ExecutionRequest) => void
  setPendingValue: (name: string, value: string) => void
  submitVariables: () => void
  cancelVariables: () => void
  confirmDanger: () => void
  cancelDanger: () => void
}

/** 变量替换：{{ name }} → 值 */
export function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g, (_, name: string) => values[name] ?? '')
}

/** 危险命令检测：命令自身标记 或 命中全局关键词 */
export function isDangerous(finalText: string, confirmRequired: boolean): boolean {
  if (confirmRequired) return true
  const patterns = useSettingsStore.getState().settings.dangerPatterns
  const lower = finalText.toLowerCase()
  return patterns.some((p) => p.trim() && lower.includes(p.trim().toLowerCase()))
}

export const useExecutionStore = create<ExecutionState>()((set, get) => {
  /** 真正发送到活动终端 */
  const send = async (
    request: ExecutionRequest,
    finalText: string,
    values: Record<string, string>
  ): Promise<void> => {
    const store = useSessionStore.getState()
    const session = store.sessions.find((s) => s.id === store.activeId)

    if (!session) {
      useToastStore.getState().push({
        kind: 'warning',
        title: '没有活动终端',
        detail: '请先从左侧打开一个 SSH 连接'
      })
      return
    }
    if (session.status !== 'connected') {
      useToastStore.getState().push({
        kind: 'warning',
        title: '当前终端尚未连接',
        detail: `「${session.title}」状态：${session.status}`
      })
      return
    }

    const written = await call(window.api.session.write(session.id, `${finalText}\r`), {
      errorTitle: '发送命令失败'
    })
    if (written === null) return

    // 热度打点：「最近 / 最常用」的数据全靠这里。
    // 先本地自增让命令中心的排序立刻反映本次执行，再异步落盘（不阻塞发送）。
    if (request.snippetId) {
      useCommandStore.getState().bumpUseCount(request.snippetId)
      void call(window.api.command.touch(request.snippetId), { silent: true })
    }

    void call(
      window.api.history.add({
        sessionId: session.id,
        connectionId: session.connectionId,
        connectionName: session.connectionName,
        command: finalText,
        variables: Object.keys(values).length > 0 ? values : undefined,
        source: request.source,
        snippetId: request.snippetId,
        executedAt: Date.now()
      }),
      { silent: true }
    )
  }

  /** 变量已齐备（或无需变量）后的下一步：危险检查 → 发送 */
  const proceed = (
    request: ExecutionRequest,
    values: Record<string, string>
  ): void => {
    const finalText = renderTemplate(request.template, values)
    if (isDangerous(finalText, request.confirmRequired)) {
      set({ danger: { request, finalText, values } })
      return
    }
    void send(request, finalText, values)
  }

  return {
    pending: null,
    pendingValues: {},
    danger: null,

    requestRun: (request) => {
      const store = useSessionStore.getState()
      const session = store.sessions.find((s) => s.id === store.activeId)

      if (!session) {
        useToastStore.getState().push({
          kind: 'warning',
          title: '没有活动终端',
          detail: '请先从左侧双击一个连接，打开 SSH 会话'
        })
        return
      }

      // 提取模板中实际出现的变量（定义中未声明但模板里用到的，也纳入询问）
      const declared = new Map(request.variables.map((v) => [v.name, v]))
      const used = new Set<string>()
      for (const m of request.template.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
        used.add(m[1])
      }
      const variables: CommandVariable[] = [...used].map(
        (name) => declared.get(name) ?? { name, type: 'text', required: true }
      )

      const effective: ExecutionRequest = { ...request, variables }
      if (variables.length === 0) {
        proceed(effective, {})
        return
      }

      const values: Record<string, string> = {}
      for (const v of variables) values[v.name] = v.defaultValue ?? ''
      set({ pending: effective, pendingValues: values })
    },

    setPendingValue: (name, value) =>
      set((s) => ({ pendingValues: { ...s.pendingValues, [name]: value } })),

    submitVariables: () => {
      const { pending, pendingValues } = get()
      if (!pending) return
      const missing = pending.variables.filter(
        (v) => v.required && !(pendingValues[v.name] ?? '').trim()
      )
      if (missing.length > 0) {
        useToastStore.getState().push({
          kind: 'warning',
          title: `请填写：${missing.map((v) => v.label ?? v.name).join('、')}`
        })
        return
      }
      set({ pending: null, pendingValues: {} })
      proceed(pending, pendingValues)
    },

    cancelVariables: () => set({ pending: null, pendingValues: {} }),

    confirmDanger: () => {
      const { danger } = get()
      if (!danger) return
      set({ danger: null })
      void send(danger.request, danger.finalText, danger.values)
    },

    cancelDanger: () => set({ danger: null })
  }
})

/** 近期执行记录：防止快速双击同一命令造成重复发送 */
let lastSnippetRun = { id: '', ts: 0 }

/** 从常用命令发起执行（面板单击入口） */
export function runCommand(command: Command): void {
  const now = Date.now()
  if (lastSnippetRun.id === command.id && now - lastSnippetRun.ts < 400) return
  lastSnippetRun = { id: command.id, ts: now }
  useExecutionStore.getState().requestRun({
    name: command.name,
    template: command.command,
    variables: command.variables,
    snippetId: command.id,
    confirmRequired: command.confirmRequired,
    source: 'snippet'
  })
}
