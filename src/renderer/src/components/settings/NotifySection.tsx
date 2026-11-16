import type * as React from 'react'
import { useSettingsStore } from '@/stores/settingsStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { Toggle } from '@/components/ui'
import { Row } from './sectionUi'
import { normalizeNotifyPrefs } from '@/lib/notifyPlan'

/**
 * 设置 → 通知（v2.1.4）。
 *
 * 四个开关的排列顺序就是它们的作用层级：总开关 → 系统通知 → 声音，
 * 启发式单独放最后并明确标"不确定"，因为它是唯一一个可能误报的项。
 */
export function NotifySection(): React.JSX.Element {
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
        label="任务完成通知"
        hint="批量执行、诊断巡检、固件升级、文件传输、设备扫描结束时提示；总开关关掉后不再有任何任务提示"
      >
        <Toggle checked={prefs.enabled} onChange={(v) => patch({ enabled: v })} />
      </Row>
      <Row
        label="窗口在后台时用系统通知"
        hint="失焦时弹 Windows 通知（收进操作中心，点了能跳回对应标签）；窗口在前台时只显示应用内提示"
      >
        <Toggle
          checked={prefs.system}
          disabled={!prefs.enabled}
          onChange={(v) => patch({ system: v })}
        />
      </Row>
      <Row label="提示音" hint="系统通知带声音；现场多人办公时建议关闭" >
        <Toggle
          checked={prefs.sound}
          disabled={!prefs.enabled || !prefs.system}
          onChange={(v) => patch({ sound: v })}
        />
      </Row>
      <Row
        label="疑似完成（启发式）"
        hint="终端静默 1.5 秒以上且窗口在后台时提示「疑似完成」。靠「没动静了」来猜，可能误报，所以默认关闭"
      >
        <Toggle
          checked={prefs.heuristic}
          disabled={!prefs.enabled}
          onChange={(v) => patch({ heuristic: v })}
        />
      </Row>
      {mutedNames.length > 0 && (
        <Row
          label="已静音的连接"
          hint="在这台设备的标签上右键「本连接不弹通知」可随时取消"
        >
          <div className="flex max-w-[260px] flex-wrap justify-end gap-1">
            {mutedNames.map(({ id, name }) => (
              <button
                key={id}
                type="button"
                className="flex h-6 items-center gap-1 rounded-md border border-edge bg-raised px-2 text-2xs text-ink-3 hover:text-danger"
                title="点击取消静音"
                onClick={() =>
                  patch({
                    mutedConnectionIds: (prefs.mutedConnectionIds ?? []).filter((x) => x !== id)
                  })
                }
              >
                {name}
              </button>
            ))}
          </div>
        </Row>
      )}
    </>
  )
}
