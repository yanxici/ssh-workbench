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
  /**
   * 弹窗弹出时锁定的目标会话。
   *
   * 没有它的话，填变量的几秒里切标签（点系统通知、Ctrl+Tab）就会把命令
   * 打到新活动主机上 —— 与 danger.sessionId 同一个坑，只是这条路径更隐蔽：
   * 变量框的「发送到终端」看起来永远发往「这台」机器。
   */
  pendingSessionId: string | null
  /** 等待危险确认 */
  /**
   * danger.sessionId 锁定「弹窗弹出时的那台主机」。
   * 没有它的话，确认时用的是最新 activeId —— 弹窗期间按 Ctrl+Tab 或点系统通知
   * 切了标签，rm -rf / reboot 就会直接打到另一台机器上。
   */
  danger: {
    request: ExecutionRequest
    finalText: string
    values: Record<string, string>
    sessionId: string
  } | null

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
    sessionId: string,
    request: ExecutionRequest,
    finalText: string,
    values: Record<string, string>
  ): Promise<void> => {
    const store = useSessionStore.getState()
    const session = store.sessions.find((s) => s.id === sessionId)

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
    sessionId: string,
    request: ExecutionRequest,
    values: Record<string, string>
  ): void => {
    const finalText = renderTemplate(request.template, values)
    if (isDangerous(finalText, request.confirmRequired)) {
      set({ danger: { request, finalText, values, sessionId } })
      return
    }
    void send(sessionId, request, finalText, values)
  }

  return {
    pending: null,
    pendingValues: {},
    pendingSessionId: null,
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
      const sessionId = session.id
      if (variables.length === 0) {
        proceed(sessionId, effective, {})
        return
      }

      const values: Record<string, string> = {}
      for (const v of variables) values[v.name] = v.defaultValue ?? ''
      set({ pending: effective, pendingValues: values, pendingSessionId: sessionId })
    },

    setPendingValue: (name, value) =>
      set((s) => ({ pendingValues: { ...s.pendingValues, [name]: value } })),

    submitVariables: () => {
      const { pending, pendingValues, pendingSessionId } = get()
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
      if (!pendingSessionId) {
        set({ pending: null, pendingValues: {}, pendingSessionId: null })
        return
      }
      /*
       * 目标会话已经关了（或掉线）就放弃，绝不退回 activeId：
       * 那正是这条锁定要防的事 —— 把命令发给「此刻恰好在前台」的机器。
       */
      const target = useSessionStore.getState().sessions.find((s) => s.id === pendingSessionId)
      if (!target || target.status !== 'connected') {
        set({ pending: null, pendingValues: {}, pendingSessionId: null })
        useToastStore.getState().push({
          kind: 'warning',
          title: '目标终端已关闭，命令未发送',
          detail: '请重新选择终端后再执行'
        })
        return
      }
      set({ pending: null, pendingValues: {}, pendingSessionId: null })
      proceed(pendingSessionId, pending, pendingValues)
    },

    cancelVariables: () => set({ pending: null, pendingValues: {}, pendingSessionId: null }),

    confirmDanger: () => {
      const { danger } = get()
      if (!danger) return
      set({ danger: null })
      /*
       * 发往触发弹窗时锁定的那台主机，而不是此刻的 activeId。
       * 目标已经不在线时宁可放弃，也不能「就近」打到别的机器上。
       */
      const store = useSessionStore.getState()
      const target = store.sessions.find((s) => s.id === danger.sessionId)
      if (!target || target.status !== 'connected') {
        useToastStore.getState().push({
          kind: 'warning',
          title: '目标设备已断开，危险操作已取消',
          detail: '请重新在目标终端上执行'
        })
        return
      }
      void send(danger.sessionId, danger.request, danger.finalText, danger.values)
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
