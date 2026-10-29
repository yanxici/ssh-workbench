import { useSettingsStore } from '@/stores/settingsStore'
import { Row } from './sectionUi'

/** 设置 → 危险命令关键词（每行一个；命中即二次确认） */
export function DangerSection(): JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)

  const commitDanger = (text: string): void => {
    const patterns = text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    void update({ dangerPatterns: patterns })
  }

  return (
    <>
      <div className="text-2xs leading-relaxed text-ink-3">
        每行一个关键词；任何命令文本命中这些关键词都会触发二次确认（与命令自身的危险标记相互独立）。
      </div>
      <textarea
        className="input scroll-thin h-24 resize-none selectable py-2 font-mono text-xs leading-relaxed"
        defaultValue={settings.dangerPatterns.join('\n')}
        // 用 onBlur 提交而不是受控 onChange：每敲一个字就写一次设置会产生大量落盘
        onBlur={(e) => commitDanger(e.target.value)}
        spellCheck={false}
      />
      <Row label="当前生效" hint={`${settings.dangerPatterns.length} 条关键词`}>
        <span className="text-2xs text-ink-3">{settings.dangerPatterns.length}</span>
      </Row>
    </>
  )
}
