import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ArrowDownUp,
  Braces,
  Clock3,
  Command as CommandIcon,
  CornerDownLeft,
  Folder,
  Layers,
  Pencil,
  Pin,
  Play,
  Plus,
  Search,
  Sparkles,
  Star,
  Trash2,
  X
} from 'lucide-react'
import type { Command } from '@shared/types'
import { useCommandStore } from '@/stores/commandStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useToastStore } from '@/stores/toastStore'
import { useUiStore } from '@/stores/uiStore'
import { runCommand } from '@/stores/executionStore'
import {
  buildScopes,
  sameScope,
  searchCommands,
  type Scope,
  type SortMode
} from '@/lib/commandSearch'
import { DynamicIcon } from '@/lib/icons'
import { cn, formatRelativeTime } from '@/lib/utils'
import { ConfirmDialog, ContextMenu, useContextMenu, type MenuEntry } from '@/components/ui'
import { Highlight } from './Highlight'

/**
 * 按钮墙的列数。
 * 键盘 ↑↓ 的步长必须等于它，否则光标会跳到相邻列而不是相邻行。
 */
const WALL_COLS = 3

/**
 * 命令中心（Ctrl+K）—— 解决「命令多了以后只能靠翻列表找」的核心组件。
 *
 * 旧痛点：命令全塞在一个长列表里，搜索框默认收起，搜到还要在分组里滚；
 *        常用的那几条永远沉在末尾。
 *
 * 现在的结构：
 *   左 = 范围索引（全部 / 最近 / 最常用 / 已收藏 / 各分组，分组支持 a/b 层级）
 *   上 = 搜索（fuzzy，命中名字/命令/描述/分组，可高亮）
 *   下 = 结果列表（键盘 ↑↓ 导航、↵ 执行、Ctrl+↵ 编辑、Ctrl+D 收藏）
 *
 * 一切都可以只用键盘完成：Ctrl+K → 敲两个字母 → ↵。
 */
export function CommandCenter({
  onEdit
}: {
  onEdit: (initial: Command | null, presetGroup?: string) => void
}): JSX.Element | null {
  const open = useUiStore((s) => s.commandCenterOpen)
  const presetQuery = useUiStore((s) => s.commandCenterQuery)
  const close = useUiStore((s) => s.closeCommandCenter)

  const commands = useCommandStore((s) => s.commands)
  const togglePin = useCommandStore((s) => s.togglePin)
  const remove = useCommandStore((s) => s.remove)

  const pinnedIds = useSettingsStore((s) => s.settings.pinnedCommandIds) ?? []
  const groupOrder = useSettingsStore((s) => s.settings.commandGroupOrder) ?? []
  const extraGroups = useSettingsStore((s) => s.settings.commandGroups) ?? []
  const savedSort = useSettingsStore((s) => s.settings.commandSort) ?? 'smart'
  const updateSettings = useSettingsStore((s) => s.update)

  const [query, setQuery] = useState('')
  const [scope, setScope] = useState<Scope>({ kind: 'all' })
  const [sort, setSort] = useState<SortMode>(savedSort)
  const [cursor, setCursor] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState<Command | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** 首次挂载时跳过 scrollIntoView（浮层还在做 pop-in 动画，高度不可信） */
  const firstPaint = useRef(true)
  const menu = useContextMenu<Command>()

  // 每次打开都重置到「全部 + 空搜索 + 光标归零」，并聚焦输入框
  useEffect(() => {
    if (!open) return
    setQuery(presetQuery)
    setScope({ kind: 'all' })
    setSort(savedSort)
    setCursor(0)
    firstPaint.current = true
    // 等浮层挂载完成再聚焦，否则 autofocus 会被动画/重排吃掉
    const t = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, presetQuery])

  const scopes = useMemo(
    () => buildScopes(commands, { groupOrder, extraGroups, pinnedIds }),
    [commands, groupOrder, extraGroups, pinnedIds]
  )

  const results = useMemo(
    () => searchCommands({ commands, query, scope, sort, pinnedIds }),
    [commands, query, scope, sort, pinnedIds]
  )

  /**
   * 没输入关键字时用「分组堆叠按钮墙」呈现，而不是一行行列表。
   *
   * 这是用户的核心诉求：命令多了以后，靠滚长列表找一条命令本身就是错的交互，
   * 一屏铺开的按钮可以用眼睛直接扫到，不用先想关键字再搜。
   * 一旦输入了关键字，就退回列表 —— 那时结果需要按相关度排序，列表更合适。
   */
  const wallMode = query.trim().length === 0
  const wall = useMemo(() => {
    if (!wallMode) return []
    const order: string[] = []
    const map = new Map<string, typeof results>()
    for (const r of results) {
      const g = r.command.group || '默认'
      if (!map.has(g)) {
        map.set(g, [])
        order.push(g)
      }
      map.get(g)!.push(r)
    }
    return order.map((group) => ({ group, items: map.get(group) ?? [] }))
  }, [wallMode, results])

  /** id → 结果索引，按钮墙上点/悬停都要用，避免每块都 findIndex */
  /**
   * 当前视觉顺序。
   * 列表模式 = 相关度顺序；按钮墙模式 = 按分组铺开的顺序。
   * 键盘 ↑↓ 必须跟着视觉顺序走，否则光标会在屏幕上乱跳。
   */
  const displayList = useMemo(
    () => (wallMode ? wall.flatMap((g) => g.items) : results),
    [wallMode, wall, results]
  )

  /** id → displayList 下标：按钮墙上的悬停要能把光标设到「视觉位置」 */
  const resultIndexById = useMemo(() => {
    const map = new Map<string, number>()
    displayList.forEach((r, i) => map.set(r.command.id, i))
    return map
  }, [displayList])

  /** 结果集变化时把光标夹回合法范围（否则会指到不存在的行） */
  useEffect(() => {
    setCursor((c) => (displayList.length === 0 ? 0 : Math.min(c, displayList.length - 1)))
  }, [displayList.length])

  // 让选中项始终可见。首次挂载时跳过：此时 pop-in 动画还没跑完，
  // scrollIntoView 会按被压缩的高度算，把列表顶上挤掉一项。
  useEffect(() => {
    if (firstPaint.current) {
      firstPaint.current = false
      return
    }
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [cursor, displayList])

  if (!open) return null

  const active = displayList[cursor]?.command ?? null

  const runActive = (): void => {
    if (!active) return
    if (active.variables.length > 0 || active.confirmRequired) {
      // 有变量/危险命令：交给原有执行流水线（弹变量框、弹确认框）
      runCommand(active)
      close()
      return
    }
    runCommand(active)
    close()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    const mod = e.ctrlKey || e.metaKey

    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      // 按钮墙是 3 列网格，↓ 走一格 = 视觉上跨一行。
      // 列数写在 WALL_COLS 里，改列数时这里跟着改，否则键盘会和视觉错位。
      const step = wallMode ? WALL_COLS : 1
      setCursor((c) =>
        displayList.length === 0 ? 0 : (c + step) % displayList.length
      )
      return
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      const step = wallMode ? WALL_COLS : 1
      setCursor((c) =>
        displayList.length === 0
          ? 0
          : (c - step + displayList.length * 2) % displayList.length
      )
      return
    }
    if (wallMode && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
      e.preventDefault()
      const step = e.key === 'ArrowRight' ? 1 : -1
      setCursor((c) =>
        displayList.length === 0
          ? 0
          : (c + step + displayList.length) % displayList.length
      )
      return
    }
    if (e.key === 'Home' && displayList.length > 0) {
      e.preventDefault()
      setCursor(0)
      return
    }
    if (e.key === 'End' && displayList.length > 0) {
      e.preventDefault()
      setCursor(displayList.length - 1)
      return
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (!active) return
      if (mod) {
        // Ctrl+↵ = 编辑这条命令
        onEdit(active)
        close()
      } else {
        runActive()
      }
      return
    }
    if (e.key === 'Tab') {
      // Tab 在范围索引里循环切换（不用鼠标也能换分组）
      e.preventDefault()
      const idx = scopes.findIndex((s) => sameScope(s.scope, scope))
      const dir = e.shiftKey ? -1 : 1
      const next = scopes[(idx + dir + scopes.length) % scopes.length]
      if (next) {
        setScope(next.scope)
        setCursor(0)
      }
      return
    }
    if (mod && e.key.toLowerCase() === 'd') {
      e.preventDefault()
      if (active) void togglePin(active.id)
    }
  }

  const menuItems = (c: Command): MenuEntry[] => [
    {
      label: '执行',
      icon: <Play size={12} />,
      onClick: () => {
        runCommand(c)
        close()
      }
    },
    { label: '编辑', icon: <Pencil size={12} />, onClick: () => onEdit(c) },
    {
      label: pinnedIds.includes(c.id) ? '取消收藏' : '收藏置顶',
      icon: <Pin size={12} />,
      onClick: () => void togglePin(c.id)
    },
    { label: '新建同类命令', icon: <Plus size={12} />, onClick: () => onEdit(null, c.group) },
    {
      label: '删除',
      icon: <Trash2 size={12} />,
      danger: true,
      separatorBefore: true,
      onClick: () => setConfirmDelete(c)
    }
  ]

  const activeScopeIdx = scopes.findIndex((s) => sameScope(s.scope, scope))

  /** 排序方式记住最后一次选择（下次打开沿用，存在 settings 里） */
  const pickSort = (next: SortMode): void => {
    setSort(next)
    setCursor(0)
    void updateSettings({ commandSort: next })
  }

  return (
    <>
      <div
        className="fixed inset-0 z-[60] flex animate-fade-in items-start justify-center bg-ink/45 p-4 pt-[9vh]"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) close()
        }}
      >
        <div
          className="flex max-h-[74vh] w-full max-w-[760px] animate-pop-in flex-col overflow-hidden rounded-xl border border-edge bg-panel shadow-pop"
          onKeyDown={onKeyDown}
        >
          {/* ---------- 搜索行 ---------- */}
          <div className="flex shrink-0 items-center gap-2 border-b border-edge px-3 py-2">
            <Search size={14} className="shrink-0 text-ink-3" />
            <input
              ref={inputRef}
              className="h-7 min-w-0 flex-1 selectable bg-transparent text-sm text-ink outline-none placeholder:text-ink-3"
              placeholder="搜索命令、命令文本、描述或分组…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value)
                setCursor(0)
              }}
            />
            {query && (
              <button
                className="btn-icon h-6 w-6 shrink-0"
                title="清空搜索"
                onClick={() => {
                  setQuery('')
                  inputRef.current?.focus()
                }}
              >
                <X size={12} />
              </button>
            )}
            <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-edge-soft p-0.5">
              <SortChip
                active={sort === 'smart'}
                label="智能"
                icon={<Sparkles size={11} />}
                onClick={() => pickSort('smart')}
              />
              <SortChip
                active={sort === 'recent'}
                label="最近"
                icon={<Clock3 size={11} />}
                onClick={() => pickSort('recent')}
              />
              <SortChip
                active={sort === 'frequent'}
                label="常用"
                icon={<ArrowDownUp size={11} />}
                onClick={() => pickSort('frequent')}
              />
            </div>
          </div>

          <div className="flex min-h-0 flex-1">
            {/* ---------- 左：范围索引 ---------- */}
            <div className="scroll-thin flex w-[184px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-edge bg-app p-1.5">
              {scopes.map((entry, i) => {
                const virtual = entry.scope.kind !== 'group'
                const selected = sameScope(entry.scope, scope)
                // 虚拟范围与分组之间加一条分隔
                const showSep = i > 0 && !virtual && scopes[i - 1]?.scope.kind !== 'group'
                return (
                  <div key={`${entry.scope.kind}:${entry.scope.group ?? ''}`}>
                    {showSep && <div className="my-1 h-px bg-edge-soft" />}
                    <button
                      className={cn(
                        'group relative flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-xs transition-colors duration-150',
                        selected ? 'bg-hover text-ink' : 'text-ink-2 hover:bg-hover hover:text-ink',
                        // 层级分组缩进
                        entry.depth > 0 && 'pl-4'
                      )}
                      style={entry.depth > 0 ? { paddingLeft: 6 + entry.depth * 10 } : undefined}
                      onClick={() => {
                        setScope(entry.scope)
                        setCursor(0)
                      }}
                    >
                      {/* 选中项左侧一道 2px 品牌绿，比整块蓝底更克制 */}
                      {selected && (
                        <span className="absolute inset-y-1 left-0 w-0.5 rounded-r bg-brand" />
                      )}
                      <span
                        className={cn(
                          'flex h-3.5 w-3.5 shrink-0 items-center justify-center',
                          selected ? 'text-ink-2' : 'text-ink-3'
                        )}
                      >
                        {entry.scope.kind === 'all' && <Layers size={11} />}
                        {entry.scope.kind === 'recent' && <Clock3 size={11} />}
                        {entry.scope.kind === 'frequent' && <ArrowDownUp size={11} />}
                        {entry.scope.kind === 'pinned' && <Star size={11} />}
                        {entry.scope.kind === 'group' && <Folder size={11} />}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                      <span className="shrink-0 font-mono text-2xs text-ink-3">{entry.count}</span>
                    </button>
                  </div>
                )
              })}
              <div className="mt-auto pt-1.5">
                <button
                  className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-xs text-ink-3 transition-colors duration-150 hover:bg-hover hover:text-ink"
                  onClick={() => {
                    onEdit(null, scope.kind === 'group' ? scope.group : undefined)
                    close()
                  }}
                >
                  <Plus size={11} />
                  新建命令
                </button>
              </div>
            </div>

            {/* ---------- 右：结果 ---------- */}
            <div
              ref={listRef}
              data-testid="command-center-list"
              className="scroll-thin min-w-0 flex-1 overflow-y-auto p-1.5"
            >
              {displayList.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-1.5 px-6 py-10 text-center">
                  <CommandIcon size={22} className="text-ink-3/60" />
                  <div className="text-xs font-medium text-ink-2">
                    {query ? `没有匹配「${query}」的命令` : '这个范围里还没有命令'}
                  </div>
                  <div className="text-2xs leading-relaxed text-ink-3">
                    {query ? '试试更短的片段，或按 Tab 换一个范围' : '按 Tab 切换范围，或新建一条'}
                  </div>
                </div>
              ) : wallMode ? (
                /* ---------- 按钮墙：一屏铺开，用眼睛扫而不是靠搜 ---------- */
                <div className="flex flex-col gap-2">
                  {wall.map(({ group, items }) => (
                    <div key={group}>
                      <div className="mb-1 flex items-center gap-1.5 px-0.5" data-wall-group={group}>
                        <Folder size={10} className="shrink-0 text-ink-3/70" />
                        <span className="text-2xs font-medium uppercase tracking-wide text-ink-3">
                          {group}
                        </span>
                        <span className="font-mono text-2xs text-ink-3/60">{items.length}</span>
                      </div>
                      <div
                        className="grid gap-1"
                        style={{ gridTemplateColumns: `repeat(${WALL_COLS}, minmax(0, 1fr))` }}
                      >
                        {items.map((r) => {
                          const c = r.command
                          const i = resultIndexById.get(c.id) ?? -1
                          const selected = i === cursor
                          const pinned = pinnedIds.includes(c.id)
                          return (
                            <div
                              key={c.id}
                              data-active={selected}
                              className={cn(
                                'group relative flex min-w-0 cursor-default flex-col gap-1 rounded-lg border px-2 py-1.5 transition-colors duration-150',
                                /*
                                 * 浅色外壳里卡片要「白底 + 实边框」才浮得起来。
                                 * 之前是 bg-raised（#fafafa）压在 bg-panel（#f8f9fa）上，
                                 * 两层只差 1.5%，一屏 126 个按钮边界全糊，整块区域读起来
                                 * 像一大片灰，看不出哪里能按。
                                 */
                                selected
                                  ? 'border-accent/50 bg-select'
                                  : 'border-edge bg-app hover:bg-hover'
                              )}
                              onMouseEnter={() => i >= 0 && setCursor(i)}
                              onClick={() => {
                                runCommand(c)
                                close()
                              }}
                              onContextMenu={(e) => menu.openMenu(e, c)}
                            >
                              <span className="flex min-w-0 items-center gap-1.5">
                                <span
                                  className={cn(
                                    'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border',
                                    selected
                                      ? 'border-accent/40 bg-app text-accent'
                                      : 'border-edge-soft bg-raised text-ink-3'
                                  )}
                                >
                                  <DynamicIcon name={c.icon ?? 'Terminal'} size={11} />
                                </span>
                                <span className="min-w-0 flex-1 truncate pr-6 text-xs font-medium text-ink">
                                  {c.name}
                                </span>
                              </span>
                              {/* w-full 同 CommandPanel：UA 的 align-items:flex-start 会让长命令撑出卡片 */}
                              <span className="w-full min-w-0 truncate font-mono text-3xs leading-tight text-ink-3">
                                {c.command}
                              </span>
                              {/*
                               * 右上角一个槽：平时是角标，悬停换成收藏操作。
                               * 原来是角标排在名称行末尾、收藏按钮绝对定位盖在同一处，
                               * 悬停时按钮正好压在警示三角上。
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
                                <span className="pointer-events-none absolute right-0 top-0 opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100">
                                  <button
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
                                  </button>
                                </span>
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                /* ---------- 列表：有搜索词时按相关度排序 ---------- */
                results.map((r, i) => {
                  const c = r.command
                  const selected = i === cursor
                  const pinned = pinnedIds.includes(c.id)
                  return (
                    <div
                      key={c.id}
                      data-active={selected}
                      data-result-row=""
                      className={cn(
                        'group flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 transition-colors',
                        selected ? 'bg-accent/15' : 'hover:bg-hover'
                      )}
                      onMouseMove={() => setCursor(i)}
                      onClick={() => {
                        runCommand(c)
                        close()
                      }}
                      onContextMenu={(e) => menu.openMenu(e, c)}
                    >
                      <span
                        className={cn(
                          'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border',
                          selected
                            ? 'border-accent/40 bg-accent/10 text-accent'
                            : 'border-edge-soft bg-raised text-ink-3'
                        )}
                      >
                        <DynamicIcon name={c.icon ?? 'Terminal'} size={12} />
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-xs font-medium text-ink">
                            <Highlight text={c.name} indices={r.nameIndices} />
                          </span>
                          {pinned && <Pin size={10} className="shrink-0 text-warning" />}
                          {r.via && (
                            <span
                              className="shrink-0 rounded border border-edge-soft px-1 text-3xs leading-4 text-ink-3"
                              title={`按中英别名「${r.via}」命中`}
                            >
                              ≈{r.via}
                            </span>
                          )}
                          {c.confirmRequired && (
                            <span className="shrink-0 rounded border border-warning/40 px-1 text-3xs leading-4 text-warning/90">
                              危险
                            </span>
                          )}
                        </div>
                        <div className="truncate font-mono text-2xs text-ink-3">
                          <Highlight text={c.command} indices={r.cmdIndices} />
                        </div>
                      </div>

                      <div className="flex shrink-0 items-center gap-1.5">
                        <span className="hidden shrink-0 text-2xs text-ink-3 group-hover:inline">
                          {c.group || '默认'}
                        </span>
                        {c.useCount > 0 && (
                          <span
                            className="shrink-0 font-mono text-2xs text-ink-3"
                            title={`用过 ${c.useCount} 次`}
                          >
                            ×{c.useCount}
                          </span>
                        )}
                        {c.lastUsedAt && (
                          <span className="hidden shrink-0 text-2xs text-ink-3 sm:inline">
                            {formatRelativeTime(c.lastUsedAt)}
                          </span>
                        )}
                        <button
                          className={cn(
                            'btn-icon h-6 w-6 shrink-0',
                            pinned ? 'opacity-100 text-warning' : 'opacity-0 group-hover:opacity-100'
                          )}
                          title={pinned ? '取消收藏' : '收藏置顶'}
                          onClick={(e) => {
                            e.stopPropagation()
                            void togglePin(c.id)
                          }}
                        >
                          <Pin size={11} />
                        </button>
                        {selected && (
                          <kbd className="kbd shrink-0">
                            <CornerDownLeft size={9} className="inline" />
                          </kbd>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          </div>

          {/* ---------- 底部提示 ---------- */}
          <div className="flex shrink-0 items-center gap-3 border-t border-edge-soft bg-app/40 px-3 py-1.5 text-2xs text-ink-3">
            <Hint keys={wallMode ? '↑ ↓ ← →' : '↑ ↓'} label="选择" />
            <Hint keys="↵" label="执行" />
            <Hint keys="Ctrl+↵" label="编辑" />
            <Hint keys="Tab" label="切换范围" />
            <Hint keys="Ctrl+D" label="收藏" />
            <span className="ml-auto font-mono">
              {activeScopeIdx >= 0 ? scopes[activeScopeIdx]?.label : '全部命令'} ·{' '}
              {displayList.length}
              {wallMode && <span className="ml-1 text-ink-3/60">按钮墙</span>}
            </span>
          </div>
        </div>
      </div>

      {menu.menu && (
        <ContextMenu
          x={menu.menu.x}
          y={menu.menu.y}
          items={menuItems(menu.menu.target)}
          onClose={menu.closeMenu}
        />
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title="删除命令"
        danger
        confirmText="删除"
        message={
          <>
            确定删除「{confirmDelete?.name}」？该操作不可撤销。
          </>
        }
        onCancel={() => setConfirmDelete(null)}
        onConfirm={() => {
          const target = confirmDelete
          setConfirmDelete(null)
          if (!target) return
          void remove(target.id).then(() => {
            useToastStore.getState().push({ kind: 'success', title: `已删除「${target.name}」` })
          })
        }}
      />
    </>
  )
}

/* ------------------------------------------------------------------ *
 *  小零件
 * ------------------------------------------------------------------ */

function SortChip({
  active,
  label,
  icon,
  onClick
}: {
  active: boolean
  label: string
  icon: JSX.Element
  onClick: () => void
}): JSX.Element {
  return (
    <button
      className={cn(
        'flex h-5 items-center gap-1 rounded px-1.5 text-2xs transition-colors',
        active ? 'bg-accent/15 text-accent' : 'text-ink-3 hover:bg-hover hover:text-ink-2'
      )}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  )
}

function Hint({ keys, label }: { keys: string; label: string }): JSX.Element {
  return (
    <span className="flex items-center gap-1">
      <kbd className="kbd">{keys}</kbd>
      {label}
    </span>
  )
}
