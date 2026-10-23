import { useCallback, useEffect, useRef, useState } from 'react'
import type { LayoutSizes } from '@shared/types'
import { useSettingsStore } from '@/stores/settingsStore'
import { cn } from '@/lib/utils'
import {
  PANE_LABEL,
  PANE_SPECS,
  applyDrag,
  clampPane,
  isDefaultPane,
  nudgePane,
  resolveLayout,
  type PaneKey
} from '@/lib/layout'

/* ------------------------------------------------------------------ *
 *  分隔条
 * ------------------------------------------------------------------ */

/**
 * 侧栏分隔条：拖拽改宽 / 双击复位 / 方向键微调 / 悬停高亮。
 *
 * 为什么不用现成的面板库：本项目布局是普通 flex，
 * 加一个 6px 的透明热区（用负 margin 抵消自身占位，净宽 0）就够了，
 * 引入 react-resizable-panels 反而要重排整棵布局树。
 *
 * 热区盖在侧栏右边框上（-mx-[3px]），所以视觉上只有 1px 的边线，
 * 鼠标却能抓到 6px —— 这是「看起来精致、用起来不别扭」的常见做法。
 */
export function PaneResizer({
  pane,
  value,
  onChange,
  onCommit
}: {
  pane: PaneKey
  /** 当前尺寸（px），拖拽起点 */
  value: number
  /** 拖拽过程中的实时尺寸（父组件用局部 state 承接，避免每帧落盘） */
  onChange: (next: number) => void
  /** 松手 / 双击 / 键盘调整后提交（父组件写入 settings） */
  onCommit: (next: number) => void
}): JSX.Element {
  const spec = PANE_SPECS[pane]
  const horizontal = spec.axis === 'x'
  // dragging 用 ref 判定、用 state 上色：
  //   pointerdown → pointermove 可能落在同一个任务里（快速拖拽、自动化测试），
  //   此时 state 还没重新渲染，闭包里读到的仍是 false，移动就会被丢掉。
  const [dragging, setDragging] = useState(false)
  const dragRef = useRef(false)
  const startRef = useRef({ pos: 0, size: 0 })
  const valueRef = useRef(value)
  valueRef.current = value
  /*
   * 拖拽过程中算出的最新宽度。
   *
   * 松手时必须用它而不是 `valueRef.current`：pointerup 常常和最后一次
   * pointermove 落在同一个任务里（快速拖拽、自动化派发事件都是这样），
   * 此时 React 还没重新渲染，`valueRef.current` 仍是拖拽前的旧值 ——
   * 拿它提交会把刚拖出来的宽度原样冲回去，表现为「拖动完全没反应」。
   */
  const liveRef = useRef<number | null>(null)

  const beginDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    dragRef.current = true
    startRef.current = { pos: horizontal ? e.clientX : e.clientY, size: valueRef.current }
    liveRef.current = valueRef.current
    setDragging(true)
    // 指针捕获让指针移出热区后仍能收到 move：拿不到就算了（不能因此中断拖拽）
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
  }

  const moveDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    const cur = horizontal ? e.clientX : e.clientY
    const next = applyDrag(pane, startRef.current.size, cur - startRef.current.pos)
    liveRef.current = next
    onChange(next)
  }

  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!dragRef.current) return
    dragRef.current = false
    setDragging(false)
    try {
      if (e.currentTarget.hasPointerCapture(e.pointerId))
        e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    onCommit(clampPane(pane, liveRef.current ?? valueRef.current))
    liveRef.current = null
  }

  // 拖拽中固定全局光标：指针移出热区后不跳回默认箭头
  useEffect(() => {
    if (!dragging) return
    const prev = document.body.style.cursor
    document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize'
    return () => {
      document.body.style.cursor = prev
    }
  }, [dragging, horizontal])

  const customized = !isDefaultPane(pane, value)

  return (
    <div
      role="separator"
      aria-orientation={horizontal ? 'vertical' : 'horizontal'}
      aria-label={`调整${PANE_LABEL[pane]}`}
      aria-valuenow={Math.round(value)}
      aria-valuemin={spec.min}
      aria-valuemax={spec.max}
      tabIndex={0}
      title={`拖动调整${PANE_LABEL[pane]}，双击恢复默认`}
      className={cn(
        'group/rz relative z-20 shrink-0 focus:outline-none',
        horizontal ? '-mx-[3px] w-[6px] cursor-col-resize' : '-my-[3px] h-[6px] cursor-row-resize'
      )}
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => {
        onChange(spec.default)
        onCommit(spec.default)
      }}
      onKeyDown={(e) => {
        const back = horizontal ? 'ArrowLeft' : 'ArrowUp'
        const fwd = horizontal ? 'ArrowRight' : 'ArrowDown'
        if (e.key !== back && e.key !== fwd) return
        e.preventDefault()
        const next = nudgePane(pane, valueRef.current, e.key === back ? -1 : 1)
        onChange(next)
        onCommit(next)
      }}
    >
      {/* 可见分隔线：常态边线色，悬停/拖拽/已自定义时点亮为强调色 */}
      <span
        className={cn(
          'pointer-events-none absolute bg-edge transition-colors duration-150',
          horizontal
            ? 'inset-y-0 left-1/2 w-px -translate-x-1/2'
            : 'inset-x-0 top-1/2 h-px -translate-y-1/2',
          (dragging || customized) && 'bg-accent/60',
          'group-hover/rz:bg-accent/70 group-focus/rz:bg-accent'
        )}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  尺寸状态
 * ------------------------------------------------------------------ */

/**
 * 三栏尺寸状态：局部实时值（拖拽跟手）+ 落盘（松手才写）。
 *
 * 为什么不每帧写 settings：settings 走主进程串行读改写，
 * 每帧一次会把拖动变成打字机手感，并且互相覆盖并发修改。
 */
export function usePaneSizes(): {
  sizes: Required<LayoutSizes>
  setLive: (pane: PaneKey, value: number) => void
  commit: (pane: PaneKey, value: number) => void
  reset: (pane: PaneKey) => void
} {
  const saved = useSettingsStore((s) => s.settings.layout)
  const [sizes, setSizes] = useState<Required<LayoutSizes>>(() => resolveLayout(saved))
  // 落盘时需要整份尺寸表：settings 的 layout 字段是浅合并，
  // 只写 { [pane]: next } 会把其它栏的尺寸一起冲掉。
  const sizesRef = useRef(sizes)
  sizesRef.current = sizes

  // 外部改了尺寸（配置文件、设置面板重置）时同步回来
  useEffect(() => {
    setSizes(resolveLayout(saved))
  }, [saved])

  const setLive = useCallback((pane: PaneKey, value: number) => {
    setSizes((s) => (s[pane] === value ? s : { ...s, [pane]: clampPane(pane, value) }))
  }, [])

  const persist = useCallback((next: Required<LayoutSizes>) => {
    setSizes(next)
    void useSettingsStore.getState().update({ layout: next })
  }, [])

  const commit = useCallback(
    (pane: PaneKey, value: number) => {
      persist({ ...sizesRef.current, [pane]: clampPane(pane, value) })
    },
    [persist]
  )

  const reset = useCallback(
    (pane: PaneKey) => {
      persist({ ...sizesRef.current, [pane]: PANE_SPECS[pane].default })
    },
    [persist]
  )

  return { sizes, setLive, commit, reset }
}
