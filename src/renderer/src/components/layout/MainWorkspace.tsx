import { type DragEvent } from 'react'
import { Plus, SquareTerminal } from 'lucide-react'
import type { SessionUi } from '@/stores/sessionStore'
import { cn } from '@/lib/utils'
import { TerminalView } from '@/components/terminal/TerminalView'
import { ZmodemOverlay } from '@/components/terminal/ZmodemOverlay'
import { EmptyState } from '@/components/ui'

/**
 * 主工作区：终端 / 编辑器的容器。
 *
 * 性能红线（必须守住，改代码时别踩）：
 * - 容器及其所有父级**不许** `backdrop-filter`。xterm.js 每帧都在 canvas 上重绘，
 *   上层一旦有毛玻璃，合成器要额外做一次离屏采样，输出流快的时候直接掉帧；
 *   在 Windows 上还会出现「关掉浮层后整窗发虚」的残留。
 * - 容器**不许**有会持续变化的 CSS 动画背景。纯色 `bg-app` 是最省的做法。
 * - 所有会话保持挂载、只切 `display` —— 这样切标签不会重建 xterm 实例，
 *   回滚缓冲、滚动位置、正在跑的进程全都保留。
 */
export function MainWorkspace({
  sessions,
  activeId,
  dragOver,
  onDragOver,
  onDragLeave,
  onDrop,
  onNewConnection
}: {
  sessions: SessionUi[]
  activeId: string | null
  dragOver: boolean
  onDragOver: (e: DragEvent<HTMLDivElement>) => void
  onDragLeave: (e: DragEvent<HTMLDivElement>) => void
  onDrop: (e: DragEvent<HTMLDivElement>) => void
  onNewConnection: () => void
}): JSX.Element {
  return (
    <main
      className={cn(
        'relative min-w-0 flex-1 overflow-hidden bg-app',
        // 拖拽命令到终端时的落点提示：用 inset ring 而不是改变布局
        dragOver && 'ring-2 ring-inset ring-accent/50'
      )}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {sessions.length === 0 ? (
        /*
         * 空态文案给「下一步动作」而不是「当前状态」：
         * 用户盯着的是一块空白的黑区，他最想知道的是「怎么让它有东西」，
         * 所以第一行是动作（双击连接），第二行才是补充（拖命令）。
         */
        <EmptyState
          icon={<SquareTerminal size={34} />}
          title="双击左侧的连接开始会话"
          hint="连上之后，侧栏「常用命令」里的按钮可以直接拖进终端执行；按 Ctrl+K 可全局搜命令"
          action={
            <button className="btn btn-primary h-7 px-3 text-2xs" onClick={onNewConnection}>
              <Plus size={12} />
              新建连接
            </button>
          }
        />
      ) : (
        sessions.map((s) => (
          <div
            key={s.id}
            className="absolute inset-0"
            style={{ display: s.id === activeId ? 'block' : 'none' }}
          >
            <TerminalView session={s} active={s.id === activeId} />
          </div>
        ))
      )}

      {/* ZMODEM 传输确认与进度（跟随当前活动会话） */}
      <ZmodemOverlay />
    </main>
  )
}
