import { useSettingsStore } from '@/stores/settingsStore'
import { Toggle } from '@/components/ui'
import { Row, Segmented } from './sectionUi'

/** 设置 → 终端（字号 / 行高 / 光标 / 回滚缓冲） */
export function TerminalSection(): JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)

  const setTerminal = (patch: Partial<typeof settings.terminal>): void => {
    void update({ terminal: { ...settings.terminal, ...patch } })
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-2.5">
        <Row label="字号">
          <input
            className="input w-16 text-center"
            type="number"
            min={8}
            max={28}
            step={0.5}
            value={settings.terminal.fontSize}
            onChange={(e) => setTerminal({ fontSize: Number(e.target.value) || 13 })}
          />
        </Row>
        <Row label="行高">
          <input
            className="input w-16 text-center"
            type="number"
            min={1}
            max={2.2}
            step={0.05}
            value={settings.terminal.lineHeight}
            onChange={(e) => setTerminal({ lineHeight: Number(e.target.value) || 1.35 })}
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
        <input
          className="input w-20 text-center"
          type="number"
          min={500}
          max={50000}
          step={500}
          value={settings.terminal.scrollback}
          onChange={(e) => setTerminal({ scrollback: Number(e.target.value) || 5000 })}
        />
      </Row>
    </>
  )
}
