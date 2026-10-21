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
  type ZmodemProgress,
  type ZmodemDirection
} from '@/lib/zmodem'
import { useSessionStore } from '@/stores/sessionStore'

interface PendingConfirm {
  direction: ZmodemDirection
  resolve: (ok: boolean) => void
  sessionName: string
}

export function ZmodemOverlay(): JSX.Element | null {
  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeId)

  const [progress, setProgress] = useState<ZmodemProgress | null>(null)
  const [pending, setPending] = useState<PendingConfirm | null>(null)

  // 注册确认处理器：协议层检测到 ZMODEM 时调用
  useEffect(() => {
    setZmodemConfirmHandler(
      (direction) =>
        new Promise<boolean>((resolve) => {
          setPending((prev) => {
            // 已有一个待确认时，后到的直接拒绝，避免弹窗互相覆盖
            if (prev) {
              resolve(false)
              return prev
            }
            return { direction, resolve, sessionName: '' }
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

  // 完成/失败后自动收起（保留错误信息久一点）
  useEffect(() => {
    if (!progress || (progress.phase !== 'done' && progress.phase !== 'error')) return
    const t = setTimeout(() => setProgress(null), progress.phase === 'error' ? 6000 : 2500)
    return () => clearTimeout(t)
  }, [progress])

  // 传输中按 Esc 中断：卡死时给用户一条明确的出路
  const canAbort =
    !!progress && (progress.phase === 'active' || progress.phase === 'detected')

  useEffect(() => {
    if (!pending && (!canAbort || !activeId)) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      // 确认弹窗还在：Esc 就是「取消」。只关掉弹窗不动协议层，
      // 否则弹窗会一直挂在界面上点了也没反应。
      if (pending) {
        pending.resolve(false)
        setPending(null)
        return
      }
      if (!activeId) return
      abortZmodem(activeId)
      setProgress(null)
    }
    // 捕获阶段抢在 xterm / 弹窗之前，避免 Esc 被当成终端输入
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [canAbort, activeId, pending])

  const activeSession = sessions.find((s) => s.id === activeId) ?? null

  /* ---------------- 确认弹窗 ---------------- */
  if (pending) {
    const receiving = pending.direction === 'receive'
    const answer = (ok: boolean): void => {
      pending.resolve(ok)
      setPending(null)
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
              {receiving ? '接收远端文件' : '发送文件到远端'}
            </div>
          </div>
          <div className="modal-body space-y-2 text-xs leading-relaxed text-ink-2">
            <div className="flex items-center gap-2 text-ink-1">
              {receiving ? <ArrowDownToLine size={15} /> : <ArrowUpFromLine size={15} />}
              <span>
                {receiving
                  ? '远端发起了 ZMODEM 传输（sz），是否接收文件到本机？'
                  : '远端已进入接收状态（rz），是否选择本机文件发送？'}
              </span>
            </div>
            {activeSession && (
              <div className="text-ink-3">
                会话：{activeSession.title || activeSession.host}
              </div>
            )}
            <div className="text-ink-3">
              {receiving
                ? '接收需要先选一个保存文件夹（多文件只问一次），同名文件自动加序号，不会覆盖。'
                : '同意后将接管该会话的字节流直到传输结束。'}
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn" onClick={() => answer(false)}>
              取消
            </button>
            <button className="btn-primary" onClick={() => answer(true)} autoFocus>
              {receiving ? '接收' : '选择文件并发送'}
            </button>
          </div>
        </div>
      </div>
    )
  }

  /* ---------------- 进度条 ---------------- */
  if (!progress) return null

  const total = progress.bytesTotal
  const pct = total > 0 ? Math.min(100, Math.round((progress.bytesDone / total) * 100)) : 0
  const receiving = progress.direction === 'receive'

  const icon =
    progress.phase === 'done' ? (
      <CheckCircle2 size={14} className="text-emerald-400" />
    ) : progress.phase === 'error' ? (
      <XCircle size={14} className="text-danger" />
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
      ? '等待确认'
      : progress.phase === 'done'
        ? progress.message || '传输完成'
        : progress.phase === 'error'
          ? progress.message || '传输失败'
          : receiving
            ? '接收中'
            : '发送中'

  const abort = (): void => {
    if (activeId) abortZmodem(activeId)
    setProgress(null)
  }

  return (
    <div className="pointer-events-none absolute bottom-3 right-3 z-50 w-[300px]">
      <div className="pointer-events-auto rounded-lg border border-edge bg-panel/95 p-3 shadow-lg backdrop-blur">
        <div className="mb-2 flex items-center gap-2 text-xs">
          {icon}
          <span className="font-medium text-ink-1">{label}</span>
          <span className="ml-auto text-ink-3">{pct}%</span>
        </div>

        {progress.fileName && (
          <div className="mb-2 truncate text-[11px] text-ink-2" title={progress.fileName}>
            {progress.fileName}
          </div>
        )}

        <div className="h-1.5 overflow-hidden rounded-full bg-raised">
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-150"
            style={{ width: `${pct}%` }}
          />
        </div>

        <div className="mt-1.5 flex items-center justify-between text-[10px] text-ink-3">
          <span>{formatBytes(progress.bytesDone)}</span>
          <span>{total > 0 ? formatBytes(total) : '未知大小'}</span>
        </div>

        {progress.message && progress.phase !== 'error' && (
          <div className="mt-1 truncate text-[10px] text-ink-3" title={progress.message}>
            {progress.message}
          </div>
        )}

        {(canAbort || (progress.phase === 'detected' && receiving)) && (
          <div className="mt-2 flex items-center justify-end gap-2 border-t border-edge-soft pt-2">
            {receiving && (
              <button
                className="btn"
                onClick={() => {
                  if (activeId) void chooseZmodemSaveDir(activeId)
                }}
                title="重新选择保存到哪个文件夹"
              >
                <FolderOpen size={12} />
                选择文件夹
              </button>
            )}
            {canAbort && (
              <button className="btn" onClick={abort} title="中断当前传输（Esc）">
                <XCircle size={12} />
                中断
              </button>
            )}
          </div>
        )}

        {progress.phase === 'detected' && receiving && (
          <div className="mt-1 flex items-center gap-1 text-[10px] text-ink-3">
            <FolderOpen size={11} />
            正在等待保存文件夹与远端起始帧…
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
