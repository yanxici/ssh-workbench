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
  Clock3,
  Copy,
  Download,
  FolderPlus,
  GripVertical,
  MoreHorizontal,
  PanelRightClose,
  Pencil,
  Pin,
  Play,
  Plus,
  Search,
  Sparkles,
  Star,
  Trash2,
  TrendingUp,
  Upload,
  X
} from 'lucide-react'
import type { Command } from '@shared/types'
import { groupCommands, useCommandStore } from '@/stores/commandStore'
import { useUiStore } from '@/stores/uiStore'
import { runCommand } from '@/stores/executionStore'
import { useToastStore } from '@/stores/toastStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { cn } from '@/lib/utils'
import { moveItem, placeRelative } from '@/lib/groupOrder'
import { isCommandDrag } from '@/lib/commandDrag'
import { searchCommands, type Scope, type SortMode } from '@/lib/commandSearch'
import { DynamicIcon } from '@/lib/icons'
import { Highlight } from './Highlight'
import {
  ConfirmDialog,
  ContextMenu,
  EmptyState,
  PromptDialog,
  useContextMenu,
  type MenuEntry
} from '@/components/ui'
import { isImeComposing } from '@/lib/ime'

/**
 * 常用命令面板（侧栏 / 底栏两种排布）：
 * - 搜索框常驻（旧版默认收起，等于逼着用户先点一次放大镜）
 * - 顶部一行筛选 chip：全部 / 收藏 / 最近，再叠一个排序切换
 * - 单击执行（变量 -> 危险确认 -> 发送）；命令项可拖到终端区执行
 * - 组内拖拽排序、分组拖拽换序、右键菜单保留原有全部动作
 * - 想要更大的检索界面按 Ctrl+K 打开命令中心
 */

const SORT_LABEL: Record<SortMode, string> = {
  smart: '智能',
  recent: '最近',
  frequent: '常用',
  name: '名称'
}

/**
 * 命令墙的列数（用户明确要求「一行三个命令，这样好找一点」）。
 *
 * 固定而不是自适应：找命令靠的是稳定的空间记忆（「磁盘那个在第三行右边」），
 * 列数一变，肌肉记忆和口头描述就都失效了。所以宁可卡片自己变宽变窄，
 * 也不让列数变。键盘 ↑↓ 的步长也要跟着它，否则会跟视觉错位。
 */
const WALL_COLS = 3

/**
 * 空数组哨兵（模块级常量）。
 *
 * 不能写成 hook 里的 `?? []`：那样每次渲染都会分配一个新数组，
 * 作为 useMemo 依赖时永远不相等 —— 记忆化等于没有，且会在每次 render 重算。
 * 这个问题是 ESLint 的 react-hooks/exhaustive-deps 抓出来的。
 */
const EMPTY_IDS: string[] = []

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
  const togglePin = useCommandStore((s) => s.togglePin)

  const extraGroups = useSettingsStore((s) => s.settings.commandGroups)
  const groupOrder = useSettingsStore((s) => s.settings.commandGroupOrder)
  // undefined 时回退到模块级空数组，保证引用稳定（见 EMPTY_IDS 注释）
  const pinnedIds = useSettingsStore((s) => s.settings.pinnedCommandIds) ?? EMPTY_IDS
  const createGroup = useCommandStore((s) => s.createGroup)
  const setGroupOrder = useCommandStore((s) => s.setGroupOrder)
  const openCommandCenter = useUiStore((s) => s.openCommandCenter)

  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<Command | null>(null)
  const [pendingDeleteGroup, setPendingDeleteGroup] = useState<string | null>(null)
  const [renamingGroup, setRenamingGroup] = useState<string | null>(null)
  const [newGroupDialog, setNewGroupDialog] = useState(false)
  /** 面板内筛选范围：虚拟范围（收藏/最近）或某个分组 */
  const [scope, setScope] = useState<Scope>({ kind: 'all' })
  /** 排序：默认智能（命中度 + 热度） */
  const [sort, setSort] = useState<SortMode>('smart')
  const [cursor, setCursor] = useState(0)
  const { menu, openMenu, closeMenu } = useContextMenu<Command>()
  const moreMenu = useContextMenu<'more'>()
  const groupMenu = useContextMenu<string>()

  const searching = keyword.trim().length > 0
  const filtered = scope.kind !== 'all' || searching || sort !== 'smart'

  /**
   * 结果集：
   *   无筛选 → 沿用 groupCommands（保留空分组、分组顺序、折叠等既有行为）
   *   有筛选 → 用 searchCommands 打分排序，再按分组归拢（组内顺序 = 相关度）
   */
  const ranked = useMemo(
    () =>
      filtered
        ? searchCommands({ commands, query: keyword, scope, sort, pinnedIds })
        : [],
    [filtered, commands, keyword, scope, sort, pinnedIds]
  )

  /** 命中元信息（别名 / 高亮区间），按命令 id 索引，只在搜索态下有值 */
  const hitInfo = useMemo(() => {
    const map = new Map<string, { via?: string; nameIndices: number[]; cmdIndices: number[] }>()
    for (const r of ranked) {
      map.set(r.command.id, {
        via: r.via,
        nameIndices: r.nameIndices,
        cmdIndices: r.cmdIndices
      })
    }
    return map
  }, [ranked])

  const groups = useMemo(() => {
    if (!filtered) return groupCommands(commands, keyword, extraGroups ?? [], groupOrder ?? [])

    const map = new Map<string, Command[]>()
    for (const r of ranked) {
      const key = r.command.group || '默认'
      const list = map.get(key)
      if (list) list.push(r.command)
      else map.set(key, [r.command])
    }
    // 搜索态下高亮分区也有意义：命中密集的组排前面
    const score = new Map<string, number>()
    for (const r of ranked) {
      const key = r.command.group || '默认'
      score.set(key, Math.max(score.get(key) ?? 0, r.score))
    }
    return [...map.keys()]
      .sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0))
      .map((group) => ({ group, items: map.get(group) ?? [] }))
  }, [filtered, commands, keyword, extraGroups, groupOrder, ranked])

  /** 扁平化的结果顺序，用于键盘 ↑↓ 导航 */
  const flat = useMemo(
    () => groups.flatMap((g) => (collapsed[g.group] && !searching ? [] : g.items)),
    [groups, collapsed, searching]
  )
  const activeItem = flat[Math.min(cursor, Math.max(0, flat.length - 1))] ?? null

  /**
   * id → 扁平索引。
   * 原实现把 `flat.findIndex(...)` 放在每个卡片里，卡片多了就是 O(n²)：
   * 100 条命令要扫描 10000 次，鼠标一动（setCursor）再来一遍。
   */
  const flatIndexById = useMemo(() => {
    const map = new Map<string, number>()
    flat.forEach((c, i) => map.set(c.id, i))
    return map
  }, [flat])

  /** 收藏 id 集合：原来每个卡片都 includes 一次数组 */
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds])

  /* ---------- 分组排序 ---------- */
  /** 全部分组名（不受搜索过滤影响），排序操作基于它 */
  const allGroupNames = useMemo(
    () => groupCommands(commands, '', extraGroups ?? [], groupOrder ?? []).map((g) => g.group),
    [commands, extraGroups, groupOrder]
  )
  const [dragGroup, setDragGroup] = useState<string | null>(null)
  const [groupDrop, setGroupDrop] = useState<{ group: string; after: boolean } | null>(null)

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
        label: '只看这个分组',
        icon: <Search size={12} />,
        separatorBefore: true,
        onClick: () => {
          setScope({ kind: 'group', group })
          setCursor(0)
        }
      },
      {
        label: '在此分组新建命令',
        icon: <Plus size={12} />,
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

  const pickSort = (next: SortMode): void => {
    setSort(next)
    setCursor(0)
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

  const menuItems = (c: Command): MenuEntry[] => {
    const pinned = pinnedIds.includes(c.id)
    return [
      { label: '执行', icon: <Play size={12} />, onClick: () => runCommand(c) },
      { label: '编辑', icon: <Pencil size={12} />, onClick: () => onEdit(c) },
      {
        label: pinned ? '取消收藏' : '收藏置顶',
        icon: <Pin size={12} />,
        onClick: () => void togglePin(c.id)
      },
      { label: '复制一条', icon: <Copy size={12} />, onClick: () => void duplicate(c) },
      {
        label: '在命令中心中查找',
        icon: <Search size={12} />,
        onClick: () => openCommandCenter(c.name)
      },
      {
        label: '删除',
        icon: <Trash2 size={12} />,
        danger: true,
        separatorBefore: true,
        onClick: () => setPendingDelete(c)
      }
    ]
  }

  /**
   * 键盘导航：方向键选、↵ 执行、Ctrl+↵ 编辑、Esc 清空搜索。
   *
   * 网格改成固定三列之后，方向键的语义也得跟着变：
   * ↑↓ 走一行（±3 格），←→ 走一格。原来只有 ↑↓ 且步长是 1，
   * 视觉上明明是横排三个按钮，按一下 ↓ 却只跳到右边那个 —— 手感是错的。
   */
  const onKeyDown = (e: React.KeyboardEvent): void => {
    // 输入法组合态：Enter 是确认候选词，不是「执行」。事件从搜索框冒泡上来，必须在这里挡。
    if (isImeComposing(e)) return
    if (e.key === 'Escape') {
      if (searching) {
        setKeyword('')
        setScope({ kind: 'all' })
      }
      return
    }
    const stepOf = (key: string): number => {
      if (key === 'ArrowDown') return WALL_COLS
      if (key === 'ArrowUp') return -WALL_COLS
      if (key === 'ArrowRight') return 1
      if (key === 'ArrowLeft') return -1
      return 0
    }
    const step = stepOf(e.key)
    if (step !== 0) {
      e.preventDefault()
      if (flat.length === 0) return
      setCursor((c) => (c + step + flat.length * WALL_COLS) % flat.length)
      return
    }
    if (e.key === 'Enter' && activeItem) {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) onEdit(activeItem)
      else runCommand(activeItem)
    }
  }

  const scopes: Array<{ scope: Scope; label: string; icon: JSX.Element }> = [
    { scope: { kind: 'all' }, label: '全部', icon: <Braces size={10} /> },
    { scope: { kind: 'pinned' }, label: '收藏', icon: <Star size={10} /> },
    { scope: { kind: 'recent' }, label: '最近', icon: <Clock3 size={10} /> }
  ]

  return (
    <div className="flex h-full flex-col" onKeyDown={onKeyDown} data-testid="command-panel">
      {/* ---------- 头部：标题 + 常用操作 ----------
          命令栏现在常驻在窗口右侧（默认 380px），比原来的 280px 侧栏宽，
          并且不再和连接/文件面板抢位置。头部只留「搜索 / 新建 / 更多 / 收起」
          四个高频动作，导入导出之类的低频操作收进 ⋯ 菜单 —— 宽度够了也不该
          把头部塞成一排难点的方阵。 */}
      <div className="panel-head">
        <Play size={13} className="shrink-0 text-ink-3" />
        <span className="panel-title">常用命令</span>
        <span className="panel-count">{commands.length}</span>
        <span className="flex-1" />
        <button
          className="btn-icon h-6 w-6"
          title="搜索全部命令 (Ctrl+K)"
          aria-label="打开命令中心"
          onClick={() => openCommandCenter(keyword)}
        >
          <Search size={13} />
        </button>
        <button
          className="btn-icon h-6 w-6"
          title="新建命令"
          aria-label="新建命令"
          onClick={() => onEdit(null)}
        >
          <Plus size={14} />
        </button>
        <button
          className="btn-icon h-6 w-6"
          title="更多操作"
          aria-label="更多操作"
          onClick={(e) => moreMenu.openMenu(e, 'more')}
        >
          <MoreHorizontal size={14} />
        </button>
        {onCollapse && (
          <button
            className="btn-icon h-6 w-6"
            title="收起命令栏 (Ctrl+Alt+B)"
            aria-label="收起命令栏"
            onClick={onCollapse}
          >
            {horizontal ? <ChevronDown size={13} /> : <PanelRightClose size={13} />}
          </button>
        )}
      </div>

      {/* ---------- 搜索：常驻一行 ---------- */}
      <div className={cn('shrink-0 px-2 pb-1.5 pt-2', horizontal && 'pb-0')}>
        <div className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            className="input h-7 pl-7 pr-6 text-xs"
            placeholder="搜索命令 / 描述 / 分组…"
            value={keyword}
            onChange={(e) => {
              setKeyword(e.target.value)
              setCursor(0)
            }}
            onKeyDown={(e) => {
              // 输入法组合态：Enter/↑↓ 属于候选词选择，不能当列表导航
              if (isImeComposing(e)) return
              // ↑↓ 从输入框直接跳到列表，不必先点空白处
              if (e.key === 'ArrowDown' || e.key === 'Enter') {
                e.preventDefault()
                if (flat.length > 0) {
                  if (e.key === 'ArrowDown') setCursor(0)
                  else if (activeItem) runCommand(activeItem)
                }
              }
            }}
          />
          {keyword && (
            <button
              className="btn-icon absolute right-0.5 top-1/2 h-5 w-5 -translate-y-1/2"
              title="清空搜索"
              onClick={() => setKeyword('')}
            >
              <X size={11} />
            </button>
          )}
        </div>
      </div>

      {/* ---------- 筛选 chip + 排序：做成一个分段控件，视觉上合并成一条 ---------- */}
      <div className="flex shrink-0 items-center gap-1 px-2 pb-1.5">
        <div className="flex items-center gap-0.5 rounded-md bg-raised p-0.5">
          {scopes.map((s) => {
            const on = s.scope.kind === scope.kind
            return (
              <button
                key={s.scope.kind}
                className={cn(
                  'flex h-[22px] items-center gap-1 rounded px-1.5 text-2xs transition-colors duration-150',
                  on
                    ? 'bg-app font-medium text-ink shadow-[0_1px_2px_rgb(0_0_0/0.06)]'
                    : 'text-ink-3 hover:text-ink-2'
                )}
                onClick={() => {
                  setScope(on ? { kind: 'all' } : s.scope)
                  setCursor(0)
                }}
              >
                {s.icon}
                {s.label}
              </button>
            )
          })}
        </div>
        <span className="flex-1" />
        <button
          className="flex h-[22px] items-center gap-1 rounded px-1.5 text-2xs text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink-2"
          title={`当前排序：${SORT_LABEL[sort]}（点击切换）`}
          onClick={() =>
            pickSort(sort === 'smart' ? 'recent' : sort === 'recent' ? 'frequent' : 'smart')
          }
        >
          {sort === 'smart' ? (
            <Sparkles size={11} />
          ) : sort === 'recent' ? (
            <Clock3 size={11} />
          ) : (
            <TrendingUp size={11} />
          )}
          {SORT_LABEL[sort]}
        </button>
      </div>

      {/* ---------- 列表 ---------- */}
      <div
        className={cn(
          'scroll-thin min-h-0 flex-1 pb-1',
          horizontal ? 'flex gap-2 overflow-x-auto px-2 pt-0.5' : 'overflow-y-auto px-1.5'
        )}
      >
        {groups.length === 0 &&
          (horizontal ? (
            <EmptyState
              icon={<Play size={24} />}
              title={commands.length === 0 ? '还没有常用命令' : '没有匹配的命令'}
              hint={
                commands.length === 0
                  ? '点右上角 + 新建一条；也可以按 Ctrl+K 打开命令中心'
                  : '换个关键字，或按 Ctrl+K 在命令中心里全局检索'
              }
            />
          ) : (
            /* 窄栏里 56px 图标 + 两行长文案会挤成一团，这里用紧凑版 */
            <div className="flex flex-col items-center gap-1.5 px-3 py-10 text-center">
              <Search size={16} className="mb-0.5 text-ink-3/70" />
              <div className="text-xs text-ink-2">
                {commands.length === 0 ? '还没有常用命令' : '没有匹配的命令'}
              </div>
              <div className="text-2xs leading-relaxed text-ink-3">
                {commands.length === 0 ? '点右上角 + 新建一条' : '换个关键字试试'}
              </div>
              <button
                className="mt-1 rounded-md border border-edge-soft px-2 py-1 text-2xs text-ink-2 transition-colors hover:border-edge hover:bg-hover hover:text-ink"
                onClick={() => openCommandCenter(keyword)}
              >
                打开命令中心 <span className="kbd ml-0.5">Ctrl K</span>
              </button>
            </div>
          ))}

        {groups.map(({ group, items }) => {
          const isCollapsed = collapsed[group] && !searching && scope.kind === 'all'
          return (
            <div
              key={group}
              className={cn(
                horizontal &&
                  'h-full w-[248px] shrink-0 overflow-y-auto rounded-md border border-edge-soft bg-panel/50 px-1 pt-1',
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
                className={cn(
                  'group/hdr flex w-full items-center gap-1',
                  /*
                   * 分组标题吸顶。命令墙一屏放不下 10 个分组，往下滚两屏之后
                   * 眼前只剩一片按钮，看不出自己还在哪个分组里 —— 分组一多，
                   * 「知道自己在哪」比「少占一行」重要。
                   * 只有竖排需要吸顶；横排是每分组一列，列头本来就一直在。
                   */
                  !horizontal &&
                    'sticky top-0 z-10 -mx-0.5 rounded-md bg-panel px-0.5 pb-0.5 pt-1'
                )}
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
                  className="flex min-w-0 flex-1 cursor-default items-center gap-1 rounded-md px-1.5 py-1 text-2xs font-medium text-ink-2 transition-colors hover:bg-hover hover:text-ink"
                  onClick={() => toggleGroup(group)}
                >
                  {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                  <span className="truncate">{group}</span>
                  <span className="font-mono text-2xs tabular-nums text-ink-3/70">
                    {items.length}
                  </span>
                </button>
                <span className="flex shrink-0 items-center gap-0.5 pr-0.5 opacity-0 transition-opacity group-hover/hdr:opacity-100">
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

              {!isCollapsed && (
                /*
                 * 堆叠按钮墙：命令按分组堆成一片按钮，不用滚长列表去翻。
                 * 每块只显示「图标 + 名称」，命令行作为辨识辅助，热度与完整命令放到 title，
                 * 因为目标是「一眼扫到、直接点」，而不是逐行读详情。
                 *
                 * 列数固定 WALL_COLS = 3，理由见常量定义处（空间记忆 + 键盘步长一致）。
                 */
                <div
                  className="grid gap-1 pb-1"
                  style={{ gridTemplateColumns: `repeat(${WALL_COLS}, minmax(0, 1fr))` }}
                >
                  {items.map((c) => {
                    const idx = flatIndexById.get(c.id) ?? -1
                    const isActive = idx >= 0 && idx === cursor
                    const pinned = pinnedSet.has(c.id)
                    const hit = hitInfo.get(c.id)
                    return (
                      <button
                        key={c.id}
                        draggable
                        data-cmd-id={c.id}
                        type="button"
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
                        onClick={(e) => {
                          // Ctrl/⌘ + 单击 = 编辑，普通单击 = 执行
                          if (e.ctrlKey || e.metaKey) onEdit(c)
                          else runCommand(c)
                        }}
                        onContextMenu={(e) => openMenu(e, c)}
                        onMouseEnter={() => idx >= 0 && setCursor(idx)}
                        title={`${c.name}\n${c.command}${c.useCount > 0 ? `\n用过 ${c.useCount} 次` : ''}\n\n单击执行 · Ctrl+单击编辑 · 右键更多`}
                        className={cn(
                          'group relative flex min-w-0 cursor-default flex-col gap-1 rounded-lg border px-2 py-1.5 text-left transition-colors duration-150',
                          /*
                           * 常态是「灰底上的白按钮」，不是「浅灰按钮压在浅灰底上」。
                           * 侧栏底色 bg-panel（#f8f9fa），卡片若用 bg-raised（#fafafa）
                           * 两层只差 1.5%，126 个按钮会糊成一片没有边界；白色 + 实边框
                           * 才读得出「这是一堆可以按的东西」。
                           */
                          isActive
                            ? 'border-accent/50 bg-select'
                            : 'border-edge bg-app hover:bg-hover',
                          overId === c.id && dragId && dragId !== c.id && 'border-accent/60',
                          dragId === c.id && 'opacity-40'
                        )}
                      >
                        {/*
                         * 名称行：图标 + 名字（右侧留出 24px 给角标/操作槽）。
                         * 必须带 w-full：与下面命令行同一个坑 —— button 的 UA 样式是
                         * align-items:flex-start，交叉轴上子项宽度由内容决定，行内那个
                         * flex-1 truncate 拿不到可收缩的宽度基准，长命令名会撑出卡片
                         * （129 张里 92 张中招，最宽溢出 123px）。
                         */}
                        <span className="flex w-full min-w-0 items-center gap-1.5">
                          <span
                            className={cn(
                              'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border',
                              isActive ? 'border-accent/40 bg-app' : 'border-edge-soft bg-raised'
                            )}
                            style={{ color: c.color ?? 'rgb(var(--c-ink-2))' }}
                          >
                            <DynamicIcon name={c.icon} size={12} />
                          </span>
                          <span className="min-w-0 flex-1 truncate pr-6 text-xs font-medium text-ink">
                            <Highlight text={c.name} indices={hit?.nameIndices ?? []} />
                          </span>
                        </span>

                        {/*
                         * 命令行：单行省略，作为「这是干什么的」的辨识辅助。
                         * 必须带 w-full：button 的 UA 样式是 align-items:flex-start，
                         * 交叉轴上子项宽度由内容决定，truncate 的 overflow:hidden
                         * 不参与收缩 —— 长命令会直接撑出卡片右边界（128 张里 82 张中招）。
                         * w-full 把宽度钉在卡片内容宽，truncate 才真正生效。
                         */}
                        <span className="w-full min-w-0 truncate font-mono text-3xs leading-tight text-ink-3">
                          <Highlight text={c.command} indices={hit?.cmdIndices ?? []} />
                        </span>

                        {/*
                         * 右上角一个槽，两种内容交叉淡入：
                         * 平时显示角标（收藏 / 需确认 / 有变量），悬停显示操作（收藏 / 编辑）。
                         * 原来是「角标在名称行尾 + 操作条绝对定位 top-1 right-1」，
                         * 悬停时两个东西正正压在同一个位置，操作按钮盖在 AlertTriangle 上。
                         * 现在两者同槽互斥，只改 opacity，不产生位移。
                         */}
                        <span className="pointer-events-none absolute right-1 top-1 flex items-center gap-0.5">
                          <span className="flex items-center gap-0.5 transition-opacity duration-150 group-hover:opacity-0">
                            {pinned && <Pin size={9} className="text-warning" />}
                            {c.confirmRequired && (
                              <AlertTriangle size={9} className="text-warning" />
                            )}
                            {c.variables.length > 0 && (
                              <Braces size={9} className="text-accent/80" />
                            )}
                          </span>
                          <span className="absolute right-0 top-0 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100">
                            <span
                              role="button"
                              tabIndex={-1}
                              className={cn(
                                'flex h-[18px] w-[18px] items-center justify-center rounded text-ink-3 hover:text-warning',
                                pinned && 'text-warning'
                              )}
                              title={pinned ? '取消收藏' : '收藏置顶'}
                              onClick={(e) => {
                                e.stopPropagation()
                                void togglePin(c.id)
                              }}
                            >
                              <Pin size={10} />
                            </span>
                            <span
                              role="button"
                              tabIndex={-1}
                              className="flex h-[18px] w-[18px] items-center justify-center rounded text-ink-3 hover:text-ink"
                              title="编辑此命令"
                              onClick={(e) => {
                                e.stopPropagation()
                                onEdit(c)
                              }}
                            >
                              <Pencil size={10} />
                            </span>
                          </span>
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* ---------- 底部状态：提示键盘用法 ---------- */}
      {!horizontal && (
        <div className="flex shrink-0 items-center gap-2 border-t border-edge-soft px-2 py-1 text-2xs text-ink-3">
          <span className="truncate">
            {scope.kind === 'all' ? '↑↓ 选择 · ↵ 执行' : scope.kind === 'pinned' ? '已收藏' : '最近使用'}
          </span>
          <span className="flex-1" />
          <button
            className="flex items-center gap-0.5 rounded px-1 text-2xs text-ink-3 transition-colors hover:text-accent"
            title="打开命令中心"
            onClick={() => openCommandCenter(keyword)}
          >
            命令中心
            <ChevronRight size={10} />
          </button>
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={closeMenu} />
      )}

      {/* 头部的「更多」：导入/导出/新建分组这些低频动作收在这里 */}
      {moreMenu.menu && (
        <ContextMenu
          x={moreMenu.menu.x}
          y={moreMenu.menu.y}
          items={[
            {
              label: '新建分组',
              icon: <FolderPlus size={12} />,
              onClick: () => setNewGroupDialog(true)
            },
            { label: '导入命令 JSON…', icon: <Upload size={12} />, onClick: () => void importJson('merge') },
            { label: '导出命令 JSON…', icon: <Download size={12} />, onClick: () => void exportJson() },
            {
              label: '打开命令中心',
              icon: <Search size={12} />,
              separatorBefore: true,
              onClick: () => openCommandCenter(keyword)
            }
          ]}
          onClose={moreMenu.closeMenu}
        />
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
        onConfirm={(name) => {
          setNewGroupDialog(false)
          handleNewGroup(name)
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
