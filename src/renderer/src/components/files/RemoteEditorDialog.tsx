import type * as React from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  FileText,
  Loader2,
  Replace,
  Save,
  Search,
  X
} from 'lucide-react'
import type { TextEncoding } from '@shared/types'
import { useI18n } from '@/i18n'
import { isImeComposing } from '@/lib/ime'
import { useOverlayEscape } from '@/lib/overlayKeys'
import {
  applyTabIndent,
  countLines,
  findMatches,
  getLineCol,
  replaceAllMatches,
  replaceMatch,
  stepMatchIndex
} from '@/lib/editorText'

/**
 * 远程小文件编辑器（<2MB）。
 * 保存由 sftpManager 完成：原文件先备份为 <name>.bak 再写入。
 */
export function RemoteEditorDialog({
  path,
  content,
  encoding = 'utf-8',
  onClose,
  onSave
}: {
  path: string
  content: string
  encoding?: TextEncoding
  onClose: () => void
  onSave: (content: string, close?: boolean) => Promise<boolean> | void
}): React.JSX.Element {
  const { t } = useI18n()
  const [text, setText] = useState(content)
  const [saving, setSaving] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  const [cursor, setCursor] = useState<{ line: number; col: number }>({ line: 1, col: 1 })

  const [findOpen, setFindOpen] = useState(false)
  const [replaceOpen, setReplaceOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [activeMatch, setActiveMatch] = useState(-1)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLDivElement>(null)
  const findInputRef = useRef<HTMLInputElement>(null)
  const savedTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const dirty = text !== content
  const totalLines = useMemo(() => countLines(text), [text])
  const matches = useMemo(
    () => (findOpen ? findMatches(text, query, caseSensitive) : []),
    [findOpen, text, query, caseSensitive]
  )

  useEffect(() => {
    return () => {
      if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    }
  }, [])

  const syncCursor = (el: HTMLTextAreaElement, nextText?: string): void => {
    setCursor(getLineCol(nextText ?? el.value, el.selectionStart))
  }

  const syncScroll = (): void => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }

  const requestClose = (): void => {
    if (saving) return
    if (dirty) {
      setConfirmClose(true)
      return
    }
    onClose()
  }

  const doSave = async (closeAfter: boolean): Promise<void> => {
    if (saving) return
    setSaving(true)
    setConfirmClose(false)
    try {
      const ok = await onSave(text, closeAfter)
      if (!closeAfter && ok !== false) {
        setJustSaved(true)
        if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
        savedTimerRef.current = setTimeout(() => setJustSaved(false), 2000)
      }
    } finally {
      setSaving(false)
    }
  }

  const focusMatch = (index: number, list = matches, stealFocus = false): void => {
    const el = textareaRef.current
    const target = list[index]
    if (!el || !target) return
    setActiveMatch(index)
    if (stealFocus) el.focus()
    el.setSelectionRange(target.start, target.end)
    syncCursor(el)
    // Approximate line scroll so matched line lands near center of viewport
    const { line } = getLineCol(el.value, target.start)
    const lineHeight = 19.5
    const desiredTop = Math.max(0, (line - 1) * lineHeight - el.clientHeight / 2)
    el.scrollTop = desiredTop
    syncScroll()
  }

  const jumpMatch = (direction: 'next' | 'prev', stealFocus = false): void => {
    if (matches.length === 0) return
    const el = textareaRef.current
    const pos =
      direction === 'next' ? (el?.selectionEnd ?? 0) : (el?.selectionStart ?? 0)
    const idx = stepMatchIndex(matches, pos, direction)
    if (idx !== -1) focusMatch(idx, matches, stealFocus)
  }

  const handleReplaceOne = (stealFocus = false): void => {
    if (matches.length === 0) return
    const el = textareaRef.current
    const idx =
      activeMatch >= 0 && activeMatch < matches.length
        ? activeMatch
        : stepMatchIndex(matches, el?.selectionStart ?? 0, 'next')
    if (idx < 0) return
    const { text: nextText, caret } = replaceMatch(text, matches[idx], replacement)
    setText(nextText)
    const nextMatches = findMatches(nextText, query, caseSensitive)
    requestAnimationFrame(() => {
      if (!el) return
      const nextIdx = stepMatchIndex(nextMatches, caret, 'next')
      if (nextIdx !== -1) {
        focusMatch(nextIdx, nextMatches, stealFocus)
      } else {
        setActiveMatch(-1)
        if (stealFocus) el.focus()
        el.setSelectionRange(caret, caret)
        syncCursor(el, nextText)
      }
    })
  }

  const handleReplaceAll = (): void => {
    if (!query) return
    const res = replaceAllMatches(text, query, replacement, caseSensitive)
    if (res.count === 0) return
    setText(res.text)
    setActiveMatch(-1)
    requestAnimationFrame(() => {
      if (textareaRef.current) syncCursor(textareaRef.current, res.text)
    })
  }

  const openFindBar = (withReplace: boolean): void => {
    setFindOpen(true)
    if (withReplace) setReplaceOpen(true)
    const el = textareaRef.current
    if (el && el.selectionEnd > el.selectionStart) {
      const sel = el.value.slice(el.selectionStart, el.selectionEnd)
      if (!sel.includes('\n') && sel.length <= 120) setQuery(sel)
    }
    requestAnimationFrame(() => {
      findInputRef.current?.focus()
      findInputRef.current?.select()
    })
  }

  const handleWindowKeyDownRef = useRef<(e: KeyboardEvent) => void>(() => {})
  handleWindowKeyDownRef.current = (e: KeyboardEvent): void => {
    if (e.isComposing || e.keyCode === 229) return
    const mod = e.ctrlKey || e.metaKey
    if (mod && !e.altKey && e.key.toLowerCase() === 's') {
      e.preventDefault()
      if (dirty) void doSave(false)
      return
    }
    if (mod && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      openFindBar(false)
      return
    }
    if (mod && !e.altKey && e.key.toLowerCase() === 'h') {
      e.preventDefault()
      openFindBar(true)
      return
    }
  }

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => handleWindowKeyDownRef.current(e)
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  /*
   * Esc 走统一弹层栈，不再自己监听 window。
   *
   * 自己监听时它和文件管理面板各挂一个 window 监听器：面板那个在 capture 阶段、
   * 又恰好是栈顶，按一次 Esc 会先把文件管理面板连同这里的编辑器一起卸载，
   * 未保存的修改一声不响全丢。现在编辑器压栈在最上，Esc 只交给它，
   * 由它按 确认框 → 搜索框 → 真正关闭 的顺序处理。
   *
   * 也不能让内层输入框先吃掉 Esc：搜索框/确认框的处理都放在这里，而输入框
   * 自己的 Esc 会 preventDefault 表示已消费，栈监听器就不再往下走。
   */
  useOverlayEscape(true, () => {
    if (confirmClose) {
      setConfirmClose(false)
      return
    }
    if (findOpen) {
      setFindOpen(false)
      textareaRef.current?.focus()
      return
    }
    requestClose()
  })

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (isImeComposing(e)) return
    if (e.key === 'Tab') {
      e.preventDefault()
      const el = e.currentTarget
      const res = applyTabIndent(el.value, el.selectionStart, el.selectionEnd, e.shiftKey)
      setText(res.text)
      setActiveMatch(-1)
      requestAnimationFrame(() => {
        el.setSelectionRange(res.start, res.end)
        syncCursor(el, res.text)
      })
    }
  }

  const handleFindInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (isImeComposing(e)) return
    if (e.key === 'Enter') {
      e.preventDefault()
      jumpMatch(e.shiftKey ? 'prev' : 'next', false)
    }
  }

  const handleReplaceInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (isImeComposing(e)) return
    if (e.key === 'Enter') {
      e.preventDefault()
      handleReplaceOne(false)
    }
  }

  const lineNumbers = useMemo(() => {
    const arr = new Array<string>(totalLines)
    for (let i = 0; i < totalLines; i++) arr[i] = String(i + 1)
    return arr.join('\n')
  }, [totalLines])

  const displayMatchIdx =
    matches.length === 0
      ? 0
      : activeMatch >= 0 && activeMatch < matches.length
        ? activeMatch + 1
        : 0

  return (
    <div
      className="modal-overlay items-start justify-center pt-[5vh]"
      style={{ zIndex: 44 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) requestClose()
      }}
    >
      <div className="modal max-w-4xl">
        <div className="modal-header">
          <div className="modal-title flex min-w-0 flex-1 items-center gap-2">
            <FileText size={13} className="shrink-0 text-accent" />
            <span className="truncate font-mono text-2xs">{path}</span>
            <span
              className="shrink-0 rounded border border-edge bg-app px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink-3"
              title={t('editor.encoding')}
            >
              {encoding}
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className={`btn-icon h-6 w-6 ${findOpen ? 'bg-hover text-ink' : ''}`}
              title={`${t('editor.find')} (Ctrl+F)`}
              onClick={() => (findOpen ? setFindOpen(false) : openFindBar(false))}
            >
              <Search size={13} />
            </button>
            <button
              type="button"
              className={`btn-icon h-6 w-6 ${findOpen && replaceOpen ? 'bg-hover text-ink' : ''}`}
              title={`${t('editor.replaceOne')} (Ctrl+H)`}
              onClick={() => openFindBar(true)}
            >
              <Replace size={13} />
            </button>
            <button
              type="button"
              className="btn-icon h-6 w-6"
              title={t('editor.close')}
              onClick={requestClose}
            >
              <X size={13} />
            </button>
          </div>
        </div>

        {findOpen && (
          <div className="flex shrink-0 flex-col gap-1.5 border-b border-edge bg-panel px-3 py-2 text-xs">
            <div className="flex items-center gap-1.5">
              <Search size={12} className="shrink-0 text-ink-3" />
              <input
                ref={findInputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value)
                  setActiveMatch(-1)
                }}
                onKeyDown={handleFindInputKeyDown}
                placeholder={t('editor.findPlaceholder')}
                className="input h-6 flex-1 font-mono text-2xs"
              />
              <button
                type="button"
                className={`btn h-6 px-1.5 font-mono text-[11px] ${caseSensitive ? 'btn-primary' : ''}`}
                title={t('editor.caseSensitive')}
                onClick={() => {
                  setCaseSensitive((v) => !v)
                  setActiveMatch(-1)
                }}
              >
                Aa
              </button>
              <span className="min-w-[54px] text-center font-mono text-2xs text-ink-3">
                {query
                  ? matches.length > 0
                    ? t('editor.matchOf', { current: displayMatchIdx || 1, total: matches.length })
                    : t('editor.noMatch')
                  : ''}
              </span>
              <button
                type="button"
                className="btn-icon h-6 w-6"
                disabled={matches.length === 0}
                title={t('editor.prevMatch')}
                onClick={() => jumpMatch('prev')}
              >
                <ChevronUp size={13} />
              </button>
              <button
                type="button"
                className="btn-icon h-6 w-6"
                disabled={matches.length === 0}
                title={t('editor.nextMatch')}
                onClick={() => jumpMatch('next')}
              >
                <ChevronDown size={13} />
              </button>
              <button
                type="button"
                className="btn-icon h-6 w-6"
                title={t('editor.closeFind')}
                onClick={() => {
                  setFindOpen(false)
                  textareaRef.current?.focus()
                }}
              >
                <X size={13} />
              </button>
            </div>
            {replaceOpen && (
              <div className="flex items-center gap-1.5">
                <Replace size={12} className="shrink-0 text-ink-3" />
                <input
                  value={replacement}
                  onChange={(e) => setReplacement(e.target.value)}
                  onKeyDown={handleReplaceInputKeyDown}
                  placeholder={t('editor.replacePlaceholder')}
                  className="input h-6 flex-1 font-mono text-2xs"
                />
                <button
                  type="button"
                  className="btn h-6 px-2 text-2xs"
                  disabled={matches.length === 0}
                  onClick={() => handleReplaceOne(false)}
                >
                  {t('editor.replaceOne')}
                </button>
                <button
                  type="button"
                  className="btn h-6 px-2 text-2xs"
                  disabled={matches.length === 0}
                  onClick={handleReplaceAll}
                >
                  {t('editor.replaceAll')}
                </button>
              </div>
            )}
          </div>
        )}

        {confirmClose && (
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-edge bg-warning/10 px-3 py-2 text-xs">
            <span className="flex items-center gap-1.5 text-ink">
              <AlertTriangle size={13} className="shrink-0 text-warning" />
              {t('editor.dirtyPrompt')}
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                className="btn h-6 px-2 text-2xs"
                onClick={() => setConfirmClose(false)}
              >
                {t('editor.keepEditing')}
              </button>
              <button
                type="button"
                className="btn h-6 px-2 text-2xs text-danger"
                onClick={onClose}
              >
                {t('editor.discardClose')}
              </button>
              <button
                type="button"
                className="btn btn-primary h-6 px-2 text-2xs"
                disabled={saving}
                onClick={() => void doSave(true)}
              >
                {t('editor.saveAndClose')}
              </button>
            </div>
          </div>
        )}

        {/* Do not use modal-body (flex: 1 / flex-basis: 0%) with h-[56vh] inside a max-h-only .modal;
            otherwise flex-basis: 0% overrides h-[56vh] and leaves the height indefinite for children. */}
        <div className="flex h-[56vh] min-h-0 overflow-hidden">
          <div
            ref={gutterRef}
            aria-hidden="true"
            className="shrink-0 select-none overflow-hidden border-r border-edge bg-panel px-2.5 pt-3 pb-7 text-right font-mono text-xs leading-[19.5px] text-ink-3"
          >
            <pre className="m-0 font-mono text-xs leading-[19.5px]">{lineNumbers}</pre>
          </div>
          <textarea
            ref={textareaRef}
            autoFocus
            wrap="off"
            className="scroll-thin min-w-0 flex-1 resize-none overflow-auto whitespace-pre selectable bg-app p-3 font-mono text-xs leading-[19.5px] text-ink outline-none"
            value={text}
            onChange={(e) => {
              setText(e.target.value)
              setJustSaved(false)
              setActiveMatch(-1)
              syncCursor(e.target, e.target.value)
            }}
            onScroll={syncScroll}
            onClick={(e) => syncCursor(e.currentTarget)}
            onKeyUp={(e) => syncCursor(e.currentTarget)}
            onKeyDown={handleTextareaKeyDown}
            spellCheck={false}
          />
        </div>

        <div className="modal-footer">
          <span className="mr-auto flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-0.5 text-2xs text-ink-3">
            <span className="font-mono">
              {t('editor.lineCol', { line: cursor.line, col: cursor.col })}
            </span>
            <span className="font-mono">{t('editor.linesTotal', { count: totalLines })}</span>
            <span>
              {t('files.ui.editor.bakPrefix')}
              <span className="font-mono">.bak</span>
            </span>
            {dirty && <span className="text-warning">{t('files.ui.editor.unsaved')}</span>}
            {!dirty && justSaved && <span className="text-success">{t('editor.saved')}</span>}
          </span>
          <button type="button" className="btn" disabled={saving} onClick={requestClose}>
            {t('editor.close')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={saving || !dirty}
            title="Ctrl+S"
            onClick={() => void doSave(false)}
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            {saving ? t('editor.saving') : t('editor.save')}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={saving}
            onClick={() => void doSave(true)}
          >
            <Save size={12} />
            {t('editor.saveAndClose')}
          </button>
        </div>
      </div>
    </div>
  )
}
