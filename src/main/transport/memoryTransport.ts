/**
 * 内存传输实现 —— 只给测试用。
 *
 * 存在的理由：串口硬件在 CI 上不存在，而「连接 → 收数据 → 发数据 → 断开」
 * 这条链路的行为（合帧、状态流转、断线通知、录制）与具体传输无关。
 * 有了它，会话管理器的主流程可以在没有硬件、没有网络的环境里跑断言。
 *
 * 刻意不实现任何真实 I/O 语义（不做流控、不模拟波特率），
 * 它的职责是「可控地产生事件」，而不是仿真设备。
 */
import type { Transport, TransportEvents, TransportOpenOptions } from './types'

export interface MemoryTransportOptions {
  kind?: 'ssh' | 'serial'
  /** open() 是否失败，用于测连接失败路径 */
  failOpen?: string | null
  /** 每次 open() 的耗时，用于测并发关闭 */
  openDelayMs?: number
}

export class MemoryTransport implements Transport {
  readonly kind: 'ssh' | 'serial'

  private readonly events: TransportEvents
  private readonly options: MemoryTransportOptions
  private opened = false
  private closing = false

  /** 上层写入的全部内容，按调用顺序记录（测试断言用） */
  readonly written: string[] = []
  /** writeBytes 写入的原始字节 */
  readonly writtenBytes: Buffer[] = []
  /** resize 调用记录 */
  readonly resizes: Array<[number, number]> = []

  constructor(options: MemoryTransportOptions, events: TransportEvents) {
    this.options = options
    this.kind = options.kind ?? 'ssh'
    this.events = events
  }

  async open(_opts: TransportOpenOptions): Promise<void> {
    if (this.opened) throw new Error('传输层已打开')
    if (this.options.openDelayMs) {
      await new Promise((r) => setTimeout(r, this.options.openDelayMs))
    }
    if (this.options.failOpen) throw new Error(this.options.failOpen)
    if (this.closing) throw new Error('会话已关闭')
    this.opened = true
  }

  write(data: string): void {
    if (!this.opened || this.closing) return
    this.written.push(data)
  }

  writeBytes(data: Buffer): void {
    if (!this.opened || this.closing) return
    this.writtenBytes.push(data)
  }

  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows])
  }

  close(): void {
    this.closing = true
  }

  /* ---------------- 测试驱动接口 ---------------- */

  /** 模拟对端发来数据 */
  emitData(raw: Buffer, text: string): void {
    if (this.closing) return
    this.events.onData(raw, text)
  }

  /** 模拟对端断开；传 error 表示异常断开（拔线、网络中断） */
  emitClose(error?: Error): void {
    if (this.closing) return
    this.closing = true
    this.events.onClose(error)
  }

  isClosed(): boolean {
    return this.closing
  }
}
