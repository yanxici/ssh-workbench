import { useMemo } from 'react'
import type * as React from 'react'
import { Command, Plus, Radar, TerminalSquare, Usb } from 'lucide-react'
import type { Connection } from '@shared/types'
import { connectionAddress } from '@shared/serialDisplay'
import { useConnectionStore } from '@/stores/connectionStore'
import { useDiscoveryStore } from '@/stores/discoveryStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useUiStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

/**
 * 空工作区的快速启动页。
 *
 * 设计取向（Spec 3.3 / P2 单色精密仪器外壳）：
 * - 容器是纯色 bg-app 画布，无发光、无阴影、无装饰动画；性能红线同 MainWorkspace。
 * - 居中 max-w-[640px]**：眼睛从上到下扫一次就能看完，不需要横向移动。
 * - 上部四个动作按钮解决「我来这儿是要干什么」；下部最近连接解决「我要回到哪」。
 *
 * 最近连接按 lastUsedAt 降序取前 8 条，SSH 与串口一视同仁。
 * 单击直接开会话 —— 侧栏那条路径要展开分组、找到行、再双击，
 * 对一个每天开十次的连接来说这三次交互全是税。
 */

/** 最近连接最多展示多少条：再多就要滚动，滚动就不算「一眼看完」了 */
const RECENT_LIMIT = 8

export function WelcomeQuickLaunch({
  onNewConnection
}: {
  onNewConnection: () => void
}): React.JSX.Element {
  const { t } = useI18n()
  const connections = useConnectionStore((s) => s.connections)
  const openSession = useSessionStore((s) => s.open)
  const openConnEditor = useUiStore((s) => s.openConnEditor)
  const openCommandCenter = useUiStore((s) => s.openCommandCenter)

  /*
   * 过滤 + 排序 + 截断只随连接表变化重算。
   *
   * 大库实测 2900+ 条：这一页每次重渲染都重排一遍是白烧 CPU，
   * 而它偏偏挂在空工作区上 —— 没有会话时后台同步、面板开合都在触发重渲染。
   * 依赖只有 connections，其余状态变化不该重排。
   */
  const recent = useMemo(
    () =>
      connections
        .filter((c) => (c.lastUsedAt ?? 0) > 0)
        .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))
        .slice(0, RECENT_LIMIT),
    [connections]
  )

  /**
   * 与侧栏一致的打开逻辑，外加一条串口专属处理：
   * pathPending 表示设备换过口（USB 序列号没对上），此时直接 open 只会在终端里
   * 报一句「找不到端口」——不如把连接编辑弹窗带出来，让用户当场重选。
   */
  const launch = (c: Connection): void => {
    if (c.kind === 'serial' && c.serial?.pathPending) {
      openConnEditor(c)
      return
    }
    openSession({
      id: c.id,
      name: c.name,
      host: c.host,
      username: c.username,
      kind: c.kind,
      serial: c.serial
    })
  }

  /**
   * 「设备发现」是浮层面板而不是左侧活动栏视图，已开着就不再翻转。
   *
   * 这里走 getState 读面板状态而不是订阅 panelOpen：本页只关心
   * 「点下去那一刻开没开」，订阅会让面板一开一合就整页重渲染，
   * 而这一页恰好在空工作区上，重渲染的代价全落在无谓的地方。
   */
  const openDiscovery = (): void => {
    const discovery = useDiscoveryStore.getState()
    if (!discovery.panelOpen) discovery.togglePanel()
  }

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto px-6 py-10">
      <div className="w-full max-w-[640px]">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-edge bg-raised text-ink-2">
            <TerminalSquare size={16} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold tracking-wide text-ink">
              SSH Workbench
            </div>
            <div className="truncate text-2xs text-ink-3">{t('welcome.subtitle')}</div>
          </div>
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-1.5">
          <button className="btn btn-primary h-7 px-3 text-2xs" onClick={onNewConnection}>
            <Plus size={12} />
            {t('welcome.newSsh')}
          </button>
          <button
            className="btn h-7 px-2.5 text-2xs"
            title={t('welcome.newSerial.hint')}
            onClick={() => openConnEditor(null, { kind: 'serial' })}
          >
            <Usb size={12} />
            {t('welcome.newSerial')}
          </button>
          <button className="btn h-7 px-2.5 text-2xs" onClick={openDiscovery}>
            <Radar size={12} />
            {t('welcome.discovery')}
          </button>
          <button className="btn h-7 px-2.5 text-2xs" onClick={() => openCommandCenter('')}>
            <Command size={12} />
            {t('welcome.commandCenter')}
          </button>
        </div>

        <div className="mt-7">
          <div className="flex items-baseline justify-between">
            <span className="text-2xs font-medium tracking-wide text-ink-3">
              {t('welcome.recent')}
            </span>
            <span className="text-3xs tabular-nums text-ink-3/60">{recent.length}</span>
          </div>

          {recent.length === 0 ? (
            <p className="mt-2 text-xs text-ink-3">{t('welcome.emptyRecent')}</p>
          ) : (
            <div className="mt-1.5 flex flex-col">
              {recent.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  title={connectionAddress(c)}
                  onClick={() => launch(c)}
                  className="group flex h-8 w-full items-center gap-2 rounded-md px-1.5 text-left transition-colors duration-150 hover:bg-hover"
                >
                  <span
                    className={cn(
                      'h-4 w-[3px] shrink-0 rounded-full',
                      !c.color && 'bg-transparent'
                    )}
                    style={c.color ? { background: c.color } : undefined}
                  />
                  <span className="max-w-[42%] shrink-0 truncate text-xs text-ink">{c.name}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-2xs tabular-nums text-ink-3">
                    {connectionAddress(c)}
                  </span>
                  <span className="shrink-0 rounded-sm border border-edge-soft px-1 text-3xs leading-4 text-ink-3">
                    {c.kind === 'serial' ? t('welcome.typeSerial') : 'SSH'}
                  </span>
                  <span className="w-8 shrink-0 text-right text-3xs text-ink-3 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
                    {t('welcome.connect')}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
