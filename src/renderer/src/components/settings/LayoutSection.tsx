import type * as React from 'react'
import { RotateCcw } from 'lucide-react'
import type { LayoutSizes } from '@shared/types'
import { KEYS, PANE_LABEL, PANE_SPECS, clampPane } from '@/lib/layout'
import { useSettingsStore } from '@/stores/settingsStore'
import { useToastStore } from '@/stores/toastStore'

/** 设置 → 侧栏宽度（与拖动分隔条共用同一套 clamp 规则） */
export function LayoutSection(): React.JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)

  /** 当前栏宽（缺项按默认值补齐），设置面板里可精确定值 */
  const layoutSizes: Required<LayoutSizes> = {
    sidebar: clampPane('sidebar', settings.layout?.sidebar),
    commandRail: clampPane('commandRail', settings.layout?.commandRail)
  }

  const setPane = (key: (typeof KEYS)[number], value: number): void => {
    void update({ layout: { ...layoutSizes, [key]: clampPane(key, value) } })
  }

  return (
    <>
      <div className="space-y-1.5">
        {KEYS.map((key) => {
          const spec = PANE_SPECS[key]
          const value = layoutSizes[key]
          return (
            <div key={key} className="flex items-center gap-2">
              <span className="w-24 shrink-0 text-xs text-ink-2">{PANE_LABEL[key]}</span>
              <input
                className="input h-6 w-16 text-center font-mono text-2xs"
                type="number"
                min={spec.min}
                max={spec.max}
                step={2}
                value={value}
                onChange={(e) => setPane(key, Number(e.target.value) || spec.default)}
              />
              <span className="text-2xs text-ink-3">px</span>
              <span className="flex-1" />
              {/* 被拖窄到极限时给出提示，避免误以为卡住 */}
              <span className="shrink-0 text-2xs text-ink-3/70">
                {spec.min}–{spec.max}
              </span>
              <button
                className="btn-icon h-6 w-6 shrink-0"
                title={`${PANE_LABEL[key]}恢复默认 ${spec.default}px`}
                disabled={value === spec.default}
                onClick={() => setPane(key, spec.default)}
              >
                <RotateCcw size={11} />
              </button>
            </div>
          )
        })}
      </div>
      <button
        className="btn h-7 w-full justify-center text-2xs"
        onClick={() => {
          /*
           * 一次写全部键，不能循环调 setPane。
           * setPane 每次都拿 render 时那份 layoutSizes 展开，
           * 循环里第二次会把第一次写入的值又覆盖回去 ——
           * 结果是只有最后一栏（commandRail）被真的重置了。
           */
          const next: Required<LayoutSizes> = {
            sidebar: PANE_SPECS.sidebar.default,
            commandRail: PANE_SPECS.commandRail.default
          }
          void update({ layout: next }).then(() => {
            useToastStore.getState().push({ kind: 'success', title: '栏宽已全部恢复默认' })
          })
        }}
      >
        <RotateCcw size={11} />
        全部恢复默认
      </button>
    </>
  )
}
