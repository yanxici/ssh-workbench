import { useState } from 'react'
import { FileText, Save } from 'lucide-react'

/**
 * 远程小文件编辑器（<2MB）。
 * 保存由 sftpManager 完成：原文件先备份为 <name>.bak 再写入。
 */
export function RemoteEditorDialog({
  path,
  content,
  onClose,
  onSave
}: {
  path: string
  content: string
  onClose: () => void
  onSave: (content: string) => void
}): JSX.Element {
  const [text, setText] = useState(content)
  const dirty = text !== content

  return (
    <div
      className="modal-overlay items-start justify-center pt-[6vh]"
      style={{ zIndex: 44 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal max-w-3xl">
        <div className="modal-header">
          <div className="modal-title flex min-w-0 items-center gap-2">
            <FileText size={13} className="shrink-0 text-accent" />
            <span className="truncate font-mono text-2xs">{path}</span>
          </div>
        </div>
        <div className="modal-body p-0">
          <textarea
            autoFocus
            className="scroll-thin h-[54vh] w-full resize-none selectable bg-app p-3 font-mono text-xs leading-relaxed text-ink outline-none"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="modal-footer">
          <span className="mr-auto text-2xs text-ink-3">
            保存时原文件自动备份为 <span className="font-mono">.bak</span>
            {dirty && <span className="ml-2 text-warning">● 有未保存修改</span>}
          </span>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={() => onSave(text)}>
            <Save size={12} />
            保存到远端
          </button>
        </div>
      </div>
    </div>
  )
}
