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

  /** 接收方收到的文件提议 */
  export interface ZmodemOffer {
    get_details(): FileDetails
    /** on_input 传函数则边收边回调，不再内部留存；传 'spool_array' 或省略则收完返回数组 */
    accept(opts?: {
      on_input?: ((payload: Uint8Array) => void) | 'spool_array'
    }): Promise<Uint8Array[] | undefined>
    skip(): void
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
    on(evt: string, cb: (...args: unknown[]) => void): this
    /** 只在 session 类型为 send 时可用 */
    send_offer(params: FileDetails): Promise<ZmodemTransfer | undefined>
    close(): void
    abort(): void
    has_ended(): boolean
    get_trailing_bytes(): number[]
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
}
