/**
 * ZMODEM 传输交互：
 * - 检测到远端 sz/rz 时弹出确认，用户同意才接管字节流（避免普通输出被误判）
 * - 传输中显示进度；完成后短暂停留再自动消失
 *
 * 该组件同时把「确认处理器」注册到 lib/zmodem，使协议层能反过来询问 UI。
 */

import { useEffect, useState } from 'react'
import { ArrowDownToLine, ArrowUpFromLine, Loader2, CheckCircle2, XCircle } from 'lucide-react'
import {
  watchZmodem,
  setZmodemConfirmHandler,
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
    return () => setZmodemConfirmHandler(null)
  }, [])

  // 只监听当前活动会话的进度
  useEffect(() => {
    if (!activeId) {
      setProgress(null)
      return
    }
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
              同意后将接管该会话的字节流直到传输结束。
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

        <div className="mt-1.5 flex justify-between text-[10px] text-ink-3">
          <span>{formatBytes(progress.bytesDone)}</span>
          <span>{total > 0 ? formatBytes(total) : '未知大小'}</span>
        </div>
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
