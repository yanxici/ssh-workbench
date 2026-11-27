import type * as React from 'react'
/**
 * ZMODEM 传输交互：
 * - 检测到远端 sz/rz 时弹出确认，用户同意才接管字节流（避免普通输出被误判）
 * - 传输中显示进度，并提供「中断」出口（进度面板按钮 / Esc），
 *   卡住时用户不必再等它自己超时
 * - 完成后短暂停留再自动消失
 *
 * 该组件同时把「确认处理器」注册到 lib/zmodem，使协议层能反过来询问 UI。
 */

import { useEffect, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  FolderOpen,
  Loader2,
  XCircle
} from 'lucide-react'
import {
  watchZmodem,
  setZmodemConfirmHandler,
  abortZmodem,
  getZmodemProgress,
  chooseZmodemSaveDir,
  type ZmodemConfirmResult,
  type ZmodemProgress,
  type ZmodemDirection
} from '@/lib/zmodem'
import { useI18n } from '@/i18n'
import { setZmodemIdentityResolver } from '@/lib/zmodemRecord'
import { terminalRegistry, useSessionStore } from '@/stores/sessionStore'
import { hasOpenOverlay, overlayDepth, useOverlayEscape } from '@/lib/overlayKeys'

interface PendingConfirm {
  direction: ZmodemDirection
  resolve: (res: ZmodemConfirmResult) => void
  sessionName: string
  /** 弹窗属于哪个会话：该会话关掉后弹窗必须自动作废，不能挡住别的会话 */
  sessionId: string
}

export function ZmodemOverlay(): React.JSX.Element | null {
  const { t } = useI18n()
  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeId)

  const [progress, setProgress] = useState<ZmodemProgress | null>(null)
  const [pending, setPending] = useState<PendingConfirm | null>(null)
  const [skipExisting, setSkipExisting] = useState(true)

  // 注册确认处理器：协议层检测到 ZMODEM 时调用
  useEffect(() => {
    setZmodemConfirmHandler(
      (sessionId, direction) =>
        new Promise<ZmodemConfirmResult>((resolve) => {
          const src = useSessionStore.getState().sessions.find((s) => s.id === sessionId)
          const sessionName = src ? src.title || src.host : ''
          setPending((prev) => {
            // 已有一个待确认时，后到的直接拒绝，避免弹窗互相覆盖
            if (prev) {
              resolve(false)
              return prev
            }
            return { direction, resolve, sessionName, sessionId }
          })
        })
    )
    return () => {
      setZmodemConfirmHandler(null)
      // 组件被卸载时若还挂着一个待确认：必须给出答复，否则协议层的
      // await confirm() 永远不返回，整个会话就卡在「等待确认」里出不来。
      setPending((prev) => {
        prev?.resolve(false)
        return null
      })
    }
  }, [])

  /*
   * 传输记录的身份解析器：ZMODEM 的 sessionId 只在本进程有效，
   * 记录里必须换算成 connectionId 才能在重启后还对得上。
   * 放在 UI 层是因为协议层（lib/zmodem）不能依赖会话表 ——
   * 它要被无头测试单独打包，拖着整棵 store 依赖树就跑不起来。
   */
  useEffect(() => {
    setZmodemIdentityResolver((sessionId) => {
      const s = useSessionStore.getState().sessions.find((x) => x.id === sessionId)
      return s
        ? {
            connectionId: s.connectionId,
            connectionName: s.connectionName,
            target: s.target
          }
        : {}
    })
    return () => setZmodemIdentityResolver(null)
  }, [])

  // 只监听当前活动会话的进度。
  // 挂载/切回时先取一次快照：传输可能停在「等待确认」「等待远端起始帧」
  // 这种不会再推送新事件的阶段，不恢复快照的话面板就是空的，
  // 用户既看不到「收取中」的进度，也没有「中断」按钮可按 —— 界面等于卡死。
  useEffect(() => {
    if (!activeId) {
      setProgress(null)
      return
    }
    setProgress(getZmodemProgress(activeId))
    return watchZmodem(activeId, (p) => {
      setProgress(p)
    })
  }, [activeId])

  // 完成/失败/取消后自动收起（保留错误信息久一点，取消的最快收起）
  useEffect(() => {
    if (!progress) return
    const { phase } = progress
    if (phase !== 'done' && phase !== 'error' && phase !== 'canceled') return
    const t = setTimeout(
      () => setProgress(null),
      phase === 'error' ? 6000 : phase === 'canceled' ? 1800 : 2500
    )
    return () => clearTimeout(t)
  }, [progress])

  // 传输中按 Esc 中断：卡死时给用户一条明确的出路
  const canAbort =
    !!progress && (progress.phase === 'active' || progress.phase === 'detected')

  /*
   * 确认弹窗是**模态**的：接进弹层栈，Esc 由栈统一分发（只关最上层）。
   * 自己挂 capture 监听会抢在设置面板/其他弹窗之前，按一次 Esc 把两个都关掉。
   */
  const cancelPending = (): void => {
    setPending((prev) => {
      prev?.resolve(false)
      return null
    })
    // 只有当前确认弹窗自己是唯一弹层时才把焦点还给终端，避免压在下面的设置面板/弹窗被抢焦点
    if (activeId && overlayDepth() <= 1) terminalRegistry.get(activeId)?.term.focus()
  }
  useOverlayEscape(Boolean(pending), cancelPending)

  /*
   * 角落里的进度条不是模态：没有弹窗时要能按 Esc 中断卡死的传输，
   * 但**别人开着弹窗时绝不能响应** —— 用户在设置页里按 Esc 撤销输入，
   * 却把正在跑的 ZMODEM 传输杀掉，是最难解释的那类数据损坏。
   */
  useEffect(() => {
    if (pending || !canAbort || !activeId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (e.isComposing || e.keyCode === 229) return
      if (hasOpenOverlay()) return
      e.preventDefault()
      e.stopPropagation()
      abortZmodem(activeId)
      setProgress(null)
      terminalRegistry.get(activeId)?.term.focus()
    }
    // 捕获阶段抢在 xterm 之前，避免 Esc 被当成终端输入发往远端
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [canAbort, activeId, pending])

  /*
   * 来源会话关掉后确认弹窗必须自己作废：旧代码只看 pending，会话没了弹窗还在，
   * 于是 sources 表里待确认的 resolve 永远不兑现，后续所有会话的 ZMODEM 都被
   * 「已有一个待确认」挡回去 —— 表现为整个程序再也弹不出传输确认。
   *
   * 只看「还在不在列表里」不够：会话对象还在、状态已经掉线/出错时弹窗照样挂着，
   * 用户点「接收」把数据发往一个断了的管理通道，界面只会一直转圈。
   * 另外 pending 期间协议层自己也可能判失败（超时 watchdog、对端发中止帧），
   * 那些走 watchZmodem 的 error/canceled 相位，同样要收起弹窗。
   */
  useEffect(() => {
    if (!pending) return
    const source = sessions.find((s) => s.id === pending.sessionId)
    const alive = Boolean(source) && source!.status !== 'disconnected' && source!.status !== 'error'
    if (alive) return
    pending.resolve(false)
    setPending(null)
  }, [pending, sessions])

  useEffect(() => {
    if (!pending) return
    return watchZmodem(pending.sessionId, (p) => {
      if (p.phase !== 'error' && p.phase !== 'canceled') return
      pending.resolve(false)
      setPending(null)
    })
  }, [pending])

  const activeSession = sessions.find((s) => s.id === activeId) ?? null

  /* ---------------- 确认弹窗 ---------------- */
  if (pending) {
    const receiving = pending.direction === 'receive'
    const confirmSessionName =
      pending.sessionName || (activeSession ? activeSession.title || activeSession.host : '')
    const answer = (ok: boolean): void => {
      pending.resolve(ok ? (receiving ? { accepted: true, skipExisting } : true) : false)
      setPending(null)
      if (!ok && activeId && overlayDepth() <= 1) terminalRegistry.get(activeId)?.term.focus()
    }
    return (
      <div
        className="modal-overlay items-center pt-0"
        style={{ zIndex: 60 }}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) answer(false)
        }}
      >
        <div className="modal max-w-sm">
          <div className="modal-header">
            <div className="modal-title">
              {receiving ? t('zmodem.title.receive') : t('zmodem.title.send')}
            </div>
          </div>
          <div className="modal-body space-y-2 text-xs leading-relaxed text-ink-2">
            <div className="flex items-center gap-2 text-ink-1">
              {receiving ? <ArrowDownToLine size={15} /> : <ArrowUpFromLine size={15} />}
              <span>
                {receiving ? t('zmodem.prompt.receive') : t('zmodem.prompt.send')}
              </span>
            </div>
            {confirmSessionName && (
              <div className="text-ink-3">{t('zmodem.session', { name: confirmSessionName })}</div>
            )}
            <div className="text-ink-3">
              {receiving ? t('zmodem.hint.receive') : t('zmodem.hint.send')}
            </div>
            {receiving && (
              <label className="flex cursor-pointer select-none items-center gap-2 pt-0.5 text-ink-1">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={skipExisting}
                  onChange={(e) => setSkipExisting(e.target.checked)}
                />
                <span>{t('zmodem.skipExisting')}</span>
              </label>
            )}
          </div>
          <div className="modal-footer">
            <button className="btn" onClick={() => answer(false)}>
              {t('zmodem.cancel')}
            </button>
            <button className="btn-primary" onClick={() => answer(true)} autoFocus>
              {receiving ? t('zmodem.accept.receive') : t('zmodem.accept.send')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  /* ---------------- 进度条 ---------------- */
  if (!progress) return null

  const total = progress.bytesTotal
  const pct =
    total > 0
      ? Math.min(100, Math.round((progress.bytesDone / total) * 100))
      : progress.phase === 'done'
        ? 100
        : 0
  const receiving = progress.direction === 'receive'

  const icon =
    progress.phase === 'done' ? (
      <CheckCircle2 size={14} className="text-emerald-400" />
    ) : progress.phase === 'error' ? (
      <XCircle size={14} className="text-danger" />
    ) : progress.phase === 'canceled' ? (
      <XCircle size={14} className="text-ink-3" />
    ) : progress.phase === 'detected' ? (
      receiving ? (
        <ArrowDownToLine size={14} />
      ) : (
        <ArrowUpFromLine size={14} />
      )
    ) : (
      <Loader2 size={14} className="animate-spin" />
    )

  const label =
    progress.phase === 'detected'
      ? t('term.zmodem.waitConfirm')
      : progress.phase === 'done'
        ? progress.message || t('term.zmodem.done')
        : progress.phase === 'error'
          ? progress.message || t('term.zmodem.failed')
          : progress.phase === 'canceled'
            ? progress.message || t('term.zmodem.canceled')
            : receiving
              ? t('term.zmodem.receiving')
              : t('term.zmodem.sending')

  const abort = (): void => {
    if (activeId) abortZmodem(activeId)
    setProgress(null)
    if (activeId) terminalRegistry.get(activeId)?.term.focus()
  }

  return (
    <div className="pointer-events-none absolute bottom-3 right-3 z-50 w-[300px]">
      <div className="pointer-events-auto rounded-lg border border-edge bg-panel p-3 shadow-lg">
        <div className="mb-2 flex items-center gap-2 text-xs">
          {icon}
          <span className="font-medium text-ink-1">{label}</span>
          <span className="ml-auto text-ink-3">
            {total > 0 || progress.phase === 'done' ? `${pct}%` : formatBytes(progress.bytesDone)}
          </span>
        </div>

        {progress.fileName && (
          <div className="mb-2 flex items-center justify-between gap-2 text-2xs text-ink-2">
            <span className="truncate" title={progress.fileName}>
              {progress.fileName}
            </span>
            {progress.fileCount && progress.fileCount > 1 && (
              <span className="shrink-0 tabular-nums text-ink-3">
                {progress.fileIndex ?? 1}/{progress.fileCount}
              </span>
            )}
          </div>
        )}

        <div className="h-1.5 overflow-hidden rounded-full bg-raised">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>

        <div className="mt-1.5 flex items-center justify-between text-3xs text-ink-3">
          <span>{formatBytes(progress.bytesDone)}</span>
          <span>{total > 0 ? formatBytes(total) : t('term.zmodem.unknownSize')}</span>
        </div>

        {progress.message && progress.phase !== 'error' && progress.phase !== 'canceled' && (
          <div className="mt-1 truncate text-3xs text-ink-3" title={progress.message}>
            {progress.message}
          </div>
        )}

        {(canAbort || (progress.phase === 'detected' && receiving)) && (
          <div className="mt-2 flex items-center justify-end gap-2 border-t border-edge-soft pt-2">
            {progress.phase === 'detected' && receiving && (
              <button
                className="btn"
                onClick={() => {
                  if (activeId) void chooseZmodemSaveDir(activeId)
                }}
                title={t('term.zmodem.pickDirTitle')}
              >
                <FolderOpen size={12} />
                {t('term.zmodem.pickDir')}
              </button>
            )}
            {canAbort && (
              <button className="btn" onClick={abort} title={t('term.zmodem.abortTitle')}>
                <XCircle size={12} />
                {t('term.zmodem.abort')}
              </button>
            )}
          </div>
        )}

        {progress.phase === 'detected' && receiving && (
          <div className="mt-1 flex items-center gap-1 text-3xs text-ink-3">
            <FolderOpen size={11} />
            {t('term.zmodem.waitingDirAndHeader')}
          </div>
        )}
      </div>
    </div>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}
