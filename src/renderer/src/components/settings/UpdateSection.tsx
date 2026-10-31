import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, ExternalLink, RefreshCw, RotateCw } from 'lucide-react'
import type { UpdatePrefs, UpdateStatus } from '@shared/types'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUpdateStore, formatMB, formatRemaining } from '@/stores/updateStore'
import { Toggle } from '@/components/ui'
import { cn } from '@/lib/utils'
import { isImeComposing } from '@/lib/ime'

/**
 * 设置 → 软件更新。
 *
 * 与标题栏的 UpdateBadge 是同一份状态的两种视图：
 * 标题栏负责「随时能看到、随手能点」，这里负责「说清楚现在是什么情况、
 * 以及把检查频率和代理配好」。两边都读 useUpdateStore，不存在状态不一致。
 */
export function UpdateSection(): JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.update)
  const status = useUpdateStore((s) => s.status)
  const check = useUpdateStore((s) => s.check)
  const download = useUpdateStore((s) => s.download)
  const install = useUpdateStore((s) => s.install)
  const openRelease = useUpdateStore((s) => s.openRelease)

  const [proxyDraft, setProxyDraft] = useState<string | null>(null)
  const prefs: UpdatePrefs = settings.update ?? {}

  const setPrefs = (patch: Partial<UpdatePrefs>): void => {
    void updateSettings({ update: { ...prefs, ...patch } })
  }

  const commitProxy = (): void => {
    if (proxyDraft === null) return
    setPrefs({ proxyUrl: proxyDraft.trim() })
    setProxyDraft(null)
  }

  const phase = status?.phase ?? 'idle'
  const busy = phase === 'checking' || phase === 'downloading'
  const remaining = formatRemaining(status?.transferred, status?.total, status?.bytesPerSecond)

  return (
    <div className="space-y-2.5">
      {/* ---------- 当前状态 ---------- */}
      <div
        className={cn(
          'rounded-md border px-2.5 py-2',
          phase === 'error'
            ? 'border-danger/40 bg-danger/5'
            : phase === 'downloaded'
              ? 'border-success/40 bg-success/5'
              : 'border-edge-soft bg-panel'
        )}
      >
        <div className="flex items-start gap-2">
          <span className="mt-0.5 shrink-0">
            {phase === 'error' ? (
              <AlertTriangle size={13} className="text-danger" />
            ) : phase === 'downloaded' ? (
              <CheckCircle2 size={13} className="text-success" />
            ) : (
              <RefreshCw size={13} className={cn('text-ink-3', busy && 'animate-spin')} />
            )}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-xs text-ink-2">{describe(status)}</div>
            {phase === 'downloading' && (
              <div className="mt-1.5 space-y-1">
                <div className="h-1 overflow-hidden rounded-full bg-edge-soft">
                  <div
                    className="h-full rounded-full bg-accent transition-[width] duration-300"
                    style={{ width: `${Math.max(1, status?.percent ?? 0)}%` }}
                  />
                </div>
                <div className="flex items-center justify-between font-mono text-3xs text-ink-3">
                  <span>
                    {formatMB(status?.transferred)} / {formatMB(status?.total)}
                  </span>
                  <span>{remaining ?? `${Math.round(status?.percent ?? 0)}%`}</span>
                </div>
              </div>
            )}
            {phase === 'error' && status?.error && (
              <div className="selectable scroll-thin mt-1 max-h-16 overflow-y-auto break-all font-mono text-3xs leading-relaxed text-ink-3">
                {status.error}
              </div>
            )}
            {phase === 'available' && status?.releaseNotes && (
              <div className="selectable scroll-thin mt-1 max-h-24 overflow-y-auto whitespace-pre-line break-words text-3xs leading-relaxed text-ink-3">
                {status.releaseNotes}
              </div>
            )}
          </div>
        </div>

        {/* 操作按钮：按阶段只给「下一步该干的那件事」，不摆一排灰按钮 */}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {phase === 'available' && (
            <button className="btn h-6 gap-1 px-2 text-2xs" onClick={() => void download()}>
              <Download size={11} />
              下载更新
            </button>
          )}
          {phase === 'downloaded' && (
            <button className="btn h-6 gap-1 px-2 text-2xs" onClick={() => void install()}>
              <RotateCw size={11} />
              重启并安装
            </button>
          )}
          <button className="btn h-6 gap-1 px-2 text-2xs" disabled={busy} onClick={() => void check()}>
            <RefreshCw size={11} className={cn(busy && 'animate-spin')} />
            {phase === 'checking' ? '检查中…' : '立即检查'}
          </button>
          <button className="btn-ghost h-6 gap-1 px-2 text-2xs" onClick={() => void openRelease()}>
            <ExternalLink size={11} />
            打开发布页
          </button>
        </div>
      </div>

      {/* ---------- 偏好 ---------- */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-ink-2">启动时自动检查</div>
          <div className="mt-0.5 text-2xs leading-snug text-ink-3">
            启动几秒后静默查一次（只读几 KB 的版本文件），有新版会在标题栏亮出「更新」
          </div>
        </div>
        <Toggle checked={prefs.autoCheck !== false} onChange={(v) => setPrefs({ autoCheck: v })} />
      </div>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-ink-2">自动下载安装包</div>
          <div className="mt-0.5 text-2xs leading-snug text-ink-3">
            默认关闭。现场网络按流量计费，几十兆的包在下之前应该由你点头
          </div>
        </div>
        <Toggle
          checked={prefs.autoDownload === true}
          onChange={(v) => setPrefs({ autoDownload: v })}
        />
      </div>

      <div className="space-y-1">
        <div className="text-xs text-ink-2">更新专用代理</div>
        <input
          className="input h-7 font-mono text-2xs"
          placeholder="http://127.0.0.1:7897（留空跟随系统代理）"
          value={proxyDraft ?? prefs.proxyUrl ?? ''}
          onChange={(e) => setProxyDraft(e.target.value)}
          onBlur={commitProxy}
          onKeyDown={(e) => {
            if (isImeComposing(e)) return
            if (e.key === 'Enter') commitProxy()
            if (e.key === 'Escape') setProxyDraft(null)
          }}
          spellCheck={false}
        />
        <div className="text-2xs leading-snug text-ink-3">
          只影响更新包的下载，不影响 SSH 连接。国内直连 GitHub 常拉不动，填上本地代理能明显提速；
          改完对下一次检查即生效。
        </div>
      </div>

      <div className="text-3xs leading-relaxed text-ink-3/80">
        当前版本 v{status?.currentVersion ?? '—'}
        {status?.latestVersion ? ` ｜ 发布源最新 v${status.latestVersion}` : ''}
      </div>
    </div>
  )
}

/** 把状态机翻成一句人话 */
function describe(status: UpdateStatus | null): string {
  if (!status) return '尚未检查更新'
  switch (status.phase) {
    case 'checking':
      return '正在检查更新…'
    case 'available':
      return `发现新版本 v${status.latestVersion}`
    case 'downloading':
      return `正在下载 v${status.latestVersion}…`
    case 'downloaded':
      return `v${status.latestVersion} 已下载，重启即可完成更新`
    case 'error':
      return '检查更新失败'
    default:
      return `已是最新版本 v${status.currentVersion}`
  }
}
