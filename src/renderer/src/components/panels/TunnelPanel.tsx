import type * as React from 'react'
import { useEffect, useState } from 'react'
import {
  ArrowUpRight,
  Cable,
  ChevronDown,
  Copy,
  Loader2,
  Pencil,
  Play,
  Plus,
  Radio,
  RefreshCw,
  Save,
  Search,
  Square,
  Trash2,
  Zap
} from 'lucide-react'
import type { RemoteListeningPort, TunnelConfig, TunnelRuntimeInfo } from '@shared/types'
import { needsLanGrant } from '@shared/bindHost'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { useSessionStore } from '@/stores/sessionStore'
import { useToastStore } from '@/stores/toastStore'
import {
  ConfirmDialog,
  ContextMenu,
  EmptyState,
  useContextMenu,
  type MenuEntry
} from '@/components/ui'
import { describeEndpoint, useTunnelStore } from '@/stores/tunnelStore'
import { TunnelEditor } from './TunnelEditor'

/**
 * 端口转发面板（侧栏「隧道」页）：
 * 管理 -L / -R / -D 三类隧道的配置与运行状态。
 * 启动时自动挑选合适的在线会话（优先关联连接，其次当前活动会话）。
 */
export function TunnelPanel(): React.JSX.Element {
  const tunnels = useTunnelStore((s) => s.tunnels)
  const runtimes = useTunnelStore((s) => s.runtimes)
  const loaded = useTunnelStore((s) => s.loaded)
  const keyword = useTunnelStore((s) => s.keyword)
  const setKeyword = useTunnelStore((s) => s.setKeyword)
  const discoveredBySession = useTunnelStore((s) => s.discoveredBySession)
  const discoveringSessionId = useTunnelStore((s) => s.discoveringSessionId)
  const discoverPorts = useTunnelStore((s) => s.discoverPorts)
  const quickStart = useTunnelStore((s) => s.quickStart)
  const promote = useTunnelStore((s) => s.promote)
  const openLocal = useTunnelStore((s) => s.openLocal)
  const stop = useTunnelStore((s) => s.stop)
  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeId)
  /* menuItems 的形参就叫 t（TunnelConfig），这里换个名字免得被遮蔽 */
  const { t: tr } = useI18n()

  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<TunnelConfig | null>(null)
  const [pendingDelete, setPendingDelete] = useState<TunnelConfig | null>(null)
  const { menu, openMenu, closeMenu } = useContextMenu<TunnelConfig>()
  /* 远端监听端口区块默认收起：这是按需探测的辅助功能，不该抢已保存隧道的版面 */
  const [portsOpen, setPortsOpen] = useState(false)

  useEffect(() => {
    void useTunnelStore.getState().load()
  }, [])

  const kw = keyword.trim().toLowerCase()
  const filtered = kw
    ? tunnels.filter(
        (t) =>
          t.name.toLowerCase().includes(kw) ||
          (t.targetHost ?? '').toLowerCase().includes(kw) ||
          String(t.bindPort).includes(kw)
      )
    : tunnels

  /** 端口探测只对「当前活动的在线 SSH 会话」做，串口会话没有远端监听端口可谈 */
  const currentSession =
    sessions.find((s) => s.id === activeId && s.status === 'connected' && s.kind !== 'serial') ??
    sessions.find((s) => s.status === 'connected' && s.kind !== 'serial') ??
    null
  const discovered = currentSession ? (discoveredBySession[currentSession.id] ?? []) : []
  const discovering = currentSession !== null && discoveringSessionId === currentSession.id
  const ephemeralActive = Object.values(runtimes).filter(
    (r) =>
      r.ephemeral === true &&
      (r.status === 'active' || r.status === 'starting' || r.status === 'reconnecting')
  )

  /** 端口行 ↔ 已有转发：同一会话上活跃/重连中的临时转发与已保存 -L 隧道都算 */
  const forwardOf = (
    p: RemoteListeningPort
  ): { id: string; localPort: number; ephemeral: boolean } | null => {
    if (!currentSession) return null
    for (const r of Object.values(runtimes)) {
      if (r.sessionId !== currentSession.id) continue
      if (r.status !== 'active' && r.status !== 'starting' && r.status !== 'reconnecting') continue
      if (r.ephemeral) {
        // 多网卡的同端口很常见（uhttpd 同时监听 0.0.0.0 与 ::），只比端口会把
        // 另一张网卡的行也点亮成已转发，点进去却连不通。
        if (
          r.ephemeralConfig?.targetPort === p.port &&
          r.ephemeralConfig?.targetHost === p.targetHost
        ) {
          return {
            id: r.tunnelId,
            localPort: r.actualPort ?? r.ephemeralConfig.bindPort,
            ephemeral: true
          }
        }
        continue
      }
      const cfg = tunnels.find((x) => x.id === r.tunnelId)
      if (
        cfg &&
        cfg.type === 'local' &&
        cfg.targetPort === p.port &&
        cfg.targetHost === p.targetHost
      ) {
        return { id: cfg.id, localPort: r.actualPort ?? cfg.bindPort, ephemeral: false }
      }
    }
    return null
  }

  /* TLS 端口就用 https，其余按 http 打开 —— 只是给「打开」按钮一个合理默认值 */
  const protocolFor = (port: number): 'http' | 'https' =>
    port === 443 || port === 8443 ? 'https' : 'http'

  const copyLocal = (port: number): void => {
    // 复制的是「主机:端口」而不是完整 URL：这个按钮面向任意 TCP 服务（MySQL、
    // Redis、管理后台的 https 端口），硬加 http:// 等于把地址改成一个连不上的链接。
    const url = '127.0.0.1:' + String(port)
    void window.api.clip.write(url).then((res) => {
      if (res.ok) {
        useToastStore.getState().push({ kind: 'success', title: tr('tunnel.copied', { url }) })
      }
    })
  }

  const scan = (): void => {
    if (!currentSession) {
      useToastStore.getState().push({ kind: 'warning', title: tr('tunnel.discover.noSession') })
      return
    }
    setPortsOpen(true)
    void discoverPorts(currentSession.id)
  }

  const openCreate = (): void => {
    setEditing(null)
    setEditorOpen(true)
  }

  const openEdit = (t: TunnelConfig): void => {
    setEditing(t)
    setEditorOpen(true)
  }

  const menuItems = (t: TunnelConfig): MenuEntry[] => {
    const runtime = runtimes[t.id]
    const running =
      runtime?.status === 'active' ||
      runtime?.status === 'starting' ||
      runtime?.status === 'reconnecting'
    return [
      running
        ? {
            label: tr('panel.tunnel.actionStop'),
            icon: <Square size={12} />,
            onClick: () => void useTunnelStore.getState().stop(t.id)
          }
        : {
            label: tr('panel.tunnel.actionStart'),
            icon: <Play size={12} />,
            onClick: () => void useTunnelStore.getState().start(t.id)
          },
      {
        label: tr('panel.tunnel.actionEdit'),
        icon: <Pencil size={12} />,
        onClick: () => openEdit(t)
      },
      {
        label: tr('panel.tunnel.actionDuplicate'),
        icon: <Copy size={12} />,
        onClick: () =>
          void useTunnelStore.getState().save({
            name: tr('panel.tunnel.copySuffix', { name: t.name }),
            type: t.type,
            bindHost: t.bindHost,
            bindPort: t.bindPort,
            targetHost: t.targetHost,
            targetPort: t.targetPort,
            connectionId: t.connectionId,
            remark: t.remark,
            /*
             * 必须透传 allowLan。
             * 复制一条监听 0.0.0.0 的隧道时，原配置可能因为 allowLan=false
             * 而本来就不该存在（存量的老配置），但既然它已经在用，
             * 副本也应当按同一授权保存；否则复制动作会被后端拒绝。
             */
            allowLan: t.allowLan ?? needsLanGrant(t.bindHost)
          })
      },
      {
        label: tr('panel.tunnel.actionDelete'),
        icon: <Trash2 size={12} />,
        danger: true,
        separatorBefore: true,
        onClick: () => setPendingDelete(t)
      }
    ]
  }

  return (
    <div className="flex h-full flex-col">
      <div className="panel-head">
        <Cable size={13} className="shrink-0 text-ink-3" />
        <span className="panel-title">{tr('panel.tunnel.title')}</span>
        <span className="panel-count">{tunnels.length}</span>
        <span className="flex-1" />
        <button
          className="btn-icon h-6 w-6"
          title={tr('panel.tunnel.refresh')}
          onClick={() => void useTunnelStore.getState().load()}
        >
          <RefreshCw size={13} />
        </button>
        <button
          className="btn-icon h-6 w-6"
          title={tr('panel.tunnel.newTitle')}
          onClick={openCreate}
        >
          <Plus size={14} />
        </button>
      </div>

      <div className="panel-toolbar">
        <div className="relative flex-1">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            className="input h-7 pl-7 text-xs"
            placeholder={tr('panel.tunnel.searchPlaceholder')}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
      </div>

      <div className="panel-body">
        {/* section 1: remote listening ports */}
        <div className="flex items-center gap-1 px-2 pb-1 pt-1.5 text-2xs">
          <button
            className="flex min-w-0 flex-1 items-center gap-1 font-semibold text-ink-3 hover:text-ink-2"
            onClick={() => setPortsOpen((v) => !v)}
          >
            <ChevronDown
              size={11}
              className={cn('shrink-0 transition-transform', !portsOpen && '-rotate-90')}
            />
            <span className="truncate">{tr('tunnel.section.ports')}</span>
            {discovered.length > 0 && (
              <span className="shrink-0 font-mono text-3xs">{discovered.length}</span>
            )}
          </button>
          <button
            className="btn-icon h-5 w-5"
            title={tr('tunnel.discover')}
            disabled={!currentSession || discovering}
            onClick={scan}
          >
            {discovering ? <Loader2 size={11} className="animate-spin" /> : <Radio size={11} />}
          </button>
        </div>

        {portsOpen && (
          <div className="pb-1">
            {!currentSession && (
              <div className="px-4 py-1 text-3xs leading-relaxed text-ink-3">
                {tr('tunnel.discover.noSession')}
              </div>
            )}
            {currentSession && discovered.length === 0 && (
              <div className="px-4 py-1 text-3xs leading-relaxed text-ink-3">
                {tr('tunnel.discover.empty')}
              </div>
            )}
            {discovered.map((p) => {
              const fw = forwardOf(p)
              return (
                <div
                  /* 同端口会挂在多张网卡上（0.0.0.0 与 ::），只用端口做 key 会撞 */
                  key={p.port + '/' + p.proto + '/' + p.targetHost}
                  className="group flex items-center gap-1.5 rounded-md px-2 py-0.5 hover:bg-hover/60"
                >
                  <span className="w-11 shrink-0 text-right font-mono text-3xs tabular-nums text-ink-2">
                    {p.port}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-3xs text-ink-3" title={p.address}>
                    {p.process ? p.process + ' · ' : ''}
                    {p.address}
                  </span>
                  {fw ? (
                    <>
                      <span className="shrink-0 font-mono text-3xs text-accent">:{fw.localPort}</span>
                      <button
                        className="btn-icon h-5 w-5"
                        title={tr('tunnel.action.open')}
                        onClick={() => void openLocal(fw.localPort, protocolFor(p.port))}
                      >
                        <ArrowUpRight size={11} />
                      </button>
                      <button
                        className="btn-icon h-5 w-5"
                        title={tr('tunnel.action.copy')}
                        onClick={() => copyLocal(fw.localPort)}
                      >
                        <Copy size={11} />
                      </button>
                      {fw.ephemeral && (
                        <button
                          className="btn-icon h-5 w-5"
                          title={tr('tunnel.action.promote')}
                          onClick={() => void promote(fw.id)}
                        >
                          <Save size={11} />
                        </button>
                      )}
                      <button
                        className="btn-icon h-5 w-5 hover:text-warning"
                        title={tr('tunnel.action.stop')}
                        onClick={() => void stop(fw.id)}
                      >
                        <Square size={11} />
                      </button>
                      {!fw.ephemeral && (
                        <span className="shrink-0 rounded-sm border border-edge-soft px-1 text-3xs text-ink-3">
                          {tr('tunnel.badge.saved')}
                        </span>
                      )}
                    </>
                  ) : (
                    <button
                      className="btn h-5 px-1.5 text-3xs opacity-0 group-hover:opacity-100"
                      onClick={() =>
                        currentSession && void quickStart(currentSession.id, p.port, p.targetHost)
                      }
                    >
                      {tr('tunnel.action.forward')}
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}

        {/* section 2: ephemeral forwards */}
        {ephemeralActive.length > 0 && (
          <>
            <div className="mt-1 flex items-center gap-1 px-2 pb-1 pt-1.5 text-2xs font-semibold text-ink-3">
              <span className="truncate">{tr('tunnel.section.quick')}</span>
              <span className="shrink-0 font-mono text-3xs">{ephemeralActive.length}</span>
            </div>
            {ephemeralActive.map((r) => {
              const port = r.actualPort ?? r.ephemeralConfig?.bindPort ?? 0
              const target = r.ephemeralConfig
              return (
                <div key={r.tunnelId} className="rounded-md px-2 py-1 hover:bg-hover/60">
                  <div className="flex items-center gap-1.5">
                    <StatusDot runtime={r} />
                    <span className="min-w-0 flex-1 truncate font-mono text-3xs text-ink-2">
                      :{port}
                      {target ? ` → ${target.targetHost}:${target.targetPort}` : ''}
                    </span>
                    <button
                      className="btn-icon h-5 w-5"
                      title={tr('tunnel.action.open')}
                      onClick={() => void openLocal(port, protocolFor(target?.targetPort ?? port))}
                    >
                      <ArrowUpRight size={11} />
                    </button>
                    <button
                      className="btn-icon h-5 w-5"
                      title={tr('tunnel.action.copy')}
                      onClick={() => copyLocal(port)}
                    >
                      <Copy size={11} />
                    </button>
                    <button
                      className="btn-icon h-5 w-5"
                      title={tr('tunnel.action.promote')}
                      onClick={() => void promote(r.tunnelId)}
                    >
                      <Save size={11} />
                    </button>
                    <button
                      className="btn-icon h-5 w-5 hover:text-warning"
                      title={tr('tunnel.action.stop')}
                      onClick={() => void stop(r.tunnelId)}
                    >
                      <Square size={11} />
                    </button>
                  </div>
                  <div className="mt-0.5 flex items-center gap-2 pl-3 text-3xs text-ink-3">
                    {r.sessionTitle && (
                      <span className="truncate">
                        {tr('tunnel.viaSession', { name: r.sessionTitle })}
                      </span>
                    )}
                    {r.status === 'reconnecting' && (
                      <span className="shrink-0 text-warning">{tr('tunnel.waitingReconnect')}</span>
                    )}
                  </div>
                </div>
              )
            })}
          </>
        )}

        {/* section 3: saved tunnels */}
        <div className="mt-1 flex items-center gap-1 px-2 pb-1 pt-1.5 text-2xs font-semibold text-ink-3">
          <span className="truncate">{tr('tunnel.section.saved')}</span>
          <span className="shrink-0 font-mono text-3xs">{tunnels.length}</span>
        </div>

        {filtered.length === 0 && ephemeralActive.length === 0 && (
          <EmptyState
            icon={<Cable size={24} />}
            title={
              tunnels.length === 0
                ? tr('panel.tunnel.emptyTitle')
                : tr('panel.tunnel.emptySearchTitle')
            }
            hint={
              tunnels.length === 0
                ? tr('panel.tunnel.emptyHint')
                : tr('panel.tunnel.emptySearchHint')
            }
            action={
              tunnels.length === 0 ? (
                <button className="btn btn-primary h-7 px-3 text-xs" onClick={openCreate}>
                  <Plus size={12} />
                  {tr('panel.tunnel.newTitle')}
                </button>
              ) : undefined
            }
          />
        )}

        {!loaded && tunnels.length === 0 && (
          <div className="py-4 text-center text-2xs text-ink-3">{tr('panel.tunnel.loading')}</div>
        )}

        {filtered.map((t) => {
          const runtime: TunnelRuntimeInfo | undefined = runtimes[t.id]
          const running =
            runtime?.status === 'active' ||
            runtime?.status === 'starting' ||
            runtime?.status === 'reconnecting'
          const typeLabel =
            t.type === 'local'
              ? tr('panel.tunnel.type.local')
              : t.type === 'remote'
                ? tr('panel.tunnel.type.remote')
                : tr('panel.tunnel.type.dynamic')
          return (
            <div
              key={t.id}
              className="group rounded-md px-2 py-1.5 transition-colors hover:bg-hover/60"
              onContextMenu={(e) => openMenu(e, t)}
            >
              {/*
               * 第一行：状态点 + 名称 + 类型 + 启停
               */}
              <div className="flex items-center gap-1.5">
                <StatusDot runtime={runtime} />
                <span className="min-w-0 flex-1 truncate text-xs text-ink" title={t.name}>
                  {t.name}
                </span>
                <span className="shrink-0 rounded-sm border border-edge-soft bg-raised px-1 py-px font-mono text-3xs text-ink-3">
                  {typeLabel}
                </span>
                {t.autoStart === true && (
                  <span
                    className="shrink-0 rounded-sm border border-accent/40 px-1 text-3xs text-accent"
                    title={tr('tunnel.editor.autoStart')}
                  >
                    {tr('tunnel.badge.autoStart')}
                  </span>
                )}
                {running ? (
                  <button
                    className="btn-icon h-5 w-5 opacity-0 hover:text-warning group-hover:opacity-100"
                    title={tr('panel.tunnel.actionStop')}
                    onClick={() => void useTunnelStore.getState().stop(t.id)}
                  >
                    <Square size={11} />
                  </button>
                ) : (
                  <button
                    className="btn-icon h-5 w-5 opacity-0 hover:text-success group-hover:opacity-100"
                    title={tr('panel.tunnel.actionStart')}
                    onClick={() => void useTunnelStore.getState().start(t.id)}
                  >
                    <Play size={11} />
                  </button>
                )}
              </div>

              {/*
               * 第二行：端点
               */}
              <div className="mt-0.5 truncate pl-3 font-mono text-3xs text-ink-3">
                {describeEndpoint(t, runtime)}
              </div>

              {/*
               * 第三行：运行信息 / 错误
               */}
              {runtime?.status === 'error' && runtime.error && (
                <div className="mt-0.5 pl-3 text-3xs leading-relaxed text-danger/90">
                  {runtime.error}
                </div>
              )}
              {runtime?.status === 'reconnecting' && (
                <div className="mt-0.5 flex items-center gap-1.5 pl-3 text-3xs text-warning">
                  <Loader2 size={10} className="shrink-0 animate-spin" />
                  <span className="truncate">
                    {runtime.error ?? tr('tunnel.waitingReconnect')}
                  </span>
                </div>
              )}
              {runtime?.status === 'active' && (
                <div className="mt-0.5 flex items-center gap-2 pl-3 text-3xs text-ink-3">
                  {runtime.sessionTitle && (
                    <span className="truncate">
                      {tr('tunnel.viaSession', { name: runtime.sessionTitle })}
                    </span>
                  )}
                  {runtime.connectionCount > 0 && (
                    <span className="shrink-0">
                      {tr('panel.tunnel.forwardedCount', { count: runtime.connectionCount })}
                    </span>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {tunnels.length > 0 && (
        <div className="shrink-0 border-t border-edge-soft px-2.5 py-1.5 text-3xs leading-relaxed text-ink-3">
          <Zap size={10} className="mr-1 inline-block" />
          {tr('panel.tunnel.footerHint')}
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={closeMenu} />
      )}

      <TunnelEditor open={editorOpen} initial={editing} onClose={() => setEditorOpen(false)} />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={tr('panel.tunnel.deleteTitle')}
        danger
        confirmText={tr('panel.tunnel.deleteConfirm')}
        message={
          <>
            {tr('panel.tunnel.deletePrefix')}
            <span className="font-medium text-ink">
              {tr('panel.tunnel.deleteQuoted', { name: pendingDelete?.name ?? '' })}
            </span>
            {tr('panel.tunnel.deleteSuffix')}
            {pendingDelete && runtimes[pendingDelete.id]?.status === 'active' && (
              <div className="mt-1 text-2xs text-warning">
                {tr('panel.tunnel.deleteRunningWarn')}
              </div>
            )}
          </>
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const t = pendingDelete
          setPendingDelete(null)
          if (!t) return
          const stopFirst = (): Promise<void> =>
            runtimes[t.id]?.status === 'active' ||
            runtimes[t.id]?.status === 'starting' ||
            runtimes[t.id]?.status === 'reconnecting'
              ? useTunnelStore.getState().stop(t.id)
              : Promise.resolve()
          void stopFirst().then(() => useTunnelStore.getState().remove(t.id))
        }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */

function StatusDot({ runtime }: { runtime?: TunnelRuntimeInfo }): React.JSX.Element {
  const { t } = useI18n()
  const status = runtime?.status ?? 'stopped'
  return (
    <span
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        status === 'active' && 'bg-success',
        status === 'starting' && 'animate-pulse bg-warning',
        status === 'reconnecting' && 'animate-pulse bg-warning',
        status === 'error' && 'bg-danger',
        status === 'stopped' && 'bg-ink-3/40'
      )}
      title={
        status === 'active'
          ? t('panel.tunnel.statusActive')
          : status === 'starting'
            ? t('panel.tunnel.statusStarting')
            : status === 'reconnecting'
              ? t('panel.tunnel.statusReconnecting')
              : status === 'error'
                ? t('panel.tunnel.statusError')
                : t('panel.tunnel.statusStopped')
      }
    />
  )
}
