import { useEffect, useRef } from 'react'

/**
 * 弹层栈。
 *
 * 集中处理三件"每个弹窗各挂一个 window keydown"必然出错的事：
 *
 * 1) Esc 级联：内外两层弹窗各自监听 window keydown，按一次 Esc 会把两层一起关掉。
 *    → 只有栈顶那一层响应。
 * 2) 非 LIFO 卸载：用标量计数（myDepth === depth）时，中间某层先卸载会把计数减乱，
 *    剩下的层闭包里记的编号永远对不上，Esc 从此失效；编号重复时还会一次关两层。
 *    → 用有序栈数组 + 按 id 精确 splice，任意顺序卸载都自洽。
 * 3) 全局快捷键抢键：App 在 window 的 **capture** 阶段跑快捷键分发，
 *    比任何组件内的监听都早，于是设置面板里「录制快捷键」录不到组合键
 *    （录 Ctrl+K 直接打开了命令中心）。
 *    → 有任何弹层打开时，App 的全局分发直接让路。
 *
 * 监听器用 **bubble** 阶段挂（不是 capture）：这样内层聚焦控件（录制快捷键、
 * 下拉框、输入框）可以先消费 Escape 并 preventDefault()，消费过的就不再关弹层；
 * capture 阶段挂会抢在内层控件之前，把所有内层 Esc 一律变成"关掉整个弹层"。
 */

interface Entry {
  id: symbol
  onEscape: () => void
}

const stack: Entry[] = []
let listening = false

function onKeyDown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  // 输入法候选词取消：IME 组合中的 Escape 属于输入法，不是"关弹层"
  if (e.isComposing || e.keyCode === 229) return
  // 内层控件已经消费（录制快捷键、下拉框、草稿输入框……）
  if (e.defaultPrevented) return
  const top = stack[stack.length - 1]
  if (!top) return
  e.preventDefault()
  top.onEscape()
}

function ensureListening(): void {
  if (listening) return
  listening = true
  window.addEventListener('keydown', onKeyDown)
}

function stopListeningIfIdle(): void {
  if (!listening || stack.length > 0) return
  listening = false
  window.removeEventListener('keydown', onKeyDown)
}

/** 当前是否有弹层打开（App 的全局快捷键分发用它决定让不让路） */
export function hasOpenOverlay(): boolean {
  return stack.length > 0
}

/**
 * 当前弹层数量（0 = 没有）。
 *
 * 命令中心需要它：Ctrl+K 是「开关式」快捷键，弹层在场时 App 整体让路，
 * 于是这个键永远关不掉已经打开的命令中心。层数为 1 说明栈顶就是它自己，
 * 这时允许 toggle；叠着变量框/确认框时仍然让路。
 */
export function overlayDepth(): number {
  return stack.length
}

/**
 * 弹层专用 Esc 监听：全模块只有一个 window 监听器，只让栈顶响应。
 * onEscape 用 ref 保存，调用方不必把它包成 useCallback 也能拿到最新闭包。
 */
export function useOverlayEscape(open: boolean, onEscape: () => void): void {
  const handler = useRef(onEscape)
  handler.current = onEscape

  useEffect(() => {
    if (!open) return
    const id = Symbol('overlay')
    stack.push({ id, onEscape: () => handler.current() })
    ensureListening()
    /*
     * 抢回焦点：终端聚焦时 document.activeElement 是 .xterm-helper-textarea，
     * xterm 的 _keyDown 对 Escape 是「发给远端 + preventDefault/stopPropagation」，
     * 我们的 bubble 监听根本收不到 —— 弹层关不掉，按键还会静默打进远端 SSH。
     * 弹层一压栈就让终端失焦，Esc 与后续字符都落回弹层自己身上。
     */
    const active = document.activeElement
    if (active instanceof HTMLElement && active.closest('.xterm')) active.blur()
    return () => {
      const index = stack.findIndex((entry) => entry.id === id)
      if (index >= 0) stack.splice(index, 1)
      stopListeningIfIdle()
    }
  }, [open])
}
