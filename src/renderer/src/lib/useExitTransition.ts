import { useEffect, useState } from 'react'

/**
 * 为条件挂载的浮层保留退场动画时间。
 *
 * open 从 true 变 false 时，先保持挂载并打上 exiting 标记，等退场动画播完再卸载；
 * 若全局开启了 `.motion-off`（或系统偏好减少动态效果），立即卸载，不做空等。
 */
export function useExitTransition(
  open: boolean,
  durationMs = 120
): { mounted: boolean; exiting: boolean } {
  const [mounted, setMounted] = useState(open)
  const [exiting, setExiting] = useState(false)

  useEffect(() => {
    if (open) {
      setMounted(true)
      setExiting(false)
      return
    }
    if (!mounted) return
    if (
      typeof document !== 'undefined' &&
      document.documentElement.classList.contains('motion-off')
    ) {
      setMounted(false)
      setExiting(false)
      return
    }
    setExiting(true)
    const timer = window.setTimeout(() => {
      setMounted(false)
      setExiting(false)
    }, durationMs)
    return () => window.clearTimeout(timer)
  }, [open, mounted, durationMs])

  return { mounted, exiting }
}
