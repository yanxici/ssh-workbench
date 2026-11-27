import type * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, Braces } from 'lucide-react'
import { Modal } from '@/components/ui'
import { useI18n } from '@/i18n'
import { isImeComposing } from '@/lib/ime'
import { useSettingsStore } from '@/stores/settingsStore'
import { analyzePaste, stripMarkdownFence, type PasteAnalysis } from '@/lib/pasteGuard'

/**
 * 多行粘贴确认框。
 *
 * 核心取舍：单行内容根本不进这个组件（analyzePaste 已过滤），所以这里
 * 不需要为「轻量」做妥协 —— 正文可直接编辑，因为用户真正想粘的常常是
 * 中间那一两行，而不是剪贴板里的全部内容。
 *
 * 键盘隔离（设计文档 Review Focus #2）：整个弹窗在 onKeyDown 上
 * stopPropagation，xterm 的自定义键处理器与全局快捷键都收不到这次按键；
 * Ctrl+Enter 会先判输入法组合态，避免中文/日文候选词确认时误发。
 */
export function PasteConfirmDialog({
  target,
  analysis,
  text,
  onCancel,
  onConfirm
}: {
  /** 目标会话标题，用来确认「粘到哪台机器」 */
  target: string
  /** 打开时的分析结果，只用于首屏决定要不要自动剥围栏（其余提示都实时重算） */
  analysis: PasteAnalysis
  /** 原始剪贴板内容 */
  text: string
  onCancel: () => void
  onConfirm: (finalText: string) => void
}): React.JSX.Element {
  const { t } = useI18n()
  /*
   * 带代码围栏时先自动剥一层：从文档里粘命令几乎总是带 ```，
   * 原样执行只会得到「command not found: ```」。按钮仍然保留，
   * 用来处理用户自己又粘了一层的情况。
   */
  const [draft, setDraft] = useState<string>(() =>
    analysis.hasCodeFence ? stripMarkdownFence(text) : text
  )
  const areaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(0, 0)
    el.scrollTop = 0
  }, [])

  /*
   * 实时重算：行数、末尾换行、危险词都跟着用户的手改。
   *
   * 危险词必须用设置里的那一份而不是组件 props 里那份：用户在这个框里
   * 把 'rm -rf /' 删成 'ls /' 之后还挂着「命中危险词」的红条，等于教人
   * 忽略警告条。用 getState() 现取（不是 hook 订阅）—— 弹窗活几秒钟，
   * 期间用户不会去改设置页，订阅只会平白多一次重渲染。
   */
  const dangerPatterns = useSettingsStore.getState().settings.dangerPatterns
  const live = analyzePaste(draft, dangerPatterns, false)
  const hasDanger = live.matchedDangers.length > 0

  const submit = (): void => {
    if (!draft) return
    onConfirm(draft)
  }

  return (
    <Modal
      open
      title={
        <span className="flex items-center gap-2">
          <Braces size={14} className="text-accent" />
          {t('terminal.paste.title')}
        </span>
      }
      onClose={onCancel}
      width="max-w-2xl"
      footer={
        <>
          <span className="mr-auto text-2xs text-ink-3">{t('terminal.paste.hintKey')}</span>
          <button className="btn" onClick={onCancel}>
            {t('terminal.paste.cancel')}
          </button>
          <button className="btn btn-primary" disabled={!draft} onClick={submit}>
            {t('terminal.paste.confirm')}
          </button>
        </>
      }
    >
      {
        /* stopPropagation：弹窗里的按键不进终端，也不触发全局快捷键 */
      }
      <div className="space-y-2.5" onKeyDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between text-2xs text-ink-3">
          <span>{t('terminal.paste.target', { target })}</span>
          <span className="font-mono">{t('terminal.paste.lines', { count: live.lineCount })}</span>
        </div>

        {hasDanger && (
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/5 px-2.5 py-1.5 text-2xs leading-relaxed text-warning">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" />
            <span>{t('terminal.paste.danger', { words: live.matchedDangers.join(', ') })}</span>
          </div>
        )}

        {live.hasTrailingNewline && (
          <div className="rounded-md border border-edge-soft bg-app/60 px-2.5 py-1.5 text-2xs leading-relaxed text-ink-2">
            {t('terminal.paste.trailing')}
          </div>
        )}

        <textarea
          ref={areaRef}
          value={draft}
          spellCheck={false}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (isImeComposing(e)) return
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault()
              submit()
            }
          }}
          className="selectable h-56 w-full resize-none rounded-md border border-edge bg-app/60 px-3 py-2 font-mono text-xs leading-relaxed text-ink outline-none"
        />

        <div className="flex items-center gap-1.5">
          <button
            className="btn h-6 px-2 text-2xs"
            onClick={() => setDraft((d) => stripMarkdownFence(d))}
          >
            {t('terminal.paste.stripFence')}
          </button>
          <button
            className="btn h-6 px-2 text-2xs"
            onClick={() => setDraft((d) => d.replace(/\r\n?/g, '\n').replace(/\n+$/, ''))}
          >
            {t('terminal.paste.trimNewline')}
          </button>
          {analysis.hasCodeFence && (
            <span className="ml-auto text-2xs text-ink-3">{t('terminal.paste.fenceStripped')}</span>
          )}
        </div>
      </div>
    </Modal>
  )
}
