import type * as React from 'react'
import type { TerminalRenderer, TokenPanel } from '@shared/types'
import { useSettingsStore } from '@/stores/settingsStore'
import { Row, Segmented } from './sectionUi'
import { Toggle } from '@/components/ui'

/**
 * 实验性开关：设计 token 的面板级灰度。
 *
 * 为什么做成设置里的可见开关而不是隐藏配置：
 *   灰度要能「让人自己判断哪一面板新样式更好看」，藏起来就只能靠改 JSON。
 *   同时它也是回滚开关 —— 全部关掉即回到旧视觉，不需要重新发版。
 */
const PANELS: Array<{ id: TokenPanel; label: string; hint: string }> = [
  { id: 'sftp', label: '文件面板（SFTP / 本地双栏）', hint: '行高 28px → 24px，内距统一到 4px' },
  { id: 'connections', label: '连接列表', hint: '行高 36px → 24px，与文件行对齐' },
  { id: 'commandPanel', label: '命令面板', hint: '卡片与分组的间距、圆角收敛' },
  { id: 'terminal', label: '终端', hint: '终端容器边距与面板外壳对齐' },
  { id: 'statusBar', label: '状态栏', hint: '高度改用 --size-statusbar，与浮动层定位统一' }
]

export function ExperimentalSection(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const tokens = settings.experimental?.tokens ?? {}

  const setOne = (id: TokenPanel, on: boolean): void => {
    void update({ experimental: { tokens: { ...tokens, [id]: on } } })
  }
  const anyOn = PANELS.some((p) => tokens[p.id] === true)

  return (
    <>
      {PANELS.map((p) => (
        <Row key={p.id} label={p.label} hint={p.hint}>
          <Toggle checked={tokens[p.id] === true} onChange={(on) => setOne(p.id, on)} />
        </Row>
      ))}
      <Row
        label="终端渲染后端"
        hint="DOM 为默认（字形与旧版一致）。WebGL 更省 CPU；挂载前会自检字形是否按配置光栅化，不成立自动回落 DOM"
      >
        <Segmented<TerminalRenderer>
          value={settings.experimental?.terminalRenderer ?? 'dom'}
          options={[
            { value: 'dom' as const, label: 'DOM' },
            { value: 'auto' as const, label: '自动' },
            { value: 'webgl' as const, label: 'WebGL' }
          ]}
          onChange={(v) =>
            void update({ experimental: { ...settings.experimental, terminalRenderer: v } })
          }
        />
      </Row>
      <Row
        label="强制软件渲染（关闭 GPU 加速）"
        hint="终端将回落到 DOM 渲染。GPU 进程崩溃后本项会自动被打开，下次启动生效"
      >
        <Toggle
          checked={settings.experimental?.softwareRender === true}
          onChange={(on) =>
            void update({ experimental: { ...settings.experimental, softwareRender: on } })
          }
        />
      </Row>
      {anyOn && (
        <Row label="一键回到旧视觉" hint="关闭全部面板的 token 开关">
          <button
            type="button"
            className="btn"
            onClick={() => {
              const cleared: Partial<Record<TokenPanel, boolean>> = {}
              for (const p of PANELS) cleared[p.id] = false
              void update({ experimental: { tokens: cleared } })
            }}
          >
            全部关闭
          </button>
        </Row>
      )}
    </>
  )
}