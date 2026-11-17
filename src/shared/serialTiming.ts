/**
 * 串口发送节奏（逐字符 / 行间延迟）的取值收敛与说明文案。
 *
 * 为什么单独一个文件：这个值的合法区间要同时被四处用到 ——
 * 传输层（真的按时序发）、落盘归一化（connections.json 可手改）、
 * 导入校验（别人给的 JSON）、连接编辑器的输入框上限。
 * 各写一遍的结果必然是「界面能填 500、传输层只认 100」这种自相矛盾。
 */
import type { SerialConfig } from './types'

/**
 * 字符间隔上限（毫秒）。
 *
 * 延迟是作用在**每一个字符**上的，所以上限必须收紧：填 1000 意味着粘一条
 * 100 字符的命令要 100 秒 —— 那不是「慢速设备」，那是表单填错了。
 * 100ms 已经相当于 9600 波特率下单字节传输时间（约 10.4ms）的十倍，
 * 再慢的设备应当靠流控（RTS/CTS）解决，而不是靠加大延迟。
 */
export const SERIAL_MAX_CHAR_DELAY_MS = 100

/**
 * 行间延迟上限（毫秒）。
 *
 * 用于「执行完一行才回 OK」的设备（AT 通道、部分 bootloader 菜单）。
 * 现场常见值 50~500ms；超过 2 秒说明该用命令库的等待逻辑，而不是干等。
 */
export const SERIAL_MAX_LINE_DELAY_MS = 2000

/** 收敛字符间隔：非法 / 负数 / 非有限值一律当 0（= 不节流，保持旧行为） */
export function normalizeCharDelayMs(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(Math.floor(n), SERIAL_MAX_CHAR_DELAY_MS)
}

/** 收敛行间延迟：语义同上，上限不同 */
export function normalizeLineDelayMs(v: unknown): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(Math.floor(n), SERIAL_MAX_LINE_DELAY_MS)
}

/** 两个延迟是否都关着（传输层据此走「整段直发」的原路径） */
export function isSerialPacingOff(cfg: Pick<SerialConfig, 'charDelayMs' | 'lineDelayMs'>): boolean {
  return normalizeCharDelayMs(cfg.charDelayMs) === 0 && normalizeLineDelayMs(cfg.lineDelayMs) === 0
}

/**
 * 给界面用的一句话说明。
 *
 * 两个延迟都是 0 时返回空串而不是「已关闭」：连接编辑器只在真的开启节奏时
 * 才多显示一行，默认状态下不占地方。
 */
export function describeSerialPacing(
  cfg: Pick<SerialConfig, 'charDelayMs' | 'lineDelayMs'>
): string {
  const charDelay = normalizeCharDelayMs(cfg.charDelayMs)
  const lineDelay = normalizeLineDelayMs(cfg.lineDelayMs)
  if (charDelay === 0 && lineDelay === 0) return ''
  const parts: string[] = []
  if (charDelay > 0) parts.push(`每字符 ${charDelay}ms`)
  if (lineDelay > 0) parts.push(`换行后 ${lineDelay}ms`)
  return parts.join(' · ')
}
