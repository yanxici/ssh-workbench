import { createElement } from 'react'
import * as Lucide from 'lucide-react'
import type { LucideProps } from 'lucide-react'

/**
 * 命令图标：编辑器里从白名单中挑选，渲染时按名字动态解析。
 * 白名单刻意保持精简，避免全量图标进入产物体积与选择列表过长。
 */
export const COMMAND_ICONS = [
  'Terminal',
  'SquareTerminal',
  'Info',
  'Cpu',
  'MemoryStick',
  'HardDrive',
  'Network',
  'Wifi',
  'Globe',
  'Router',
  'Plug',
  'Cable',
  'Activity',
  'Gauge',
  'ListTree',
  'FileText',
  'Search',
  'Bug',
  'Thermometer',
  'Microchip',
  'Zap',
  'Rocket',
  'RefreshCw',
  'Power',
  'Trash2',
  'ServerCog',
  'Layers',
  'Clock',
  'Timer',
  'Shield',
  'Wrench',
  'Settings2',
  'Play',
  'Bookmark'
] as const

export type CommandIconName = (typeof COMMAND_ICONS)[number]

/** lucide 图标名 -> 组件 */
const REGISTRY = Lucide as unknown as Record<string, React.ComponentType<LucideProps> | undefined>

export function DynamicIcon({
  name,
  size = 14,
  className,
  strokeWidth
}: {
  name?: string
  size?: number
  className?: string
  strokeWidth?: number
}): JSX.Element {
  const Cmp = (name ? REGISTRY[name] : undefined) ?? Lucide.Terminal
  return createElement(Cmp, { size, className, strokeWidth: strokeWidth ?? 1.8 })
}

/** 常用色标（连接色条 / 命令色点） */
export const COLORS = [
  '#58A6FF',
  '#3FB950',
  '#D29922',
  '#F85149',
  '#BC8CFF',
  '#39C5CF',
  '#FF7B72',
  '#A5D6FF'
] as const
