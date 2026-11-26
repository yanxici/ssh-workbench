import { useMemo } from 'react'
import type * as React from 'react'
import { Command, Plus, Radar, Usb } from 'lucide-react'
import type { Connection } from '@shared/types'
import { connectionAddress } from '@shared/serialDisplay'
import { BrandMark } from '@/components/ui'
import { useConnectionStore } from '@/stores/connectionStore'
import { useDiscoveryStore } from '@/stores/discoveryStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useUiStore } from '@/stores/uiStore'
import { useUpdateStore } from '@/stores/updateStore'
import { useI18n } from '@/i18n'
import { cn, formatRelativeTime } from '@/lib/utils'

/**
 * 空工作区的 Portix 快速启动页。
 *
 * 设计取向：
 * - 纯色 bg-app 画布，零毛玻璃、零装饰动画，保持 2900+ 连接库下的轻盈响应。
 * - 居中 max-w-[660px]：上方品牌识别 + 4 张结构化入口卡；下方最近连接卡与快捷键提示。
 * - 最近连接按 lastUsedAt 降序取前 8 条，单击即开会话。
 */

const RECENT_LIMIT = 8

export function WelcomeQuickLaunch({
  onNewConnection
}: {
  onNewConnection: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const connections = useConnectionStore((s) => s.connections)
  const openSession = useSessionStore((s) => s.open)
  const openConnEditor = useUiStore((s) => s.openConnEditor)
  const openCommandCenter = useUiStore((s) => s.openCommandCenter)
  const version = useUpdateStore((s) => s.status?.currentVersion)

  const recent = useMemo(
    () =>
      connections
        .filter((c) => (c.lastUsedAt ?? 0) > 0)
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
        .slice(0, RECENT_LIMIT),
    [connections]
  )

  const launch = (c: Connection): void => {
    if (c.kind === 'serial' && c.serial?.pathPending) {
      openConnEditor(c)
      return
    }
    openSession({
      id: c.id,
      name: c.name,
      host: c.host,
      username: c.username,
      kind: c.kind,
      serial: c.serial
    })
  }

  const openDiscovery = (): void => {
    const discovery = useDiscoveryStore.getState()
    if (!discovery.panelOpen) discovery.togglePanel()
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-[660px]">
        {/* Brand header */}
        <div className="flex items-center gap-3.5">
          <BrandMark size={44} className="shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate text-base font-semibold tracking-[-0.02em] text-ink">
                Portix
              </span>
              {version && (
                <span className="shrink-0 rounded-full border border-edge bg-panel px-2 py-px font-mono text-3xs text-ink-3">
                  v{version}
                </span>
              )}
            </div>
            <div className="mt-0.5 truncate text-xs text-ink-3">{t('welcome.subtitle')}</div>
          </div>
        </div>

        {/* Quick launch cards */}
        <div className="mt-6 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <button
            type="button"
            onClick={onNewConnection}
            className="group flex flex-col items-start rounded-lg border border-accent/35 bg-accent/10 p-3 text-left transition-colors duration-150 hover:border-accent/60 hover:bg-accent/15"
          >
            <div className="flex w-full items-center justify-between gap-1">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent text-on-accent">
                <Plus size={14} />
              </span>
              <kbd className="rounded border border-accent/25 bg-app/80 px-1 py-px font-mono text-3xs text-accent">
                Ctrl+N
              </kbd>
            </div>
            <div className="mt-2.5 text-xs font-semibold text-ink">{t('welcome.newSsh')}</div>
            <div className="mt-0.5 line-clamp-1 text-2xs text-ink-3">
              {t('welcome.newSsh.desc')}
            </div>
          </button>

          <button
            type="button"
            title={t('welcome.newSerial.hint')}
            onClick={() => openConnEditor(null, { kind: 'serial' })}
            className="group flex flex-col items-start rounded-lg border border-edge bg-panel p-3 text-left shadow-card transition-colors duration-150 hover:border-accent/40 hover:bg-raised"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-md border border-edge bg-app text-ink-2 group-hover:text-accent">
              <Usb size={14} />
            </span>
            <div className="mt-2.5 text-xs font-semibold text-ink">{t('welcome.newSerial')}</div>
            <div className="mt-0.5 line-clamp-1 text-2xs text-ink-3">
              {t('welcome.newSerial.desc')}
            </div>
          </button>

          <button
            type="button"
            onClick={openDiscovery}
            className="group flex flex-col items-start rounded-lg border border-edge bg-panel p-3 text-left shadow-card transition-colors duration-150 hover:border-accent/40 hover:bg-raised"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-md border border-edge bg-app text-ink-2 group-hover:text-accent">
              <Radar size={14} />
            </span>
            <div className="mt-2.5 text-xs font-semibold text-ink">{t('welcome.discovery')}</div>
            <div className="mt-0.5 line-clamp-1 text-2xs text-ink-3">
              {t('welcome.discovery.desc')}
            </div>
          </button>

          <button
            type="button"
            onClick={() => openCommandCenter('')}
            className="group flex flex-col items-start rounded-lg border border-edge bg-panel p-3 text-left shadow-card transition-colors duration-150 hover:border-accent/40 hover:bg-raised"
          >
            <div className="flex w-full items-center justify-between gap-1">
              <span className="flex h-7 w-7 items-center justify-center rounded-md border border-edge bg-app text-ink-2 group-hover:text-accent">
                <Command size={14} />
              </span>
              <kbd className="rounded border border-edge bg-app px-1 py-px font-mono text-3xs text-ink-3">
                Ctrl+K
              </kbd>
            </div>
            <div className="mt-2.5 text-xs font-semibold text-ink">
              {t('welcome.shortcut.commandCenter')}
            </div>
            <div className="mt-0.5 line-clamp-1 text-2xs text-ink-3">
              {t('welcome.commandCenter.desc')}
            </div>
          </button>
        </div>

        {/* Recent connections */}
        <div className="mt-7">
          <div className="flex items-baseline justify-between">
            <span className="text-2xs font-semibold tracking-wide text-ink-3">
              {t('welcome.recent')}
            </span>
            <span className="font-mono text-3xs tabular-nums text-ink-3/70">{recent.length}</span>
          </div>

          {recent.length === 0 ? (
            <div className="mt-2 rounded-lg border border-dashed border-edge bg-panel/60 px-4 py-5 text-center text-xs text-ink-3">
              {t('welcome.emptyRecent')}
            </div>
          ) : (
            <div className="mt-2 flex flex-col rounded-lg border border-edge bg-panel p-1.5 shadow-card">
              {recent.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  title={connectionAddress(c)}
                  onClick={() => launch(c)}
                  className="group flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left transition-colors duration-150 hover:bg-hover"
                >
                  <span
                    className={cn(
                      'h-4 w-[3px] shrink-0 rounded-full',
                      !c.color && 'bg-edge'
                    )}
                    style={c.color ? { background: c.color } : undefined}
                  />
                  <span className="max-w-[38%] shrink-0 truncate text-xs font-medium text-ink">
                    {c.name}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-2xs tabular-nums text-ink-3">
                    {connectionAddress(c)}
                  </span>
                  <span className="shrink-0 rounded border border-edge-soft bg-app px-1.5 text-3xs leading-4 text-ink-3">
                    {c.kind === 'serial' ? t('welcome.typeSerial') : 'SSH'}
                  </span>
                  <span className="hidden w-12 shrink-0 text-right text-3xs tabular-nums text-ink-3/70 sm:inline">
                    {formatRelativeTime(c.lastUsedAt)}
                  </span>
                  <span className="w-8 shrink-0 text-right text-3xs font-medium text-accent opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                    {t('welcome.connect')}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Keyboard shortcut footer */}
        <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-edge-soft pt-3.5 text-2xs text-ink-3">
          <span className="flex items-center gap-1.5">
            <kbd className="rounded border border-edge bg-panel px-1.5 py-px font-mono text-3xs text-ink-2">
              Ctrl+K
            </kbd>
            {t('welcome.shortcut.commandCenter')}
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="rounded border border-edge bg-panel px-1.5 py-px font-mono text-3xs text-ink-2">
              Ctrl+Shift+Z
            </kbd>
            {t('welcome.shortcut.zen')}
          </span>
          <span className="flex items-center gap-1.5">
            <kbd className="rounded border border-edge bg-panel px-1.5 py-px font-mono text-3xs text-ink-2">
              Ctrl+Alt+B
            </kbd>
            {t('welcome.shortcut.commandRail')}
          </span>
        </div>
      </div>
    </div>
  )
}
