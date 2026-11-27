import type * as React from 'react'
import type { TerminalRenderer, TokenPanel } from '@shared/types'
import { useSettingsStore } from '@/stores/settingsStore'
import { useI18n, type I18nKey } from '@/i18n'
import { Row, Segmented } from './sectionUi'
import { Toggle } from '@/components/ui'

/**
 * 实验性开关：设计 token 的面板级灰度。
 *
 * 为什么做成设置里的可见开关而不是隐藏配置：
 *   灰度要能「让人自己判断哪一面板新样式更好看」，藏起来就只能靠改 JSON。
 *   同时它也是回滚开关 —— 全部关掉即回到旧视觉，不需要重新发版。
 */
const PANELS: Array<{ id: TokenPanel; labelKey: I18nKey; hintKey: I18nKey }> = [
  { id: 'sftp', labelKey: 'settings.ext.exp.sftp', hintKey: 'settings.ext.exp.sftpHint' },
  {
    id: 'connections',
    labelKey: 'settings.ext.exp.connections',
    hintKey: 'settings.ext.exp.connectionsHint'
  },
  {
    id: 'commandPanel',
    labelKey: 'settings.ext.exp.commandPanel',
    hintKey: 'settings.ext.exp.commandPanelHint'
  },
  {
    id: 'terminal',
    labelKey: 'settings.ext.exp.terminal',
    hintKey: 'settings.ext.exp.terminalHint'
  },
  {
    id: 'statusBar',
    labelKey: 'settings.ext.exp.statusBar',
    hintKey: 'settings.ext.exp.statusBarHint'
  }
]

export function ExperimentalSection(): React.JSX.Element {
  const { t } = useI18n()
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const tokens = settings.experimental?.tokens ?? {}

  const setOne = (id: TokenPanel, on: boolean): void => {
    void update({ experimental: { tokens: { ...tokens, [id]: on } } })
  }
  const anyOn = PANELS.some((p) => tokens[p.id] === true)
  // 系统「减少动态效果」优先于应用开关（settingsStore.applyMotion 用同一判据）。
  // 把生效状态摆到界面上，避免开关看着是开、界面却完全静止时被当成坏了。
  const systemReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  return (
    <>
      {PANELS.map((p) => (
        <Row key={p.id} label={t(p.labelKey)} hint={t(p.hintKey)}>
          <Toggle checked={tokens[p.id] === true} onChange={(on) => setOne(p.id, on)} />
        </Row>
      ))}
      <Row
        label={t('settings.ext.exp.motion')}
        hint={`${t('settings.ext.exp.motionHint')}${systemReduced ? t('settings.ext.exp.motionSystemReduced') : ''}`}
      >
        <Toggle
          checked={settings.experimental?.motion !== false}
          onChange={(on) => void update({ experimental: { ...settings.experimental, motion: on } })}
        />
      </Row>
      <Row label={t('settings.ext.exp.renderer')} hint={t('settings.ext.exp.rendererHint')}>
        <Segmented<TerminalRenderer>
          value={settings.experimental?.terminalRenderer ?? 'dom'}
          options={[
            { value: 'dom' as const, label: 'DOM' },
            { value: 'auto' as const, label: t('settings.ext.exp.rendererAuto') },
            { value: 'webgl' as const, label: 'WebGL' }
          ]}
          onChange={(v) =>
            void update({ experimental: { ...settings.experimental, terminalRenderer: v } })
          }
        />
      </Row>
      <Row
        label={t('settings.ext.exp.softwareRender')}
        hint={t('settings.ext.exp.softwareRenderHint')}
      >
        <Toggle
          checked={settings.experimental?.softwareRender === true}
          onChange={(on) =>
            void update({ experimental: { ...settings.experimental, softwareRender: on } })
          }
        />
      </Row>
      {anyOn && (
        <Row
          label={t('settings.ext.exp.resetTokens')}
          hint={t('settings.ext.exp.resetTokensHint')}
        >
          <button
            type="button"
            className="btn"
            onClick={() => {
              const cleared: Partial<Record<TokenPanel, boolean>> = {}
              for (const p of PANELS) cleared[p.id] = false
              void update({ experimental: { tokens: cleared } })
            }}
          >
            {t('settings.ext.exp.disableAll')}
          </button>
        </Row>
      )}
    </>
  )
}