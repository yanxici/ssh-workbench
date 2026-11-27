import type * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { useSettingsStore } from '@/stores/settingsStore'
import { useI18n } from '@/i18n'
import { Row } from './sectionUi'

/** 设置 → 危险命令关键词（每行一个；命中即二次确认） */
export function DangerSection(): React.JSX.Element {
  const { t } = useI18n()
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)

  /*
   * 本地草稿 + 失焦提交：每敲一个字就写设置会产生大量落盘。
   * 但草稿必须是受控的 —— 原来用非受控 defaultValue，外部改了这个设置
   * （导入配置、重置）文本框还显示老内容；而且按 Esc 关掉设置面板时
   * 输入框直接卸载，onBlur 不一定来得及触发，改了半天的关键词就白改了。
   */
  const [draft, setDraft] = useState(settings.dangerPatterns.join('\n'))
  const focused = useRef(false)
  const draftRef = useRef(draft)
  draftRef.current = draft

  // 未聚焦时才跟随外部变化，否则用户正在输入会被覆盖
  useEffect(() => {
    if (!focused.current) setDraft(settings.dangerPatterns.join('\n'))
  }, [settings.dangerPatterns])

  const commit = (text: string): void => {
    const patterns = text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    if (patterns.join('\n') === settings.dangerPatterns.join('\n')) return
    void update({ dangerPatterns: patterns })
  }

  // 卸载（Esc 关闭设置面板）时兜底提交，避免编辑丢失
  const commitRef = useRef(commit)
  commitRef.current = commit
  useEffect(() => {
    return () => {
      if (focused.current) commitRef.current(draftRef.current)
    }
  }, [])

  return (
    <>
      <div className="text-2xs leading-relaxed text-ink-3">{t('settings.ext.danger.desc')}</div>
      <textarea
        className="input scroll-thin h-24 resize-none selectable py-2 font-mono text-xs leading-relaxed"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => {
          focused.current = true
        }}
        onBlur={(e) => {
          focused.current = false
          commit(e.target.value)
        }}
        spellCheck={false}
      />
      <Row
        label={t('settings.ext.danger.active')}
        hint={t('settings.ext.danger.countHint', { count: settings.dangerPatterns.length })}
      >
        <span className="text-2xs text-ink-3">{settings.dangerPatterns.length}</span>
      </Row>
    </>
  )
}
