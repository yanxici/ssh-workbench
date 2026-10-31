import { useEffect, useState } from 'react'
import { ArrowUp, Folder, FolderPlus, Loader2 } from 'lucide-react'
import type { RemoteFile } from '@shared/types'
import { Modal, PromptDialog } from '@/components/ui'
import { call } from '@/lib/ipc'
import { cn, remoteDirname, remoteJoin } from '@/lib/utils'
import { normalizeRemoteDir, rememberUploadDir } from '@/lib/uploadDir'
import { isImeComposing } from '@/lib/ime'

/**
 * 上传目标目录选择器。
 *
 * 之前「上传」直接把调用方的 remoteDir 交给系统文件对话框，用户只能选本地文件，
 * 目标目录完全不可见、不可改；调用方没拿到当前目录时还会退化成 '/'（远端根）。
 * 这里在选文件之前先把目标目录摆到台面上：可以逐级浏览、手输、新建，
 * 确认后才弹出系统的本地文件选择框。
 */
export function UploadTargetDialog({
  open,
  sessionId,
  defaultDir,
  hint,
  busy,
  kind = 'file',
  onCancel,
  onConfirm
}: {
  open: boolean
  sessionId: string
  /** 打开时预填的目录；'' 表示没有可靠默认值，让用户自己选 */
  defaultDir: string
  /** 额外说明（例如「已选 3 个本地文件」） */
  hint?: string
  busy?: boolean
  /** 确认后弹的是本地文件选择框还是文件夹选择框 */
  kind?: 'file' | 'folder'
  onCancel: () => void
  onConfirm: (dir: string) => void
}): JSX.Element | null {
  const [dir, setDir] = useState(defaultDir)
  const [input, setInput] = useState(defaultDir)
  const [dirs, setDirs] = useState<RemoteFile[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mkdirOpen, setMkdirOpen] = useState(false)

  /* 每次打开都用最新的默认值重置（同一个组件实例会反复用） */
  useEffect(() => {
    if (!open) return
    setDir(defaultDir)
    setInput(defaultDir)
    setError(null)
  }, [open, defaultDir])

  useEffect(() => {
    setInput(dir)
  }, [dir])

  useEffect(() => {
    if (!open || !sessionId || !dir) {
      setDirs(null)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    void call(window.api.sftp.list(sessionId, dir), { silent: true })
      .then((list) => {
        if (cancelled) return
        if (!list) {
          setDirs([])
          setError('无法读取该目录，请检查路径或权限')
          return
        }
        setDirs(list.filter((f) => f.type === 'directory'))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, sessionId, dir])

  const normalized = normalizeRemoteDir(dir)

  const submit = (): void => {
    if (!normalized) {
      setError('请先选择或填写目标目录')
      return
    }
    rememberUploadDir(sessionId, normalized)
    onConfirm(normalized)
  }

  const goInput = (): void => {
    const next = normalizeRemoteDir(input)
    if (!next) {
      setError('请先选择或填写目标目录')
      return
    }
    setDir(next)
  }

  const gotoHome = async (): Promise<void> => {
    const home = await call(window.api.sftp.home(sessionId), { silent: true })
    const next = normalizeRemoteDir(home)
    if (next) setDir(next)
    else setError('无法获取远端主目录')
  }

  const createDir = async (name: string): Promise<void> => {
    const base = normalized || '/'
    const target = remoteJoin(base, name)
    const done = await call(window.api.sftp.mkdir(sessionId, target), {
      errorTitle: '新建文件夹失败'
    })
    if (done !== null) setDir(target)
  }

  return (
    <>
      <Modal
        open={open}
        title={kind === 'folder' ? '上传文件夹到远端目录' : '上传到远端目录'}
        onClose={onCancel}
        width="max-w-md"
        footer={
          <>
            <button className="btn" onClick={onCancel}>
              取消
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={submit}>
              {busy ? '正在准备…' : kind === 'folder' ? '选择文件夹并上传' : '选择文件并上传'}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div>
            <div className="field-label mb-1">目标目录</div>
            <div className="flex items-center gap-1.5">
              <input
                className="input selectable min-w-0 flex-1 font-mono"
                value={input}
                placeholder="例如 /home/user 或 /tmp"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (isImeComposing(e)) return
                  if (e.key === 'Enter') goInput()
                }}
              />
              <button
                className="btn-icon shrink-0"
                title="上级目录"
                disabled={!normalized}
                onClick={() => setDir(remoteDirname(normalized || '/'))}
              >
                <ArrowUp size={13} />
              </button>
              <button
                className="btn-icon shrink-0"
                title="回到主目录"
                onClick={() => void gotoHome()}
              >
                <Folder size={13} />
              </button>
              <button
                className="btn-icon shrink-0"
                title="在此新建文件夹"
                onClick={() => setMkdirOpen(true)}
              >
                <FolderPlus size={13} />
              </button>
            </div>
            {hint && <div className="mt-1 text-3xs text-ink-3">{hint}</div>}
          </div>

          <div className="rounded-md border border-edge bg-app/60">
            <div className="flex h-7 items-center gap-1.5 border-b border-edge px-2">
              <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-2" title={normalized}>
                {normalized || '未选择目录'}
              </span>
              {loading && <Loader2 size={11} className="animate-spin text-ink-3" />}
            </div>
            <div className="scroll-thin max-h-[38vh] min-h-[96px] overflow-y-auto py-1">
              {!normalized && (
                <div className="px-2 py-2 text-2xs text-ink-3">
                  还没有可靠的目标目录，请在上方填写或点主目录图标选择。
                </div>
              )}
              {normalized && dirs === null && loading && (
                <div className="flex items-center gap-2 px-2 py-2 text-2xs text-ink-3">
                  <Loader2 size={11} className="animate-spin" /> 读取中…
                </div>
              )}
              {normalized && dirs?.length === 0 && !loading && (
                <div className="px-2 py-2 text-2xs text-ink-3">该目录下没有子目录</div>
              )}
              {dirs?.map((d) => (
                <button
                  key={d.path}
                  className={cn(
                    'flex w-full items-center gap-2 px-2 py-1 text-left text-xs',
                    'transition-colors duration-150 hover:bg-hover'
                  )}
                  title={d.path}
                  onClick={() => setDir(d.path)}
                >
                  <Folder size={12} className="shrink-0 text-ink-3" />
                  <span className="truncate">{d.name}</span>
                </button>
              ))}
            </div>
          </div>

          {error && <div className="text-2xs text-danger">{error}</div>}
        </div>
      </Modal>

      <PromptDialog
        open={open && mkdirOpen}
        title="新建文件夹"
        label="文件夹名称"
        confirmText="创建"
        onCancel={() => setMkdirOpen(false)}
        onConfirm={(value) => {
          setMkdirOpen(false)
          void createDir(value)
        }}
      />
    </>
  )
}
