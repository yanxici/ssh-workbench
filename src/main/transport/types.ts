/**
 * 传输层抽象。
 *
 * 背景：V1.x 的 sessionManager 与 ssh2 的 `Client` / `ClientChannel` 深度耦合 ——
 * 打开 shell、写数据、改窗口大小、探测延迟、断线通知，全部直接调 ssh2 的 API。
 * V2.0.0 要接串口，而串口没有「连接对象」「shell 通道」「窗口大小」这些概念，
 * 于是把这些能力抽成一个接口：会话管理器只认 Transport，不再认 ssh2。
 *
 * 设计约束（都是踩过或预判过的坑）：
 *
 * 1. **不引入异步写队列**。串口写入在 open 之后是同步的，SSH 的 shell.write 也是。
 *    抽成 Promise 会让 write() 的调用方（终端 onData，每敲一个键都走）不得不处理
 *    乱序风险 —— 键盘输入必须保持顺序，宁可同步阻塞。
 *
 * 2. **resize 是可选能力**。串口没有终端尺寸，调用方不能假设它存在。
 *
 * 3. **onData 交出的是原始字节 + 已解码文本**。原始字节给 ZMODEM 用（二进制协议
 *    必须基于未解码的流解析），文本给终端显示。解码在哪一侧做由实现决定：
 *    SSH 侧固定 UTF-8（远端 locale 决定），串口侧按连接配置的 charset。
 *
 * 4. **close 与 onClose 的语义是「对端没了」**，不是「我主动关的」。
 *    主动关闭由调用方自己标记，否则自动重连会在用户点关闭后继续拉起连接。
 */

/** 传输层事件回调。实现方在状态变化时调用，调用方负责节流与合帧 */
export interface TransportEvents {
  /** 收到数据。raw 为未解码字节，text 为按实现约定解码后的文本 */
  onData: (raw: Buffer, text: string) => void
  /**
   * 传输层断开。
   * @param error 有值表示异常断开（可展示给用户），undefined 表示对端正常关闭
   */
  onClose: (error?: Error) => void
}

export interface TransportOpenOptions {
  cols: number
  rows: number
}

/**
 * 一条已建立（或正在建立）的会话通道。
 *
 * 生命周期：构造 → open() → 收发 → close()；open 失败直接抛错，不进入半开状态。
 */
export interface Transport {
  /** 人类可读的通道类型，仅用于日志与错误信息 */
  readonly kind: 'ssh' | 'serial'

  /** 建立通道并开始投递事件。必须在 open 返回后才能 write */
  open(opts: TransportOpenOptions): Promise<void>

  /** 写入文本（已按实现约定编码）。调用方保证 open 已完成 */
  write(data: string): void

  /**
   * 写入原始字节。ZMODEM 等二进制协议用，绕开文本编码。
   * 不支持二进制语义的实现（目前没有）可以退化成 write(data.toString())。
   */
  writeBytes(data: Buffer): void

  /** 调整窗口大小。串口实现为空操作 */
  resize(cols: number, rows: number): void

  /** 关闭通道。必须幂等 —— 断开与用户关闭会先后触发 */
  close(): void
}

/** 传输层构造器：拿到连接配置与事件回调，产出一个尚未 open 的 Transport */
export type TransportFactory = (events: TransportEvents) => Transport
