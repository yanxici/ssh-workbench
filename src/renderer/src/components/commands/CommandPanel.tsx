import { useMemo, useState, type DragEvent } from 'react'
import {
  AlertTriangle,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  Braces,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  FolderPlus,
  GripVertical,
  Pencil,
  PanelRightClose,
  Play,
  Plus,
  Search,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import type { Command } from '@shared/types'
import { groupCommands, useCommandStore } from '@/stores/commandStore'
import { runCommand } from '@/stores/executionStore'
import { useToastStore } from '@/stores/toastStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { cn } from '@/lib/utils'
import { moveItem, placeRelative } from '@/lib/groupOrder'
import { isCommandDrag } from '@/lib/commandDrag'
import { DynamicIcon } from '@/lib/icons'
import { ConfirmDialog, ContextMenu, EmptyState, PromptDialog, useContextMenu, type MenuEntry } from '@/components/ui'

/**
 * 常用命令面板（重点功能）：
 * - 分组折叠 / 关键字搜索 / 单击执行（变量 -> 危险确认 -> 发送）
 * - 组内拖拽排序；命令项可直接拖到终端区执行
 * - 右键：执行 / 编辑 / 复制一条 / 删除
 * - 头部「折叠」按钮把面板收成一条窄条，把空间让给终端
 */
export function CommandPanel({
  onEdit,
  layout = 'vertical',
  onCollapse
}: {
  /** presetGroup：新建命令时预填的分组 */
  onEdit: (initial: Command | null, presetGroup?: string) => void
  /** vertical = 右侧栏；horizontal = 底部横条（分组横向排列） */
  layout?: 'vertical' | 'horizontal'
  /** 头部「折叠」按钮回调；不传则不显示该按钮 */
  onCollapse?: () => void
}): JSX.Element {
  const horizontal = layout === 'horizontal'
  const commands = useCommandStore((s) => s.commands)
  const keyword = useCommandStore((s) => s.keyword)
  const setKeyword = useCommandStore((s) => s.setKeyword)
  const collapsed = useCommandStore((s) => s.collapsed)
  const toggleGroup = useCommandStore((s) => s.toggleGroup)
  const remove = useCommandStore((s) => s.remove)
  const save = useCommandStore((s) => s.save)
  const reorder = useCommandStore((s) => s.reorder)
  const renameGroup = useCommandStore((s) => s.renameGroup)
  const deleteGroup = useCommandStore((s) => s.deleteGroup)
  const importJson = useCommandStore((s) => s.importJson)
  const exportJson = useCommandStore((s) => s.exportJson)

  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Command | null>(null)
  const [pendingDeleteGroup, setPendingDeleteGroup] = useState<string | null>(null)
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const [newGroupDialog, setNewGroupDialog] = useState(false)
  /** 搜索框默认收起，头部点搜索图标才展开 —— 常态下不占一行高度 */
  const [searchOpen, setSearchOpen] = useState(false)
  const { menu, openMenu, closeMenu } = useContextMenu<Command>()

  const extraGroups = useSettingsStore((s) => s.settings.commandGroups)
  const groupOrder = useSettingsStore((s) => s.settings.commandGroupOrder)
  const createGroup = useCommandStore((s) => s.createGroup)
  const setGroupOrder = useCommandStore((s) => s.setGroupOrder)
  const groups = useMemo(
    () => groupCommands(commands, keyword, extraGroups ?? [], groupOrder ?? []),
    [commands, keyword, extraGroups, groupOrder]
  )
  const searching = keyword.trim().length > 0

  /* ---------- 分组排序 ---------- */
  /** 全部分组名（不受搜索过滤影响），排序操作基于它 */
  const allGroupNames = useMemo(
    () => groupCommands(commands, '', extraGroups ?? [], groupOrder ?? []).map((g) => g.group),
    [commands, extraGroups, groupOrder]
  )
  const [dragGroup, setDragGroup] = useState<string | null>(null)
  const [groupDrop, setGroupDrop] = useState<{ group: string; after: boolean } | null>(null)
  const groupMenu = useContextMenu<string>()

  const moveGroupTo = (group: string, to: number): void => {
    const from = allGroupNames.indexOf(group)
    if (from < 0 || from === to) return
    void setGroupOrder(moveItem(allGroupNames, from, to))
  }

  const groupMenuItems = (group: string): MenuEntry[] => {
    const idx = allGroupNames.indexOf(group)
    const last = allGroupNames.length - 1
    return [
      {
        label: '移到最前',
        icon: <ArrowUpToLine size={12} />,
        disabled: idx <= 0,
        onClick: () => moveGroupTo(group, 0)
      },
      {
        label: '上移',
        icon: <ArrowUp size={12} />,
        disabled: idx <= 0,
        onClick: () => moveGroupTo(group, idx - 1)
      },
      {
        label: '下移',
        icon: <ArrowDown size={12} />,
        disabled: idx < 0 || idx >= last,
        onClick: () => moveGroupTo(group, idx + 1)
      },
      {
        label: '移到最后',
        icon: <ArrowDownToLine size={12} />,
        disabled: idx < 0 || idx >= last,
        onClick: () => moveGroupTo(group, last)
      },
      {
        label: '在此分组新建命令',
        icon: <Plus size={12} />,
        separatorBefore: true,
        onClick: () => onEdit(null, group)
      },
      { label: '重命名分组', icon: <Pencil size={12} />, onClick: () => setRenamingGroup(group) },
      {
        label: '删除分组',
        icon: <Trash2 size={12} />,
        danger: true,
        separatorBefore: true,
        onClick: () => setPendingDeleteGroup(group)
      }
    ]
  }

  const GROUP_MIME = 'application/x-ssh-cmd-group'
  /** 拖到分组容器上：按鼠标在前半/后半决定放在它之前还是之后 */
  const handleGroupDragOver = (e: DragEvent<HTMLDivElement>, group: string): void => {
    if (!dragGroup || !e.dataTransfer.types.includes(GROUP_MIME)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const after = horizontal
      ? e.clientX > rect.left + rect.width / 2
      : e.clientY > rect.top + Math.min(rect.height, 28) / 2
    if (groupDrop?.group !== group || groupDrop.after !== after) setGroupDrop({ group, after })
  }
  const handleGroupDrop = (e: DragEvent<HTMLDivElement>, group: string): void => {
    if (!dragGroup || !e.dataTransfer.types.includes(GROUP_MIME)) return
    e.preventDefault()
    const after = groupDrop?.group === group ? groupDrop.after : false
    const next = placeRelative(allGroupNames, dragGroup, group, after)
    setDragGroup(null)
    setGroupDrop(null)
    if (next.join('\u0000') !== allGroupNames.join('\u0000')) void setGroupOrder(next)
  }

  const handleNewGroup = (name: string): void => {
    void createGroup(name).then((ok) => {
      if (ok) useToastStore.getState().push({ kind: 'success', title: `已新建分组「${name.trim()}」` })
    })
  }

  /** 组内拖拽排序：只动本组，其他组位置不变 */
  const handleDropInGroup = (group: string, targetId: string, draggedId: string): void => {
    const g = groups.find((x) => x.group === group)
    if (!g) return
    const groupIds = g.items.map((i) => i.id)
    const from = groupIds.indexOf(draggedId)
    const to = groupIds.indexOf(targetId)
    if (from < 0 || to < 0 || from === to) return

    const nextGroupIds = [...groupIds]
    const [moved] = nextGroupIds.splice(from, 1)
    nextGroupIds.splice(to, 0, moved)

    // 替换全局顺序中该组的位置
    const globalIds = commands.map((c) => c.id)
    const slots = globalIds
      .map((id, idx) => ({ id, idx }))
      .filter((p) => groupIds.includes(p.id))
    slots.forEach((slot, i) => {
      globalIds[slot.idx] = nextGroupIds[i]
    })
    void reorder(globalIds)
  }

  const duplicate = async (c: Command): Promise<void> => {
    await save({
      name: `${c.name} 副本`,
      command: c.command,
      description: c.description,
      group: c.group,
      icon: c.icon,
      color: c.color,
      confirmRequired: c.confirmRequired,
      variables: c.variables
    })
  }

  const menuItems = (c: Command): MenuEntry[] => [
    { label: '执行', icon: <Play size={12} />, onClick: () => runCommand(c) },
    { label: '编辑', icon: <Pencil size={12} />, onClick: () => onEdit(c) },
    { label: '复制一条', icon: <Copy size={12} />, onClick: () => void duplicate(c) },
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
      {/* 头部（紧凑：一行放下标题与全部操作） */}
      <div className="flex shrink-0 items-center gap-1 border-b border-edge-soft px-1.5 py-1">
        <span className="truncate text-xs font-semibold text-ink">常用命令</span>
        <span className="shrink-0 text-2xs text-ink-3">{commands.length}</span>
        <span className="flex-1" />
        <button
          className="btn-icon h-6 w-6"
          title="搜索命令 (Ctrl+F)"
          onClick={() => {
            if (searchOpen) setKeyword('')
            setSearchOpen((v) => !v)
          }}
        >
          <Search size={13} />
        </button>
        <button
          className="btn-icon h-6 w-6"
          title="导入 JSON"
          onClick={() => void importJson('merge')}
        >
          <Upload size={13} />
        </button>
        <button className="btn-icon h-6 w-6" title="导出 JSON" onClick={() => void exportJson()}>
          <Download size={13} />
        </button>
        <button
          className="btn-icon h-6 w-6"
          title="新建分组"
          onClick={() => setNewGroupDialog(true)}
        >
          <FolderPlus size={13} />
        </button>
        <button className="btn-icon h-6 w-6" title="新建命令" onClick={() => onEdit(null)}>
          <Plus size={14} />
        </button>
        {onCollapse && (
          <button className="btn-icon h-6 w-6" title="折叠命令面板 (Ctrl+B)" onClick={onCollapse}>
            {horizontal ? <ChevronDown size={13} /> : <PanelRightClose size={13} />}
          </button>
        )}
      </div>

      {/* 搜索（默认收起，展开时才占一行） */}
      {searchOpen && (
        <div className="shrink-0 px-1.5 pt-1.5">
          <div className="relative">
            <Search
              size={12}
              className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3"
            />
            <input
              className="input pl-7 pr-7"
              autoFocus
              placeholder="搜索命令 / 描述 / 分组…"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return
                setKeyword('')
                setSearchOpen(false)
              }}
            />
            <button
              className="btn-icon absolute right-0.5 top-1/2 h-6 w-6 -translate-y-1/2"
              title="收起搜索"
              onClick={() => {
                setKeyword('')
                setSearchOpen(false)
              }}
            >
              <X size={12} />
            </button>
          </div>
        </div>
      )}

      {/* 列表（底部模式：分组横向排列，横向滚动） */}
      <div
        className={cn(
          'scroll-thin min-h-0 flex-1 pb-1',
          horizontal ? 'flex gap-2 overflow-x-auto px-2 pt-1.5' : 'overflow-y-auto px-1.5 pt-1'
        )}
      >
        {groups.length === 0 && (
          <EmptyState
            icon={<Play size={24} />}
            title={commands.length === 0 ? '还没有常用命令' : '没有匹配的命令'}
            hint={
              commands.length === 0
                ? '点击右上角 + 新建一条常用命令，单击即可发送到当前终端'
                : '换个关键字试试'
            }
          />
        )}

        {groups.map(({ group, items }) => {
          const isCollapsed = collapsed[group] && !searching
          return (
            <div
              key={group}
              className={cn(
                horizontal && 'h-full w-[248px] shrink-0 overflow-y-auto rounded-md border border-edge-soft bg-panel/50 px-1 pt-1',
                'relative mb-1',
                dragGroup === group && 'opacity-40'
              )}
              onDragOver={(e) => handleGroupDragOver(e, group)}
              onDrop={(e) => handleGroupDrop(e, group)}
            >
              {/* 分组拖拽落点指示线 */}
              {groupDrop?.group === group && dragGroup && dragGroup !== group && (
                <span
                  className={cn(
                    'pointer-events-none absolute z-10 rounded-full bg-accent',
                    horizontal
                      ? cn('inset-y-0 w-[2px]', groupDrop.after ? '-right-[5px]' : '-left-[5px]')
                      : cn('inset-x-0 h-[2px]', groupDrop.after ? '-bottom-[3px]' : '-top-[3px]')
                  )}
                />
              )}
              <div
                className="group/hdr flex w-full items-center gap-1"
                draggable={!searching}
                onDragStart={(e) => {
                  setDragGroup(group)
                  e.dataTransfer.setData(GROUP_MIME, group)
                  e.dataTransfer.effectAllowed = 'move'
                }}
                onDragEnd={() => {
                  setDragGroup(null)
                  setGroupDrop(null)
                }}
                onContextMenu={(e) => groupMenu.openMenu(e, group)}
                title={searching ? undefined : '拖动可调整分组顺序，右键更多操作'}
              >
                {!searching && (
                  <GripVertical
                    size={11}
                    className="-mr-1 shrink-0 cursor-grab text-ink-3/40 opacity-0 transition-opacity group-hover/hdr:opacity-100"
                  />
                )}
                <button
                  className="flex min-w-0 flex-1 cursor-default items-center gap-1 rounded-md px-1.5 py-1 text-2xs font-medium text-ink-3 transition-colors hover:text-ink-2"
                  onClick={() => toggleGroup(group)}
                >
                  {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                  <span className="truncate">{group}</span>
                  <span className="text-ink-3/60">{items.length}</span>
                </button>
                {/* 分组操作按钮 */}
                <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/hdr:opacity-100 pr-0.5">
                  <button
                    className="btn-icon h-5 w-5"
                    title={`在「${group}」分组中新建命令`}
                    onClick={() => onEdit(null, group)}
                  >
                    <Plus size={11} />
                  </button>
                  <button
                    className="btn-icon h-5 w-5"
                    title={`重命名分组「${group}」`}
                    onClick={() => setRenamingGroup(group)}
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    className="btn-icon h-5 w-5 text-danger/70 hover:text-danger"
                    title={`删除分组「${group}」及其所有命令`}
                    onClick={() => setPendingDeleteGroup(group)}
                  >
                    <Trash2 size={11} />
                  </button>
                </span>
              </div>

              {!isCollapsed &&
                items.map((c) => (
                  <div
                    key={c.id}
                    draggable
                    data-cmd-id={c.id}
                    onDragStart={(e) => {
                      setDragId(c.id)
                      // 沿用终端区可识别的 MIME；额外的 text/plain 供 Electron 判定为可拖放
                      e.dataTransfer.setData('application/x-ssh-command', c.id)
                      e.dataTransfer.setData('text/plain', c.id)
                      e.dataTransfer.effectAllowed = 'copyMove'
                      // 缩略图保持干净，不带 id 文本
                      const ghost = document.createElement('div')
                      ghost.textContent = c.name
                      ghost.className = 'rounded-md bg-panel px-2 py-1 text-xs text-ink'
                      ghost.style.position = 'fixed'
                      ghost.style.top = '-1000px'
                      document.body.appendChild(ghost)
                      e.dataTransfer.setDragImage(ghost, 8, 8)
                      window.setTimeout(() => ghost.remove(), 0)
                    }}
                    onDragOver={(e) => {
                      if (!isCommandDrag(e.dataTransfer.types)) return
                      e.preventDefault()
                      e.dataTransfer.dropEffect = 'copy'
                      setOverId(c.id)
                    }}
                    onDragLeave={() => setOverId((t) => (t === c.id ? null : t))}
                    onDrop={(e) => {
                      e.preventDefault()
                      const dragged =
                        e.dataTransfer.getData('application/x-ssh-command') || dragId
                      setDragId(null)
                      setOverId(null)
                      if (dragged && dragged !== c.id) handleDropInGroup(group, c.id, dragged)
                    }}
                    onDragEnd={() => {
                      setDragId(null)
                      setOverId(null)
                    }}
                    onClick={() => runCommand(c)}
                    onContextMenu={(e) => openMenu(e, c)}
                    className={cn(
                      'group flex cursor-default items-center gap-2 rounded-md border border-transparent px-1.5 py-1.5 transition-colors duration-75',
                      'hover:border-edge-soft hover:bg-hover/70 active:bg-hover',
                      overId === c.id && dragId && dragId !== c.id && 'border-accent/50',
                      dragId === c.id && 'opacity-40'
                    )}
                    title={`单击执行：${c.command}`}
                  >
                    {/* 图标 */}
                    <span
                      className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-edge-soft bg-app"
                      style={{ color: c.color ?? 'rgb(var(--c-ink-2))' }}
                    >
                      <DynamicIcon name={c.icon} size={13} />
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-xs text-ink">{c.name}</span>
                        {c.variables.length > 0 && (
                          <span title={`含 ${c.variables.length} 个变量`}>
                            <Braces size={10} className="shrink-0 text-accent/80" />
                          </span>
                        )}
                        {c.confirmRequired && (
                          <span title="危险命令：执行前二次确认">
                            <AlertTriangle size={10} className="shrink-0 text-warning" />
                          </span>
                        )}
                      </div>
                      <div className="truncate font-mono text-2xs text-ink-3">{c.command}</div>
                    </div>

                    <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        className="btn-icon h-5 w-5"
                        title="编辑此命令"
                        onClick={(e) => {
                          e.stopPropagation()
                          onEdit(c)
                        }}
                      >
                        <Pencil size={11} />
                      </button>
                      <Play size={12} className="text-accent" />
                    </span>
                  </div>
                ))}
            </div>
          )
        })}
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={closeMenu} />
      )}

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
        open={newGroupDialog}
        title="新建分组"
        label="分组名称"
        defaultValue=""
        onCancel={() => setNewGroupDialog(false)}
        onConfirm={(name) => { setNewGroupDialog(false); handleNewGroup(name) }}
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
          if (old) void renameGroup(old, name)
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
            {(() => {
              const n = commands.filter((c) => (c.group || '默认') === pendingDeleteGroup).length
              return n > 0 ? `及其下 ${n} 条命令吗？此操作不可恢复。` : '吗？（空分组）'
            })()}
          </>
        }
        onCancel={() => setPendingDeleteGroup(null)}
        onConfirm={() => {
          const g = pendingDeleteGroup
          setPendingDeleteGroup(null)
          if (g)
            void deleteGroup(g).then((n) => {
              if (n !== null)
                useToastStore.getState().push({ kind: 'success', title: `已删除分组「${g}」` })
            })
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除常用命令"
        danger
        confirmText="删除"
        message={
          <>
            确定删除
            <span className="font-medium text-ink">「{pendingDelete?.name}」</span>吗？
            <div className="mt-2 selectable font-mono text-2xs text-ink-3">
              {pendingDelete?.command}
            </div>
          </>
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete
          setPendingDelete(null)
          if (!target) return
          void remove(target.id).then(() =>
            useToastStore.getState().push({ kind: 'success', title: `已删除「${target.name}」` })
          )
        }}
      />
    </div>
  )
}
