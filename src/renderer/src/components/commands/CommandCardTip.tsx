import { useEffect, useRef, useState } from 'react'

/**
 * 命令卡片的悬停浮层。
 *
 * 为什么不用原生 title：
 *   1. 原生提示有 ~1 秒延迟，而这里是「逐个悬停辨认」的高频动作；
 *   2. 原生提示不能排版 —— 命令是全角混排的长串，需要等宽字体 + 自动换行；
 *   3. 原生提示不能高亮搜索命中的字符段。
 *
 * 定位策略同 ContextMenu：先按锚点右下角渲染，量到真实尺寸后向内翻转，
 * 避免贴边时被窗口裁掉。不改变任何全局状态，鼠标移开即卸载。
 */
export function CommandCardTip({
  anchor,
  name,
  command,
  useCount
}: {
  /** 卡片在屏幕坐标系里的矩形；null = 不显示 */
  anchor: { x: number; y: number; w: number; h: number } | null
  name: string
  command: string
  useCount: number
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (!anchor) {
      setPos(null)
      return
    }
    const el = ref.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const pad = 8
    const gap = 6
    // 默认贴在卡片下方；下方放不下就翻到上方
    let x = anchor.x
    let y = anchor.y + anchor.h + gap
    if (y + rect.height > window.innerHeight - pad) {
      const above = anchor.y - rect.height - gap
      y = above >= pad ? above : Math.max(pad, window.innerHeight - rect.height - pad)
    }
    if (x + rect.width > window.innerWidth - pad) x = Math.max(pad, window.innerWidth - rect.width - pad)
    setPos({ x, y })
  }, [anchor])

  if (!anchor) return null

  return (
    <div
      ref={ref}
      role="tooltip"
      className="pointer-events-none fixed z-[80] max-w-[460px] rounded-md border border-edge bg-app px-2.5 py-1.5 shadow-pop"
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999 }}
    >
      {/*
        名称单独一个块 + 命令单独一个块。
        命令用 break-all：命令里没有空格的长串（URL、sqlite3 语句、-mS 参数）必须能断，
        否则 460px 的 max-w 也压不住，会横向溢出。
      */}
      <div className="text-xs font-medium leading-snug text-ink">{name}</div>
      <div className="mt-1 selectable whitespace-pre-wrap break-all font-mono text-3xs leading-relaxed text-ink-2">
        {command}
      </div>
      <div className="mt-1 text-3xs text-ink-3">
        {useCount > 0 ? `用过 ${useCount} 次` : '还没用过'}
        <span className="mx-1 text-ink-3/50">·</span>
        单击执行 · Ctrl+单击编辑
      </div>
    </div>
  )
}
