import { useSettingsStore } from '@/stores/settingsStore'
import { Toggle } from '@/components/ui'
import { Row } from './sectionUi'

/** 设置 → 行为（延迟探测 / 自动录像 / 重连 / 跟随终端 / 指纹校验 / 会话恢复） */
export function BehaviorSection(): JSX.Element {
  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsStore((s) => s.update)

  return (
    <>
      <Row label="延迟探测" hint="每 5 秒向设备发送一次轻量探测，用于状态栏延迟显示">
        <Toggle checked={settings.latencyProbe} onChange={(v) => void update({ latencyProbe: v })} />
      </Row>
      <Row
        label="自动记录会话日志"
        hint="连接后的终端输入输出自动录制为 cast 文件（单会话上限 50MB），可在侧栏「日志」中回放与导出"
      >
        <Toggle checked={settings.autoLog} onChange={(v) => void update({ autoLog: v })} />
      </Row>
      <Row
        label="断线自动重连"
        hint="网络抖动断开后在后台按 1/2/4/8/16 秒退避重试，标签上显示进度；用户主动关闭标签则不重连"
      >
        <Toggle
          checked={settings.autoReconnect !== false}
          onChange={(v) => void update({ autoReconnect: v })}
        />
      </Row>
      {settings.autoReconnect !== false && (
        <Row label="最多重试次数" hint="用尽后停止并提示，可手动重连（1~20 次）">
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
        label="跟随终端目录"
        hint="在终端里 cd 到某个目录时，侧栏「文件」面板自动跳到该位置；面板标题栏的链状图标也能一键开关"
      >
        <Toggle
          checked={settings.filesFollowTerminalCwd !== false}
          onChange={(v) => void update({ filesFollowTerminalCwd: v })}
        />
      </Row>
      <Row
        label="严格主机指纹校验"
        hint="首次连接记录指纹；指纹变化（如重装系统/换固件）时拒绝连接并告警"
      >
        <Toggle
          checked={settings.strictHostKey}
          onChange={(v) => void update({ strictHostKey: v })}
        />
      </Row>
      <Row label="会话恢复" hint="启动时自动恢复上次退出时打开的连接（最多 10 个）">
        <Toggle
          checked={settings.restoreSessions ?? false}
          onChange={(v) => void update({ restoreSessions: v })}
        />
      </Row>
      {/* 原来这里有个「常用命令面板位置：右侧栏 / 底部横条」的开关。
          新外壳把命令面板收进侧栏，位置由活动栏决定，那个开关点了没有
          任何效果 —— 一个点了没反应的开关比没有这个开关更糟，所以删掉。 */}
    </>
  )
}
