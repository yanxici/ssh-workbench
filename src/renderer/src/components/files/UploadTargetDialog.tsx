import type * as React from 'react'
import { useEffect, useState } from 'react'
import { ArrowUp, Folder, FolderPlus, Loader2 } from 'lucide-react'
import type { RemoteFile } from '@shared/types'
import { Modal, PromptDialog } from '@/components/ui'
import { call } from '@/lib/ipc'
import { cn, remoteDirname, remoteJoin } from '@/lib/utils'
import { normalizeRemoteDir, rememberUploadDir } from '@/lib/uploadDir'
import { isImeComposing } from '@/lib/ime'
import { tNow, useI18n } from '@/i18n'

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
  /** force=true 表示不跳过「大小与修改时间都一致」的文件，整份重传 */
  onConfirm: (dir: string, force: boolean) => void
}): React.JSX.Element | null {
  const { t } = useI18n()
  const [dir, setDir] = useState(defaultDir)
  const [input, setInput] = useState(defaultDir)
  const [dirs, setDirs] = useState<RemoteFile[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mkdirOpen, setMkdirOpen] = useState(false)
  /*
   * 目录上传默认跳过「远端已有且大小/修改时间都一致」的文件 —— 这是省时间的关键，
   * 但它同时也意味着「用户以为自己传了、远端还是老内容」。留一个明确的开关，
   * 怀疑跳过判断出错时能整份重传，不必去删远端文件。
   */
  const [force, setForce] = useState(false)

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
          setError(tNow('files.ui.uploadDlg.errList'))
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
    /*
     * 先读输入框再退回 dir：用户手输目录后不按回车直接点「确定」时，
     * dir 还停在上一级，只读 dir 会把文件静默传到旧目录。
     */
    /*
     * 只认输入框当前内容，不再 || 回退到 dir。
     * 回退看起来"更宽容"，实际是把「用户清空输入框」这个明确的否定
     * 悄悄变成一个肯定：清空后点确定，文件照样传到旧目录，用户全程无感。
     */
    const target = normalizeRemoteDir(input)
    if (!target) {
      setError(t('files.ui.uploadDlg.errEmpty'))
      return
    }
    rememberUploadDir(sessionId, target)
    onConfirm(target, force)
  }

  const goInput = (): void => {
    const next = normalizeRemoteDir(input)
    if (!next) {
      setError(t('files.ui.uploadDlg.errEmpty'))
      return
    }
    setDir(next)
  }

  const gotoHome = async (): Promise<void> => {
    const home = await call(window.api.sftp.home(sessionId), { silent: true })
    const next = normalizeRemoteDir(home)
    if (next) setDir(next)
    else setError(t('files.ui.uploadDlg.errHome'))
  }

  const createDir = async (name: string): Promise<void> => {
    // 用户可能在输入框里打了路径却没回车；新建要落在他眼前那个目录，
    // 不是浏览器栏里还没跟上的旧 dir
    const base = normalizeRemoteDir(input) || normalized || '/'
    const target = remoteJoin(base, name)
    const done = await call(window.api.sftp.mkdir(sessionId, target), {
      errorTitle: t('files.ui.err.mkdir')
    })
    if (done !== null) setDir(target)
  }

  return (
    <>
      <Modal
        open={open}
        title={kind === 'folder' ? t('files.ui.uploadDlg.titleFolder') : t('files.ui.uploadDlg.titleFile')}
        onClose={onCancel}
        width="max-w-md"
        footer={
          <>
            <button className="btn" onClick={onCancel}>
              {t('files.ui.cancel')}
            </button>
            <button className="btn btn-primary" disabled={busy} onClick={submit}>
              {busy
                ? t('files.ui.uploadDlg.preparing')
                : kind === 'folder'
                  ? t('files.ui.uploadDlg.pickFolder')
                  : t('files.ui.uploadDlg.pickFile')}
            </button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <div>
            <div className="field-label mb-1">{t('files.ui.uploadDlg.targetLabel')}</div>
            <div className="flex items-center gap-1.5">
              <input
                className="input selectable min-w-0 flex-1 font-mono"
                value={input}
                placeholder={t('files.ui.uploadDlg.targetPlaceholder')}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (isImeComposing(e)) return
                  if (e.key === 'Enter') goInput()
                }}
              />
              <button
                className="btn-icon shrink-0"
                title={t('files.ui.parentDir')}
                disabled={!normalized}
                onClick={() => setDir(remoteDirname(normalized || '/'))}
              >
                <ArrowUp size={13} />
              </button>
              <button
                className="btn-icon shrink-0"
                title={t('files.ui.uploadDlg.goHome')}
                onClick={() => void gotoHome()}
              >
                <Folder size={13} />
              </button>
              <button
                className="btn-icon shrink-0"
                title={t('files.ui.uploadDlg.mkdirHere')}
                onClick={() => setMkdirOpen(true)}
              >
                <FolderPlus size={13} />
              </button>
            </div>
            {hint && <div className="mt-1 text-3xs text-ink-3">{hint}</div>}
          </div>

          {kind === 'folder' && (
            <label className="flex items-start gap-1.5 text-2xs leading-4 text-ink-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={force}
                onChange={(e) => setForce(e.target.checked)}
              />
              <span>
                {t('files.ui.uploadDlg.forceAll')}
                <span className="ml-1 text-3xs text-ink-3">
                  {t('files.ui.uploadDlg.forceAllHint')}
                </span>
              </span>
            </label>
          )}

          <div className="rounded-md border border-edge bg-app/60">
            <div className="flex h-7 items-center gap-1.5 border-b border-edge px-2">
              <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-2" title={normalized}>
                {normalized || t('files.ui.noDirSelected')}
              </span>
              {loading && <Loader2 size={11} className="animate-spin text-ink-3" />}
            </div>
            <div className="scroll-thin max-h-[38vh] min-h-[96px] overflow-y-auto py-1">
              {!normalized && (
                <div className="px-2 py-2 text-2xs text-ink-3">
                  {t('files.ui.uploadDlg.needTargetHint')}
                </div>
              )}
              {normalized && dirs === null && loading && (
                <div className="flex items-center gap-2 px-2 py-2 text-2xs text-ink-3">
                  <Loader2 size={11} className="animate-spin" /> {t('files.ui.reading')}
                </div>
              )}
              {normalized && dirs?.length === 0 && !loading && (
                <div className="px-2 py-2 text-2xs text-ink-3">{t('files.ui.uploadDlg.noSubdirs')}</div>
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
        title={t('files.ui.newFolder')}
        label={t('files.ui.folderName')}
        confirmText={t('files.ui.create')}
        onCancel={() => setMkdirOpen(false)}
        onConfirm={(value) => {
          setMkdirOpen(false)
          void createDir(value)
        }}
      />
    </>
  )
}
