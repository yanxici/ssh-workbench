import { useEffect, useRef, useState } from 'react'
import { loadDir, peekDir } from '@/lib/dirCache'
import {
  ChevronDown,
  ChevronRight,
  Columns2,
  Download,
  FileText,
  Folder,
  FolderPlus,
  FolderUp,
  Link2,
  Loader2,
  Pencil,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Upload,
  X
} from 'lucide-react'
import type { RemoteFile } from '@shared/types'
import { useSftpStore } from '@/stores/sftpStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useToastStore } from '@/stores/toastStore'
import { call } from '@/lib/ipc'
import { cn, formatBytes, remoteDirname, remoteJoin } from '@/lib/utils'
import { normalizeRemoteDir, rememberUploadDir, resolveUploadDir } from '@/lib/uploadDir'
import { UploadTargetDialog } from './UploadTargetDialog'
import {
  ConfirmDialog,
  ContextMenu,
  PromptDialog,
  useContextMenu,
  type MenuEntry
} from '@/components/ui'

/**
 * 终端左侧的会话文件树（连接会话后自动打开，可折叠）。
 * - 根为 `/`，自动展开到远端 home（可从 home 逐级往上浏览）
 * - 目录懒加载：点开箭头才拉取子目录
 * - 顶部路径栏显示当前目录（默认 home）
 * - 双击：目录展开/收起并让终端同步 cd 到该目录，文件打开远程编辑器
 * - 右键：编辑 / 上传到此处 / 新建文件夹 / 下载 / 重命名 / 权限 / 删除
 * - 刷新机制：操作后 bump 全局 treeVersion，各级目录重新拉取（展开结构保留）
 */

/** 由 home 路径推导需要自动展开的目录链：/home/share → ['/home', '/home/share'] */
function expandChain(home: string): string[] {
  const parts = home.split('/').filter(Boolean)
  const chain: string[] = []
  let current = ''
  for (const p of parts) {
    current = `${current}/${p}`
    chain.push(current)
  }
  return chain
}

/** 单引号转义，供 shell 安全使用：a'b → 'a'\''b' */
function shellQuote(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`
}

/**
 * 路径含控制字符（如 ^C、回车、ESC）时不能发给终端：
 * 这些字符会先被终端行规程 / readline 解释，单引号挡不住，恶意文件名可借此执行命令
 */
function isUnsafeForTerminal(p: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\x00-\x1f\x7f]/.test(p)
}

export function SessionFileTree({
  sessionId,
  title,
  onClose,
  onOpenTransfer
}: {
  sessionId: string
  title: string
  onClose: () => void
  onOpenTransfer: () => void
}): JSX.Element {
  const version = useSftpStore((s) => s.treeVersion)
  const bumpTree = useSftpStore((s) => s.bumpTree)
  const openEditor = useSftpStore((s) => s.openEditor)
  /** 所属会话的连接状态：连接中不发 SFTP 请求，就绪后自动加载 */
  const sessionStatus = useSessionStore(
    (s) => s.sessions.find((x) => x.id === sessionId)?.status ?? 'disconnected'
  )

  const [ready, setReady] = useState(false)
  const [autoExpand, setAutoExpand] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<RemoteFile | null>(null)
  /** 手动重试计数（失败后点「重试」触发） */
  const [attempt, setAttempt] = useState(0)
  /** 当前目录（顶部路径栏显示；双击目录时更新并同步终端 cd） */
  const [currentDir, setCurrentDir] = useState<string | null>(null)
  /** 上传前的目标目录确认框 */
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadDefault, setUploadDefault] = useState('')
  const [uploadHint, setUploadHint] = useState<string | undefined>(undefined)
  const [uploadBusy, setUploadBusy] = useState(false)

  // 初始化：根为 /，取 home 用于自动展开到主目录。
  // 只有会话 connected 后才发起请求（修复「连接瞬间打开文件树」的竞态失败）
  useEffect(() => {
    if (sessionStatus !== 'connected') return
    let cancelled = false
    setError(null)
    setReady(false)
    setAutoExpand([])
    setSelected(null)
    void window.api.sftp.home(sessionId).then((res) => {
      if (cancelled) return
      if (res.ok) {
        setAutoExpand(expandChain(res.data))
        // home 取不到时不要假装当前目录是 '/'：那会让上传默认目标变成根目录
        setCurrentDir(normalizeRemoteDir(res.data))
      } else {
        setError(res.error)
      }
      setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, sessionStatus, attempt])

  /** 刷新：未就绪/出错时重跑初始化，否则整体重列目录 */
  const refresh = (): void => {
    if (error || !ready) setAttempt((n) => n + 1)
    else bumpTree()
  }

  /**
   * 上传：先确认目标目录，再弹系统的本地文件选择框。
   *
   * 以前这里是 `autoExpand[last] ?? '/'` —— home 还没取到（或取失败）时
   * 直接退化成根目录，用户也没法改；现在默认值走同一条解析链，
   * 真的没有默认值时对话框会留空要求用户自己选，绝不静默落根。
   */
  const beginUpload = async (preferred?: string): Promise<void> => {
    const dir = await resolveUploadDir(
      sessionId,
      preferred ?? (selected?.type === 'directory' ? selected.path : currentDir)
    )
    setUploadDefault(dir)
    setUploadHint(
      preferred
        ? `目标来自所选条目：${preferred}`
        : dir
          ? undefined
          : '还没有可用目录，请手动指定上传位置'
    )
    setUploadOpen(true)
  }

  const doUpload = async (dir: string): Promise<void> => {
    const target = normalizeRemoteDir(dir)
    if (!target) return
    setUploadBusy(true)
    try {
      rememberUploadDir(sessionId, target)
      const res = await call(window.api.sftp.uploadDialog(sessionId, target), {
        errorTitle: '上传失败'
      })
      if (res && !res.canceled) {
        useToastStore.getState().push({
          kind: 'info',
          title: `已加入 ${res.count} 个上传任务`,
          detail: `目标：${target}`
        })
        bumpTree()
      }
    } finally {
      setUploadBusy(false)
      setUploadOpen(false)
    }
  }

  const handleUpload = (): void => {
    void beginUpload()
  }

  /** 上传文件夹：目标目录与「上传文件」同一套解析，落点保留同名目录 */
  const handleUploadFolder = async (): Promise<void> => {
    const target = await resolveUploadDir(
      sessionId,
      selected?.type === 'directory' ? selected.path : currentDir
    )
    if (!target) {
      useToastStore.getState().push({
        kind: 'warning',
        title: '没有可用的目标目录',
        detail: '请先展开一个远端目录'
      })
      return
    }
    rememberUploadDir(sessionId, target)
    const res = await call(window.api.sftp.uploadFolderDialog(sessionId, target, true), {
      errorTitle: '上传文件夹失败'
    })
    if (res && !res.canceled) {
      useToastStore.getState().push({
        kind: 'info',
        title: `已加入 ${res.count} 个文件夹上传任务`,
        detail: `目标：${target}（保留同名目录）`
      })
      bumpTree()
    }
  }

  /** 双击目录：更新路径栏，并让终端 cd 过去 */
  const enterDir = (dir: string): void => {
    setCurrentDir(dir)
    if (isUnsafeForTerminal(dir)) {
      useToastStore.getState().push({
        kind: 'error',
        title: '未同步终端目录',
        detail: '路径包含控制字符，为安全起见不自动 cd，请在终端手动进入'
      })
      return
    }
    void call(window.api.session.write(sessionId, `cd ${shellQuote(dir)}\r`), {
      errorTitle: '终端同步目录失败'
    })
  }

  const handleDownload = (): void => {
    if (!selected) return
    void call(window.api.sftp.downloadDialog(sessionId, [selected.path]), {
      errorTitle: '下载失败'
    }).then((res) => {
      if (res && !res.canceled) {
        useToastStore.getState().push({ kind: 'info', title: '已加入下载任务' })
      }
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-panel">
      {/* 头部工具栏 */}
      <div className="flex h-8 shrink-0 items-center gap-0.5 border-b border-edge-soft pl-2 pr-1">
        <span className="shrink-0 text-2xs font-semibold text-ink-2">文件</span>
        <span className="min-w-0 flex-1 truncate pl-1 text-2xs text-ink-3" title={title}>
          {title}
        </span>
        <button
          className="btn-icon h-6 w-6"
          title={
            selected?.type === 'directory'
              ? `上传文件到「${selected.name}」（可改目标目录）`
              : '上传文件（选择目标目录）'
          }
          onClick={handleUpload}
        >
          <Upload size={12} />
        </button>
        <button
          className="btn-icon h-6 w-6"
          title={
            selected?.type === 'directory'
              ? `上传文件夹到「${selected.name}」（远端保留同名目录）`
              : '上传文件夹（选择目标目录）'
          }
          onClick={() => void handleUploadFolder()}
        >
          <FolderUp size={12} />
        </button>
        <button
          className="btn-icon h-6 w-6"
          title={selected ? `下载「${selected.name}」` : '先选中一个文件/目录'}
          disabled={!selected}
          onClick={handleDownload}
        >
          <Download size={12} />
        </button>
        <button className="btn-icon h-6 w-6" title="刷新" onClick={refresh}>
          <RefreshCw size={12} />
        </button>
        <button
          className="btn-icon h-6 w-6"
          title="双栏传输模式（本地 ↔ 远端，适合批量互传）"
          onClick={onOpenTransfer}
        >
          <Columns2 size={12} />
        </button>
        <button className="btn-icon h-6 w-6" title="关闭文件面板" onClick={onClose}>
          <X size={12} />
        </button>
      </div>

      {/* 当前目录路径栏 */}
      <div
        className="flex h-6 shrink-0 items-center gap-1 border-b border-edge-soft px-2 text-ink-3"
        title={currentDir ?? ''}
      >
        <Folder size={11} className="shrink-0 text-accent/70" />
        {/* rtl + bdi：路径过长时省略号出现在左侧，保留末级目录可见 */}
        <span className="selectable min-w-0 flex-1 truncate text-left font-mono text-3xs" dir="rtl">
          <bdi>{currentDir ?? '—'}</bdi>
        </span>
      </div>

      {/* 树主体 */}
      <div className="scroll-thin min-h-0 flex-1 overflow-auto py-1" onClick={() => setSelected(null)}>
        {sessionStatus === 'connecting' ? (
          <div className="flex items-center justify-center gap-2 py-6 text-2xs text-ink-3">
            <Loader2 size={12} className="animate-spin" />
            等待会话连接…
          </div>
        ) : sessionStatus === 'error' || sessionStatus === 'disconnected' ? (
          <div className="px-3 py-4 text-2xs leading-relaxed text-ink-3">
            会话{sessionStatus === 'error' ? '连接失败' : '已断开'}。
            <div className="mt-1 text-ink-3/70">重新建立连接后，文件树会自动加载。</div>
          </div>
        ) : error ? (
          <div className="flex flex-col items-start gap-2 px-3 py-4">
            <div className="text-2xs leading-relaxed text-ink-3">{error}</div>
            <button
              className="flex items-center gap-1 rounded border border-edge px-2 py-1 text-2xs text-ink-2 transition-colors hover:bg-hover hover:text-ink"
              onClick={() => setAttempt((n) => n + 1)}
            >
              <RefreshCw size={11} />
              重试
            </button>
          </div>
        ) : ready ? (
          <TreeLevel
            key={autoExpand.join('|')}
            sessionId={sessionId}
            path="/"
            depth={0}
            version={version}
            autoExpand={autoExpand}
            selectedPath={selected?.path ?? null}
            onSelect={setSelected}
            onOpenFile={(f) => void openEditor(f.path)}
            onEnterDir={enterDir}
            onRefresh={bumpTree}
            onUploadTo={(dir) => void beginUpload(dir)}
          />
        ) : (
          <div className="flex items-center justify-center gap-2 py-6 text-2xs text-ink-3">
            <Loader2 size={12} className="animate-spin" />
            加载中…
          </div>
        )}
      </div>

      {/* 上传目标目录确认（选完目录才弹本地文件选择框） */}
      <UploadTargetDialog
        open={uploadOpen}
        sessionId={sessionId}
        defaultDir={uploadDefault}
        hint={uploadHint}
        busy={uploadBusy}
        onCancel={() => setUploadOpen(false)}
        onConfirm={(dir) => void doUpload(dir)}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  目录层级（递归，懒加载）
 * ------------------------------------------------------------------ */

function TreeLevel({
  sessionId,
  path,
  depth,
  version,
  autoExpand,
  selectedPath,
  onSelect,
  onOpenFile,
  onEnterDir,
  onRefresh,
  onUploadTo
}: {
  sessionId: string
  path: string
  depth: number
  version: number
  /** 需要自动展开的目录链（仅初始化时生效） */
  autoExpand: string[]
  selectedPath: string | null
  onSelect: (f: RemoteFile) => void
  onOpenFile: (f: RemoteFile) => void
  onEnterDir: (dir: string) => void
  onRefresh: () => void
  /** 打开上传目标目录确认框（dir 为该行的落点） */
  onUploadTo: (dir: string) => void
}): JSX.Element {
  const [files, setFiles] = useState<RemoteFile[] | null>(null)
  /** 大目录默认只渲染前 300 项，用户点「展开全部」后才铺满 */
  const [showAll, setShowAll] = useState(false)
  /** 后台静默刷新中：有缓存时界面不空，只在角落提示一下 */
  const [refreshing, setRefreshing] = useState(false)
  /*
   * version 变化表示「外部要求强制刷新」（上传/删除/新建等写操作之后）。
   * 用它和「普通挂载」区分：普通挂载吃缓存，写操作后必须绕过缓存。
   */
  const lastVersionRef = useRef(version)
  const forceRefresh = version !== lastVersionRef.current
  if (forceRefresh) lastVersionRef.current = version
  // 初始展开状态：自动展开链中属于本层子目录的项
  const [openDirs, setOpenDirs] = useState<Set<string>>(
    () => new Set(autoExpand.filter((p) => remoteDirname(p) === path))
  )

  useEffect(() => {
    let cancelled = false

    /*
     * 先看缓存：命中就直接上屏，避免折叠再展开、切走再切回都重新等一次往返。
     * 过期缓存也先用，随后后台静默刷新（stale-while-revalidate）。
     */
    const { cached, fresh } = peekDir(sessionId, path)
    if (cached) {
      setFiles(cached.files)
      setRefreshing(!fresh)
      if (fresh) return
    } else {
      setRefreshing(true)
    }

    void loadDir(
      sessionId,
      path,
      () => call(window.api.sftp.list(sessionId, path), { silent: true }),
      // version 变化 = 外部要求强制刷新（上传、删除等写操作后）
      forceRefresh
    ).then((list) => {
      if (cancelled) return
      if (list) setFiles(list)
      setRefreshing(false)
    })

    return () => {
      cancelled = true
    }
  }, [sessionId, path, version])

  const toggleDir = (p: string): void => {
    setOpenDirs((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }

  /*
   * 无缓存时的占位（方案 C）。
   *
   * 旧实现只画一个转圈图标，在慢链路上看起来就像「点了没反应」。
   * 改成几行灰色骨架条：既提示正在加载，又提前占住高度，
   * 数据到达后不会整块跳动。
   */
  if (!files) {
    return (
      <div style={{ paddingLeft: 10 + depth * 12 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex items-center gap-1.5 py-0.5 pr-2">
            <span className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-sm bg-edge-soft" />
            <span
              className="h-2 animate-pulse rounded bg-edge-soft"
              style={{ width: 60 + i * 22, animationDelay: i * 120 + "ms" }}
            />
          </div>
        ))}
        <div className="flex items-center gap-1 pl-0.5 pt-0.5 text-3xs text-ink-3">
          <Loader2 size={9} className="animate-spin" />
          读取中…
        </div>
      </div>
    )
  }

  /*
   * 大目录截断。
   *
   * 远端 var-log、家目录这类目录动辄几千项，一次性全渲染会让展开瞬间卡死。
   * 这里只渲染前 LIMIT 项，剩下的给一个按钮 —— 用「用户主动要求」换流畅度，
   * 比直接上虚拟列表改动小得多（层级递归的虚拟化很容易出错）。
   */
  const LIMIT = 300
  const shown = files.length > LIMIT ? files.slice(0, showAll ? files.length : LIMIT) : files
  const hidden = files.length - shown.length

  return (
    <>
      {shown.map((f) => (
        <div key={f.path}>
          <TreeRow
            file={f}
            depth={depth}
            expanded={openDirs.has(f.path)}
            selected={selectedPath === f.path}
            sessionId={sessionId}
            onToggle={() => toggleDir(f.path)}
            onSelect={onSelect}
            onOpenFile={onOpenFile}
            onEnterDir={onEnterDir}
            onRefresh={onRefresh}
            onUploadTo={onUploadTo}
          />
          {f.type === 'directory' && openDirs.has(f.path) && (
            <TreeLevel
              sessionId={sessionId}
              path={f.path}
              depth={depth + 1}
              version={version}
              autoExpand={autoExpand}
              selectedPath={selectedPath}
              onSelect={onSelect}
              onOpenFile={onOpenFile}
              onEnterDir={onEnterDir}
              onRefresh={onRefresh}
              onUploadTo={onUploadTo}
            />
          )}
        </div>
      ))}

      {hidden > 0 && (
        <button
          className="w-full py-1 text-left text-2xs text-ink-3 hover:text-ink"
          style={{ paddingLeft: 10 + depth * 12 }}
          onClick={() => setShowAll(true)}
        >
          还有 {hidden} 项，点击展开全部
        </button>
      )}

      {/* 有缓存时后台静默刷新：不遮挡内容，只在末尾挂一个极轻的提示 */}
      {refreshing && files !== null && (
        <div
          className="flex items-center gap-1 py-0.5 text-3xs text-ink-3/70"
          style={{ paddingLeft: 10 + depth * 12 }}
        >
          <Loader2 size={8} className="animate-spin" />
          同步中
        </div>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ *
 *  单行（含右键菜单）
 * ------------------------------------------------------------------ */

function TreeRow({
  file,
  depth,
  expanded,
  selected,
  sessionId,
  onToggle,
  onSelect,
  onOpenFile,
  onEnterDir,
  onRefresh,
  onUploadTo
}: {
  file: RemoteFile
  depth: number
  expanded: boolean
  selected: boolean
  sessionId: string
  onToggle: () => void
  onSelect: (f: RemoteFile) => void
  onOpenFile: (f: RemoteFile) => void
  onEnterDir: (dir: string) => void
  onRefresh: () => void
  onUploadTo: (dir: string) => void
}): JSX.Element {
  const { menu, openMenu, closeMenu } = useContextMenu<string>()
  const [dialog, setDialog] = useState<null | 'mkdir' | 'rename' | 'chmod'>(null)
  const [pendingDelete, setPendingDelete] = useState(false)

  const isDir = file.type === 'directory'

  /* ---------- 操作 ---------- */

  const mkdirAt = async (value: string): Promise<void> => {
    const done = await call(window.api.sftp.mkdir(sessionId, remoteJoin(file.path, value)), {
      errorTitle: '新建文件夹失败'
    })
    if (done !== null) onRefresh()
  }

  const renameTo = async (value: string): Promise<void> => {
    const done = await call(
      window.api.sftp.rename(sessionId, file.path, remoteJoin(remoteDirname(file.path), value)),
      { errorTitle: '重命名失败' }
    )
    if (done !== null) onRefresh()
  }

  const chmodTo = async (value: string): Promise<void> => {
    const mode = parseInt(value, 8)
    if (!Number.isFinite(mode)) return
    const done = await call(window.api.sftp.chmod(sessionId, file.path, mode), {
      errorTitle: '修改权限失败'
    })
    if (done !== null) {
      useToastStore.getState().push({ kind: 'success', title: `权限已更新为 ${value}` })
      onRefresh()
    }
  }

  const removeThis = async (): Promise<void> => {
    const done = await call(window.api.sftp.remove(sessionId, file.path), {
      errorTitle: '删除失败'
    })
    if (done !== null) {
      useToastStore.getState().push({ kind: 'success', title: `已删除「${file.name}」` })
      onRefresh()
    }
  }

  const uploadHere = (): void => {
    onUploadTo(isDir ? file.path : remoteDirname(file.path))
  }

  /** 上传文件夹到本行的落点（目录本身 / 文件所在目录） */
  const uploadFolderHere = async (): Promise<void> => {
    const target = await resolveUploadDir(
      sessionId,
      isDir ? file.path : remoteDirname(file.path)
    )
    if (!target) return
    rememberUploadDir(sessionId, target)
    const res = await call(window.api.sftp.uploadFolderDialog(sessionId, target, true), {
      errorTitle: '上传文件夹失败'
    })
    if (res && !res.canceled) {
      useToastStore.getState().push({
        kind: 'info',
        title: `已加入 ${res.count} 个文件夹上传任务`,
        detail: `目标：${target}（保留同名目录）`
      })
      onRefresh()
    }
  }

  const downloadHere = async (): Promise<void> => {
    const res = await call(window.api.sftp.downloadDialog(sessionId, [file.path]), {
      errorTitle: '下载失败'
    })
    if (res && !res.canceled) {
      useToastStore.getState().push({ kind: 'info', title: '已加入下载任务' })
    }
  }

  const menuItems = (): MenuEntry[] => [
    ...(isDir
      ? [
          { label: expanded ? '收起' : '展开', onClick: onToggle },
          { label: '终端进入此目录', onClick: () => onEnterDir(file.path) },
          {
            label: '上传文件到此处',
            icon: <Upload size={12} />,
            onClick: () => uploadHere()
          },
          {
            label: '上传文件夹到此处',
            icon: <FolderUp size={12} />,
            onClick: () => void uploadFolderHere()
          },
          {
            label: '新建文件夹',
            icon: <FolderPlus size={12} />,
            onClick: () => setDialog('mkdir')
          }
        ]
      : [
          {
            label: '编辑',
            icon: <Pencil size={12} />,
            onClick: () => onOpenFile(file)
          }
        ]),
    {
      label: isDir ? '下载此目录' : '下载',
      icon: <Download size={12} />,
      onClick: () => void downloadHere()
    },
    { label: '重命名', onClick: () => setDialog('rename') },
    {
      label: '修改权限',
      icon: <ShieldCheck size={12} />,
      onClick: () => setDialog('chmod')
    },
    {
      label: '删除',
      icon: <Trash2 size={12} />,
      danger: true,
      separatorBefore: true,
      onClick: () => setPendingDelete(true)
    }
  ]

  return (
    <>
      <div
        className={cn(
          'flex cursor-default items-center gap-1.5 rounded-sm py-[2px] pr-1.5 text-xs',
          selected ? 'bg-accent/15 text-ink' : 'text-ink-2 hover:bg-hover/60'
        )}
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={(e) => {
          e.stopPropagation()
          onSelect(file)
        }}
        onDoubleClick={() => {
          if (isDir) {
            onToggle()
            onEnterDir(file.path)
          } else onOpenFile(file)
        }}
        onContextMenu={(e) => openMenu(e, file.path)}
        title={file.path}
      >
        {isDir ? (
          <button
            className="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-ink-3"
            onClick={(e) => {
              e.stopPropagation()
              onToggle()
            }}
          >
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        ) : (
          <span className="w-3.5 shrink-0" />
        )}

        {isDir ? (
          <Folder size={12} className="shrink-0 text-accent/80" />
        ) : file.isLink ? (
          <Link2 size={12} className="shrink-0 text-warning/80" />
        ) : (
          <FileText size={12} className="shrink-0 text-ink-3" />
        )}

        <span className="min-w-0 flex-1 truncate">{file.name}</span>

        {!isDir && (
          <span className="shrink-0 font-mono text-3xs text-ink-3/70">
            {formatBytes(file.size)}
          </span>
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onClose={closeMenu} />}

      <PromptDialog
        open={dialog !== null}
        title={dialog === 'rename' ? '重命名' : dialog === 'chmod' ? '修改权限' : '新建文件夹'}
        label={
          dialog === 'chmod'
            ? '权限（八进制，如 644 / 755 / 600）'
            : dialog === 'rename'
              ? '新名称'
              : '文件夹名称'
        }
        defaultValue={
          dialog === 'rename'
            ? file.name
            : dialog === 'chmod'
              ? (file.mode & 0o777).toString(8).padStart(3, '0')
              : ''
        }
        onCancel={() => setDialog(null)}
        onConfirm={(value) => {
          const kind = dialog
          setDialog(null)
          if (kind === 'mkdir') void mkdirAt(value)
          else if (kind === 'rename') void renameTo(value)
          else if (kind === 'chmod') void chmodTo(value)
        }}
      />

      <ConfirmDialog
        open={pendingDelete}
        title="删除远程文件"
        danger
        confirmText="删除"
        message={
          <>
            确定删除远端{isDir ? '目录' : '文件'}
            <span className="font-medium text-ink">「{file.name}」</span>吗？
            <div className="mt-2 selectable break-all font-mono text-2xs text-ink-3">{file.path}</div>
            {isDir && <div className="mt-1 text-2xs text-danger">目录将被递归删除，不可恢复。</div>}
          </>
        }
        onCancel={() => setPendingDelete(false)}
        onConfirm={() => {
          setPendingDelete(false)
          void removeThis()
        }}
      />
    </>
  )
}
