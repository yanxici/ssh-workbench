/**
 * 串口波特率的合法区间与常用档位。
 *
 * 为什么要单独一个文件：这个区间有两处判定者 ——
 *   1. 传输层的在线切波特率（`SerialTransport.setBaudRate`）；
 *   2. 导入别人给的连接文件（`cleanSerial`）。
 * 两边各写一遍的后果是「界面能填 3000000，导入时被判非法」这种自相矛盾。
 */

/** 下限：低于 50 的波特率在真实设备上不存在，几乎一定是填错了字段 */
export const SERIAL_MIN_BAUD = 50
/** 上限：4 Mbps，覆盖到 FTDI / CP210x 能跑的最高档，再高驱动也未必支持 */
export const SERIAL_MAX_BAUD = 4_000_000

/**
 * 下拉框里的常用档位。
 *
 * 只列常见的：给一份「从 50 到 4000000 全列」的表单，用户反而要在一百多项里找
 * 自己那个 115200。真正冷门的值走「自定义」输入框，不靠这张表覆盖。
 */
export const SERIAL_BAUD_PRESETS: number[] = [
  1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1500000, 2000000,
  3000000
]

/** 波特率是否落在可接受区间内（整数、50..4000000） */
export function isValidBaudRate(v: unknown): boolean {
  const n = Number(v)
  return Number.isInteger(n) && n >= SERIAL_MIN_BAUD && n <= SERIAL_MAX_BAUD
}

/**
 * 收敛一个波特率值。
 *
 * 非有限数 / 非整数 / 越界时回落到 `fallback`（默认 115200）而不是抛异常：
 * 调用点分别是「导入文件」（该判非法，用 isValidBaudRate 自己判）与
 * 「传输层在线切换」（值来自下拉框或输入框，给个能用的默认值比崩掉好）。
 */
export function normalizeBaudRate(v: unknown, fallback = 115200): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n < SERIAL_MIN_BAUD || n > SERIAL_MAX_BAUD) return fallback
  return n
}
