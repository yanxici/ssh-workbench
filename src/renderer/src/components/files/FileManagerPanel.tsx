import { ArrowDownToLine, ArrowLeft, ArrowRight, FolderTree, X } from 'lucide-react'
import { useSftpStore } from '@/stores/sftpStore'
import { LocalPane } from './LocalPane'
import { RemotePane } from './RemotePane'
import { UploadTargetDialog } from './UploadTargetDialog'

/**
 * SFTP 文件管理面板（覆盖主区域的双栏视图）。
 * 左：本地文件系统；右：远端设备文件系统；中间：上传/下载按钮。
 * 传输进度统一由全局 TransferProgressDock 展示（不随面板开关消失）。
 */
export function FileManagerPanel(): JSX.Element | null {
  const open = useSftpStore((s) => s.open)
  const sessionTitle = useSftpStore((s) => s.sessionTitle)
  const close = useSftpStore((s) => s.close)
  const sessionId = useSftpStore((s) => s.sessionId)
  const localSel = useSftpStore((s) => s.localSel)
  const remoteSel = useSftpStore((s) => s.remoteSel)
  const remoteDir = useSftpStore((s) => s.remoteDir)
  const uploadPaths = useSftpStore((s) => s.uploadPaths)
  const requestUpload = useSftpStore((s) => s.requestUpload)
  const cancelUploadRequest = useSftpStore((s) => s.cancelUploadRequest)
  const uploadRequest = useSftpStore((s) => s.uploadRequest)
  const downloadPaths = useSftpStore((s) => s.downloadPaths)
  const transfers = useSftpStore((s) => s.transfers)
  const showDock = useSftpStore((s) => s.showDock)

  if (!open) return null

  const activeCount = transfers.filter(
    (t) => t.status === 'running' || t.status === 'pending'
  ).length

  return (
    <div className="fixed inset-x-0 bottom-[26px] top-[38px] z-30 flex flex-col bg-app">
      {/* 标题栏 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3">
        <FolderTree size={14} className="text-accent" />
        <span className="text-xs font-semibold">文件管理</span>
        <span className="max-w-[280px] truncate text-2xs text-ink-3">{sessionTitle}</span>
        <span className="flex-1" />
        <span className="hidden truncate text-2xs text-ink-3 lg:block">
          双击目录进入 · 双击远程文件编辑 · 拖拽两侧互相传输
        </span>
        {transfers.length > 0 && (
          <button
            className="flex items-center gap-1 rounded border border-edge-soft px-1.5 py-0.5 text-2xs text-ink-3 transition-colors hover:bg-hover hover:text-ink"
            title="打开传输进度浮层"
            onClick={showDock}
          >
            <ArrowDownToLine
              size={11}
              className={activeCount > 0 ? 'text-accent' : 'text-success'}
            />
            {activeCount > 0 ? `${activeCount} 项传输中` : '传输记录'}
          </button>
        )}
        <button className="btn-icon" title="关闭 (Esc)" onClick={close}>
          <X size={14} />
        </button>
      </div>

      {/* 双栏 + 中间操作列 */}
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <LocalPane />
        </div>

        <div className="flex w-[52px] shrink-0 flex-col items-center justify-center gap-3 border-x border-edge-soft bg-panel/50">
          <button
            className="btn-icon h-8 w-8"
            title={`上传选中项（已选 ${localSel.length}，可改目标目录）`}
            disabled={localSel.length === 0}
            onClick={() => void requestUpload(sessionId, localSel)}
          >
            <ArrowRight size={16} />
          </button>
          <button
            className="btn-icon h-8 w-8"
            title={`下载选中项到左侧目录（已选 ${remoteSel.length}）`}
            disabled={remoteSel.length === 0}
            onClick={() => void downloadPaths(sessionId, remoteSel)}
          >
            <ArrowLeft size={16} />
          </button>
        </div>

        <div className="flex min-w-0 flex-1 flex-col">
          <RemotePane />
        </div>
      </div>

      {/* 上传目标目录确认（双栏里点上传 / 拖拽本地文件过来时都会先走这里） */}
      <UploadTargetDialog
        open={uploadRequest !== null}
        sessionId={sessionId ?? ''}
        defaultDir={uploadRequest?.defaultDir ?? ''}
        hint={
          uploadRequest
            ? `共 ${uploadRequest.localPaths.length} 项 · 右侧当前：${remoteDir || '未进入目录'}`
            : undefined
        }
        onCancel={cancelUploadRequest}
        onConfirm={(dir) => {
          const paths = uploadRequest?.localPaths ?? []
          cancelUploadRequest()
          void uploadPaths(sessionId, paths, dir)
        }}
      />
    </div>
  )
}
