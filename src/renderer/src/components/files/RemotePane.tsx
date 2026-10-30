import { useEffect, useState, type MouseEvent } from 'react'
import {
  ArrowUp,
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
  Trash2
} from 'lucide-react'
import type { RemoteFile } from '@shared/types'
import { useSftpStore } from '@/stores/sftpStore'
import { cn, formatBytes, formatTime, remoteDirname } from '@/lib/utils'
import {
  ConfirmDialog,
  ContextMenu,
  PromptDialog,
  useContextMenu,
  type MenuEntry
} from '@/components/ui'

/** 文件管理器右栏：远程设备文件系统（下载来源 / 上传目标） */
export function RemotePane(): JSX.Element {
  const dir = useSftpStore((s) => s.remoteDir)
  /** 本面板所属会话：上传/下载执行链路要求显式传入（不再依赖 store.sessionId） */
  const sessionId = useSftpStore((s) => s.sessionId)
  const files = useSftpStore((s) => s.remoteFiles)
  const loading = useSftpStore((s) => s.remoteLoading)
  const sel = useSftpStore((s) => s.remoteSel)
  const setSel = useSftpStore((s) => s.setRemoteSel)
  const nav = useSftpStore((s) => s.navRemote)
  const refresh = useSftpStore((s) => s.refreshRemote)
  const uploadPaths = useSftpStore((s) => s.uploadPaths)
  const requestUpload = useSftpStore((s) => s.requestUpload)
  const downloadPaths = useSftpStore((s) => s.downloadPaths)
  const mkdir = useSftpStore((s) => s.mkdirRemote)
  const rename = useSftpStore((s) => s.renameRemote)
  const remove = useSftpStore((s) => s.removeRemote)
  const uploadFolder = useSftpStore((s) => s.uploadFolder)
  const chmod = useSftpStore((s) => s.chmodRemote)
  const openEditor = useSftpStore((s) => s.openEditor)

  const [pathInput, setPathInput] = useState(dir)
  const [dialog, setDialog] = useState<{ kind: 'mkdir' | 'rename' | 'chmod'; target?: string } | null>(
    null
  )
  const [pendingDelete, setPendingDelete] = useState<RemoteFile | null>(null)
  const { menu, openMenu, closeMenu } = useContextMenu<string>()

  useEffect(() => setPathInput(dir), [dir])

  const clickRow = (path: string, e: MouseEvent): void => {
    if (e.ctrlKey || e.metaKey) {
      setSel(sel.includes(path) ? sel.filter((p) => p !== path) : [...sel, path])
    } else {
      setSel([path])
    }
  }

  const menuItems = (path: string): MenuEntry[] => {
    const f = files.find((x) => x.path === path)
    const targets = sel.includes(path) ? sel : [path]
    return [
      {
        label: '编辑',
        icon: <Pencil size={12} />,
        disabled: !f || f.type === 'directory',
        onClick: () => void openEditor(sessionId, path)
      },
      {
        label: '下载到左侧目录',
        icon: <Download size={12} />,
        onClick: () => void downloadPaths(sessionId, targets)
      },
      {
        label: '上传文件夹到此目录',
        icon: <FolderUp size={12} />,
        onClick: () => void uploadFolder(sessionId, f?.type === 'directory' ? path : dir || undefined)
      },
      {
        label: '重命名',
        disabled: targets.length !== 1,
        onClick: () => setDialog({ kind: 'rename', target: path })
      },
      {
        label: '修改权限',
        icon: <ShieldCheck size={12} />,
        disabled: !f,
        onClick: () => setDialog({ kind: 'chmod', target: path })
      },
      {
        label: '删除',
        icon: <Trash2 size={12} />,
        danger: true,
        separatorBefore: true,
        onClick: () => {
          if (f) setPendingDelete(f)
        }
      }
    ]
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具栏 */}
      <div className="flex shrink-0 items-center gap-1 border-b border-edge-soft px-2 py-1.5">
        <span className="shrink-0 text-2xs font-semibold text-ink-2">远程</span>
        <button
          className="btn-icon h-6 w-6 shrink-0"
          title="上级目录"
          onClick={() => void nav(remoteDirname(dir))}
        >
          <ArrowUp size={13} />
        </button>
        <input
          className="input h-6 min-w-0 flex-1 font-mono text-2xs"
          value={pathInput}
          onChange={(e) => setPathInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void nav(pathInput.trim())
          }}
          title={dir}
        />
        <button
          className="btn-icon h-6 w-6 shrink-0"
          title={dir ? `上传文件夹到 ${dir}（远端保留同名目录）` : '上传文件夹（选择目标目录）'}
          onClick={() => void uploadFolder(sessionId, dir || undefined)}
        >
          <FolderUp size={13} />
        </button>
        <button
          className="btn-icon h-6 w-6 shrink-0"
          title="新建文件夹"
          onClick={() => setDialog({ kind: 'mkdir' })}
        >
          <FolderPlus size={13} />
        </button>
        <button className="btn-icon h-6 w-6 shrink-0" title="刷新" onClick={() => void refresh()}>
          <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
        </button>
      </div>

      {/* 列表（同时是上传落点） */}
      <div
        className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('application/x-local-paths')) e.preventDefault()
        }}
        onDrop={(e) => {
          const raw = e.dataTransfer.getData('application/x-local-paths')
          if (!raw) return
          e.preventDefault()
          try {
            const paths = JSON.parse(raw) as string[]
            // 拖到右栏 = 明确落到「右栏当前显示的目录」，这是用户看得见的选择；
            // 只有右栏还没定位（dir 为空）时才回退到目录选择框。
            if (dir) void uploadPaths(sessionId, paths, dir)
            else void requestUpload(sessionId, paths)
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
        {files.map((f) => (
          <div
            key={f.path}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(
                'application/x-remote-paths',
                JSON.stringify(sel.includes(f.path) ? sel : [f.path])
              )
              e.dataTransfer.effectAllowed = 'copy'
            }}
            onClick={(e) => clickRow(f.path, e)}
            onDoubleClick={() => {
              if (f.type === 'directory') void nav(f.path)
              else void openEditor(sessionId, f.path)
            }}
            onContextMenu={(e) => openMenu(e, f.path)}
            className={cn(
              'flex cursor-default items-center gap-2 rounded px-2 py-[3px] text-xs',
              sel.includes(f.path) ? 'bg-accent/15 text-ink' : 'text-ink-2 hover:bg-hover/60'
            )}
            title={f.path}
          >
            {f.type === 'directory' ? (
              <Folder size={13} className="shrink-0 text-accent/80" />
            ) : f.isLink ? (
              <Link2 size={13} className="shrink-0 text-warning/80" />
            ) : (
              <FileText size={13} className="shrink-0 text-ink-3" />
            )}
            <span className="min-w-0 flex-1 truncate">{f.name}</span>
            <span className="w-16 shrink-0 text-right font-mono text-2xs text-ink-3">
              {f.type === 'directory' ? '—' : formatBytes(f.size)}
            </span>
            <span className="w-[88px] shrink-0 text-right font-mono text-2xs text-ink-3">
              {f.modeStr}
            </span>
            <span className="w-[104px] shrink-0 text-right font-mono text-2xs text-ink-3">
              {formatTime(f.mtime)}
            </span>
          </div>
        ))}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={closeMenu} />}

      <PromptDialog
        open={dialog !== null}
        title={
          dialog?.kind === 'rename'
            ? '重命名'
            : dialog?.kind === 'chmod'
              ? '修改权限'
              : '新建文件夹'
        }
        label={
          dialog?.kind === 'chmod'
            ? '权限（八进制，如 644 / 755 / 600）'
            : dialog?.kind === 'rename'
              ? '新名称'
              : '文件夹名称'
        }
        defaultValue={
          dialog?.kind === 'rename'
            ? (dialog.target?.split('/').pop() ?? '')
            : dialog?.kind === 'chmod'
              ? ((files.find((x) => x.path === dialog.target)?.mode ?? 0) & 0o777)
                  .toString(8)
                  .padStart(3, '0')
              : ''
        }
        onCancel={() => setDialog(null)}
        onConfirm={(value) => {
          const d = dialog
          setDialog(null)
          if (!d) return
          if (d.kind === 'mkdir') void mkdir(value)
          else if (d.kind === 'rename' && d.target) void rename(d.target, value)
          else if (d.kind === 'chmod' && d.target) {
            const mode = parseInt(value, 8)
            if (Number.isFinite(mode)) void chmod(d.target, mode)
          }
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除远程文件"
        danger
        confirmText="删除"
        message={
          <>
            确定删除远端
            {pendingDelete?.type === 'directory' ? '目录' : '文件'}
            <span className="font-medium text-ink">「{pendingDelete?.name}」</span>吗？
            <div className="mt-2 selectable break-all font-mono text-2xs text-ink-3">
              {pendingDelete?.path}
            </div>
            {pendingDelete?.type === 'directory' && (
              <div className="mt-1 text-2xs text-danger">目录将被递归删除，不可恢复。</div>
            )}
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
