import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import {
  ArrowUp,
  FileText,
  Folder,
  FolderPlus,
  Loader2,
  Pencil,
  RefreshCw,
  Trash2,
  Upload
} from 'lucide-react'
import type { LocalFile } from '@shared/types'
import { useSftpStore } from '@/stores/sftpStore'
import { call } from '@/lib/ipc'
import { cn, formatBytes, formatTime, localDirname } from '@/lib/utils'
import {
  ConfirmDialog,
  ContextMenu,
  PromptDialog,
  useContextMenu,
  type MenuEntry
} from '@/components/ui'
import { isImeComposing } from '@/lib/ime'

/** 文件管理器左栏：本地文件系统（上传来源 / 下载目标） */
export function LocalPane(): JSX.Element {
  const dir = useSftpStore((s) => s.localDir)
  /** 本面板所属会话：上传/下载执行链路要求显式传入（不再依赖 store.sessionId） */
  const sessionId = useSftpStore((s) => s.sessionId)
  const files = useSftpStore((s) => s.localFiles)
  const loading = useSftpStore((s) => s.localLoading)
  const sel = useSftpStore((s) => s.localSel)
  const setSel = useSftpStore((s) => s.setLocalSel)
  const nav = useSftpStore((s) => s.navLocal)
  const refresh = useSftpStore((s) => s.refreshLocal)
  const requestUpload = useSftpStore((s) => s.requestUpload)
  const downloadPaths = useSftpStore((s) => s.downloadPaths)
  const mkdir = useSftpStore((s) => s.mkdirLocal)
  const rename = useSftpStore((s) => s.renameLocal)
  const remove = useSftpStore((s) => s.removeLocal)

  const [pathInput, setPathInput] = useState(dir)
  const [drives, setDrives] = useState<string[]>([])
  const [dialog, setDialog] = useState<{ kind: 'mkdir' | 'rename'; target?: string } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<LocalFile | null>(null)
  const { menu, openMenu, closeMenu } = useContextMenu<string>()

  useEffect(() => setPathInput(dir), [dir])

  useEffect(() => {
    void call(window.api.local.drives(), { silent: true }).then((d) => setDrives(d ?? []))
  }, [])

  /* 选中集合 Set 化：与 RemotePane 同理，原来的每行 includes 是 O(n²) */
  const selSet = useMemo(() => new Set(sel), [sel])

  /* 渲染截断：与 RemotePane / FileExplorer / SessionFileTree 统一 300 口径 */
  const ROW_LIMIT = 300
  const shownFiles = useMemo(
    () => (files.length > ROW_LIMIT ? files.slice(0, ROW_LIMIT) : files),
    [files]
  )

  const clickRow = (path: string, e: MouseEvent): void => {
    if (e.ctrlKey || e.metaKey) {
      setSel(selSet.has(path) ? sel.filter((p) => p !== path) : [...sel, path])
    } else {
      setSel([path])
    }
  }

  const menuItems = (path: string): MenuEntry[] => {
    const targets = selSet.has(path) ? sel : [path]
    return [
      {
        label: '上传到远端目录…',
        icon: <Upload size={12} />,
        onClick: () => void requestUpload(sessionId, targets)
      },
      {
        label: '重命名',
        icon: <Pencil size={12} />,
        disabled: targets.length !== 1,
        onClick: () => setDialog({ kind: 'rename', target: path })
      },
      {
        label: '删除',
        icon: <Trash2 size={12} />,
        danger: true,
        separatorBefore: true,
        onClick: () => {
          const f = files.find((x) => x.path === path)
          if (f) setPendingDelete(f)
        }
      }
    ]
  }

  const currentDrive = drives.find((d) => dir.toLowerCase().startsWith(d.toLowerCase()))

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具栏 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-edge-soft px-2 py-1.5">
        <span className="shrink-0 text-2xs font-semibold text-ink-2">本地</span>
        {drives.length > 1 && (
          <select
            className="input h-6 w-[68px] shrink-0 px-1 text-2xs"
            value={currentDrive ?? ''}
            onChange={(e) => {
              if (e.target.value) void nav(e.target.value)
            }}
          >
            {drives.map((d) => (
              <option key={d} value={d}>
                {d.replace(/\\$/, '')}
              </option>
            ))}
          </select>
        )}
        <button
          className="btn-icon h-6 w-6 shrink-0"
          title="上级目录"
          onClick={() => void nav(localDirname(dir))}
        >
          <ArrowUp size={13} />
        </button>
        <input
          className="input h-6 min-w-0 flex-1 font-mono text-2xs"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (isImeComposing(e)) return
            if (e.key === 'Enter') void nav(pathInput.trim())
          }}
          title={dir}
        />
        <button
          className="btn-icon h-6 w-6 shrink-0"
          title="新建文件夹"
          onClick={() => setDialog({ kind: 'mkdir' })}
        >
          <FolderPlus size={13} />
        </button>
        <button
          className="btn-icon h-6 w-6 shrink-0"
          title="刷新"
          onClick={() => void refresh()}
        >
          <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
        </button>
      </div>

      {/* 列表（同时是下载落点） */}
      <div
        className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/x-remote-paths')) e.preventDefault()
        }}
        onDrop={(e) => {
          const raw = e.dataTransfer.getData('application/x-remote-paths')
          if (!raw) return
          e.preventDefault()
          try {
            void downloadPaths(sessionId, JSON.parse(raw) as string[])
          } catch {
            /* 无效拖拽数据 */
          }
        }}
      >
        {loading && files.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-8 text-2xs text-ink-3">
            <Loader2 size={13} className="animate-spin" /> 读取中…
          </div>
        )}
        {shownFiles.map((f) => (
          <div
            key={f.path}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(
                'application/x-local-paths',
                JSON.stringify(selSet.has(f.path) ? sel : [f.path])
              )
              e.dataTransfer.effectAllowed = 'copy'
            }}
            onClick={(e) => clickRow(f.path, e)}
            onDoubleClick={() => {
              if (f.isDir) void nav(f.path)
            }}
            onContextMenu={(e) => openMenu(e, f.path)}
            className={cn(
              'file-row-cv flex cursor-default items-center gap-2 rounded px-2 py-[3px] text-xs',
              selSet.has(f.path)
                ? 'bg-accent/15 text-ink'
                : 'text-ink-2 hover:bg-hover/60'
            )}
            title={f.path}
          >
            {f.isDir ? (
              <Folder size={13} className="shrink-0 text-accent/80" />
            ) : (
              <FileText size={13} className="shrink-0 text-ink-3" />
            )}
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            <span className="w-16 shrink-0 text-right font-mono text-2xs text-ink-3">
              {f.isDir ? '—' : formatBytes(f.size)}
            </span>
            <span className="w-[104px] shrink-0 text-right font-mono text-2xs text-ink-3">
              {formatTime(f.mtime)}
            </span>
          </div>
        ))}
        {files.length > shownFiles.length && (
          <div className="px-2 py-1 text-2xs text-ink-3">
            仅显示前 {shownFiles.length} 项，共 {files.length} 项 —— 用上方的路径栏可直接进入目标目录
          </div>
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={closeMenu} />}

      <PromptDialog
        open={dialog !== null}
        title={dialog?.kind === 'rename' ? '重命名' : '新建文件夹'}
        label={dialog?.kind === 'rename' ? '新名称' : '文件夹名称'}
        defaultValue={dialog?.kind === 'rename' ? (dialog.target?.split(/[\\/]/).pop() ?? '') : ''}
        onCancel={() => setDialog(null)}
        onConfirm={(value) => {
          const d = dialog
          setDialog(null)
          if (!d) return
          if (d.kind === 'mkdir') void mkdir(value)
          else if (d.target) void rename(d.target, value)
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除本地文件"
        danger
        confirmText="删除"
        message={
          <>
            确定删除本地
            {pendingDelete?.isDir ? '文件夹' : '文件'}
            <span className="font-medium text-ink">「{pendingDelete?.name}」</span>吗？
            <div className="mt-2 selectable break-all font-mono text-2xs text-ink-3">
              {pendingDelete?.path}
            </div>
            <div className="mt-1 text-2xs text-danger">本地删除不进回收站，不可恢复。</div>
          </>
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const f = pendingDelete
          setPendingDelete(null)
          if (f) void remove(f.path)
        }}
      />
    </div>
  )
}
