import { useMemo, useState } from 'react'
import {
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  FileDown,
  FileUp,
  FolderPlus,
  Pencil,
  Plug,
  Plus,
  Search,
  SquareTerminal,
  Trash2,
  X
} from 'lucide-react'
import type { Connection, ConnectionInput } from '@shared/types'
import { groupConnections, useConnectionStore } from '@/stores/connectionStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useToastStore } from '@/stores/toastStore'
import { cn, formatRelativeTime } from '@/lib/utils'
import { call } from '@/lib/ipc'
import { ConnTransferDialog } from './ConnTransferDialog'
import {
  ConfirmDialog,
  ContextMenu,
  EmptyState,
  useContextMenu,
  type MenuEntry
} from '@/components/ui'

/**
 * 左侧连接列表：分组折叠、搜索、双击打开、右键菜单、从剪贴板识别 ssh 命令。
 */
export function ConnectionSidebar({
  onEdit
}: {
  onEdit: (initial: Connection | null, preset?: Partial<ConnectionInput>) => void
}): JSX.Element {
  const connections = useConnectionStore((s) => s.connections)
  const keyword = useConnectionStore((s) => s.keyword)
  const setKeyword = useConnectionStore((s) => s.setKeyword)
  const collapsed = useConnectionStore((s) => s.collapsed)
  const toggleGroup = useConnectionStore((s) => s.toggleGroup)
  const remove = useConnectionStore((s) => s.remove)
  const save = useConnectionStore((s) => s.save)

  const sessions = useSessionStore((s) => s.sessions)
  const open = useSessionStore((s) => s.open)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Connection | null>(null)
  const { menu, openMenu, closeMenu } = useContextMenu<Connection>()
  const transferMenu = useContextMenu<'transfer'>()
  const [transfer, setTransfer] = useState<'export' | 'import' | null>(null)

  const groups = useMemo(() => groupConnections(connections, keyword), [connections, keyword])

  const openConnection = (c: Connection): void => {
    open({ id: c.id, name: c.name, host: c.host, username: c.username })
  }

  const duplicateConnection = async (c: Connection): Promise<void> => {
    const saved = await save({
      name: `${c.name} 副本`,
      host: c.host,
      port: c.port,
      username: c.username,
      authType: c.authType,
      privateKeyPath: c.privateKeyPath,
      group: c.group,
      tags: c.tags,
      color: c.color,
      remark: c.remark
    })
    if (saved) {
      useToastStore.getState().push({
        kind: 'success',
        title: '已复制连接',
        detail: '出于安全考虑，密码不会随连接复制，请编辑副本补全凭据'
      })
    }
  }

  const importFromClipboard = async (): Promise<void> => {
    const parsed = await call(window.api.conn.parseSshCommand(), { silent: true })
    if (!parsed || !parsed.ok) {
      useToastStore.getState().push({
        kind: 'warning',
        title: '剪贴板里没有可识别的 ssh 命令',
        detail: '支持的格式示例：ssh root@192.168.1.10 -p 2222 -i ~/.ssh/id_rsa'
      })
      return
    }
    onEdit(null, {
      name: parsed.username ? `${parsed.username}@${parsed.host}` : parsed.host,
      host: parsed.host,
      port: parsed.port ?? 22,
      username: parsed.username ?? 'root',
      authType: parsed.privateKeyPath ? 'privateKey' : 'password',
      privateKeyPath: parsed.privateKeyPath
    })
  }

  const menuItems = (c: Connection): MenuEntry[] => [
    { label: '连接', icon: <Plug size={12} />, onClick: () => openConnection(c) },
    { label: '编辑', icon: <Pencil size={12} />, onClick: () => onEdit(c) },
    { label: '复制连接', icon: <Copy size={12} />, onClick: () => void duplicateConnection(c) },
    {
      label: '新建同组连接',
      icon: <FolderPlus size={12} />,
      onClick: () => onEdit(null, { group: c.group })
    },
    {
      label: '删除',
      icon: <Trash2 size={12} />,
      danger: true,
      separatorBefore: true,
      onClick: () => setPendingDelete(c)
    }
  ]

  return (
    <div className="flex h-full flex-col">
      {/* 搜索与操作：搜索框独占一行，操作按钮另起一行，避免窄栏里被挤压 */}
      <div className="shrink-0 space-y-1.5 border-b border-edge-soft px-2 py-1.5">
        <div className="relative">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            className="input h-7 py-0 pl-7 pr-6 text-xs"
            placeholder="搜索连接 / 主机 / 标签…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          {keyword && (
            <button
              className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded text-ink-3 hover:text-ink"
              title="清空搜索"
              onClick={() => setKeyword('')}
            >
              <X size={12} />
            </button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button
            className="btn-icon h-6 flex-1 gap-1 px-1.5 text-2xs"
            title="导出 / 导入连接（发给同事直接可用）"
            onClick={(e) => transferMenu.openMenu(e, 'transfer')}
          >
            <ArrowDownUp size={13} />
            <span>导入导出</span>
          </button>
          <button
            className="btn-icon h-6 flex-1 gap-1 px-1.5 text-2xs"
            title="从剪贴板识别 ssh 命令并新建连接"
            onClick={() => void importFromClipboard()}
          >
            <ClipboardPaste size={13} />
            <span>剪贴板</span>
          </button>
          <button
            className="btn-icon h-6 flex-1 gap-1 px-1.5 text-2xs"
            title="新建连接 (Ctrl+N)"
            onClick={() => onEdit(null)}
          >
            <Plus size={14} />
            <span>新建</span>
          </button>
        </div>
      </div>

      {/* 列表 */}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1.5">
        {groups.length === 0 && (
          <EmptyState
            icon={<SquareTerminal size={26} />}
            title={connections.length === 0 ? '还没有连接' : '没有匹配的连接'}
            hint={
              connections.length === 0
                ? '点击右上角 + 新建，或复制 ssh 命令后用剪贴板按钮一键填充'
                : '换个关键字试试'
            }
          />
        )}

        {groups.map(({ group, items }) => (
          <div key={group} className="mb-0.5">
            <button
              className="flex w-full cursor-default items-center gap-1 rounded-md px-1.5 py-1 text-2xs font-medium text-ink-3 transition-colors hover:text-ink-2"
              onClick={() => toggleGroup(group)}
            >
              {collapsed[group] ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
              <span className="truncate">{group}</span>
              <span className="text-ink-3/60">{items.length}</span>
            </button>

            {!collapsed[group] &&
              items.map((c) => {
                const live = sessions.find((s) => s.connectionId === c.id)
                return (
                  <div
                    key={c.id}
                    className={cn(
                      'group relative cursor-default rounded-md py-1.5 pl-2 pr-1 transition-colors duration-75',
                      selectedId === c.id ? 'bg-hover' : 'hover:bg-hover/60'
                    )}
                    onClick={() => setSelectedId(c.id)}
                    onDoubleClick={() => openConnection(c)}
                    onContextMenu={(e) => openMenu(e, c)}
                  >
                    <div className="flex items-center gap-2">
                      {/* 色标 */}
                      <span
                        className="h-4 w-[3px] shrink-0 rounded-full"
                        style={{ background: c.color ?? 'rgb(var(--c-edge))' }}
                      />

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-xs text-ink">{c.name}</span>
                          {live && (
                            <span
                              className={cn(
                                'h-1.5 w-1.5 shrink-0 rounded-full',
                                live.status === 'connected' && 'bg-success',
                                live.status === 'connecting' && 'bg-warning animate-pulse-soft',
                                live.status === 'error' && 'bg-danger',
                                live.status === 'disconnected' && 'bg-ink-3'
                              )}
                            />
                          )}
                          <span className="shrink-0 text-2xs text-ink-3/70">
                            {formatRelativeTime(c.lastUsedAt)}
                          </span>
                        </div>
                      </div>

                      <button
                        className="btn-icon h-6 w-6 shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
                        title="打开连接"
                        onClick={(e) => {
                          e.stopPropagation()
                          openConnection(c)
                        }}
                      >
                        <Plug size={13} />
                      </button>
                    </div>
                    {/* 主机信息单独一行，占满宽度，不再与时间戳互相挤压 */}
                    <div className="mt-0.5 truncate pl-[11px] font-mono text-2xs text-ink-3" title={`${c.username}@${c.host}:${c.port}`}>
                      {c.username}@{c.host}:{c.port}
                    </div>
                    {c.tags.length > 0 && (
                      <div className="mt-1 flex flex-wrap gap-1 pl-[11px]">
                        {c.tags.slice(0, 3).map((t) => (
                          <span
                            key={t}
                            className="max-w-[76px] truncate rounded border border-edge-soft bg-raised px-1 py-px text-[10px] leading-tight text-ink-3"
                          >
                            {t}
                          </span>
                        ))}
                        {c.tags.length > 3 && (
                          <span className="text-[10px] text-ink-3/70">+{c.tags.length - 3}</span>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
          </div>
        ))}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={closeMenu} />}

      {transferMenu.menu && (
        <ContextMenu
          x={transferMenu.menu.x}
          y={transferMenu.menu.y}
          items={[
            {
              label: '导出连接…',
              icon: <FileDown size={12} />,
              disabled: connections.length === 0,
              onClick: () => setTransfer('export')
            },
            { label: '导入连接…', icon: <FileUp size={12} />, onClick: () => setTransfer('import') }
          ]}
          onClose={transferMenu.closeMenu}
        />
      )}
      <ConnTransferDialog mode={transfer} onClose={() => setTransfer(null)} />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除连接"
        danger
        confirmText="删除"
        message={
          <>
            确定删除连接 <span className="font-medium text-ink">「{pendingDelete?.name}」</span>
            （{pendingDelete?.username}@{pendingDelete?.host}）吗？
            <div className="mt-2 text-2xs text-ink-3">
              删除后已保存的密码会一并从凭据保险箱移除，该操作不可撤销。
            </div>
          </>
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete
          setPendingDelete(null)
          if (!target) return
          void remove(target.id).then((ok) => {
            if (ok) {
              useToastStore.getState().push({ kind: 'success', title: `已删除「${target.name}」` })
            }
          })
        }}
      />
    </div>
  )
}
