import { useMemo, useState } from 'react'
import {
  ArrowDownUp,
  ChevronDown,
  ChevronRight,
  ClipboardPaste,
  Copy,
  FileDown,
  FileUp,
  FolderInput,
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
import { useSettingsStore } from '@/stores/settingsStore'
import { useToastStore } from '@/stores/toastStore'
import { cn, formatRelativeTime } from '@/lib/utils'
import { call } from '@/lib/ipc'
import { ConnTransferDialog } from './ConnTransferDialog'
import {
  ConfirmDialog,
  ContextMenu,
  EmptyState,
  PromptDialog,
  useContextMenu,
  type MenuEntry
} from '@/components/ui'

/**
 * 左侧连接列表：分组折叠、搜索、双击打开、右键菜单、从剪贴板识别 ssh 命令。
 */

/** 每个分组默认先渲染多少条（滚动到「还有 N 条」按钮时再追加） */
const PAGE_SIZE = 60
/** 超过这个数的分组默认折叠，避免一次铺出几千行 */
const LARGE_GROUP = 200

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
  const createGroup = useConnectionStore((s) => s.createGroup)
  const renameGroup = useConnectionStore((s) => s.renameGroup)
  const deleteGroup = useConnectionStore((s) => s.deleteGroup)
  const setGroupOrder = useConnectionStore((s) => s.setGroupOrder)
  const savedGroups = useSettingsStore((s) => s.settings.connectionGroups)
  const savedOrder = useSettingsStore((s) => s.settings.connectionGroupOrder)

  const sessions = useSessionStore((s) => s.sessions)
  const open = useSessionStore((s) => s.open)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Connection | null>(null)
  const { menu, openMenu, closeMenu } = useContextMenu<Connection>()
  const transferMenu = useContextMenu<'transfer'>()
  const [transfer, setTransfer] = useState<'export' | 'import' | null>(null)

  // 分组管理的三个弹窗 / 一个右键菜单
  const groupMenu = useContextMenu<string>()
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const [pendingDeleteGroup, setPendingDeleteGroup] = useState<string | null>(null)
  /** 拖拽中的分组名（用于分组之间拖拽排序） */
  const [draggingGroup, setDraggingGroup] = useState<string | null>(null)
  /** 「移到分组」的目标连接 */
  const [movingConn, setMovingConn] = useState<Connection | null>(null)
  const moveToGroup = useConnectionStore((s) => s.moveToGroup)

  const groups = useMemo(
    () => groupConnections(connections, keyword, savedGroups ?? [], savedOrder ?? []),
    [connections, keyword, savedGroups, savedOrder]
  )

  /** 所有分组名（含空分组），用于「移到分组 / 新建同组」的候选列表 */
  const allGroupNames = useMemo(() => groups.map((g) => g.group), [groups])

  /**
   * 连接 id → 会话索引。
   * 原实现把 `sessions.find(...)` 写在每个列表项里，复杂度 O(连接数 × 会话数)：
   * 连接上千条时，每渲染一轮要跑几万次比较。
   */
  const sessionByConn = useMemo(() => {
    const map = new Map<string, (typeof sessions)[number]>()
    for (const s of sessions) if (!map.has(s.connectionId)) map.set(s.connectionId, s)
    return map
  }, [sessions])

  /**
   * 每个分组当前渲染多少条。
   * 连接库可能有几千条（实测 2917 条同组），一次性铺出来会让侧栏卡死，
   * 因此分页渲染：默认一屏 60 条，滚到底部自动追加。
   * 同时默认折叠「超长分组」，用户主动点击才展开。
   */
  const [shown, setShown] = useState<Record<string, number>>({})

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

  /** 分组右键菜单：新建 / 重命名 / 删除 */
  const groupMenuItems = (group: string): MenuEntry[] => [
    {
      label: '在此分组新建连接',
      icon: <Plus size={12} />,
      onClick: () => onEdit(null, { group })
    },
    {
      label: '重命名分组',
      icon: <Pencil size={12} />,
      onClick: () => setRenamingGroup(group)
    },
    { label: '新建分组…', icon: <FolderPlus size={12} />, onClick: () => setNewGroupOpen(true) },
    {
      label: '删除分组',
      icon: <Trash2 size={12} />,
      danger: true,
      separatorBefore: true,
      onClick: () => setPendingDeleteGroup(group)
    }
  ]

  /** 拖拽分组排序：放到 target 之前或之后 */
  const dropGroup = (src: string, target: string, after: boolean): void => {
    if (src === target) return
    const names = allGroupNames.filter((n) => n !== src)
    const ti = names.indexOf(target)
    if (ti < 0) return
    names.splice(after ? ti + 1 : ti, 0, src)
    void setGroupOrder(names)
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
      label: '移到分组',
      icon: <FolderInput size={12} />,
      disabled: allGroupNames.length === 0,
      onClick: () => {
        // 子菜单在 ContextMenu 里不支持，这里用「切到下一个分组」的确定性行为代替弹窗：
        // 直接弹分组选择由 setMovingConn 控制，见下方 moveDialog
        setMovingConn(c)
      }
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
      {/* 头部：标题 + 总数 + 全局操作（图标化，省一行高度） */}
      <div className="panel-head">
        <Plug size={13} className="shrink-0 text-ink-3" />
        <span className="panel-title">连接</span>
        <span className="panel-count">{connections.length}</span>
        <span className="flex-1" />
        <button
          className="btn-icon h-6 w-6"
          title="导出 / 导入连接（发给同事直接可用）"
          aria-label="导入导出"
          onClick={(e) => transferMenu.openMenu(e, 'transfer')}
        >
          <ArrowDownUp size={13} />
        </button>
        <button
          className="btn-icon h-6 w-6"
          title="从剪贴板识别 ssh 命令并新建连接"
          aria-label="剪贴板导入"
          onClick={() => void importFromClipboard()}
        >
          <ClipboardPaste size={13} />
        </button>
        <button
          className="btn-icon h-6 w-6"
          title="新建分组"
          aria-label="新建分组"
          onClick={() => setNewGroupOpen(true)}
        >
          <FolderPlus size={13} />
        </button>
        <button
          className="btn-icon h-6 w-6"
          title="新建连接 (Ctrl+N)"
          aria-label="新建连接"
          onClick={() => onEdit(null)}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* 搜索：独占一行，宽度足够看清长主机名 */}
      <div className="panel-toolbar">
        <div className="relative flex-1">
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
      </div>

      {/* 列表 */}
      <div
        data-testid="connection-sidebar"
        className="panel-body"
      >
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

        {groups.map(({ group, items }) => {
          const searching = keyword.trim().length > 0
          // 用户手动折叠过就听用户的；没动过时，超长分组默认收起
          const isCollapsed =
            collapsed[group] !== undefined
              ? collapsed[group]
              : items.length > LARGE_GROUP && !searching
          const limit = shown[group] ?? PAGE_SIZE
          const visible = searching ? items : items.slice(0, limit)
          const rest = items.length - visible.length

          return (
            <div
              key={group}
              className="mb-1"
              onDragOver={(e) => {
                if (!draggingGroup) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(e) => {
                if (!draggingGroup) return
                e.preventDefault()
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                // 落在分组下半区就是「放在这个分组之后」
                const after = e.clientY > rect.top + Math.min(rect.height, 24) / 2
                dropGroup(draggingGroup, group, after)
                setDraggingGroup(null)
              }}
            >
              {/* 分组头做成 sticky：几千条连接往下滚时，永远知道自己在哪个组 */}
              <button
                className={cn(
                  'sticky top-0 z-10 flex w-full cursor-default items-center gap-1 rounded-md bg-panel px-1.5 py-1 text-2xs font-semibold text-ink-3 transition-colors hover:text-ink-2',
                  draggingGroup === group && 'opacity-40'
                )}
                draggable
                title="右键管理分组；按住拖拽可调整分组顺序"
                onClick={() => toggleGroup(group, isCollapsed)}
                onDragStart={(e) => {
                  setDraggingGroup(group)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragEnd={() => setDraggingGroup(null)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  groupMenu.openMenu(e, group)
                }}
              >
                {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                <span className="truncate">{group}</span>
                <span className="font-mono font-normal text-ink-3/60">{items.length}</span>
              </button>

              {!isCollapsed &&
                visible.map((c) => {
                  const live = sessionByConn.get(c.id)
                  const active = selectedId === c.id
                  /*
                   * 「最近使用」只对七天内用过的连接显示。
                   * 原来每行都印一个相对时间（`3 天前` / `2 个月前`），
                   * 2929 行里 2900 行都是几个月前的同一个灰字 —— 它不再是信息，
                   * 而是一层均匀的噪点，把真正需要区分的名字/主机压了下去。
                   */
                  const recent =
                    c.lastUsedAt !== undefined && Date.now() - c.lastUsedAt < 7 * 24 * 3600 * 1000
                  return (
                    <div
                      key={c.id}
                      data-conn-id={c.id}
                      tabIndex={0}
                      role="button"
                      className={cn(
                        'group relative cursor-default rounded-md py-1.5 pl-2 pr-1 transition-colors duration-150',
                        'focus-visible:bg-hover focus-visible:outline-none',
                        active ? 'bg-select' : 'hover:bg-hover'
                      )}
                      onClick={() => setSelectedId(c.id)}
                      onDoubleClick={() => openConnection(c)}
                      onKeyDown={(e) => {
                        // 选中态存在的意义就是「键盘能接着操作」，否则单选没有落点
                        if (e.key === 'Enter') openConnection(c)
                      }}
                      onContextMenu={(e) => openMenu(e, c)}
                    >
                      <div className="flex items-center gap-2">
                        {/*
                         * 色标只在用户真的设过颜色时出现。
                         * 之前没设颜色也画一条 --c-edge 的灰竖线「保持左缘对齐」，
                         * 结果几千行浅灰短横在左缘排成一道虚线，比不画还乱。
                         * 对齐改由下面的固定宽度占位保证 —— 占位不留背景色。
                         */}
                        <span className="flex h-4 w-[3px] shrink-0 items-center justify-center">
                          {c.color && (
                            <span
                              className="h-4 w-full rounded-full"
                              style={{ background: c.color }}
                            />
                          )}
                        </span>

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
                            <span className="flex-1" />
                            {recent && (
                              <span className="shrink-0 text-3xs tabular-nums text-ink-3/60">
                                {formatRelativeTime(c.lastUsedAt)}
                              </span>
                            )}
                          </div>

                          {/* 主机信息：等宽字体，单行省略，悬停看完整地址 */}
                          <div
                            className="mt-0.5 truncate pl-[11px] font-mono text-2xs text-ink-3"
                            title={`${c.username}@${c.host}:${c.port}`}
                          >
                            {c.username}@{c.host}:{c.port}
                          </div>

                          {c.tags.length > 0 && (
                            <div className="mt-1 flex gap-1 pl-[11px]">
                              {c.tags.slice(0, 2).map((t) => (
                                <span
                                  key={t}
                                  className="max-w-[76px] truncate rounded border border-edge-soft px-1 text-3xs leading-4 text-ink-3"
                                >
                                  {t}
                                </span>
                              ))}
                              {c.tags.length > 2 && (
                                <span className="text-3xs leading-4 text-ink-3/70">
                                  +{c.tags.length - 2}
                                </span>
                              )}
                            </div>
                          )}
                        </div>

                        {/*
                         * 打开按钮用绝对定位悬浮在行右缘，而不是当作 flex 子项。
                         * 作为子项时它即使 opacity-0 也照样占 24px，长设备名
                         * （`RTU-消毒仓-3号-2024改`）会被无谓地截短 24px。
                         */}
                        <button
                          className="btn-icon absolute right-1 top-1/2 h-6 w-6 -translate-y-1/2 opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100"
                          title="打开连接"
                          tabIndex={-1}
                          onClick={(e) => {
                            e.stopPropagation()
                            openConnection(c)
                          }}
                        >
                          <Plug size={13} />
                        </button>
                      </div>
                    </div>
                  )
                })}

              {/* 分页尾巴：一次只铺 60 条，剩下的一次点一下补一屏 */}
              {!isCollapsed && rest > 0 && (
                <button
                  className="mb-1 mt-0.5 flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-edge-soft py-1 text-2xs text-ink-3 transition-colors hover:border-edge hover:bg-hover hover:text-ink-2"
                  onClick={() =>
                    setShown((s) => ({ ...s, [group]: (s[group] ?? PAGE_SIZE) + PAGE_SIZE * 2 }))
                  }
                >
                  <ChevronDown size={11} />
                  还有 {rest} 条，继续展开
                </button>
              )}
            </div>
          )
        })}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={closeMenu} />}

      {groupMenu.menu && (
        <ContextMenu
          x={groupMenu.menu.x}
          y={groupMenu.menu.y}
          items={groupMenuItems(groupMenu.menu.target)}
          onClose={groupMenu.closeMenu}
        />
      )}

      {/* 新建分组 */}
      <PromptDialog
        open={newGroupOpen}
        title="新建分组"
        label="分组名称"
        placeholder="例如：机器人 / 充电桩 / 现场设备"
        onCancel={() => setNewGroupOpen(false)}
        onConfirm={(name) => {
          setNewGroupOpen(false)
          void createGroup(name).then((ok) => {
            if (ok) {
              useToastStore.getState().push({ kind: 'success', title: `已新建分组「${name}」` })
            }
          })
        }}
      />

      {/* 重命名分组 */}
      <PromptDialog
        open={renamingGroup !== null}
        title="重命名分组"
        label="新名称"
        defaultValue={renamingGroup ?? ''}
        onCancel={() => setRenamingGroup(null)}
        onConfirm={(name) => {
          const old = renamingGroup
          setRenamingGroup(null)
          if (!old) return
          void renameGroup(old, name).then(() => {
            useToastStore.getState().push({ kind: 'success', title: `已重命名为「${name}」` })
          })
        }}
      />

      {/* 删除分组确认 */}
      <ConfirmDialog
        open={pendingDeleteGroup !== null}
        title="删除分组"
        danger
        confirmText="删除"
        message={
          <>
            确定删除分组
            <span className="font-medium text-ink">「{pendingDeleteGroup}」</span>
            及其下全部连接吗？
            <div className="mt-2 text-2xs text-ink-3">
              该分组内共
              <span className="font-medium text-ink">
                {' '}
                {groups.find((g) => g.group === pendingDeleteGroup)?.items.length ?? 0}{' '}
              </span>
              条连接，删除后已保存的密码会一并从凭据保险箱移除，操作不可撤销。
            </div>
          </>
        }
        onCancel={() => setPendingDeleteGroup(null)}
        onConfirm={() => {
          const target = pendingDeleteGroup
          setPendingDeleteGroup(null)
          if (!target) return
          void deleteGroup(target).then((n) => {
            if (n !== null) {
              useToastStore
                .getState()
                .push({ kind: 'success', title: `已删除分组「${target}」及 ${n} 条连接` })
            }
          })
        }}
      />

      {/* 移到分组：列出全部分组，点一个就迁过去 */}
      {movingConn && (
        <ContextMenu
          x={window.innerWidth / 2 - 90}
          y={window.innerHeight / 2 - 120}
          items={[
            ...allGroupNames.map((g) => ({
              label: g,
              disabled: (movingConn.group || '默认') === g,
              onClick: () => {
                const target = movingConn
                setMovingConn(null)
                if (!target) return
                void moveToGroup([target.id], g).then((n) => {
                  if (n > 0) {
                    useToastStore
                      .getState()
                      .push({ kind: 'success', title: `已移到分组「${g}」` })
                  }
                })
              }
            })),
            {
              label: '新建分组并移入…',
              separatorBefore: true,
              onClick: () => {
                setMovingConn(null)
                setNewGroupOpen(true)
              }
            }
          ]}
          onClose={() => setMovingConn(null)}
        />
      )}

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
