import { useDeferredValue, useMemo, useRef, useState } from 'react'
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
  Modal,
  PromptDialog,
  useContextMenu,
  type MenuEntry
} from '@/components/ui'

/**
 * 左侧连接列表：分组折叠、搜索、双击打开、右键菜单、从剪贴板识别 ssh 命令。
 */

/** 分组色标候选：和连接色标同一套语义色，深浅都够辨识 */
const GROUP_PALETTE = [
  '#ef4444',
  '#f97316',
  '#f59e0b',
  '#84cc16',
  '#22c55e',
  '#14b8a6',
  '#06b6d4',
  '#3b82f6',
  '#6366f1',
  '#8b5cf6',
  '#a855f7',
  '#ec4899'
]

/** 拖动连接时 dataTransfer 的 MIME，和分组拖拽排序（拖分组名）区分开 */
const CONN_MIME = 'application/x-ssh-conn-ids'

/**
 * 批量编辑标签弹窗
 */
function BatchTagsEditor({
  selectedIds,
  connections,
  onClose,
  onConfirm
}: {
  selectedIds: Set<string>
  connections: Connection[]
  onClose: () => void
  onConfirm: () => void
}): JSX.Element {
  const updateTags = useConnectionStore((s) => s.updateTags)
  const selectedConns = connections.filter((c) => selectedIds.has(c.id))
  const existingTags = Array.from(new Set(selectedConns.flatMap((c) => c.tags)))
  
  const [tagsInput, setTagsInput] = useState(existingTags.join(', '))
  const [addMode, setAddMode] = useState<'replace' | 'append'>('append')

  return (
    <Modal open title={`批量编辑标签（${selectedIds.size} 条连接）`} onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className="mb-1 block text-xs text-ink-2">标签（英文逗号分隔）</label>
          <input
            className="input w-full"
            placeholder="例如：生产,充电桩,现场"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={addMode === 'append'}
              onChange={() => setAddMode('append')}
            />
            <span>追加到现有标签</span>
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="radio"
              checked={addMode === 'replace'}
              onChange={() => setAddMode('replace')}
            />
            <span>替换所有标签</span>
          </label>
        </div>
        {existingTags.length > 0 && addMode === 'append' && (
          <div className="text-2xs text-ink-3">
            当前标签：{existingTags.join(', ')}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={() => {
              const newTags = tagsInput
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)

              /*
               * 一次批量 IPC，不再逐条 save()。
               * 旧写法对每条连接调一次 save：500 条 = 500 次 IPC，
               * 且每次 save 都会把整个 connections 数组换掉，
               * 侧栏跟着全量重渲染 500 次（每个分组、每行都要重算）。
               */
              void updateTags(
                Array.from(selectedIds),
                newTags,
                addMode === 'replace' ? 'replace' : 'add'
              ).then(() => {
                useToastStore.getState().push({
                  kind: 'success',
                  title: `已更新 ${selectedIds.size} 条连接的标签`
                })
                onConfirm()
              })
            }}
          >
            确定
          </button>
        </div>
      </div>
    </Modal>
  )
}

/**
 * 每个分组默认先渲染多少条（滚动到「还有 N 条」按钮时再追加）。
 * 配合 .conn-row-cv（content-visibility），视口外的行不再产生布局/绘制开销，
 * 单批可以放大到 200 —— 减少「继续展开」的点击次数，同时不会拖慢滚动。
 */
const PAGE_SIZE = 200
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
  const removeMany = useConnectionStore((s) => s.removeMany)
  const save = useConnectionStore((s) => s.save)
  const createGroup = useConnectionStore((s) => s.createGroup)
  const renameGroup = useConnectionStore((s) => s.renameGroup)
  const deleteGroup = useConnectionStore((s) => s.deleteGroup)
  const setGroupOrder = useConnectionStore((s) => s.setGroupOrder)
  const savedGroups = useSettingsStore((s) => s.settings.connectionGroups)
  const savedOrder = useSettingsStore((s) => s.settings.connectionGroupOrder)
  const groupColors = useSettingsStore((s) => s.settings.connectionGroupColors)
  const onlyGroup = useConnectionStore((s) => s.onlyGroup)
  const setOnlyGroup = useConnectionStore((s) => s.setOnlyGroup)
  const setGroupColor = useConnectionStore((s) => s.setGroupColor)

  const sessions = useSessionStore((s) => s.sessions)
  const open = useSessionStore((s) => s.open)

  /*
   * 多选：Ctrl/Cmd 点加选，Shift 点按当前可见顺序连选。
   * 原来只有单个 selectedId，且它只用来画背景色 —— 选了也不能做任何事。
   * 2790 条连接要归组，只能一条条右键「移到分组」，这是最大的操作瓶颈。
   */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  /** Shift 连选的锚点 */
  const anchorId = useRef<string | null>(null)
  const [pendingBatchDelete, setPendingBatchDelete] = useState(false)
  /** 批量编辑标签 */
  const [batchTagsOpen, setBatchTagsOpen] = useState(false)
  /**
   * 批量移动：待移动的 id 集合。
   * 坐标复用右键菜单的 menu.x/menu.y —— 批量项本身就从那个菜单点出来，
   * 在原位弹出分组列表，视觉上是「原地展开」而不是又跳出一坨。
   */
  const [batchMoveIds, setBatchMoveIds] = useState<string[] | null>(null)
  const setBatchMoveFor = (ids: string[]): void => setBatchMoveIds(ids)
  /** 正在设置色标的分组名 */
  const [colorFor, setColorForState] = useState<string | null>(null)
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

  /*
   * 搜索防抖：keyword 一变就重算 2790 条连接的 5 字段匹配，
   * 每敲一个字母都全量重算会让输入明显掉帧。useDeferredValue 让
   * React 先保证输入框回显，把重算放到低优先级渲染里。
   */
  const deferredKeyword = useDeferredValue(keyword)

  const groups = useMemo(
    () =>
      groupConnections(connections, deferredKeyword, savedGroups ?? [], savedOrder ?? [], onlyGroup),
    [connections, deferredKeyword, savedGroups, savedOrder, onlyGroup]
  )

  /** 搜索命中的总条数（用于提示「查到了多少条，但只显示前 N 条」） */
  const matchedTotal = useMemo(
    () => groups.reduce((n, g) => n + g.items.length, 0),
    [groups]
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
      label: onlyGroup === group ? '取消只看这组' : '只看这组',
      onClick: () => setOnlyGroup(onlyGroup === group ? null : group)
    },
    {
      label: '设置分组色标…',
      separatorBefore: true,
      onClick: () => setColorForState(group)
    },
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

  /*
   * 右键菜单。
   *
   * 批量操作放在这里而不是顶部工具栏：选中连接时突然多出一条横栏，
   * 会把列表整体往下推、打断扫视，用起来很难受。
   * 改成「多选后右键 → 菜单顶部出现批量项」，界面不动，操作还更顺手。
   */
  const menuItems = (c: Connection): MenuEntry[] => {
    const batch = selectedIds.size > 1 && selectedIds.has(c.id) ? [...selectedIds] : null

    if (batch) {
      return [
        {
          label: `已选 ${batch.length} 条 · 移到分组`,
          icon: <FolderInput size={12} />,
          onClick: () => setBatchMoveFor(batch)
        },
        {
          label: `批量编辑标签（${batch.length} 条）`,
          icon: <Pencil size={12} />,
          onClick: () => setBatchTagsOpen(true)
        },
        {
          label: `删除选中的 ${batch.length} 条`,
          icon: <Trash2 size={12} />,
          danger: true,
          onClick: () => setPendingBatchDelete(true)
        },
        {
          label: '取消选择',
          separatorBefore: true,
          onClick: () => setSelectedIds(new Set())
        }
      ]
    }

    return [
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
        onClick: () => setMovingConn(c)
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
        onKeyDown={(e) => {
          // Esc 随时清掉多选（没有顶部横栏了，键盘要有兜底出口）
          if (e.key === 'Escape') setSelectedIds(new Set())
        }}
        onClick={(e) => {
          // 点空白处取消选择
          if (e.target === e.currentTarget) setSelectedIds(new Set())
        }}
      >
        {/* 搜索命中但被分页截断时给个提示，否则用户以为结果就这么点 */}
        {deferredKeyword.trim().length > 0 && matchedTotal > 0 && (
          <div className="px-2 py-1 text-3xs text-ink-3">
            命中 {matchedTotal} 条
            {matchedTotal > PAGE_SIZE && "（每组先显示 " + PAGE_SIZE + " 条，滚到底可继续展开）"}
          </div>
        )}

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
          const searching = deferredKeyword.trim().length > 0
          // 用户手动折叠过就听用户的；没动过时，超长分组默认收起
          const isCollapsed =
            collapsed[group] !== undefined
              ? collapsed[group]
              : items.length > LARGE_GROUP && !searching
          /*
           * 搜索态同样分页。
           * 旧实现 searching ? items : items.slice(0, limit) 会把命中的
           * 上千条一次性铺出来 —— 输个 a 就能让侧栏卡住。
           */
          const limit = shown[group] ?? PAGE_SIZE
          const visible = items.slice(0, limit)
          const rest = items.length - visible.length

          return (
            <div
              key={group}
              className="mb-1"
              onDragOver={(e) => {
                const isConn = e.dataTransfer.types.includes(CONN_MIME)
                if (!draggingGroup && !isConn) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
              }}
              onDrop={(e) => {
                const raw = e.dataTransfer.getData(CONN_MIME)
                if (raw) {
                  // 连接拖进分组：批量移动，这是最符合直觉的归组方式
                  e.preventDefault()
                  e.stopPropagation()
                  // JSON.parse 返回 any：先当 unknown，再逐项校验成 string[]
                  let parsed: unknown
                  try {
                    parsed = JSON.parse(raw)
                  } catch {
                    return
                  }
                  if (!Array.isArray(parsed) || parsed.length === 0) return
                  const ids: string[] = parsed.filter((x): x is string => typeof x === 'string')
                  if (ids.length === 0) return
                  void moveToGroup(ids, group).then((n) => {
                    if (n > 0) {
                      useToastStore.getState().push({
                        kind: "success",
                        title: `已把 ${n} 条连接移入「${group}」`
                      })
                      setSelectedIds(new Set())
                    }
                  })
                  return
                }
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
                  draggingGroup === group && 'opacity-40',
                  onlyGroup === group && 'text-ink'
                )}
                draggable
                title={`右键管理分组；拖拽可排序；双击只看这一组${onlyGroup === group ? "（再双击取消）" : ""}`}
                onClick={() => toggleGroup(group, isCollapsed)}
                onDoubleClick={() => setOnlyGroup(onlyGroup === group ? null : group)}
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
                {groupColors?.[group] && (
                  <span
                    className="h-3 w-[3px] shrink-0 rounded-full"
                    style={{ background: groupColors[group] }}
                  />
                )}
                {isCollapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                <span className="truncate">{group}</span>
                <span className="font-mono font-normal text-ink-3/60">{items.length}</span>
              </button>

              {!isCollapsed &&
                visible.map((c, idx) => {
                  const live = sessionByConn.get(c.id)
                  const active = selectedIds.has(c.id)
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
                        'conn-row-cv group relative cursor-default rounded-md py-1.5 pl-2 pr-1 transition-colors duration-150',
                        'focus-visible:bg-hover focus-visible:outline-none',
                        /*
                         * 选中态刻意做得很轻：只留一层浅描边 + 左侧细色条。
                         * 整块 bg-select 太抢眼，扫视列表时会被一块亮色一直牵着走，
                         * 而用户点选只是为了右键或拖拽，不需要那么强的视觉回报。
                         */
                        active
                          ? 'bg-select/35 ring-1 ring-inset ring-edge'
                          : 'hover:bg-hover'
                      )}
                      draggable
                      onDragStart={(e) => {
                        // 拖未选中的行 = 只拖这一条；拖已选中的行 = 拖整个选择集
                        const ids = selectedIds.has(c.id) ? [...selectedIds] : [c.id]
                        e.dataTransfer.setData(CONN_MIME, JSON.stringify(ids))
                        e.dataTransfer.effectAllowed = "move"
                      }}
                      onClick={(e) => {
                        /*
                         * Shift 连选需要「当前可见顺序」，这里按本组 visible 取；
                         * 跨组连选没有明确语义，不做。
                         */
                        if (e.shiftKey && anchorId.current) {
                          const ids = visible.map((x) => x.id)
                          const a = ids.indexOf(anchorId.current)
                          const b = idx
                          if (a >= 0 && b >= 0) {
                            const [lo, hi] = a < b ? [a, b] : [b, a]
                            setSelectedIds(new Set(ids.slice(lo, hi + 1)))
                            return
                          }
                        }
                        if (e.ctrlKey || e.metaKey) {
                          setSelectedIds((prev) => {
                            const next = new Set(prev)
                            if (next.has(c.id)) next.delete(c.id)
                            else next.add(c.id)
                            return next
                          })
                          anchorId.current = c.id
                          return
                        }
                        /*
                         * 普通单击：清掉多选，但**不**把这一条高亮成选中态。
                         * 用户反馈「选中就变亮、上面还多一条操作栏」很干扰视线；
                         * 双击才是打开连接，单击高亮没有实际用途。
                         * 锚点仍要记，否则 Shift 连选没有起点。
                         */
                        if (selectedIds.size > 0) setSelectedIds(new Set())
                        anchorId.current = c.id
                      }}
                      onDoubleClick={() => openConnection(c)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') openConnection(c)
                        if (e.key === 'Delete') setPendingBatchDelete(true)
                      }}
                      onContextMenu={(e) => {
                        // 右键未选中的行时先把它选中，避免「右键A删了B」
                        if (!selectedIds.has(c.id)) {
                          setSelectedIds(new Set([c.id]))
                          anchorId.current = c.id
                        }
                        openMenu(e, c)
                      }}
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

      {/* 分组色标 */}
      {colorFor && (
        <Modal open title={`分组色标 · ${colorFor}`} onClose={() => setColorForState(null)}>
          <div className="flex flex-wrap gap-2 py-2">
            {GROUP_PALETTE.map((c) => (
              <button
                key={c}
                className="h-7 w-7 rounded-full border border-edge-soft transition-transform hover:scale-110"
                style={{ background: c }}
                title={c}
                onClick={() => {
                  void setGroupColor(colorFor, c)
                  setColorForState(null)
                }}
              />
            ))}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              className="btn"
              onClick={() => {
                void setGroupColor(colorFor, undefined)
                setColorForState(null)
              }}
            >
              清除色标
            </button>
            <button className="btn" onClick={() => setColorForState(null)}>
              取消
            </button>
          </div>
        </Modal>
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

      {/* 批量移到分组：从右键菜单的批量项触发，在原右键位置弹出分组列表 */}
      {batchMoveIds && menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            ...allGroupNames.map((g) => ({
              label: g,
              onClick: () => {
                const ids = batchMoveIds
                setBatchMoveIds(null)
                closeMenu()
                if (!ids) return
                void moveToGroup(ids, g).then((n) => {
                  if (n > 0) {
                    useToastStore.getState().push({
                      kind: "success",
                      title: `已把 ${n} 条连接移入「${g}」`
                    })
                    setSelectedIds(new Set())
                  }
                })
              }
            })),
            {
              label: "新建分组并移入…",
              separatorBefore: true,
              onClick: () => {
                setBatchMoveIds(null)
                closeMenu()
                setNewGroupOpen(true)
              }
            }
          ]}
          onClose={() => {
            setBatchMoveIds(null)
            closeMenu()
          }}
        />
      )}

      {/* 批量删除确认 */}
      <ConfirmDialog
        open={pendingBatchDelete}
        title="删除选中的连接"
        danger
        confirmText="全部删除"
        message={
          <>
            确定删除选中的
            <span className="font-medium text-ink"> {selectedIds.size} </span>
            条连接吗？
            <div className="mt-2 text-2xs text-ink-3">
              已保存的密码会一并从凭据保险箱移除，该操作不可撤销。
            </div>
          </>
        }
        onCancel={() => setPendingBatchDelete(false)}
        onConfirm={() => {
          const ids = [...selectedIds]
          setPendingBatchDelete(false)
          setSelectedIds(new Set())
          // 一次 IPC + 一次落盘；逐个 remove 会是 N 次读改写
          void removeMany(ids).then((n) => {
            useToastStore.getState().push({
              kind: "success",
              title: `已删除 ${n} 条连接`
            })
          })
        }}
      />

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

      {/* 批量编辑标签 */}
      {batchTagsOpen && (
        <BatchTagsEditor
          selectedIds={selectedIds}
          connections={connections}
          onClose={() => setBatchTagsOpen(false)}
          onConfirm={() => {
            setBatchTagsOpen(false)
            setSelectedIds(new Set())
          }}
        />
      )}
    </div>
  )
}
