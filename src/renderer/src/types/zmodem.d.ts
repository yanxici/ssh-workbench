/**
 * 构建期注入的测试开关（见 electron.vite.config.ts 的 define）。
 * 仅在 ZM_TEST=1 的验证构建里为 true。
 */
declare const __ZM_TEST__: boolean

/**
 * zmodem.js 没有自带类型声明，这里只声明本项目实际用到的部分。
 * 该库是 CommonJS（index.js 汇总 src/zsentry.js），导出 Sentry / Session / ZMODEM 常量等。
 */
declare module 'zmodem.js' {  /** Sentry 检测到疑似 ZMODEM 起始序列时给出的对象 */
  export interface Detection {
    /** 确认开始；返回的 Session 已接管后续字节 */
    confirm(): ZmodemSession
    /** 否认（发送中止序列） */
    deny(): void
    /** 该 Detection 是否仍然有效（未被后续字节推翻） */
    is_valid(): boolean
    /** 'send' = 对端发文件给我们；'receive' = 对端要接收我们的文件 */
    get_session_role(): 'send' | 'receive'
  }

  export interface SentryOptions {
    /** 非 ZMODEM 的普通输出，交回终端渲染 */
    to_terminal: (octets: number[] | Uint8Array) => void
    on_detect: (detection: Detection) => void
    on_retract: () => void
    /** 向对端（SSH 通道）写入字节 */
    sender: (octets: number[] | Uint8Array) => void
  }

  export interface FileDetails {
    name: string
    size: number
    mtime?: Date
    files_remaining?: number
    bytes_remaining?: number
  }

  /**
   * 单个数据子包（zsubpacket.js）。
   * 只在 Session 的 'data_in' 事件里出现：ack_expected() && frame_end() 同时成立的
   * 就是 ZCRCW —— 库自身不会为它回 ZACK，需要调用方补一帧，否则 lrzsz 的 sz 会
   * 在窗口边界停下来等确认（表现为进度卡住不动）。
   */
  export interface ZmodemSubpacket {
    get_payload(): Uint8Array
    /** 该子包是否结束了当前帧 */
    frame_end(): boolean
    /** 对端是否期待一个 ZACK */
    ack_expected(): boolean
  }

  /** 接收方收到的文件提议 */
  export interface ZmodemOffer {
    get_details(): FileDetails
    /** on_input 传函数则边收边回调，不再内部留存；传 'spool_array' 或省略则收完返回数组 */
    accept(opts?: {
      on_input?: ((payload: Uint8Array) => void) | 'spool_array'
    }): Promise<Uint8Array[] | undefined>
    skip(): void
    /** 'complete' = 该文件（ZEOF）收完 */
    on(evt: 'complete' | 'input', cb: (...args: unknown[]) => void): this
    /**
     * 库内部真正的 accept 实现（重新装好 ZDATA/ZEOF 解析器并发出 ZRPOS）。
     * 断点续传时用它把会话从「解析器被打断」的状态里救回来；
     * 注意它会另起一个 promise，原来 accept() 的 promise 不再兑现，
     * 因此收尾必须靠字节数 / 'complete' 事件判断，不能只等 accept()。
     */
    _accept_func(offset: number): Promise<unknown>
  }

  /** 发送方对单个文件的传输句柄 */
  export interface ZmodemTransfer {
    get_details(): FileDetails
    get_offset(): number
    send(chunk: number[] | Uint8Array): void
    end(chunk?: number[] | Uint8Array): Promise<void>
  }

  export interface ZmodemSession {
    type: 'send' | 'receive'
    on(evt: 'offer', cb: (offer: ZmodemOffer) => void): this
    on(evt: 'session_end', cb: () => void): this
    on(evt: 'garbage', cb: (octets: number[]) => void): this
    /** 每收到一个数据子包触发一次；补 ZACK 的唯一入口 */
    on(evt: 'data_in', cb: (subpacket: ZmodemSubpacket) => void): this
    on(evt: string, cb: (...args: unknown[]) => void): this
    /**
     * 只在 session 类型为 receive 时可用。
     * 必须调用，才会发出第一个 ZRINIT 开始协商；不调用则远端 sz 永远等待。
     * 返回值在收到第一个 offer / 会话结束时兑现。
     */
    start(): Promise<ZmodemOffer | undefined>
    /** 只在 session 类型为 send 时可用 */
    send_offer(params: FileDetails): Promise<ZmodemTransfer | undefined>
    close(): void
    abort(): void
    has_ended(): boolean
    get_trailing_bytes(): number[]
    /**
     * 库内部：重建 ZDATA/ZEOF 解析器、把文件偏移设到 offset 并发出 ZRPOS。
     * 解析器被异常打断后只能靠它复位，否则后续每一帧都会再抛 Unhandled header。
     */
    _accept(offset: number): Promise<unknown>
    /** 库内部输入缓冲区：异常发生时这里往往还压着半帧字节，续传前必须清空 */
    _input_buffer: number[]
    /** 库内部子包解析器：异常后可能停在子包模式，续传前必须置空 */
    _next_subpacket_handler: unknown
  }

  export class Sentry {
    constructor(options: SentryOptions)
    /** 喂入原始字节；解析出 ZMODEM 后交 Session，其余走 to_terminal */
    consume(input: number[] | Uint8Array): void
    get_confirmed_session(): ZmodemSession | null
  }

  /** 协议头构造（自动化测试用：生成真实起始帧，避免硬编码字节） */
  export interface ZmodemHeader {
    NAME: string
    to_hex(): number[]
  }

  export const Header: {
    build(name: string, payload?: unknown): ZmodemHeader
  }

  export const ZMLIB: {
    ABORT_SEQUENCE: number[]
  }

  /** 协议头字段编码（ZACK 的 4 字节小端偏移用得到） */
  export const ENCODELIB: {
    pack_u32_le(n: number): number[]
    unpack_u32_le(bytes: number[]): number
  }
}
