/**
 * 输入法组合态判定。
 *
 * 为什么需要：中文输入法在拼音串还没上屏时，Enter 是「确认候选词」，
 * 不是「执行动作」。此时浏览器仍会派发 keydown，React 的 onKeyDown 照样收到，
 * 于是「搜索框里敲 nihao 按回车确认候选」会直接执行第一条命令 / 跳转目录 / 提交表单 ——
 * 用户只是想选个字。
 *
 * 为什么用 nativeEvent.isComposing 而不是 e.isComposing：
 * React 合成事件（SyntheticEvent）没有 isComposing 字段，读它恒为 undefined，
 * 守卫写成 `if (e.isComposing) return` 等于没写，而且 TypeScript 不会报错
 * （React 的 KeyboardEvent 类型里 isComposing 是可选属性）。
 * 真实标志在原生事件上：`e.nativeEvent.isComposing`。
 *
 * 为什么不用 keyCode === 229：
 * 229 是 Chrome 早期 IME 的历史 hack，只在「组合中被吞掉的按键」上出现，
 * 且 Safari/Firefox 行为不一致。isComposing 是 DOM Level 3 标准字段，
 * Chromium（Electron 的运行时）自 M56 起正确实现，是当前唯一可靠判据。
 *
 * 为什么不判 `compositionstart`/`compositionend` 自己维护状态：
 * 那需要每个组件持有状态并处理 blur/失焦中断等边界，而原生事件上的
 * isComposing 已经是浏览器维护好的同一份状态，没必要再抄一遍。
 *
 * 用法：任何 onKeyDown 里消费 Enter / 方向键 / Escape 的分支，首行加
 *
 *   if (isImeComposing(e)) return
 *
 * 注意：容器上的 onKeyDown（事件从子输入框冒泡上来）同样要判，
 * 子树里有 input 的容器 handler 与直接挂在 input 上的 handler 风险相同。
 */

/** 判断该键盘事件是否发生在输入法组合态中（此时不应消费按键） */
export function isImeComposing(e: { nativeEvent?: { isComposing?: boolean } }): boolean {
  return e.nativeEvent?.isComposing === true
}
