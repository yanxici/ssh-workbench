import type * as React from 'react'
import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, ExternalLink, RefreshCw, RotateCw } from 'lucide-react'
import type { UpdatePrefs, UpdateStatus } from '@shared/types'
import { useSettingsStore } from '@/stores/settingsStore'
import { useUpdateStore, formatMB, formatRemaining } from '@/stores/updateStore'
import { Toggle } from '@/components/ui'
import { cn } from '@/lib/utils'
import { isImeComposing } from '@/lib/ime'
import { useI18n, type I18nKey } from '@/i18n'

/**
 * 设置 → 软件更新。
 *
 * 与标题栏的 UpdateBadge 是同一份状态的两种视图：
 * 标题栏负责「随时能看到、随手能点」，这里负责「说清楚现在是什么情况、
 * 以及把检查频率、国内更新通道和代理配好」。两边都读 useUpdateStore，不存在状态不一致。
 */
export function UpdateSection(): React.JSX.Element {
  const { t } = useI18n()
  const settings = useSettingsStore((s) => s.settings)
  const updateSettings = useSettingsStore((s) => s.update)
  const status = useUpdateStore((s) => s.status)
  const check = useUpdateStore((s) => s.check)
  const download = useUpdateStore((s) => s.download)
  const install = useUpdateStore((s) => s.install)
  const openRelease = useUpdateStore((s) => s.openRelease)
  const openMirror = useUpdateStore((s) => s.openMirror)

  const [proxyDraft, setProxyDraft] = useState<string | null>(null)
  const [mirrorDraft, setMirrorDraft] = useState<string | null>(null)
  const prefs: UpdatePrefs = settings.update ?? {}

  const setPrefs = (patch: Partial<UpdatePrefs>): void => {
    void updateSettings({ update: { ...prefs, ...patch } })
  }

  const commitProxy = (): void => {
    if (proxyDraft === null) return
    setPrefs({ proxyUrl: proxyDraft.trim() })
    setProxyDraft(null)
  }

  const commitMirror = (): void => {
    if (mirrorDraft === null) return
    setPrefs({ mirror: mirrorDraft.trim() })
    setMirrorDraft(null)
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
            <div className="text-xs text-ink-2">{describe(status, t)}</div>
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
              {t('update.download')}
            </button>
          )}
          {phase === 'downloaded' && (
            <button className="btn h-6 gap-1 px-2 text-2xs" onClick={() => void install()}>
              <RotateCw size={11} />
              {t('update.restartInstall')}
            </button>
          )}
          <button className="btn h-6 gap-1 px-2 text-2xs" disabled={busy} onClick={() => void check()}>
            <RefreshCw size={11} className={cn(busy && 'animate-spin')} />
            {phase === 'checking' ? t('update.checking') : t('update.checkNow')}
          </button>
          <button className="btn-ghost h-6 gap-1 px-2 text-2xs" onClick={() => void openRelease()}>
            <ExternalLink size={11} />
            {t('update.openRelease')}
          </button>
          {/* GitHub 在国内经常连不上，给一条能真下到包的替代入口 */}
          <button
            className="btn-ghost h-6 gap-1 px-2 text-2xs"
            title={t('update.openGitee.title')}
            onClick={() => void openMirror()}
          >
            <Download size={11} />
            {t('update.openGitee')}
          </button>
        </div>
      </div>

      {/* ---------- 偏好 ---------- */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-ink-2">{t('update.autoCheck')}</div>
          <div className="mt-0.5 text-2xs leading-snug text-ink-3">
            {t('update.autoCheck.hint')}
          </div>
        </div>
        <Toggle checked={prefs.autoCheck !== false} onChange={(v) => setPrefs({ autoCheck: v })} />
      </div>

      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-ink-2">{t('update.autoDownload')}</div>
          <div className="mt-0.5 text-2xs leading-snug text-ink-3">
            {t('update.autoDownload.hint')}
          </div>
        </div>
        <Toggle
          checked={prefs.autoDownload === true}
          onChange={(v) => setPrefs({ autoDownload: v })}
        />
      </div>

      <div className="space-y-1">
        <div className="text-xs text-ink-2">{t('update.channel')}</div>
        <input
          className="input h-7 font-mono text-2xs"
          placeholder={t('update.channel.placeholder')}
          value={mirrorDraft ?? prefs.mirror ?? ''}
          onChange={(e) => setMirrorDraft(e.target.value)}
          onBlur={commitMirror}
          onKeyDown={(e) => {
            if (isImeComposing(e)) return
            if (e.key === 'Enter') commitMirror()
            if (e.key === 'Escape') setMirrorDraft(null)
          }}
          spellCheck={false}
        />
        <div className="flex flex-wrap items-center gap-1">
          {CHANNEL_PRESETS.map((p) => {
            const cur = (prefs.mirror ?? '').trim().toLowerCase()
            const active =
              p.value === '' ? cur === '' || cur === 'auto' : cur === p.value.toLowerCase()
            const label = p.labelKey ? t(p.labelKey) : p.rawLabel
            return (
              <button
                key={p.value || 'auto'}
                className={cn('btn-ghost h-5 px-1.5 text-3xs', active && 'text-accent')}
                onClick={() => {
                  setMirrorDraft(null)
                  setPrefs({ mirror: p.value })
                }}
              >
                {label}
              </button>
            )
          })}
        </div>
        <div className="text-2xs leading-snug text-ink-3">{t('update.channel.hint')}</div>
      </div>

      <div className="space-y-1">
        <div className="text-xs text-ink-2">{t('update.proxy')}</div>
        <input
          className="input h-7 font-mono text-2xs"
          placeholder={t('update.proxy.placeholder')}
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
        <div className="text-2xs leading-snug text-ink-3">{t('update.proxy.hint')}</div>
      </div>

      <div className="text-3xs leading-relaxed text-ink-3/80">
        {t('update.meta.current', { version: status?.currentVersion ?? '—' })}
        {status?.latestVersion ? t('update.meta.latest', { version: status.latestVersion }) : ''}
        {status?.sourceLabel ? t('update.meta.source', { source: status.sourceLabel }) : ''}
      </div>
    </div>
  )
}

/**
 * 更新通道预设。
 *
 * 空串 = 自动多通道回退（未配代理优先 Gitee 国内源，配了代理优先 GitHub 官方）；
 * gitee / github = 固定单一官方源；其余为前缀式公共加速站。
 */
const CHANNEL_PRESETS: { labelKey?: I18nKey; rawLabel?: string; value: string }[] = [
  { labelKey: 'update.channel.auto', value: '' },
  { labelKey: 'update.channel.gitee', value: 'gitee' },
  { labelKey: 'update.channel.github', value: 'github' },
  { rawLabel: 'gh-proxy.com', value: 'https://gh-proxy.com' },
  { rawLabel: 'ghfast.top', value: 'https://ghfast.top' }
]

/** 把状态机翻成一句人话 */
function describe(
  status: UpdateStatus | null,
  t: (key: I18nKey, vars?: Record<string, string | number>) => string
): string {
  if (!status) return t('update.status.unchecked')
  switch (status.phase) {
    case 'checking':
      return t('update.status.checking')
    case 'available':
      return t('update.status.available', { version: status.latestVersion ?? '' })
    case 'downloading':
      return t('update.status.downloading', { version: status.latestVersion ?? '' })
    case 'downloaded':
      return t('update.status.downloaded', { version: status.latestVersion ?? '' })
    case 'error':
      return t('update.status.error')
    default:
      return t('update.status.latest', { version: status.currentVersion })
  }
}
