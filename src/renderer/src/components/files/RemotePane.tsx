import type * as React from 'react'
import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
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
import { cn, formatBytes, formatTime, parseOctalMode, remoteDirname } from '@/lib/utils'
import {
  ConfirmDialog,
  ContextMenu,
  PromptDialog,
  useContextMenu,
  type MenuEntry
} from '@/components/ui'
import { isImeComposing } from '@/lib/ime'
import { useToastStore } from '@/stores/toastStore'
import { useTokenFlag } from '@/lib/useTokenFlag'
import { useI18n } from '@/i18n'
import { useVirtualizer } from '@tanstack/react-virtual'

/** 文件管理器右栏：远程设备文件系统（下载来源 / 上传目标） */
export function RemotePane(): React.JSX.Element {
  const { t } = useI18n()
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

  /*
   * 选中集合转 Set。
   * 原来每行都做 `sel.includes(f.path)`，n 行 × O(n) 查找 = O(n²)：
   * 5000 文件的目录光判断选中状态就要遍历上千万次，首帧明显卡顿。
   * Set 化之后每行 O(1)，整体降到 O(n)。
   */
  const selSet = useMemo(() => new Set(sel), [sel])

  /*
   * 渲染截断：5000 项的目录一次性铺开 DOM，光节点创建就够卡。
   * 与 FileExplorer/SessionFileTree 用同一个上限口径（300），
   * 超出部分给「还有 N 项」，用户主动点才全量渲染。
   */
  /* 设计 token 灰度：为 true 时行使用 24px 固定行高 */
  const tokensOn = useTokenFlag('sftp')

  /*
   * 虚拟滚动（阶段 3）。
   *
   * 原做法是「截断到 300 项 + 提示还有 N 项」：1 万文件的目录用户看不到全貌，
   * 只能靠路径栏猜。改成窗口化后 DOM 里始终只有视口内十几行，滚动覆盖全部条目。
   *
   * 行高必须固定（ROW_H）：虚拟化靠「索引 × 行高」定位，动态行高需要 measureElement，
   * 而这里所有行结构完全相同，固定高是最优解。24px 与阶段 1 的 token 行口径一致。
   *
   * 注意：**选中与全选语义仍基于 files 全量**（sel / selSet 不变），
   * 不受「当前渲染了哪几行」影响 —— 否则 Ctrl+A 会退化成「全选可见部分」。
   */
  const ROW_H = tokensOn ? 24 : 22
  const scrollRef = useRef<HTMLDivElement>(null)
  const vrow = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 8
  })
  const clickRow = (path: string, e: MouseEvent): void => {
    if (e.ctrlKey || e.metaKey) {
      setSel(selSet.has(path) ? sel.filter((p) => p !== path) : [...sel, path])
    } else {
      setSel([path])
    }
  }

  const menuItems = (path: string): MenuEntry[] => {
    const f = files.find((x) => x.path === path)
    const targets = selSet.has(path) ? sel : [path]
    return [
      {
        label: t('files.ui.edit'),
        icon: <Pencil size={12} />,
        disabled: !f || f.type === 'directory',
        onClick: () => void openEditor(sessionId, path)
      },
      {
        label: t('files.ui.remote.downloadMenu'),
        icon: <Download size={12} />,
        onClick: () => void downloadPaths(sessionId, targets)
      },
      {
        label: t('files.ui.explorer.uploadFolderDir'),
        icon: <FolderUp size={12} />,
        onClick: () => void uploadFolder(sessionId, f?.type === 'directory' ? path : dir || undefined)
      },
      {
        label: t('files.ui.rename'),
        disabled: targets.length !== 1,
        onClick: () => setDialog({ kind: 'rename', target: path })
      },
      {
        label: t('files.ui.chmod'),
        icon: <ShieldCheck size={12} />,
        disabled: !f,
        onClick: () => setDialog({ kind: 'chmod', target: path })
      },
      {
        label: t('files.ui.delete'),
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
      <div className="flex shrink-0 items-center gap-1 border-b border-edge-soft px-2 py-1.5">
        <span className="shrink-0 text-2xs font-semibold text-ink-2">{t('files.ui.remote.title')}</span>
        <button
          className="btn-icon h-6 w-6 shrink-0"
          title={t('files.ui.parentDir')}
          onClick={() => void nav(remoteDirname(dir))}
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
          title={
            dir
              ? t('files.ui.explorer.uploadFolderToTitle', { dir })
              : t('files.ui.explorer.uploadFolderPickTitle')
          }
          onClick={() => void uploadFolder(sessionId, dir || undefined)}
        >
          <FolderUp size={13} />
        </button>
        <button
          className="btn-icon h-6 w-6 shrink-0"
          title={t('files.ui.newFolder')}
          onClick={() => setDialog({ kind: 'mkdir' })}
        >
          <FolderPlus size={13} />
        </button>
        <button className="btn-icon h-6 w-6 shrink-0" title={t('files.ui.refresh')} onClick={() => void refresh()}>
          <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
        </button>
      </div>

      {/*
       * 列表（同时是上传落点）
       */}
      <div
        ref={scrollRef}
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
            <Loader2 size={13} className="animate-spin" /> {t('files.ui.reading')}
          </div>
        )}
        {/*
         * 虚拟滚动：只渲染视口内的行，滚动覆盖全部 files
         */}
        <div style={{ height: vrow.getTotalSize(), position: 'relative', width: '100%' }}>
          {vrow.getVirtualItems().map((vi) => {
            const f = files[vi.index]
            if (!f) return null
            return (
              <div
                key={f.path}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: vi.size,
                  transform: `translateY(${vi.start}px)`
                }}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(
                    'application/x-remote-paths',
                    JSON.stringify(selSet.has(f.path) ? sel : [f.path])
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
                  'flex h-full cursor-default items-center gap-2 rounded px-2 text-xs',
                  tokensOn && 'file-row-token-inner',
                  selSet.has(f.path) ? 'bg-accent/15 text-ink' : 'text-ink-2 hover:bg-hover/60'
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
            )
          })}
        </div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={closeMenu} />}

      <PromptDialog
        open={dialog !== null}
        title={
          dialog?.kind === 'rename'
            ? t('files.ui.rename')
            : dialog?.kind === 'chmod'
              ? t('files.ui.chmod')
              : t('files.ui.newFolder')
        }
        label={
          dialog?.kind === 'chmod'
            ? t('files.ui.chmodPrompt')
            : dialog?.kind === 'rename'
              ? t('files.ui.newName')
              : t('files.ui.folderName')
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
            const mode = parseOctalMode(value)
            /*
             * 解析失败必须出声。原实现直接 return，弹窗关了、什么都没发生 ——
             * 用户以为权限改成了 758，实际一位都没变（parseInt('758', 8) 还会
             * 静默截成 0o75，所以这里一律走严格解析并明确报错）。
             */
            if (mode === null) {
              useToastStore.getState().push({ kind: 'warning', title: t('files.ui.chmodInvalid') })
              return
            }
            void chmod(d.target, mode)
          }
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('files.ui.deleteRemote.title')}
        danger
        confirmText={t('files.ui.delete')}
        message={
          <>
            {t('files.ui.deleteRemote.prefix')}
            {pendingDelete?.type === 'directory'
              ? t('files.ui.deleteRemote.kindDir')
              : t('files.ui.deleteRemote.kindFile')}
            <span className="font-medium text-ink">「{pendingDelete?.name}」</span>
            {t('files.ui.deleteRemote.suffix')}
            <div className="mt-2 selectable break-all font-mono text-2xs text-ink-3">
              {pendingDelete?.path}
            </div>
            {pendingDelete?.type === 'directory' && (
              <div className="mt-1 text-2xs text-danger">{t('files.ui.deleteRemote.dirWarn')}</div>
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