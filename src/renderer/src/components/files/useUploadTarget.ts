import { useCallback, useState } from 'react'
import { useSftpStore } from '@/stores/sftpStore'
import { normalizeRemoteDir, resolveUploadDir } from '@/lib/uploadDir'

/**
 * 「先确认目标目录，再弹系统文件对话框」这套状态机。
 *
 * 文件侧栏和会话文件树各写了一份完全相同的实现（4 个 useState + beginUpload +
 * doUpload + 对话框 props 绑定，约 50 行 × 2）。两边唯一的差别只有 hint 文案，
 * 所以抽成一个 hook，两边只调 `request(dir)` 并渲染 `dialogProps`。
 *
 * 真正的传输链路不在这里，在 sftpStore.uploadFileDialog（解析 / 弹框 / 提示 / 失效缓存）。
 */

export interface UploadTargetDialogProps {
  open: boolean
  sessionId: string
  defaultDir: string
  hint?: string
  busy?: boolean
  /** 确认后执行哪条链路：选本地文件 / 选本地文件夹 */
  kind?: 'file' | 'folder'
  onCancel: () => void
  onConfirm: (dir: string) => void
}

export function useUploadTarget(
  sessionId: string | null,
  /** 上传任务入队后回调（各面板用来刷新自己的目录树） */
  onUploaded?: () => void
): {
  /** 打开对话框；preferred 为候选落点，hint 是给用户看的额外说明 */
  request: (preferred?: string | null, hint?: string, kind?: 'file' | 'folder') => Promise<void>
  /** 直接透传给 <UploadTargetDialog> */
  dialogProps: UploadTargetDialogProps
} {
  const [open, setOpen] = useState(false)
  const [defaultDir, setDefaultDir] = useState('')
  const [hint, setHint] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [kind, setKind] = useState<'file' | 'folder'>('file')
  const uploadFileDialog = useSftpStore((s) => s.uploadFileDialog)
  const uploadFolder = useSftpStore((s) => s.uploadFolder)

  const request = useCallback(
    async (preferred?: string | null, hintText?: string, nextKind: 'file' | 'folder' = 'file'): Promise<void> => {
      if (!sessionId) return
      // 当前目录 → 上次用的目录 → 远端 home；都拿不到就留空让用户自己填，
      // 绝不静默退化成远端根目录（历史上就是这么把文件传到 / 下的）
      const dir = await resolveUploadDir(sessionId, preferred ?? undefined)
      setDefaultDir(dir)
      setHint(hintText)
      setKind(nextKind)
      setOpen(true)
    },
    [sessionId]
  )

  const cancel = useCallback(() => setOpen(false), [])

  const confirm = useCallback(
    (dir: string): void => {
      if (!sessionId) return
      const target = normalizeRemoteDir(dir)
      if (!target) return
      setBusy(true)
      const run = kind === 'folder' ? uploadFolder(sessionId, target) : uploadFileDialog(sessionId, target)
      void run
        .then((res) => {
          if (res) onUploaded?.()
        })
        .finally(() => {
          setBusy(false)
          setOpen(false)
        })
    },
    [sessionId, kind, uploadFileDialog, uploadFolder, onUploaded]
  )

  return {
    request,
    dialogProps: {
      open,
      sessionId: sessionId ?? '',
      defaultDir,
      hint,
      busy,
      kind,
      onCancel: cancel,
      onConfirm: confirm
    }
  }
}
