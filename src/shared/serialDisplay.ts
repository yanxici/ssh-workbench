/**
 * 连接/会话的显示名。
 *
 * 为什么放在 shared 而不是主进程里：
 * 会话标签一打开就要立刻有名字（此时主进程还没回话），而主进程 list() 里也要
 * 给同一个名字。两边各写一份必然漂移 —— 改了「8N1」的写法只改一处，
 * 标签栏和状态栏就会显示成两种样子。所以格式函数只留这一份。
 */
import type { Connection, SerialConfig } from './types'

/**
 * 串口会话的一行显示名，如 `COM3 · 115200 8N1`。
 *
 * 8N1 是串口圈的通用约定（数据位/校验/停止位），比「8 数据位 无校验 1 停止位」
 * 更短，标签栏放得下。停止位 1.5 必须单独处理，`String(1.5)` 会给出 "1.5"，
 * 但 `1.5` 在模板里拼成 "1.5N1.5" 会让人读成两个参数，所以写成 "8N1.5"。
 */
export function describeSerialTarget(cfg: SerialConfig): string {
  const parity = { none: 'N', even: 'E', odd: 'O', mark: 'M', space: 'S' }[cfg.parity] ?? 'N'
  const stop = cfg.stopBits === 1.5 ? '1.5' : String(cfg.stopBits)
  return `${cfg.path} · ${cfg.baudRate} ${cfg.dataBits}${parity}${stop}`
}

/**
 * 统一显示名：SSH 为 `user@host`，串口为 `COM3 · 115200 8N1`。
 *
 * 存在的理由：渲染层原来有 30 多处各自拼 `${username}@${host}`，串口连接的
 * username/host 都是空串，直接拼会显示成一个孤零零的 `@`。
 */
export function connectionTarget(conn: {
  kind?: Connection['kind']
  host: string
  username: string
  serial?: SerialConfig
}): string {
  if (conn.kind === 'serial' && conn.serial) return describeSerialTarget(conn.serial)
  if (!conn.username) return conn.host
  return `${conn.username}@${conn.host}`
}

/**
 * 连接列表里用的地址，SSH 带端口（`:22` 对运维是有用信息），串口不带。
 *
 * 串口的「端口」是 COM 号已经在 describeSerialTarget 里了，再拼一个
 * `COM3:0` 只会让人以为 0 是 TCP 端口。
 */
export function connectionAddress(conn: {
  kind?: Connection['kind']
  host: string
  port: number
  username: string
  serial?: SerialConfig
}): string {
  if (conn.kind === 'serial') return connectionTarget(conn)
  return `${connectionTarget(conn)}:${conn.port}`
}
