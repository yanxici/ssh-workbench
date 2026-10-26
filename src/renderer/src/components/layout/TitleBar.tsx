import { Minus, Search, Settings, Square, TerminalSquare, X } from 'lucide-react'
import { useLayoutStore } from '@/stores/layoutStore'
import { useUiStore } from '@/stores/uiStore'
import { cn } from '@/lib/utils'
import { TabBar } from './TabBar'
import { UpdateBadge } from './UpdateBadge'

/**
 * 顶部标题栏（44px，品牌绿底）。
 *
 * 结构：左 Logo ｜ 中 会话标签页 ｜ 右 搜索 / 设置 / 窗口控制
 *
 * 设计取舍：
 * - 整条是窗口拖拽区（`-webkit-app-region: drag`），但所有可点元素必须
 *   反向声明 `no-drag`，否则点击会被当成拖窗口而失效。
 * - 绿色的可读性问题：白字在 #27c93f 上对比度只有 ~2.1:1，用作正文完全不够。
 *   因此这里只用它做「面」（背景），上面的文字统一 `text-on-brand`（白），
 *   并且只放短标签与图标，不放长文本。正文信息一律在下方工作区呈现。
 * - 标签页本身是半透明白底（未激活）/ 纯白底（激活），激活标签与下方
 *   工作区的白色背景连成一片，形成 VS Code 那种「标签属于内容」的观感。
 */
export function TitleBar(): JSX.Element {
  const openCommandCenter = useUiStore((s) => s.openCommandCenter)
  const setSettingsOpen = useLayoutStore((s) => s.setSettingsOpen)

  return (
    <header className="titlebar drag-region">
      {/* 左：Logo + 产品名 */}
      <div className="no-drag flex shrink-0 items-center gap-2 pl-3 pr-3">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-on-brand/20">
          <TerminalSquare size={14} className="text-on-brand" />
        </span>
        <span className="text-sm font-semibold tracking-wide">SSH Workbench</span>
      </div>

      {/* 中：会话标签页（占据全部剩余宽度，过多时横向滚动） */}
      <div className="min-w-0 flex-1 self-stretch overflow-hidden">
        <TabBar />
      </div>

      {/* 右：搜索 / 设置 / 窗口控制 */}
      <div className="no-drag flex shrink-0 items-center gap-1 pl-1 pr-2">
        <button
          className="titlebar-btn"
          title="搜索（命令中心 Ctrl+K）"
          aria-label="搜索"
          onClick={() => openCommandCenter('')}
        >
          <Search size={14} />
        </button>
        <button
          className="titlebar-btn"
          title="设置 (Ctrl+,)"
          aria-label="设置"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={14} />
        </button>

        {/* 更新入口：有新版时在设置与窗口控制之间亮出「更新」 */}
        <UpdateBadge />

        <span className="mx-1 h-4 w-px bg-on-brand/25" />

        <button
          className="titlebar-btn"
          title="最小化"
          aria-label="最小化"
          onClick={() => void window.api.win.minimize()}
        >
          <Minus size={14} />
        </button>
        <button
          className="titlebar-btn"
          title="最大化 / 还原"
          aria-label="最大化或还原"
          onClick={() => void window.api.win.toggleMax()}
        >
          <Square size={10} />
        </button>
        <button
          className={cn('titlebar-btn hover:bg-danger hover:text-white')}
          title="关闭"
          aria-label="关闭"
          onClick={() => void window.api.win.close()}
        >
          <X size={14} />
        </button>
      </div>
    </header>
  )
}
