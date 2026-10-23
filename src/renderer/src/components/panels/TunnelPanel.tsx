import { useEffect, useState } from 'react'
import {
  Cable,
  Copy,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Search,
  Square,
  Trash2,
  Zap
} from 'lucide-react'
import type { TunnelConfig, TunnelRuntimeInfo } from '@shared/types'
import { cn } from '@/lib/utils'
import {
  ConfirmDialog,
  ContextMenu,
  EmptyState,
  useContextMenu,
  type MenuEntry
} from '@/components/ui'
import { TUNNEL_TYPE_LABEL, describeEndpoint, useTunnelStore } from '@/stores/tunnelStore'
import { TunnelEditor } from './TunnelEditor'

/**
 * 端口转发面板（侧栏「隧道」页）：
 * 管理 -L / -R / -D 三类隧道的配置与运行状态。
 * 启动时自动挑选合适的在线会话（优先关联连接，其次当前活动会话）。
 */
export function TunnelPanel(): JSX.Element {
  const tunnels = useTunnelStore((s) => s.tunnels)
  const runtimes = useTunnelStore((s) => s.runtimes)
  const loaded = useTunnelStore((s) => s.loaded)
  const keyword = useTunnelStore((s) => s.keyword)
  const setKeyword = useTunnelStore((s) => s.setKeyword)

  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<TunnelConfig | null>(null)
  const [pendingDelete, setPendingDelete] = useState<TunnelConfig | null>(null)
  const { menu, openMenu, closeMenu } = useContextMenu<TunnelConfig>()

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
    const running = runtime?.status === 'active' || runtime?.status === 'starting'
    return [
      running
        ? {
            label: '停止',
            icon: <Square size={12} />,
            onClick: () => void useTunnelStore.getState().stop(t.id)
          }
        : {
            label: '启动',
            icon: <Play size={12} />,
            onClick: () => void useTunnelStore.getState().start(t.id)
          },
      {
        label: '编辑',
        icon: <Pencil size={12} />,
        onClick: () => openEdit(t)
      },
      {
        label: '复制一份',
        icon: <Copy size={12} />,
        onClick: () =>
          void useTunnelStore.getState().save({
            name: `${t.name} 副本`,
            type: t.type,
            bindHost: t.bindHost,
            bindPort: t.bindPort,
            targetHost: t.targetHost,
            targetPort: t.targetPort,
            connectionId: t.connectionId,
            remark: t.remark
          })
      },
      {
        label: '删除',
        icon: <Trash2 size={12} />,
        danger: true,
        separatorBefore: true,
        onClick: () => setPendingDelete(t)
      }
    ]
  }

  return (
    <div className="flex h-full flex-col">
      {/* 头部 */}
      <div className="panel-head">
        <Cable size={13} className="shrink-0 text-ink-3" />
        <span className="panel-title">端口转发</span>
        <span className="panel-count">{tunnels.length}</span>
        <span className="flex-1" />
        <button
          className="btn-icon h-6 w-6"
          title="刷新"
          onClick={() => void useTunnelStore.getState().load()}
        >
          <RefreshCw size={13} />
        </button>
        <button className="btn-icon h-6 w-6" title="新建隧道" onClick={openCreate}>
          <Plus size={14} />
        </button>
      </div>

      {/* 搜索 */}
      <div className="panel-toolbar">
        <div className="relative flex-1">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            className="input h-7 pl-7 text-xs"
            placeholder="搜索名称 / 地址 / 端口…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
      </div>

      {/* 列表 */}
      <div className="panel-body">
        {filtered.length === 0 && (
          <EmptyState
            icon={<Cable size={24} />}
            title={tunnels.length === 0 ? '还没有隧道' : '没有匹配的隧道'}
            hint={
              tunnels.length === 0
                ? '建立隧道可把设备内网的服务映射到本机（-L）、或把本机服务暴露给设备（-R），也能开 SOCKS5 代理（-D）'
                : '换个关键字试试'
            }
            action={
              tunnels.length === 0 ? (
                <button className="btn btn-primary h-7 px-3 text-xs" onClick={openCreate}>
                  <Plus size={12} />
                  新建隧道
                </button>
              ) : undefined
            }
          />
        )}

        {!loaded && tunnels.length === 0 && (
          <div className="py-4 text-center text-2xs text-ink-3">加载中…</div>
        )}

        {filtered.map((t) => {
          const runtime: TunnelRuntimeInfo | undefined = runtimes[t.id]
          const running = runtime?.status === 'active' || runtime?.status === 'starting'
          return (
            <div
              key={t.id}
              className="group rounded-md px-2 py-1.5 transition-colors hover:bg-hover/60"
              onContextMenu={(e) => openMenu(e, t)}
            >
              {/* 第一行：状态点 + 名称 + 类型 + 启停 */}
              <div className="flex items-center gap-1.5">
                <StatusDot runtime={runtime} />
                <span className="min-w-0 flex-1 truncate text-xs text-ink" title={t.name}>
                  {t.name}
                </span>
                <span className="shrink-0 rounded border border-edge-soft bg-raised px-1 py-px font-mono text-3xs text-ink-3">
                  {TUNNEL_TYPE_LABEL[t.type]}
                </span>
                {running ? (
                  <button
                    className="btn-icon h-5 w-5 opacity-0 hover:text-warning group-hover:opacity-100"
                    title="停止"
                    onClick={() => void useTunnelStore.getState().stop(t.id)}
                  >
                    <Square size={11} />
                  </button>
                ) : (
                  <button
                    className="btn-icon h-5 w-5 opacity-0 hover:text-success group-hover:opacity-100"
                    title="启动"
                    onClick={() => void useTunnelStore.getState().start(t.id)}
                  >
                    <Play size={11} />
                  </button>
                )}
              </div>

              {/* 第二行：端点 */}
              <div className="mt-0.5 truncate pl-3 font-mono text-3xs text-ink-3">
                {describeEndpoint(t, runtime)}
              </div>

              {/* 第三行：运行信息 / 错误 */}
              {runtime?.status === 'error' && runtime.error && (
                <div className="mt-0.5 pl-3 text-3xs leading-relaxed text-danger/90">
                  {runtime.error}
                </div>
              )}
              {runtime?.status === 'active' && (
                <div className="mt-0.5 flex items-center gap-2 pl-3 text-3xs text-ink-3">
                  {runtime.sessionTitle && (
                    <span className="truncate">经由：{runtime.sessionTitle}</span>
                  )}
                  {runtime.connectionCount > 0 && (
                    <span className="shrink-0">↑ 已转发 {runtime.connectionCount} 条连接</span>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* 低噪音提示 */}
      {tunnels.length > 0 && (
        <div className="shrink-0 border-t border-edge-soft px-2.5 py-1.5 text-3xs leading-relaxed text-ink-3">
          <Zap size={10} className="mr-1 inline-block" />
          隧道挂在选中的 SSH 会话上，会话断开时自动停止。
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={closeMenu} />
      )}

      <TunnelEditor open={editorOpen} initial={editing} onClose={() => setEditorOpen(false)} />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除隧道"
        danger
        confirmText="删除"
        message={
          <>
            确定删除隧道
            <span className="font-medium text-ink">「{pendingDelete?.name}」</span>吗？
            {pendingDelete && runtimes[pendingDelete.id]?.status === 'active' && (
              <div className="mt-1 text-2xs text-warning">该隧道正在运行，删除前会先停止。</div>
            )}
          </>
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const t = pendingDelete
          setPendingDelete(null)
          if (!t) return
          const stopFirst = (): Promise<void> =>
            runtimes[t.id]?.status === 'active' || runtimes[t.id]?.status === 'starting'
              ? useTunnelStore.getState().stop(t.id)
              : Promise.resolve()
          void stopFirst().then(() => useTunnelStore.getState().remove(t.id))
        }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ */

function StatusDot({ runtime }: { runtime?: TunnelRuntimeInfo }): JSX.Element {
  const status = runtime?.status ?? 'stopped'
  return (
    <span
      className={cn(
        'h-1.5 w-1.5 shrink-0 rounded-full',
        status === 'active' && 'bg-success',
        status === 'starting' && 'animate-pulse bg-warning',
        status === 'error' && 'bg-danger',
        status === 'stopped' && 'bg-ink-3/40'
      )}
      title={
        status === 'active'
          ? '运行中'
          : status === 'starting'
            ? '启动中'
            : status === 'error'
              ? '错误'
              : '未启动'
      }
    />
  )
}
