import type { Command } from '@shared/types'
import { CommandPanel } from '@/components/commands/CommandPanel'
import { useLayoutStore } from '@/stores/layoutStore'

/**
 * 右侧常驻命令栏。
 *
 * 它本身几乎只是一个壳：宽度、分隔条、开合都由 App 管，这里只负责
 * 「有内容时怎么渲染 CommandPanel」。
 *
 * ---- 为什么命令栏必须常驻右侧，而不是放进左侧活动栏切换 ----
 * 执行命令时最常做的前置动作是「确认自己点的是哪台机器」。如果命令面板
 * 和连接列表抢同一个位置，这个确认就要多切一次视图；切完再切回来，
 * 连接列表的滚动位置还在（keep-alive 保住了），但注意力已经断了。
 * 两块内容本来就是并行的：左边看「连到哪」，右边看「执行什么」。
 *
 * 宽度下限 340（见 lib/layout.ts 的 PANE_SPECS）：命令墙固定一行三个按钮，
 * 低于这个宽度每个名字都会被压成省略号，反而更难扫。
 */
export function CommandRail({
  width,
  onEdit
}: {
  width: number
  onEdit: (initial: Command | null, presetGroup?: string) => void
}): JSX.Element | null {
  const visible = useLayoutStore((s) => s.commandRailVisible)
  const toggleCommandRail = useLayoutStore((s) => s.toggleCommandRail)

  if (!visible) return null

  return (
    <section
      aria-label="常用命令栏"
      style={{ width }}
      className="flex min-w-0 shrink-0 flex-col overflow-hidden border-l border-edge bg-panel"
    >
      {/*
        复用 CommandPanel 本体，只把「折叠」按钮接到命令栏的开合上 ——
        两个入口（面板头部的 ×、活动栏底部的 Play）改的是同一个状态，
        不存在「隐藏了却没法再打开」的死角。
      */}
      <CommandPanel onEdit={onEdit} onCollapse={toggleCommandRail} />
    </section>
  )
}
