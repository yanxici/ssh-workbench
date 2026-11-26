import { useEffect, useRef, useState } from 'react'
import type * as React from 'react'
import { useSettingsStore } from '@/stores/settingsStore'
import { useI18n } from '@/i18n'
import { Toggle } from '@/components/ui'
import { isImeComposing } from '@/lib/ime'
import { Row, Segmented } from './sectionUi'

/**
 * 数字输入用的「草稿态」控件。
 *
 * 受控 input 直接在 onChange 里 clamp 是**不可输入**的：全选后敲 2，
 * clamp("2", 8, 28, 13) 立刻写回 8；再敲 0 变成 "80" 立刻跳 28。
 * 行高输 "1." 时 type=number 发出空串，clamp("", ...) 又弹回 1.35。
 * 回滚输 2000 时敲第一个 2 就被抬到 500。
 *
 * 正确做法是本地存字符串草稿：输入期间随便写，失焦或回车才 clamp 提交；
 * 外部设置被别处改动时（useEffect 同步）刷新草稿，避免显示过期值。
 */
function NumericField({
  value,
  min,
  max,
  step,
  fallback,
  className,
  onCommit
}: {
  value: number
  min: number
  max: number
  step: number
  fallback: number
  className: string
  onCommit: (next: number) => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(String(value))
  const focused = useRef(false)
  // 外部变更同步到草稿，但用户正在输入时不能抢
  useEffect(() => {
    if (!focused.current) setDraft(String(value))
  }, [value])

  const commit = (): void => {
    const n = Number(draft)
    const next = !Number.isFinite(n) || n <= 0 ? fallback : Math.min(max, Math.max(min, n))
    setDraft(String(next))
    if (next !== value) onCommit(next)
  }

  return (
    <input
      className={className}
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onFocus={() => {
        focused.current = true
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false
        commit()
      }}
      onKeyDown={(e) => {
        // 中文输入法里选词的回车也会冒到 keydown：不挡就会在组字中途提交并把焦点抢走
        if (isImeComposing(e)) return
        if (e.key === 'Enter') e.currentTarget.blur()
      }}
    />
  )
}

/** 设置 → 终端（字号 / 行高 / 光标 / 回滚缓冲） */
export function TerminalSection(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const { t } = useI18n()

  const setTerminal = (patch: Partial<typeof settings.terminal>): void => {
    void update({ terminal: { ...settings.terminal, ...patch } })
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2.5">
        <Row label="字号">
          <NumericField
            className="input w-16 text-center"
            min={8}
            max={28}
            step={0.5}
            fallback={13}
            value={settings.terminal.fontSize}
            onCommit={(next) => setTerminal({ fontSize: next })}
          />
        </Row>
        <Row label="行高">
          <NumericField
            className="input w-16 text-center"
            min={1}
            max={2.2}
            step={0.05}
            fallback={1.35}
            value={settings.terminal.lineHeight}
            onCommit={(next) => setTerminal({ lineHeight: next })}
          />
        </Row>
      </div>
      <Row label="光标样式">
        <Segmented
          value={settings.terminal.cursorStyle}
          options={[
            { value: 'block' as const, label: '方块' },
            { value: 'underline' as const, label: '下划线' },
            { value: 'bar' as const, label: '竖线' }
          ]}
          onChange={(v) => setTerminal({ cursorStyle: v })}
        />
      </Row>
      <Row label="光标闪烁">
        <Toggle
          checked={settings.terminal.cursorBlink}
          onChange={(v) => setTerminal({ cursorBlink: v })}
        />
      </Row>
      <Row label="回滚缓冲行数" hint="终端可向上滚动的历史行数">
        <NumericField
          className="input w-20 text-center"
          min={500}
          max={50000}
          step={500}
          fallback={5000}
          value={settings.terminal.scrollback}
          onCommit={(next) => setTerminal({ scrollback: next })}
        />
      </Row>
      <Row label={t('terminal.copyOnSelect')} hint={t('terminal.copyOnSelect.hint')}>
        <Toggle
          checked={settings.terminal.copyOnSelect === true}
          onChange={(v) => setTerminal({ copyOnSelect: v })}
        />
      </Row>
      <Row label={t('terminal.rightClickPaste')} hint={t('terminal.rightClickPaste.hint')}>
        <Toggle
          checked={settings.terminal.rightClickPaste === true}
          onChange={(v) => setTerminal({ rightClickPaste: v })}
        />
      </Row>
      <Row label={t('terminal.dropUploadMode')} hint={t('terminal.dropUploadMode.hint')}>
        <Segmented
          value={settings.terminal.dropUploadMode === 'trzsz' ? 'trzsz' : 'sftp'}
          options={[
            { value: 'sftp' as const, label: t('terminal.dropUploadMode.sftp') },
            { value: 'trzsz' as const, label: t('terminal.dropUploadMode.trzsz') }
          ]}
          onChange={(v) => setTerminal({ dropUploadMode: v })}
        />
      </Row>
      <Row
        label={t('terminal.confirmMultilinePaste')}
        hint={t('terminal.confirmMultilinePaste.hint')}
      >
        <Toggle
          checked={settings.terminal.confirmMultilinePaste !== false}
          onChange={(v) => setTerminal({ confirmMultilinePaste: v })}
        />
      </Row>
    </>
  )
}
