import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  ArrowUpCircle,
  Check,
  Download,
  ExternalLink,
  Loader2,
  RotateCcw,
  X
} from 'lucide-react'
import type { UpdateStatus } from '@shared/types'
import {
  formatMB,
  formatRemaining,
  isUpdateVisible,
  useUpdateStore
} from '@/stores/updateStore'
import { cn } from '@/lib/utils'

/**
 * 标题栏右侧的更新入口。
 *
 * 交互刻意做成「一个 chip + 一个下拉面板」，而不是弹 modal：
 * 现场正在盯着终端跑命令时，更新提示不该抢焦点。chip 只是个安静的小按钮，
 * 用户想处理才点开 —— 这就是「现代软件」那种「旁边提示更新、一键更新」的手感。
 *
 * 四种形态（由主进程的 phase 决定）：
 *   checking    转圈 + 「检查中」
 *   available   箭头 + 「更新」，点开面板显示版本与更新说明
 *   downloading 进度环/百分比，点开看详细进度
 *   downloaded  「重启安装」，点开确认
 */

/** chip 上的文案与图标 */
function chipContent(status: UpdateStatus): {
  icon: JSX.Element
  label: string
  spin?: boolean
} {
  switch (status.phase) {
    case 'checking':
      return { icon: <Loader2 size={12} />, label: '检查中', spin: true }
    case 'downloading':
      return {
        icon: <Download size={12} />,
        label: status.percent !== undefined ? `${Math.floor(status.percent)}%` : '下载中'
      }
    case 'downloaded':
      return { icon: <RotateCcw size={12} />, label: '重启安装' }
    case 'available':
      return { icon: <ArrowUpCircle size={12} />, label: '更新' }
    default:
      return { icon: <Check size={12} />, label: '已是最新' }
  }
}

export function UpdateBadge(): JSX.Element | null {
  const status = useUpdateStore((s) => s.status)
  const panelOpen = useUpdateStore((s) => s.panelOpen)
  const setPanelOpen = useUpdateStore((s) => s.setPanelOpen)
  const download = useUpdateStore((s) => s.download)
  const install = useUpdateStore((s) => s.install)
  const later = useUpdateStore((s) => s.later)
  const check = useUpdateStore((s) => s.check)
  const openRelease = useUpdateStore((s) => s.openRelease)

  const btnRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null)

  /* 面板用 fixed 定位：标题栏祖先带 overflow-hidden，absolute 会被裁掉 */
  useLayoutEffect(() => {
    if (!panelOpen || !btnRef.current) {
      setPos(null)
      return
    }
    const r = btnRef.current.getBoundingClientRect()
    setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) })
  }, [panelOpen, status?.phase, status?.percent])

  /* 点面板外 / 按 Esc 收起 */
  useEffect(() => {
    if (!panelOpen) return
    const onDown = (e: MouseEvent): void => {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      if (btnRef.current?.contains(t)) return
      setPanelOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setPanelOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [panelOpen, setPanelOpen])

  // 面板打开着却没有任何可提示的内容（例如检查完是最新）→ 自动收起
  useEffect(() => {
    if (!panelOpen) return
    if (status && status.phase === 'idle') setPanelOpen(false)
  }, [panelOpen, status, setPanelOpen])

  if (!isUpdateVisible(status) || !status) return null

  const chip = chipContent(status)

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        /* 用 titlebar-btn 的尺寸感，但宽度按内容撑开，所以单独拼类 */
        className={cn(
          'no-drag inline-flex h-7 shrink-0 items-center gap-1 rounded px-1.5 text-2xs',
          'text-on-brand/90 transition-colors duration-150 hover:bg-on-brand/15 hover:text-on-brand',
          panelOpen && 'bg-on-brand/20 text-on-brand'
        )}
        title={
          status.phase === 'available'
            ? `发现新版本 ${status.latestVersion}，点击更新`
            : status.phase === 'downloaded'
              ? '更新已下载，点击重启安装'
              : status.phase === 'downloading'
                ? '正在下载更新'
                : '正在检查更新'
        }
        aria-label="应用更新"
        onClick={() => setPanelOpen(!panelOpen)}
      >
        <span className={cn('inline-flex', chip.spin && 'animate-spin')}>{chip.icon}</span>
        <span className="tabular-nums">{chip.label}</span>
      </button>

      {panelOpen && pos && (
        <div
          ref={panelRef}
          className="no-drag fixed z-[70] w-[320px] overflow-hidden rounded-md border border-edge bg-panel text-ink shadow-pop"
          style={{ top: pos.top, right: pos.right }}
          role="dialog"
          aria-label="应用更新"
        >
          {/* 头部：版本对比 */}
          <div className="flex items-start gap-2 border-b border-edge-soft px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <div className="text-xs font-semibold">
                {status.phase === 'available' && '发现新版本'}
                {status.phase === 'downloading' && '正在下载更新'}
                {status.phase === 'downloaded' && '更新已就绪'}
                {status.phase === 'checking' && '正在检查更新'}
              </div>
              <div className="mt-0.5 font-mono text-2xs text-ink-3">
                {status.currentVersion}
                {status.latestVersion && status.latestVersion !== status.currentVersion && (
                  <>
                    {' → '}
                    <span className="text-brand">{status.latestVersion}</span>
                  </>
                )}
              </div>
            </div>
            <button
              type="button"
              className="titlebar-btn !h-6 !w-6 text-ink-3 hover:!bg-hover hover:!text-ink"
              title="关闭"
              aria-label="关闭"
              onClick={() => setPanelOpen(false)}
            >
              <X size={12} />
            </button>
          </div>

          {/* 下载进度 */}
          {status.phase === 'downloading' && (
            <div className="border-b border-edge-soft px-3 py-2.5">
              <div className="h-1.5 overflow-hidden rounded-full bg-raised">
                <div
                  className="h-full rounded-full bg-brand transition-[width] duration-200"
                  style={{ width: `${Math.max(1, Math.min(100, status.percent ?? 0))}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between font-mono text-2xs text-ink-3">
                <span>
                  {formatMB(status.transferred)} / {formatMB(status.total)}
                </span>
                <span>
                  {formatRemaining(status.transferred, status.total, status.bytesPerSecond) ??
                    `${Math.floor(status.percent ?? 0)}%`}
                </span>
              </div>
            </div>
          )}

          {/* 更新说明 */}
          {status.releaseNotes && (status.phase === 'available' || status.phase === 'downloaded') && (
            <div className="scroll-thin max-h-40 overflow-y-auto border-b border-edge-soft px-3 py-2">
              <pre className="whitespace-pre-wrap break-words font-sans text-2xs leading-relaxed text-ink-2">
                {status.releaseNotes}
              </pre>
            </div>
          )}

          {/* 底部动作 */}
          <div className="flex items-center gap-1.5 px-3 py-2">
            {status.phase === 'available' && (
              <>
                <button
                  type="button"
                  className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded bg-brand px-2 text-2xs font-medium text-on-brand transition-opacity hover:opacity-90"
                  onClick={() => void download()}
                >
                  <Download size={12} />
                  立即更新
                </button>
                <button
                  type="button"
                  className="inline-flex h-7 items-center rounded px-2 text-2xs text-ink-3 hover:bg-hover hover:text-ink"
                  onClick={() => void later()}
                >
                  稍后
                </button>
              </>
            )}

            {status.phase === 'downloading' && (
              <span className="flex-1 text-2xs text-ink-3">
                下载完成后会提示重启，期间可继续使用。
              </span>
            )}

            {status.phase === 'downloaded' && (
              <>
                <button
                  type="button"
                  className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded bg-brand px-2 text-2xs font-medium text-on-brand transition-opacity hover:opacity-90"
                  onClick={() => void install()}
                >
                  <RotateCcw size={12} />
                  重启并安装
                </button>
                <button
                  type="button"
                  className="inline-flex h-7 items-center rounded px-2 text-2xs text-ink-3 hover:bg-hover hover:text-ink"
                  onClick={() => void later()}
                >
                  稍后
                </button>
              </>
            )}

            {status.phase === 'checking' && (
              <button
                type="button"
                disabled
                className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded border border-edge px-2 text-2xs text-ink-3"
              >
                <Loader2 size={12} className="animate-spin" />
                请稍候…
              </button>
            )}

            <button
              type="button"
              className={cn(
                'inline-flex h-7 shrink-0 items-center gap-1 rounded px-2 text-2xs text-ink-3',
                'hover:bg-hover hover:text-ink'
              )}
              title="在浏览器中打开发布页"
              onClick={() => void openRelease()}
            >
              <ExternalLink size={12} />
            </button>
            <button
              type="button"
              className="inline-flex h-7 shrink-0 items-center rounded px-2 text-2xs text-ink-3 hover:bg-hover hover:text-ink"
              title="重新检查"
              onClick={() => void check()}
            >
              <RotateCcw size={12} />
            </button>
          </div>
        </div>
      )}
    </>
  )
}
