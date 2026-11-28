import type * as React from 'react'
import { useSettingsStore } from '@/stores/settingsStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { Toggle } from '@/components/ui'
import { Row } from './sectionUi'
import { normalizeNotifyPrefs } from '@/lib/notifyPlan'
import { useI18n } from '@/i18n'

/**
 * 设置 → 通知（v2.1.4）。
 *
 * 四个开关的排列顺序就是它们的作用层级：总开关 → 系统通知 → 声音，
 * 启发式单独放最后并明确标"不确定"，因为它是唯一一个可能误报的项。
 */
export function NotifySection(): React.JSX.Element {
  const { t } = useI18n()
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)
  const connections = useConnectionStore((s) => s.connections)
  const prefs = normalizeNotifyPrefs(settings.taskNotify)

  /** 写偏好时总是整体写：mutedConnectionIds 是数组，局部 patch 会被默认空数组清掉 */
  const patch = (next: Partial<typeof prefs>): void => {
    void update({ taskNotify: { ...prefs, ...next } })
  }

  /*
   * 把连接 id 还原成名字。
   *
   * 「已静音的连接」若直接显示 id，用户根本不知道自己静音了哪一台 ——
   * 而这里恰恰是用来让人发现自己静音过什么的地方（静音总是在某个烦躁的
   * 时刻点下的，事后就忘）。连接已被删除的 id 保留原样显示，因为用户的
   * 静音意图还在，删了连接不该顺手把静音记录抹掉（重名/重建连接时还要用）。
   */
  const mutedNames = (prefs.mutedConnectionIds ?? []).map((id) => ({
    id,
    name: connections.find((c) => c.id === id)?.name ?? id.slice(0, 8)
  }))

  return (
    <>
      <Row
        label={t('settings.ext.notify.enabled')}
        hint={t('settings.ext.notify.enabledHint')}
      >
        <Toggle checked={prefs.enabled} onChange={(v) => patch({ enabled: v })} />
      </Row>
      <Row
        label={t('settings.ext.notify.system')}
        hint={t('settings.ext.notify.systemHint')}
      >
        <Toggle
          checked={prefs.system}
          disabled={!prefs.enabled}
          onChange={(v) => patch({ system: v })}
        />
      </Row>
      <Row label={t('settings.ext.notify.sound')} hint={t('settings.ext.notify.soundHint')}>
        <Toggle
          checked={prefs.sound}
          disabled={!prefs.enabled || !prefs.system}
          onChange={(v) => patch({ sound: v })}
        />
      </Row>
      <Row
        label={t('settings.ext.notify.heuristic')}
        hint={t('settings.ext.notify.heuristicHint')}
      >
        <Toggle
          checked={prefs.heuristic}
          disabled={!prefs.enabled}
          onChange={(v) => patch({ heuristic: v })}
        />
      </Row>
      {mutedNames.length > 0 && (
        <Row
          label={t('settings.ext.notify.muted')}
          hint={t('settings.ext.notify.mutedHint')}
        >
          <div className="flex max-w-[260px] flex-wrap justify-end gap-1">
            {mutedNames.map(({ id, name }) => (
              <button
                key={id}
                type="button"
                className="flex h-6 max-w-full items-center gap-1 whitespace-nowrap rounded-md border border-edge bg-raised px-2 text-2xs text-ink-3 hover:text-danger"
                title={t('settings.ext.notify.unmuteTitle')}
                onClick={() =>
                  patch({
                    mutedConnectionIds: (prefs.mutedConnectionIds ?? []).filter((x) => x !== id)
                  })
                }
              >
                <span className="truncate">{name}</span>
              </button>
            ))}
          </div>
        </Row>
      )}
    </>
  )
}
