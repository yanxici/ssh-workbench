import { useState, type DragEvent, type MouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { Pencil, Pin } from 'lucide-react'
import type { Command } from '@shared/types'
import { cn } from '@/lib/utils'
import { accentClass, accentTone } from '@/lib/commandWall'
import { Highlight } from './Highlight'
import { CommandCardTip } from './CommandCardTip'

/**
 * 命令墙里的一张卡片。
 *
 * 与旧实现（内联在 CommandPanel 的 map 里）的区别：
 *   - 卡内不再显示命令行，也不常驻图标方块：名字占满整张卡宽，
 *     最多两行（line-clamp-2），固定 40px 高 —— 行是齐的，扫视时不会忽高忽低。
 *   - 辨识信息挪到左侧 2px 色条（需确认 / 收藏 / 有变量，见 accentTone），
 *     以及悬停浮层（全名 + 完整命令 + 使用次数）。
 *   - 搜索只命中命令文本时，临时在底部补一行 10px 命令片段并高亮命中字，
 *     否则「搜到了却看不出为什么」。
 */
export function CommandCard({
  command: c,
  pinned,
  active,
  hit,
  showCommandLine,
  dragging,
  dropTarget,
  onActivate,
  onEdit,
  onTogglePin,
  onContextMenu,
  onDragStart,
  onDragOver,
  onDragLeave,
  onDrop,
  onDragEnd
}: {
  command: Command
  pinned: boolean
  active: boolean
  hit?: { nameIndices: number[]; cmdIndices: number[] }
  /** 搜索命中命令文本时展开那一行说明 */
  showCommandLine: boolean
  dragging: boolean
  dropTarget: boolean
  onActivate: (e: MouseEvent) => void
  onEdit: () => void
  onTogglePin: () => void
  onContextMenu: (e: MouseEvent) => void
  onDragStart: (e: DragEvent<HTMLButtonElement>) => void
  onDragOver: (e: DragEvent<HTMLButtonElement>) => void
  onDragLeave: () => void
  onDrop: (e: DragEvent<HTMLButtonElement>) => void
  onDragEnd: () => void
}): JSX.Element {
  const tone = accentTone(c, pinned)
  const [anchor, setAnchor] = useState<{ x: number; y: number; w: number; h: number } | null>(null)

  return (
    <>
      <button
        type="button"
        draggable
        data-cmd-id={c.id}
        data-tone={tone}
        onClick={onActivate}
        onContextMenu={onContextMenu}
        onMouseEnter={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setAnchor({ x: r.left, y: r.top, w: r.width, h: r.height })
        }}
        onMouseLeave={() => setAnchor(null)}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
        className={cn(
          /*
           * 固定 40px 高：旧卡片是「图标行 + 命令行」上下两段，高 47~51px 且随名字长短跳动。
           * 两行 11px/1.3 的名字刚好 29px，加内边距 10 和边框 2 = 41，取整 40。
           */
          'group relative flex h-10 min-w-0 flex-col items-stretch justify-center overflow-hidden rounded-md border border-l-2 px-2 py-1 text-left transition-colors duration-150',
          accentClass(tone),
          active ? 'border-accent/50 border-l-accent bg-select' : 'border-edge bg-app hover:bg-hover',
          dropTarget && 'border-accent/60',
          dragging && 'opacity-40'
        )}
      >
        {/*
          名字容器必须 min-w-0 + w-full：button 的 UA 样式是 align-items:flex-start，
          交叉轴上子项宽度由内容决定，少了 width 基准 line-clamp 的 overflow 不参与收缩，
          长名字会把卡片撑出边界（旧实现踩过：129 张里 92 张中招）。
        */}
        <span className="line-clamp-2 w-full min-w-0 break-words text-2xs font-medium leading-[1.3] text-ink">
          <Highlight text={c.name} indices={hit?.nameIndices ?? []} />
        </span>

        {showCommandLine && (
          <span className="mt-0.5 w-full min-w-0 truncate font-mono text-3xs leading-none text-ink-3">
            <Highlight text={c.command} indices={hit?.cmdIndices ?? []} />
          </span>
        )}

        {/*
          悬停操作槽：收藏 / 编辑。
          平时完全不可见，不占名字宽度（旧实现用 pr-6 常驻预留 24px）。
          两个动作都 stopPropagation，否则点收藏会顺带执行命令。
        */}
        <span className="pointer-events-none absolute right-0.5 top-0.5 flex items-center gap-px opacity-0 transition-opacity duration-150 group-hover:pointer-events-auto group-hover:opacity-100">
          <span
            role="button"
            tabIndex={-1}
            className={cn(
              'flex h-[16px] w-[16px] items-center justify-center rounded bg-app/85 text-ink-3 hover:text-warning',
              pinned && 'text-warning'
            )}
            title={pinned ? '取消收藏' : '收藏置顶'}
            onClick={(e) => {
              e.stopPropagation()
              onTogglePin()
            }}
          >
            <Pin size={9} />
          </span>
          <span
            role="button"
            tabIndex={-1}
            className="flex h-[16px] w-[16px] items-center justify-center rounded bg-app/85 text-ink-3 hover:text-ink"
            title="编辑此命令"
            onClick={(e) => {
              e.stopPropagation()
              onEdit()
            }}
          >
            <Pencil size={9} />
          </span>
        </span>
      </button>

      {/*
        浮层挂到 body：<button> 里塞 <div> 是非法嵌套，且卡片 overflow-hidden 会裁掉它。
        portal 出来的节点不参与卡片的层叠与裁剪，滚动时随 hover 结束自然消失。
      */}
      {anchor &&
        createPortal(
          <CommandCardTip
            anchor={anchor}
            name={c.name}
            command={c.command}
            useCount={c.useCount}
            envs={c.envs}
          />,
          document.body
        )}
    </>
  )
}
