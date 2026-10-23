import { useCallback, useEffect, useState } from 'react'
import {
  ChevronRight,
  Folder,
  File as FileIcon,
  FileText,
  FolderOpen,
  FolderTree,
  HardDrive,
  Home,
  LayoutGrid,
  Loader2,
  Plus,
  RefreshCw,
  Terminal,
  Upload
} from 'lucide-react'
import type { RemoteFile } from '@shared/types'
import type { SessionUi } from '@/stores/sessionStore'
import { useSftpStore } from '@/stores/sftpStore'
import { call } from '@/lib/ipc'
import { cn, formatBytes, remoteDirname, remoteJoin } from '@/lib/utils'

/**
 * 侧栏文件面板：工作区 / 文件系统 两个 Tab。
 *
 * - 「工作区」= 常用位置快捷入口（home、/、/tmp、/var/log、/etc），点一下跳到该目录；
 * - 「文件系统」= 真正的远端目录树，点目录逐级下钻，顶部面包屑可回跳；
 * - 两者共用同一个 currentDir，所以从快捷入口点进去之后，面包屑继续可用。
 *
 * 为什么不用 <SessionFileTree>：那个是给「贴着终端的一栏」设计的，带有自己的
 * 工具栏与关闭按钮，塞进侧栏会跟活动栏形成两套导航。这里按新外观重做一层，
 * 数据仍走同一套 sftp IPC，功能不缩减（双击目录=进入、双击文件=打开编辑器）。
 */

const WORKSPACE_SPOTS: Array<{ label: string; get: (home: string) => string; icon: JSX.Element }> =
  [
    { label: '主目录', get: (h) => h || '/', icon: <Home size={13} /> },
    { label: '根目录', get: () => '/', icon: <HardDrive size={13} /> },
    { label: '临时目录', get: () => '/tmp', icon: <Folder size={13} /> },
    { label: '系统日志', get: () => '/var/log', icon: <FileText size={13} /> },
    { label: '配置目录', get: () => '/etc', icon: <Folder size={13} /> }
  ]

interface TreeNode {
  file: RemoteFile
  depth: number
}

export function FileExplorer({
  session,
  onBrowseSessions
}: {
  /** 当前活动会话；未连接时展示引导 */
  session: SessionUi | null
  onOpenTransfer: () => void
  onBrowseSessions: () => void
}): JSX.Element {
  const [tab, setTab] = useState<'workspace' | 'fs'>('workspace')
  const [home, setHome] = useState<string>('')
  const [currentDir, setCurrentDir] = useState<string>('')
  const [rows, setRows] = useState<TreeNode[] | null>(null)
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const version = useSftpStore((s) => s.treeVersion)
  const bumpTree = useSftpStore((s) => s.bumpTree)
  const openEditor = useSftpStore((s) => s.openEditor)

  const sessionId = session?.id ?? null
  const connected = session?.status === 'connected'

  /* ---------- 取 home（决定「主目录」快捷入口与初始路径） ---------- */
  useEffect(() => {
    if (!sessionId || !connected) {
      setHome('')
      return
    }
    let cancelled = false
    void call(window.api.sftp.home(sessionId), { silent: true }).then((dir) => {
      if (cancelled) return
      const h = dir || '/'
      setHome(h)
      setCurrentDir((cur) => cur || h)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, connected])

  /* ---------- 拉取某个目录的直接子项，并展开进 rows ---------- */
  const loadDir = useCallback(
    async (dir: string): Promise<RemoteFile[] | null> => {
      if (!sessionId) return null
      const list = await call(window.api.sftp.list(sessionId, dir), { silent: true })
      return list ?? null
    },
    [sessionId]
  )

  /* ---------- 按 openDirs 递归展开成扁平行（渲染简单、无需嵌套组件） ---------- */
  useEffect(() => {
    if (!sessionId || !connected || !currentDir) return
    let cancelled = false
    setLoading(true)
    setError(null)

    const walk = async (dir: string, depth: number): Promise<TreeNode[]> => {
      const children = await loadDir(dir)
      if (!children) return []
      // 目录在前、文件在后，各自按名称排序（与 VS Code 一致）
      const sorted = [...children].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name, 'en')
      })
      const out: TreeNode[] = []
      for (const f of sorted) {
        out.push({ file: f, depth })
        if (f.type === 'directory' && openDirs.has(f.path)) {
          out.push(...(await walk(f.path, depth + 1)))
        }
      }
      return out
    }

    void walk(currentDir, 0)
      .then((list) => {
        if (cancelled) return
        setRows(list)
      })
      .catch(() => {
        if (!cancelled) {
          setRows([])
          setError('读取目录失败')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [sessionId, connected, currentDir, openDirs, version, loadDir])

  const toggleDir = (path: string): void => {
    setOpenDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const goto = (dir: string): void => {
    setCurrentDir(dir)
    setOpenDirs(new Set())
    setSelected(null)
    setTab('fs')
  }

  /* ---------- 面包屑：把路径拆成可点的段 ---------- */
  const crumbs = (() => {
    const p = currentDir || '/'
    const parts = p.split('/').filter(Boolean)
    const out: Array<{ label: string; path: string }> = [{ label: '/', path: '/' }]
    let acc = ''
    for (const part of parts) {
      acc = `${acc}/${part}`
      out.push({ label: part, path: acc })
    }
    return out
  })()

  /* ---------- 未连接：引导去连接 ---------- */
  if (!session || !connected) {
    return (
      <div className="flex h-full flex-col">
        <div className="panel-head">
          <FolderTree size={13} className="shrink-0 text-ink-3" />
          <span className="panel-title">文件</span>
          <span className="flex-1" />
        </div>
        <ExplorerTabs tab={tab} onChange={setTab} />
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 text-center">
          <FolderOpen size={26} className="text-ink-3/60" />
          <div className="text-xs font-medium text-ink-2">还没有连接任何设备</div>
          <div className="text-2xs leading-relaxed text-ink-3">
            文件浏览器需要先建立 SSH 连接；连上之后这里会自动显示远端目录。
          </div>
          <button className="btn btn-primary mt-1 h-7 px-3 text-2xs" onClick={onBrowseSessions}>
            <Terminal size={12} />
            去连接设备
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部：与其它 5 个侧栏面板共用 panel-head。
          原来这里是「Tab 行 + 工具栏」两行自造头，比 HistoryPanel /
          CommandPanel 等高出 4px，切面板时内容整体上下跳 —— 现在统一成
          panel-head(32) + panel-toolbar，剩下的横向空间还给了会话名。 */}
      <div className="panel-head">
        <FolderTree size={13} className="shrink-0 text-ink-3" />
        <span className="panel-title">文件</span>
        <span
          className="min-w-0 flex-1 truncate text-right font-mono text-3xs text-ink-3"
          title={session.title}
        >
          {session.title}
        </span>
        <button className="btn-icon h-6 w-6" title="刷新当前目录" onClick={() => bumpTree()}>
          <RefreshCw size={13} />
        </button>
        <button
          className="btn-icon h-6 w-6"
          title="上传文件到当前目录"
          onClick={() => {
            void call(window.api.sftp.uploadDialog(sessionId!, currentDir), { silent: true }).then(
              () => bumpTree()
            )
          }}
        >
          <Upload size={13} />
        </button>
        <button
          className="btn-icon h-6 w-6"
          title="新建文件夹"
          onClick={() => {
            void call(window.api.sftp.mkdir(sessionId!, remoteJoin(currentDir, '新建文件夹')), {
              silent: true
            }).then(() => bumpTree())
          }}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Tab 行：跟命令面板的「全部/收藏/最近」用同一套分段控件外观 */}
      <ExplorerTabs tab={tab} onChange={setTab} />

      {/* 面包屑：只在「文件系统」Tab 出现 —— 工作区是快捷位置列表，
          顶上再放一条路径等于同一信息重复两次 */}
      {tab === 'fs' && (
        <div className="scroll-thin flex h-7 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-edge px-1.5">
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex shrink-0 items-center gap-0.5">
              {i > 0 && <ChevronRight size={10} className="text-ink-3/50" />}
              <button
                className={cn(
                  'rounded px-1 py-0.5 font-mono text-2xs transition-colors duration-150 hover:bg-hover',
                  i === crumbs.length - 1 ? 'text-ink' : 'text-ink-3'
                )}
                onClick={() => goto(c.path)}
              >
                {c.label}
              </button>
            </span>
          ))}
        </div>
      )}

      {/* 工作区快捷入口 */}
      {tab === 'workspace' && (
        <div className="shrink-0 border-b border-edge px-1.5 py-1.5">
          <div className="mb-1 px-1 text-3xs font-semibold uppercase tracking-wider text-ink-3/80">
            常用位置
          </div>
          {WORKSPACE_SPOTS.map((spot) => {
            const path = spot.get(home)
            const active = currentDir === path
            return (
              <button
                key={spot.label}
                className={cn(
                  'flex w-full cursor-default items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors duration-150',
                  active ? 'bg-select text-ink' : 'text-ink-2 hover:bg-hover'
                )}
                onClick={() => goto(path)}
              >
                <span className={active ? 'text-accent' : 'text-ink-3'}>{spot.icon}</span>
                <span className="min-w-0 flex-1 truncate">{spot.label}</span>
                <span className="max-w-[120px] shrink-0 truncate font-mono text-3xs text-ink-3/80">
                  {path}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {/* 目录树 */}
      <div className="scroll-thin min-h-0 flex-1 overflow-auto py-1">
        {loading && rows === null ? (
          <div className="flex items-center justify-center gap-2 py-6 text-2xs text-ink-3">
            <Loader2 size={12} className="animate-spin" />
            加载中…
          </div>
        ) : error ? (
          <div className="px-3 py-4 text-2xs leading-relaxed text-ink-3">{error}</div>
        ) : rows && rows.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
            <LayoutGrid size={18} className="text-ink-3/50" />
            <div className="text-2xs text-ink-3">这个目录是空的</div>
          </div>
        ) : (
          (rows ?? []).map(({ file, depth }) => {
            const isDir = file.type === 'directory'
            const isOpen = openDirs.has(file.path)
            const isSel = selected === file.path
            return (
              <div
                key={file.path}
                data-file-path={file.path}
                className={cn(
                  'group flex cursor-default items-center gap-1 py-[3px] pr-2 text-xs transition-colors duration-150',
                  isSel ? 'bg-select text-ink' : 'text-ink-2 hover:bg-hover'
                )}
                style={{ paddingLeft: 6 + depth * 12 }}
                onClick={() => setSelected(file.path)}
                onDoubleClick={() => {
                  if (isDir) {
                    setCurrentDir(file.path)
                    toggleDir(file.path)
                  } else {
                    void openEditor(file.path)
                  }
                }}
                title={`${file.path}${isDir ? '' : ` · ${formatBytes(file.size)}`}`}
              >
                {isDir ? (
                  <button
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-ink-3 hover:text-ink"
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleDir(file.path)
                    }}
                  >
                    <ChevronRight
                      size={11}
                      className={cn('transition-transform duration-150', isOpen && 'rotate-90')}
                    />
                  </button>
                ) : (
                  <span className="h-4 w-4 shrink-0" />
                )}

                {isDir ? (
                  <Folder size={13} className={cn('shrink-0', isSel ? 'text-accent' : 'text-ink-3')} />
                ) : (
                  <FileIcon size={13} className="shrink-0 text-ink-3" />
                )}

                <span className="min-w-0 flex-1 truncate">{file.name}</span>
              </div>
            )
          })
        )}
      </div>

      {/* 底：当前目录 + 上级 */}
      <div className="flex h-7 shrink-0 items-center gap-1 border-t border-edge px-1.5 text-2xs text-ink-3">
        <span className="min-w-0 flex-1 truncate font-mono" title={currentDir}>
          {currentDir || '/'}
        </span>
        {currentDir && currentDir !== '/' && (
          <button
            className="rounded px-1 py-0.5 transition-colors duration-150 hover:bg-hover hover:text-ink-2"
            onClick={() => goto(remoteDirname(currentDir) || '/')}
          >
            上级
          </button>
        )}
      </div>
    </div>
  )
}

/** Tab 行：工作区 / 文件系统。
 *
 * 用与命令面板「全部 / 收藏 / 最近」完全一致的分段控件外观（bg-raised 外壳 +
 * 选中项白底微投影），而不是自造的「下划线 Tab」。理由：侧栏 6 个面板里只有
 * 这里用下划线，切面板时视觉语言不统一；分段控件还能让「当前在哪一栏」在
 * 280px 宽度下更清楚。 */
function ExplorerTabs({
  tab,
  onChange
}: {
  tab: 'workspace' | 'fs'
  onChange: (t: 'workspace' | 'fs') => void
}): JSX.Element {
  const items: Array<{ key: 'workspace' | 'fs'; label: string }> = [
    { key: 'workspace', label: '工作区' },
    { key: 'fs', label: '文件系统' }
  ]
  return (
    <div className="flex shrink-0 items-center gap-1 px-2 pb-1.5 pt-1.5">
      <div className="flex items-center gap-0.5 rounded-md bg-raised p-0.5">
        {items.map((it) => {
          const on = tab === it.key
          return (
            <button
              key={it.key}
              className={cn(
                'flex h-[22px] items-center rounded px-2 text-2xs transition-colors duration-150',
                on
                  ? 'bg-app font-medium text-ink shadow-[0_1px_2px_rgb(0_0_0/0.06)]'
                  : 'text-ink-3 hover:text-ink-2'
              )}
              onClick={() => onChange(it.key)}
            >
              {it.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
