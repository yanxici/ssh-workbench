import type * as React from 'react'

/**
 * 功能面板的加载骨架。
 *
 * 三条硬要求，缺一条骨架就比白屏更糟：
 *   1. **尺寸必须与真实面板一致** —— 用同一个 .panel-shell（top/bottom 由 token 决定），
 *      否则切换瞬间整块布局会跳。
 *   2. **头部高度与 .panel-head 一致（32px）** —— 骨架先画头再画体，
 *      内容到达时头不会“长出来”。
 *   3. **不做闪烁动画** —— 骨架是兜底路径（正常情况下预加载已经完成，根本不会出现），
 *      出现时用静态灰块即可；加 shimmer 反而在「一闪而过」时产生视觉噪声。
 *
 * 这也是「净」的要求：骨架的存在感应当尽可能低。
 */
export function PanelSkeleton({ title }: { title?: string }): React.JSX.Element {
  return (
    <div className="panel-shell fixed inset-x-0 z-30 flex flex-col bg-app" aria-busy="true">
      <div className="panel-head">
        <span className="panel-title">{title ?? '加载中…'}</span>
      </div>
      <div className="flex min-h-0 flex-1">
        {/* 左轨：与 rail-w 同宽，避免内容区左右跳 */}
        <div className="rail-w shrink-0 border-r border-edge bg-panel" />
        <div className="flex min-w-0 flex-1 flex-col gap-2 p-3">
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <div
              key={i}
              className="h-6 shrink-0 rounded bg-raised"
              style={{ opacity: 1 - i * 0.12 }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
