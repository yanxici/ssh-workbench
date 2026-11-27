import type * as React from 'react'
import { Maximize2, Minimize2, Minus, Search, Settings, Square, X } from 'lucide-react'
import { useLayoutStore } from '@/stores/layoutStore'
import { useUiStore } from '@/stores/uiStore'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { BrandMark } from '@/components/ui'
import { TabBar } from './TabBar'
import { UpdateBadge } from './UpdateBadge'

/**
 * 顶部标题栏（36px，中性面板底）。
 *
 * 结构：左 Logo ｜ 中 会话标签页 ｜ 右 搜索 / 设置 / 窗口控制
 *
 * 设计取舍：
 * - 整条是窗口拖拽区（`-webkit-app-region: drag`），但所有可点元素必须
 *   反向声明 `no-drag`，否则点击会被当成拖窗口而失效。
 * - **品牌色从「面」降级为「点」**：旧版整条 44px 品牌绿底，白字在 #27c93f 上
 *   只有 2.2:1，正文根本没法读，于是所有字都得压成图标；而且标签夹在上下两道
 *   绿边之间，视觉上把标题栏切成三条色带。现在底色改用 bg-panel，绿色只保留在
 *   Logo 徽标与激活标签顶部那条 2px 指示线上 —— 一眼能看出「当前在哪」，
 *   同时整条外壳与工作区处于同一明度阶梯，不抢内容的注意力。
 * - 高度 36px 与 `--size-titlebar` 同口径（面板浮层用它做 top 偏移）。`.titlebar`
 *   自己带 `h-9`，这里不再写死高度 —— 两处都写死过一次，结果 44/38 长期不一致。
 */
export function TitleBar(): React.JSX.Element {
  const openCommandCenter = useUiStore((s) => s.openCommandCenter)
  const setSettingsOpen = useLayoutStore((s) => s.setSettingsOpen)
  const zenMode = useLayoutStore((s) => s.zenMode)
  const toggleZenMode = useLayoutStore((s) => s.toggleZenMode)
  const { t } = useI18n()

  return (
    <header className="titlebar drag-region">
      {/*
        * 左：Logo + 产品名
        */}
      <div className="no-drag flex shrink-0 items-center gap-2 pl-3 pr-2.5">
        <BrandMark size={18} className="shrink-0" />
        <span className="text-sm font-semibold tracking-[-0.02em] text-ink">Portix</span>
      </div>
      <span className="mr-1 h-3.5 w-px shrink-0 bg-edge" />

      {/*
        * 中：会话标签页（占据全部剩余宽度，过多时横向滚动）
        */}
      <div className="min-w-0 flex-1 self-stretch overflow-hidden">
        <TabBar />
      </div>

      {/*
        * 右：搜索 / 设置 / 窗口控制
        */}
      <div className="no-drag flex shrink-0 items-center gap-1 pl-1 pr-2">
        <button
          className="titlebar-btn"
          title={t('common.titlebar.searchTitle')}
          aria-label={t('common.titlebar.search')}
          onClick={() => openCommandCenter('')}
        >
          <Search size={14} />
        </button>
        <button
          className="titlebar-btn"
          title={t('common.titlebar.settingsTitle')}
          aria-label={t('common.titlebar.settings')}
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={14} />
        </button>
        {/*
         * 专注模式：窄图标按钮，和搜索/设置同一套 titlebar-btn 的尺寸与悬停色。
         * 开启态用 text-brand —— 全条只有品牌色与它的「点在亮」是唯一的彩色信号，
         * 这里借它表达「当前处于非常规视图」，退出后自动回到中性灰。
         */}
        <button
          className={cn(
            'titlebar-btn',
            zenMode && 'bg-accent/15 text-accent hover:bg-accent/20 hover:text-accent'
          )}
          title={zenMode ? t('titlebar.zen.on') : t('titlebar.zen.off')}
          aria-label={t('titlebar.zen.off')}
          aria-pressed={zenMode}
          onClick={() => toggleZenMode()}
        >
          {zenMode ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>

        {/*
          * 更新入口：有新版时在设置与窗口控制之间亮出「更新」
          */}
        <UpdateBadge />

        <span className="mx-1 h-4 w-px bg-edge" />

        <button
          className="titlebar-btn"
          title={t('common.titlebar.minimize')}
          aria-label={t('common.titlebar.minimize')}
          onClick={() => void window.api.win.minimize()}
        >
          <Minus size={14} />
        </button>
        <button
          className="titlebar-btn"
          title={t('common.titlebar.maximizeTitle')}
          aria-label={t('common.titlebar.maximize')}
          onClick={() => void window.api.win.toggleMax()}
        >
          <Square size={10} />
        </button>
        <button
          className={cn('titlebar-btn hover:bg-danger hover:text-white')}
          title={t('common.titlebar.close')}
          aria-label={t('common.titlebar.close')}
          onClick={() => void window.api.win.close()}
        >
          <X size={14} />
        </button>
      </div>
    </header>
  )
}
