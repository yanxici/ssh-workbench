import { Notification } from 'electron'
import { IPC } from '@shared/ipc'
import type { TaskNotifyPayload } from '@shared/types'
import { getMainWindow } from '../windowRef'

/**
 * 任务完成通知（系统级，Windows 操作中心）。
 *
 * 从 main/index.ts 抽出来的理由与 window/taskbar.ts 同源：入口文件已经承担了
 * 窗口创建、IPC 注册、传输聚合等互不相关的职责，这块是自包含的 —— 一个
 * 活动通知集合 + 一个去重表 + 两个导出（showTaskNotification / focusMainWindow）。
 *
 * 为什么要自己按住 Notification 实例：Electron 的 Notification 在 Windows 上
 * 一旦被 GC 回收，点通知的回调就再也不会触发（表现为"通知还在，点了没反应"）。
 * 所以活着的实例必须放集合里，on('close')/on('click') 时才移除。
 */

/** 活着的通知实例（防 GC；见文件头注释） */
const live = new Set<Notification>()

/**
 * 去重窗口。
 *
 * 一个任务的完成信号常常不止一条：批量执行里 8 台设备几乎同时结束、
 * SFTP 多个文件同批完成，都会各推一次。用户看到的是「8 条一样的通知排在
 * 操作中心里」，那不是提示而是骚扰。这里按 title+body 指纹在 5 秒内合并，
 * 与设置页里「5 秒去重」的说明保持一致。
 */
const DEDUP_WINDOW_MS = 5000
const recent = new Map<string, number>()

function shouldSkip(title: string, body: string): boolean {
  const now = Date.now()
  // 顺手清理过期键：这张表只在有通知时才写，规模永远很小，不需要定时器
  for (const [key, at] of recent) {
    if (now - at > DEDUP_WINDOW_MS) recent.delete(key)
  }
  const key = `${title}\u0000${body}`
  const last = recent.get(key)
  if (last !== undefined && now - last <= DEDUP_WINDOW_MS) return true
  recent.set(key, now)
  return false
}

/**
 * 把主窗口提到前台。
 *
 * 三个动作缺一不可：
 * - isMinimized → restore：最小化状态下 focus() 不会还原窗口，这是 Electron 的
 *   既定行为，只调 focus 会得到"任务栏图标闪了一下但窗口没出来"。
 * - show：从托盘/隐藏状态回来时窗口是隐藏的。
 * - focus：Windows 对后台进程抢焦点有限制，但这里是**用户点了通知**触发的，
 *   属于用户主动行为，系统允许。
 */
export function focusMainWindow(): void {
  const win = getMainWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  if (!win.isVisible()) win.show()
  win.focus()
}

/** 主窗口当前是否聚焦（渲染层据此决定发系统通知还是只发应用内 toast） */
export function isMainWindowFocused(): boolean {
  const win = getMainWindow()
  return !!win && win.isFocused()
}

/**
 * 弹一条系统通知。
 *
 * 返回 true 表示真的弹了，false 表示被跳过（系统不支持 / 去重命中）。
 * 返回值是给验证脚本用的 —— 光看"没报错"证明不了通知弹了。
 */
export function showTaskNotification(payload: TaskNotifyPayload): boolean {
  // Windows 7 / 未注册 AppUserModelID 的机器不支持；直接返回 false 让调用方
  // 把应用内 toast 当兜底，而不是在这里抛错
  if (!Notification.isSupported()) return false
  const title = (payload.title || '').trim()
  if (!title) return false
  const body = (payload.body || '').trim()
  if (shouldSkip(title, body)) return false

  const n = new Notification({
    title,
    body,
    // silent 是逐条覆盖：偏好里关掉声音时渲染层会传 silent=true
    silent: payload.silent !== false,
    // 关掉 Windows 的通知音效之外还要关掉「在操作中心里静默」的歧义：
    // 不设 timeoutType，交给系统默认（Win10/11 会自己收进操作中心）
    urgency: 'normal'
  })

  live.add(n)

  const cleanup = (): void => {
    live.delete(n)
  }

  n.on('click', () => {
    cleanup()
    focusMainWindow()
    // 窗口先聚焦再转发，渲染层切标签时窗口已经是可见的，
    // 不会出现「切了标签但窗口还在后面」的错位感
    if (payload.sessionId) {
      getMainWindow()?.webContents.send(IPC.EVT_NOTIFY_CLICK, { sessionId: payload.sessionId })
    }
  })
  n.on('close', cleanup)
  n.on('failed', (_e, error) => {
    cleanup()
    // 通知失败不该影响主流程（比如用户在系统设置里关了本应用的通知），
    // 只写日志不抛：抛出去会变成 IPC 失败，反而让用户以为任务出错了
    process.stdout.write(`[notify] 系统通知失败：${error}\n`)
  })

  n.show()
  return true
}

/** 当前活着的通知数（测试用：验证实例没有被立刻回收） */
export function liveNotificationCount(): number {
  return live.size
}

/** 清空去重表（测试用：让同一文案可以连续断言） */
export function resetNotifyDedupe(): void {
  recent.clear()
}
