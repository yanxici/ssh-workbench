import { useState } from 'react'
import { X, Plus, Pencil, XCircle, CircleSlash2, RefreshCw, SquarePlus } from 'lucide-react'
import type { ConnStatus } from '@shared/types'
import { useSessionStore } from '@/stores/sessionStore'
import { cn } from '@/lib/utils'
import { ContextMenu, useContextMenu, type MenuEntry } from '@/components/ui'

const STATUS_DOT: Record<ConnStatus, string> = {
  connecting: 'bg-warning animate-pulse-soft',
  connected: 'bg-success',
  disconnected: 'bg-ink-3',
  error: 'bg-danger'
}

/**
 * 顶部标签栏（同时是窗口拖拽区）。
 * 支持：切换、关闭、双击重命名、右键菜单、拖拽排序。
 */
export function TabBar({ onNewConnection }: { onNewConnection: () => void }): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions)
  const activeId = useSessionStore((s) => s.activeId)
  const setActive = useSessionStore((s) => s.setActive)
  const close = useSessionStore((s) => s.close)
  const closeOthers = useSessionStore((s) => s.closeOthers)
  const setTitle = useSessionStore((s) => s.setTitle)
  const reorder = useSessionStore((s) => s.reorder)
  const reconnect = useSessionStore((s) => s.reconnect)
  const openTerminal = useSessionStore((s) => s.openTerminal)
  const activeSession = sessions.find((x) => x.id === activeId)

  const [editingId, setEditingId] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  const { menu, openMenu, closeMenu } = useContextMenu<string>()

  const startRename = (id: string, current: string): void => {
    setEditingId(id)
    setEditText(current)
  }

  const commitRename = (): void => {
    if (editingId && editText.trim()) setTitle(editingId, editText.trim())
    setEditingId(null)
  }

  const menuItems = (id: string): MenuEntry[] => {
    const s = sessions.find((x) => x.id === id)
    const canReconnect = s && (s.status === 'disconnected' || s.status === 'error')
    return [
      ...(canReconnect
        ? [{ label: '重新连接', icon: <RefreshCw size={12} />, onClick: () => reconnect(id) }]
        : []),
      {
        label: '新建终端（复用此连接）',
        icon: <SquarePlus size={12} />,
        disabled: s?.status !== 'connected',
        onClick: () => openTerminal(id)
      },
      { label: '重命名', icon: <Pencil size={12} />, onClick: () => {
        if (s) startRename(id, s.title)
      } },
      { label: '关闭', icon: <XCircle size={12} />, onClick: () => close(id) },
      {
        label: '关闭其他标签',
        icon: <CircleSlash2 size={12} />,
        disabled: sessions.length <= 1,
        onClick: () => closeOthers(id)
      }
    ]
  }

  return (
    <div className="drag-region flex min-w-0 flex-1 items-end gap-0.5 overflow-hidden px-1.5 pt-1.5">
      {sessions.map((s, i) => {
        const isActive = s.id === activeId
        return (
          <div
            key={s.id}
            draggable={editingId !== s.id}
            onDragStart={(e) => {
              setDragIndex(i)
              e.dataTransfer.effectAllowed = 'move'
            }}
            onDragOver={(e) => {
              e.preventDefault()
              setDropTarget(i)
            }}
            onDragLeave={() => setDropTarget((t) => (t === i ? null : t))}
            onDrop={(e) => {
              e.preventDefault()
              if (dragIndex !== null && dragIndex !== i) reorder(dragIndex, i)
              setDragIndex(null)
              setDropTarget(null)
            }}
            onDragEnd={() => {
              setDragIndex(null)
              setDropTarget(null)
            }}
            className={cn(
              'no-drag group relative flex h-[32px] min-w-[132px] max-w-[220px] shrink-0 cursor-default select-none',
              'items-center gap-2 rounded-t-lg border border-b-0 px-2.5 pt-px text-xs transition-colors duration-100',
              isActive
                ? 'border-edge bg-app text-ink'
                : 'border-transparent text-ink-3 hover:bg-hover/70 hover:text-ink-2',
              dropTarget === i && dragIndex !== null && dragIndex !== i && 'border-accent/60'
            )}
            onMouseDown={(e) => {
              if (e.button === 0) setActive(s.id)
            }}
            onDoubleClick={() => startRename(s.id, s.title)}
            onContextMenu={(e) => openMenu(e, s.id)}
            title={editingId === s.id ? undefined : `${s.username}@${s.host}`}
          >
            {/* 活动标签顶部强调线 */}
            {isActive && (
              <span className="absolute inset-x-2 top-0 h-[2px] rounded-full bg-accent" />
            )}

            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', STATUS_DOT[s.status])} />

            {editingId === s.id ? (
              <input
                autoFocus
                value={editText}
                onChange={(e) => setEditText(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename()
                  if (e.key === 'Escape') setEditingId(null)
                }}
                className="h-5 min-w-0 flex-1 rounded border border-accent/60 bg-app px-1 text-xs text-ink outline-none"
              />
            ) : (
              <span className="min-w-0 flex-1 truncate">{s.title}</span>
            )}

            {(s.status === 'disconnected' || s.status === 'error') && (
              <button
                className="btn-icon h-5 w-5 shrink-0 rounded text-warning"
                title="重新连接"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation()
                  reconnect(s.id)
                }}
              >
                <RefreshCw size={11} />
              </button>
            )}

            <button
              className={cn(
                'btn-icon -mr-1 h-5 w-5 shrink-0 rounded',
                isActive ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-70'
              )}
              title="关闭标签"
              onClick={(e) => {
                e.stopPropagation()
                close(s.id)
              }}
            >
              <X size={12} />
            </button>
          </div>
        )
      })}

      {/* 在当前会话上新建终端（复用 SSH 连接，免重新登录） */}
      {activeSession && (
        <button
          className="no-drag btn-icon mb-1 ml-0.5 h-6 w-6 shrink-0"
          title="在当前会话新建终端 (Ctrl+Shift+T)"
          disabled={activeSession.status !== 'connected'}
          onClick={() => openTerminal(activeSession.id)}
        >
          <SquarePlus size={14} />
        </button>
      )}

      {/* 新建连接 */}
      <button
        className="no-drag btn-icon mb-1 ml-0.5 h-6 w-6 shrink-0"
        title="新建连接 (Ctrl+N)"
        onClick={onNewConnection}
      >
        <Plus size={14} />
      </button>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={closeMenu} />
      )}
    </div>
  )
}
