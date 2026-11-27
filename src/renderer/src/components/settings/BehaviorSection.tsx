import type * as React from 'react'
import { useSettingsStore } from '@/stores/settingsStore'
import { Toggle } from '@/components/ui'
import { useI18n } from '@/i18n'
import { Row } from './sectionUi'

/** 设置 → 行为（延迟探测 / 自动录像 / 重连 / 跟随终端 / 指纹校验 / 会话恢复） */
export function BehaviorSection(): React.JSX.Element {
  const { t } = useI18n()
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)

  return (
    <>
      <Row
        label={t('settings.ext.behavior.latencyProbe')}
        hint={t('settings.ext.behavior.latencyProbeHint')}
      >
        <Toggle checked={settings.latencyProbe} onChange={(v) => void update({ latencyProbe: v })} />
      </Row>
      <Row
        label={t('settings.ext.behavior.autoLog')}
        hint={t('settings.ext.behavior.autoLogHint')}
      >
        <Toggle checked={settings.autoLog} onChange={(v) => void update({ autoLog: v })} />
      </Row>
      {settings.autoLog && (
        <Row
          label={t('settings.ext.behavior.logPlainText')}
          hint={t('settings.ext.behavior.logPlainTextHint')}
        >
          <Toggle
            checked={settings.logPlainText !== false}
            onChange={(v) => void update({ logPlainText: v })}
          />
        </Row>
      )}
      {settings.autoLog && settings.logPlainText !== false && (
        <Row
          label={t('settings.ext.behavior.logTimestamp')}
          hint={t('settings.ext.behavior.logTimestampHint')}
        >
          <Toggle
            checked={settings.logTimestamp !== false}
            onChange={(v) => void update({ logTimestamp: v })}
          />
        </Row>
      )}
      <Row
        label={t('settings.ext.behavior.autoReconnect')}
        hint={t('settings.ext.behavior.autoReconnectHint')}
      >
        <Toggle
          checked={settings.autoReconnect !== false}
          onChange={(v) => void update({ autoReconnect: v })}
        />
      </Row>
      {settings.autoReconnect !== false && (
        <Row
          label={t('settings.ext.behavior.autoReconnectMax')}
          hint={t('settings.ext.behavior.autoReconnectMaxHint')}
        >
          <input
            type="number"
            min={1}
            max={20}
            className="input h-7 w-16 px-2 text-xs"
            value={settings.autoReconnectMax ?? 5}
            onChange={(e) => {
              const n = Math.max(1, Math.min(20, Number(e.target.value) || 5))
              void update({ autoReconnectMax: n })
            }}
          />
        </Row>
      )}
      <Row
        label={t('settings.ext.behavior.followCwd')}
        hint={t('settings.ext.behavior.followCwdHint')}
      >
        <Toggle
          checked={settings.filesFollowTerminalCwd !== false}
          onChange={(v) => void update({ filesFollowTerminalCwd: v })}
        />
      </Row>
      <Row
        label={t('settings.ext.behavior.strictHostKey')}
        hint={t('settings.ext.behavior.strictHostKeyHint')}
      >
        <Toggle
          checked={settings.strictHostKey}
          onChange={(v) => void update({ strictHostKey: v })}
        />
      </Row>
      <Row
        label={t('settings.ext.behavior.restoreSessions')}
        hint={t('settings.ext.behavior.restoreSessionsHint')}
      >
        <Toggle
          checked={settings.restoreSessions ?? false}
          onChange={(v) => void update({ restoreSessions: v })}
        />
      </Row>
      {/*
        * 原来这里有个「常用命令面板位置：右侧栏 / 底部横条」的开关。
        * 新外壳把命令面板收进侧栏，位置由活动栏决定，那个开关点了没有
        * 任何效果 —— 一个点了没反应的开关比没有这个开关更糟，所以删掉。
        */}
    </>
  )
}
