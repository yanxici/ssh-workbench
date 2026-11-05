/**
 * ZMODEM 文件传输（sz / rz）
 *
 * 设计要点：
 * - 每个会话持有一个 Sentry，插在「主进程原始字节 -> 终端」之间。
 *   远端执行 sz（发文件）或 rz（收文件）时，会主动发出 ZMODEM 起始序列，
 *   Sentry 检测到后弹确认，确认即接管字节流，不再把协议帧写进终端。
 * - 必须喂原始字节：主进程的 text 是 StringDecoder 解码结果，二进制会被破坏，
 *   因此统一用 SessionDataEvent.raw（base64）解码后再 consume()。
 * - 未被协议接管的字节必须先解码回文本再写终端，否则中文等多字节字符会乱码 ——
 *   这里用 TextDecoder({stream:true}) 做跨帧拼接，把「只在协议边界切分」的字节
 *   重新按 UTF-8 边界解码。
 *
 * 只有「用户主动确认」才会进入传输，避免把恰好像 ZMODEM 的普通输出误判。
 *
 * 接收方向的三个致命点（曾经把终端挂死的原因）：
 *   1) Receive 会话创建后必须调用 start()，否则不会发出第一个 ZRINIT，
 *      远端 sz 收不到回应就一直「等待」，界面上表现为「收取中」卡死；
 *   2) 用户在选目录期间远端会重发起始帧，旧 Detection 被 retract 后
 *      confirm() 会抛 "Stale ZMODEM session"，此时要记住用户的选择，
 *      等下一次检测直接接管，而不是静默 return（那同样是永久卡死）；
 *   3) 解析器一旦在某帧上抛错，库内部的 ZDATA 处理器就被消费掉了，之后每一帧
 *      都会再抛 "Unhandled header: ZDATA"，最终只能 abort —— 而 abort 之后
 *      Sentry 会把远端仍在推的整帧二进制原样写进终端，就是「满屏乱码」。
 *      所以这里必须：清输入缓冲 + 重装解析器 + 发 ZRPOS 续传，并且全程不把
 *      协议态里的字节写进终端。
 *   4) lrzsz 的 sz 在窗口边界用 ZCRCW 等 ZACK，而 zmodem.js 只在「非帧尾」才回
 *      ZACK，于是永远不回 —— 远端等确认等到超时，表现就是进度停在某个百分比。
 *      必须在 data_in 里自己对 ack_expected() && frame_end() 的子包补发 ZACK。
 *
 * 发送方向（本机 rz / 远端 rz）的三个致命点：
 *   5) send_offer() 之前要先发 ZSINIT 让对端开启 ESCCTL，而库里「等 ZACK」的
 *      promise 没有任何超时 —— 对端不回声就永远停在 0 字节。必须不信这个前提：
 *      自己发 ZSINIT，但不阻塞等待（见 primeSendSession / runSend）。
 *   6) 保活每 5 秒把 _next_header_handler 换成 {ZACK}；而 _stop_keepalive() 清的是
 *      拼错的字段名（_keep_alive_promise），实际永远停不掉。于是传输途中迟到的
 *      ZACK 会落进被换掉的处理器表里抛 "Unhandled header: ZACK"，会话被 abort，
 *      界面上就是「传了一半停了 / 又要重新弹确认」。发送方向必须把这两条都拦住。
 *   7) 发送循环原来是一个同步 for，几 MB 文件会把渲染进程整段冻住，对端中断、
 *      链路故障在事件层面根本处理不到 —— 改为分片 + 定期让出事件循环。
 */

import * as ZmodemModule from 'zmodem.js'
import {
  Sentry,
  type Detection,
  type ZmodemSession,
  type ZmodemOffer,
  type ZmodemTransfer,
  type ZmodemSubpacket
} from 'zmodem.js'

/** 传输方向：send = 本机发给远端（对端 rz）；receive = 远端发给本机（对端 sz） */
export type ZmodemDirection = 'send' | 'receive'

export interface ZmodemProgress {
  /** 'detected' 待确认，'active' 传输中，'done' 完成，'error' 失败 */
  phase: 'detected' | 'active' | 'done' | 'error'
  direction: ZmodemDirection
  fileName?: string
  bytesDone: number
  bytesTotal: number
  message?: string
}

interface SessionState {
  sentry: Sentry
  /** 协议未接管时的解码器，保证多字节字符跨帧不乱码 */
  decoder: TextDecoder
  active: ZmodemSession | null
  /** 是否已经向用户弹出确认（避免重复弹窗） */
  prompting: boolean
  /** 回落写终端用（无原始字节或解析异常时） */
  hooks: ZmodemHooks
  /** 已进入 ZMODEM 协议态（此期间终端上出现的是协议残渣，需记账） */
  inProtocol: boolean
  /** 协议会话已结束（用于判断残渣窗口） */
  protocolEnded: boolean
  /** 本次传输累计写入终端的残渣字符数，结束后一次性回删 */
  residueChars: number
  residueTimer?: ReturnType<typeof setTimeout>
  /** 是否曾经建立过协议会话（决定是否需要在结束后清理） */
  everHadSession: boolean
  /** 当前方向（中断时用于提示） */
  direction: ZmodemDirection | null
  /** 是否存在尚未确认的检测（此期间的输出按残渣处理，避免终端被协议帧刷屏） */
  pendingDetect: boolean
  /** 用户已同意、正在等待（或选择目录）的方向；下一次检测直接接管，不再弹窗 */
  autoConfirm: ZmodemDirection | null
  /** 保存目录令牌（接收方向，多文件传输复用同一个目录） */
  saveDirToken: string | null
  /** autoConfirm 的超时看门狗：远端放弃后不能让界面一直转圈 */
  autoTimer?: ReturnType<typeof setTimeout>
  /** 最近一次检测：远端会重发起始帧，用户还在选目录时以最新那次为准 */
  latest: Detection | null
  /**
   * 取消挂起的确认询问。
   * 用户点「中断」/关会话时若还卡在确认弹窗上，必须在这里给出答复，
   * 否则 await confirm() 永远不返回，整个流程就死在那儿退不出来。
   */
  cancelConfirm: (() => void) | null
  /** 本次会话已收到的字节数（用于「远端一直不吭声」的看门狗） */
  receivedBytes: number
  /**
   * 当前文件内的绝对位置（从 0 开始的字节偏移）。
   * 断点续传的 ZRPOS 用的是「文件内偏移」而不是「本会话累计字节数」，
   * 多文件传输时后者会把第二个文件的位置算错，所以必须单独记。
   * 语义：本文件已经「认下」的字节数（已排队落盘），断点续传的 ZRPOS 就用它。
   */
  fileOffset: number
  /**
   * 待生效的续传起点（文件内偏移）。_accept() 之后对端可能从这个位置往前重发一整帧，
   * 落在 [0, fileOffset) 区间的字节只丢弃不落盘；-1 表示没有待处理的续传。
   */
  resyncFrom: number
  /** 接收看门狗：会话建立后远端迟迟不发数据时提示用户，而不是干等 */
  stallTimer?: ReturnType<typeof setTimeout>
  /**
   * 乱码抑制窗（毫秒时间戳）。协议崩掉之后远端仍在往链路上推整帧二进制，
   * Sentry 会把它们当「未被接管的输出」原样转给终端 —— 这就是用户看到的满屏乱码。
   * 在这段时间内一律丢弃，不写终端。
   */
  suppressUntil: number
  /** 上一次续传请求的时间，避免坏帧把主线程刷爆 */
  lastResyncAt: number
  /** 本次会话已经发起过多少次断点续传，超过上限就认定这条路救不回来 */
  resyncAttempts: number
}

/** 会话结束后等待残渣到齐的窗口（远端常会补发 ZRINIT 等） */
const RESIDUE_WINDOW_MS = 600

/** 等远端重发起始帧的最长时间，超时即判定对方已经放弃 */
const AUTO_CONFIRM_TIMEOUT_MS = 20000

/** 会话建立后等第一份数据的最长时间 */
const RECEIVE_STALL_MS = 15000

/**
 * 协议崩掉后丢弃终端输出的时长。远端此时还在推数据帧，而 Sentry 已经不再接管，
 * 这些字节若写进终端就是一屏乱码（用户截图里的样子）。
 */
const GARBLE_SUPPRESS_MS = 5000

/** 两次续传请求之间的最小间隔：坏帧连续抛错时不能让 ZRPOS 刷屏 */
const RESYNC_MIN_INTERVAL_MS = 150

/** 单个文件最多续传几次，超过就认定对端链路已经不可用 */
const RESYNC_MAX_ATTEMPTS = 64

/** 接收时攒够这么多字节就落盘一次，避免整份文件驻留渲染进程内存 */
const RECEIVE_FLUSH_BYTES = 256 * 1024

/**
 * 发送方向等对端回应（ZFILE -> ZRPOS、ZEOF -> ZRINIT）的最长时间。
 * 对端可能根本没在跑 rz，或者已经超时退出 —— 那种情况下库会无限期挂在 promise 上，
 * 界面就永远停在第一个字节之前。
 */
const SEND_RESPONSE_TIMEOUT_MS = 20000

/**
 * 发送分片大小。库内部还会再按 8KB 切子包，这里只决定我们多久让出一次事件循环：
 * rsync 这种几 MB 的文件若在一个同步循环里塞完，界面会整段冻结，
 * 对端的中断 / 故障在事件层面根本处理不到。
 */
const SEND_CHUNK_BYTES = 32 * 1024

/** 每发送这么多字节让出一次事件循环 */
const SEND_YIELD_BYTES = 128 * 1024

/**
 * 发送方向的保活间隔。远端 rz 在等 ZFILE 时有自己的超时（lrzsz 约 10 秒重发 ZRINIT），
 * 用户挑一个几 MB 的文件很容易超过它 —— 那时 rz 已经退出，后面的 ZFILE 只能打到 shell 上。
 * 我们自己每 5 秒补一帧 ZSINIT 把它按住，直到真正开始发文件。
 */
const SEND_KEEPALIVE_MS = 5000

/**
 * 识别「协议残渣」行：远端传输结束后残留的控制字符回显、重发的 ZRINIT 头、
 * 以及 sz/rz 的进度文案。用于把这类内容记入 residueChars 而不是当作正常输出。
 */
/* eslint-disable no-control-regex -- ZMODEM 的 ZDLE(0x18)/DLE(0x10) 本来就是控制字符，
   不写进正则根本无法识别协议帧；这里是有意的，不是手滑。 */
const RESIDUE_PATTERNS: RegExp[] = [
  /\*\*[\x18\x10]?B[0-9A-Fa-f]{2}/, // ZMODEM 头魔数 **\x18B01 等
  /\*\*\x18?[0-9A-Fa-f]{2}/,
  /^\s*[\x18\x10]+$/, // 纯控制字符（ZDLE 残留）
  /\b(?:Sending|Receiving|Waiting|Baud|Retry|Zsending|Zreceiving)\b/i,
  /^(?:rz|sz)\s+(?:waiting|ready)/i
]

/**
 * 该段文本是否为协议残渣。
 *
 * 判定顺序（从强到弱）：
 *  1. 含 ZMODEM 头魔数（`**\x18B01`）/ rz·sz 进度文案 —— 直接判残渣；
 *  2. 开头是控制字符（ZDLE `\x18`、DLE `\x10`）—— 传输结束后的远端回显几乎总是
 *     以 ZDLE 起头（用户实测串为 `\x18` + `^C` + `ceive.`），这类内容不该进终端；
 *  3. 整段都是控制字符 —— 同样丢弃。
 */
function isResidueText(text: string): boolean {
  // 强特征：ZMODEM 头 / 进度文案
  if (RESIDUE_PATTERNS.some((re) => re.test(text))) return true

  // 以控制字符开头：仅当仍处于协议期相邻上下文时才算残渣（调用方已保证）
  if (/^[\x18\x10]/.test(text)) return true

  // 整段不含任何可见字符
  const stripped = text.replace(/[\x10-\x1f\x00-\x08]/g, '')
  return text.length > 0 && !stripped.trim()
}
/* eslint-enable no-control-regex */

const states = new Map<string, SessionState>()

/** 每个会话的进度回调；由 UI 注册 */
const watchers = new Map<string, (p: ZmodemProgress) => void>()

/**
 * 每个会话的最后一条进度。
 *
 * 界面切换标签页会重建 watcher（watchZmodem 只在挂载时订阅一次），
 * 而「等待确认 / 等待远端起始帧」这类阶段不会再有新事件推送 ——
 * 只有实时推送的话，切走再切回来面板就永远空着，用户既看不到状态
 * 也点不到「中断」，于是整个界面卡在那儿退不出来。
 */
const lastProgress = new Map<string, ZmodemProgress>()

function emit(sessionId: string, p: ZmodemProgress): void {
  lastProgress.set(sessionId, p)
  watchers.get(sessionId)?.(p)
}

/** 读取某个会话当前的进度快照（界面重挂载时用来恢复面板） */
export function getZmodemProgress(sessionId: string): ZmodemProgress | null {
  return lastProgress.get(sessionId) ?? null
}

/** UI 注册进度监听，返回取消函数 */
export function watchZmodem(
  sessionId: string,
  cb: (p: ZmodemProgress) => void
): () => void {
  watchers.set(sessionId, cb)
  return () => {
    if (watchers.get(sessionId) === cb) watchers.delete(sessionId)
  }
}

function toOctets(input: number[] | Uint8Array): number[] {
  return Array.isArray(input) ? input : Array.from(input)
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export interface ZmodemHooks {
  /** 写回终端（普通输出或被协议交回的字节） */
  write: (text: string) => void
  /** 向 SSH 通道发送原始字节 */
  send: (bytes: Uint8Array) => void
  /** 询问用户是否开始传输；resolve(true) 才接管 */
  confirm: (direction: ZmodemDirection) => Promise<boolean>
  /**
   * 传输结束后的收尾（可选）。
   * 远端 sz/rz 退出时一般不会补 \r\n，提示符会与传输进度挤在同一行，
   * 这里让 UI 补一个换行，并清掉可能残留的未完成控制序列。
   */
  afterTransfer?: () => void
}

/**
 * 为一个会话建立 Sentry。重复调用直接返回，不重复挂载。
 * 挂载后该会话的终端输出必须经由 feedZmodem 走 Sentry 转发。
 */
export function ensureZmodem(sessionId: string, hooks: ZmodemHooks): void {
  attachZmodem(sessionId, hooks)
}

/**
 * 为一个会话建立 Sentry。重复调用返回已有实例。
 */
export function attachZmodem(sessionId: string, hooks: ZmodemHooks): void {
  if (states.has(sessionId)) return

  const state: SessionState = {
    // Sentry 构造时就要拿到全部回调，这里通过闭包引用 state 以便后续替换
    sentry: null as unknown as Sentry,
    decoder: new TextDecoder('utf-8'),
    active: null,
    prompting: false,
    hooks,
    inProtocol: false,
    protocolEnded: false,
    residueChars: 0,
    everHadSession: false,
    direction: null,
    pendingDetect: false,
    autoConfirm: null,
    saveDirToken: null,
    latest: null,
    cancelConfirm: null,
    receivedBytes: 0,
    fileOffset: 0,
    resyncFrom: -1,
    suppressUntil: 0,
    lastResyncAt: 0,
    resyncAttempts: 0
  }

  state.sentry = new Sentry({
    to_terminal: (octets) => {
      // 协议未接管的字节：按 UTF-8 边界解码回文本再写终端
      const text = state.decoder.decode(Uint8Array.from(toOctets(octets)), { stream: true })
      if (!text) return

      // 协议崩掉之后的抑制窗：远端仍在推整帧二进制，而 Sentry 已不再接管，
      // 这些字节直接写进终端就是一屏乱码。整窗丢弃，只记账。
      if (Date.now() < state.suppressUntil) {
        state.residueChars += text.length
        return
      }

      // 传输期间/刚结束后/等待用户确认期间出现的、形如协议残渣的输出不写终端。
      // 例如结尾的 `\x18` 会被终端渲染成一个乱码字形（用户看到的就是它）；
      // 远端在等待回应时会不停重发 ZRQINIT，那些帧同样不该刷进终端。
      if (state.inProtocol || state.protocolEnded || state.pendingDetect) {
        if (isResidueText(text)) {
          state.residueChars += text.length
          return
        }
      }
      hooks.write(text)
    },
    on_retract: () => {
      // 检测被推翻只影响「还能不能用这次 Detection」，不代表用户的流程结束了：
      // prompting 由 handleDetect 显式管理（远端重发起始帧也会触发 retract，
      // 这里清掉会让用户在选择目录期间又冒出第二个弹窗）。
      // 用户已经表达过同意时保持 autoConfirm，等下一次检测自动接管。
      if (!state.autoConfirm) state.pendingDetect = false
    },
    sender: (octets) => {
      hooks.send(Uint8Array.from(toOctets(octets)))
    },
    on_detect: (detection: Detection) => {
      state.pendingDetect = true
      // 远端在等回应时会不断重发起始帧；每次检测都覆盖「最新」，用户答复后用最新的那次接手，
      // 避免拿着已经失效的 Detection 去 confirm（那会抛 Stale ZMODEM session，界面就卡住了）。
      state.latest = detection
      void handleDetect(sessionId, state, detection, hooks)
    }
  })

  states.set(sessionId, state)
}

async function handleDetect(
  sessionId: string,
  state: SessionState,
  detection: Detection,
  hooks: ZmodemHooks
): Promise<void> {
  if (state.active) return

  // get_session_role() 返回的就是「我方角色」：
  //   'receive' = 对端 sz 发文件给我们（ZRQINIT 由发送方发出）
  //   'send'    = 对端 rz 要收文件，由我们发（ZRINIT 由接收方发出）
  // 因此直接采用，切勿取反。
  const direction: ZmodemDirection =
    detection.get_session_role() === 'receive' ? 'receive' : 'send'

  // 用户已经点过「接收/发送」，只是中途检测被远端重发刷新过：直接接管，不再二次打扰。
  if (state.autoConfirm === direction) {
    state.prompting = false
    startSession(sessionId, state, detection, direction)
    return
  }

  // 已经有一个流程在路上（正在弹窗、或正在让用户选保存文件夹）。
  // 此时远端重发的起始帧只更新 state.latest，不再叠加弹窗、也不并行开第二个流程。
  if (state.prompting) return

  state.prompting = true
  emit(sessionId, {
    phase: 'detected',
    direction,
    bytesDone: 0,
    bytesTotal: 0
  })

  // 确认询问必须可被取消：用户点「中断」时 abortZmodem 会调用 cancelConfirm，
  // 让这里立刻得到 false 继续走拒绝分支，而不是永远吊在 await 上。
  let ok = false
  try {
    ok = await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (v: boolean): void => {
        if (settled) return
        settled = true
        if (state.cancelConfirm === cancel) state.cancelConfirm = null
        resolve(v)
      }
      const cancel = (): void => finish(false)
      state.cancelConfirm = cancel
      hooks.confirm(direction).then(finish, () => finish(false))
    })
  } catch {
    ok = false
  } finally {
    state.cancelConfirm = null
  }

  if (!ok) {
    state.prompting = false;
    // 用户拒绝：发送中止序列，让远端退出 sz/rz
    state.autoConfirm = null
    state.pendingDetect = false
    clearAutoTimer(state)
    try {
      detection.deny()
    } catch {
      /* 已被推翻则忽略 */
    }
    emit(sessionId, {
      phase: 'error',
      direction,
      bytesDone: 0,
      bytesTotal: 0,
      message: '已取消'
    })
    return
  }

  // 接收方向：先定下保存文件夹（多文件 sz 只问一次），再向远端要数据。
  // 顺序很重要 —— 必须在 confirm/start 之前问，否则远端已经在等 ZRPOS，
  // 用户挑目录的几十秒会被它当成超时。
  if (direction === 'receive' && !state.saveDirToken) {
    const picked = await pickSaveDir()
    if (!picked) {
      state.prompting = false
      state.autoConfirm = null
      state.pendingDetect = false
      clearAutoTimer(state)
      try {
        detection.deny()
      } catch {
        /* 忽略 */
      }
      emit(sessionId, {
        phase: 'error',
        direction,
        bytesDone: 0,
        bytesTotal: 0,
        message: '未选择保存文件夹，已取消'
      })
      return
    }
    state.saveDirToken = picked.token
  }

  state.prompting = false
  startSession(sessionId, state, detection, direction)
}

/** 建立协议会话：confirm() 之后立刻 start()，这是远端能继续下去的前提 */
function startSession(
  sessionId: string,
  state: SessionState,
  detection: Detection,
  direction: ZmodemDirection
): void {
  // 用户答复期间远端可能已重发过起始帧：优先用仍然有效的最新检测。
  const fresh =
    state.latest && state.latest !== detection && state.latest.is_valid()
      ? state.latest
      : detection

  let session: ZmodemSession
  try {
    session = fresh.confirm()
  } catch {
    // 检测已被后续字节推翻（远端等回应时会重发起始帧）。
    // 记住用户的选择，等下一次 on_detect 直接接管 —— 不能静默 return，
    // 否则界面会永远停在「等待」上。
    state.autoConfirm = direction
    armAutoTimer(sessionId, state)
    emit(sessionId, {
      phase: 'detected',
      direction,
      bytesDone: 0,
      bytesTotal: 0,
      message: '等待远端重发起始帧…'
    })
    return
  }

  state.autoConfirm = null
  state.pendingDetect = false
  state.latest = null
  state.direction = direction
  clearAutoTimer(state)

  state.active = session
  state.everHadSession = true

  // 进入协议态：从现在起直到会话结束，终端上出现的是协议残渣而非正常输出，
  // 交给 residue 缓冲区收集，等会话结束后统一清理（见 scheduleResidueFlush）。
  state.inProtocol = true
  state.protocolEnded = false

  session.on('session_end', () => {
    state.active = null
    state.inProtocol = false
    state.saveDirToken = null
    state.autoConfirm = null
    state.pendingDetect = false
    state.latest = null
    state.receivedBytes = 0
    state.resyncAttempts = 0
    state.lastResyncAt = 0
    clearAutoTimer(state)
    clearStallTimer(state)
    // 会话结束后排一次清理：远端可能还会补发一点残渣，给它一个短暂窗口
    scheduleResidueFlush(state)
  })

  // 位置校验以对端为准：真 sz 在 ZRPOS 之后会把整帧从头重发，
  // 库默认会因此抛 "Error correction is unimplemented." 把会话判死。
  relaxDataOffset(session)

  // ZCRCW 是「帧结束，等 ZACK」：lrzsz 的 sz 用它在窗口边界收确认。
  // 本库的条件是 ack_expected() && !frame_end()，正好把这个组合排除掉了，
  // 于是永远不回 ZACK，远端等不到确认就停在当前百分比。
  // data_in 带完整子包，可以在这里按库自身的 _file_offset 补一个 ZACK。
  //
  // 注意："data_in" 只有接收方向（Session.Receive）注册过，
  // 发送方向注册会抛 "Bad event: data_in" —— 在 async 里就是一次未处理的
  // rejection，runSend 根本轮不到执行，上传直接卡死在 0%。必须按方向判断。
  if (direction === 'receive') session.on('data_in', (subpacket: ZmodemSubpacket) => {
    try {
      if (!subpacket.ack_expected() || !subpacket.frame_end()) return
      const offset =
        typeof (session as unknown as { _file_offset?: number })._file_offset === 'number'
          ? (session as unknown as { _file_offset: number })._file_offset
          : state.receivedBytes + subpacket.get_payload().length
      const ack = ZmodemModule.Header.build(
        'ZACK',
        ZmodemModule.ENCODELIB.pack_u32_le(offset)
      ).to_hex()
      state.hooks.send(Uint8Array.from(ack))
    } catch {
      // 补 ACK 是尽力而为：失败就算了，真正的进度由 on_input 的字节数决定
    }
  })

  if (direction === 'receive') {
    void runReceive(sessionId, session, state)
  } else {
    // 发送方向进传输前先拔掉库里的两条挂起路径（保活覆盖处理器表 / ZSINIT 死等 ZACK）
    primeSendSession(session)
    void runSend(sessionId, session, state)
  }
}

function clearAutoTimer(state: SessionState): void {
  if (state.autoTimer) {
    clearTimeout(state.autoTimer)
    state.autoTimer = undefined
  }
}

/**
 * 看门狗：用户点了接收、但远端一直没再发起始帧（多半是 sz 已经放弃退出），
 * 过一段时间必须把界面从「等待」里放出来，不能一直转圈。
 */
function armAutoTimer(sessionId: string, state: SessionState): void {
  clearAutoTimer(state)
  state.autoTimer = setTimeout(() => {
    state.autoTimer = undefined
    if (state.active) return
    const direction = state.autoConfirm ?? state.direction ?? 'receive'
    state.autoConfirm = null
    state.pendingDetect = false
    state.saveDirToken = null
    state.inProtocol = false
    state.protocolEnded = false
    emit(sessionId, {
      phase: 'error',
      direction,
      bytesDone: 0,
      bytesTotal: 0,
      message: '远端已停止等待（超时），请重新执行 sz'
    })
  }, AUTO_CONFIRM_TIMEOUT_MS)
}

/** 会话已建立、但远端迟迟不发数据时的提示（不 abort，只提醒用户可以中断） */
function clearStallTimer(state: SessionState): void {
  if (state.stallTimer) {
    clearTimeout(state.stallTimer)
    state.stallTimer = undefined
  }
}

function armStallTimer(sessionId: string, state: SessionState, fileName?: string): void {
  clearStallTimer(state)
  state.stallTimer = setTimeout(() => {
    state.stallTimer = undefined
    if (!state.active) return
    if (state.receivedBytes > 0) return
    const snap = lastProgress.get(sessionId)
    emit(sessionId, {
      phase: 'active',
      direction: 'receive',
      fileName: fileName ?? snap?.fileName,
      bytesDone: 0,
      bytesTotal: snap?.bytesTotal ?? 0,
      message: '已等待 15 秒仍未收到数据，远端可能没在发送 —— 可按「中断」退出或重新执行 sz'
    })
  }, RECEIVE_STALL_MS)
}

/**
 * 会话结束后收尾：冲掉流式解码器里可能残留的半字符，
 * 并在一小段窗口后解除「协议态」标记，让终端恢复正常输出。
 *
 * 说明：协议残渣是在 to_terminal 里就直接拦下、不写终端的（见 isResidueText），
 * 所以这里不需要再去终端回删，只需负责状态归位与窗口计时。
 */
function scheduleResidueFlush(state: SessionState): void {
  if (state.residueTimer) clearTimeout(state.residueTimer)
  state.residueTimer = setTimeout(() => {
    state.residueTimer = undefined
    // 冲掉流式解码器里可能残留的半字符
    state.decoder.decode(new Uint8Array(0))
    state.residueChars = 0
    state.everHadSession = false
    // 协议结束后补一个换行：远端 sz/rz 退出时通常不回 \r\n，
    // 导致后续的 shell 提示符与传输最后一行挤在同一行。
    state.hooks.afterTransfer?.()
    state.protocolEnded = false
  }, RESIDUE_WINDOW_MS)
}

/** 让用户选一次保存文件夹；取消或失败返回 null */
async function pickSaveDir(): Promise<{ token: string; dir: string } | null> {
  try {
    const res = await window.api.zmodem.pickDir()
    if (!res.ok || res.data.canceled || !res.data.token) return null
    return { token: res.data.token, dir: res.data.dir || '' }
  } catch {
    return null
  }
}

/**
 * 让用户重新选一次保存文件夹（进度面板上的「选择文件夹」按钮）。
 *
 * 为什么需要这个入口：确认弹窗之后本该自动弹目录选择框，但系统对话框
 * 有可能被窗口抢焦点而看不见 —— 用户看到的就是「点了接收，然后一直
 * 等待，也不让选文件夹」。给一个随时可点的按钮，就不用干等。
 */
export async function chooseZmodemSaveDir(sessionId: string): Promise<boolean> {
  const state = states.get(sessionId)
  if (!state) return false
  const picked = await pickSaveDir()
  if (!picked) {
    emit(sessionId, {
      phase: 'error',
      direction: 'receive',
      bytesDone: 0,
      bytesTotal: 0,
      message: '未选择保存文件夹，已取消'
    })
    return false
  }
  state.saveDirToken = picked.token
  const snap = lastProgress.get(sessionId)
  emit(sessionId, {
    phase: snap && snap.phase !== 'done' ? snap.phase : 'detected',
    direction: 'receive',
    fileName: snap?.fileName,
    bytesDone: snap?.bytesDone ?? 0,
    bytesTotal: snap?.bytesTotal ?? 0,
    message: `保存到：${picked.dir}`
  })
  return true
}

/**
 * 在已选目录里建目标文件（重名自动编号）。
 * 目录令牌可能已过期（用户选完目录隔了很久才有文件），此时重新问一次。
 */
async function beginSave(
  state: SessionState,
  fileName: string
): Promise<{ saveId: string; path: string } | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!state.saveDirToken) {
      const picked = await pickSaveDir()
      if (!picked) return null
      state.saveDirToken = picked.token
    }
    try {
      const res = await window.api.zmodem.saveBegin(state.saveDirToken, fileName)
      if (res.ok) return res.data
    } catch {
      /* 落到下面重选 */
    }
    state.saveDirToken = null
  }
  return null
}

/** 远端 sz 发文件 -> 本机保存 */
async function runReceive(
  sessionId: string,
  session: ZmodemSession,
  state: SessionState
): Promise<void> {
  session.on('offer', (offer: ZmodemOffer) => {
    void handleOffer(sessionId, state, offer)
  })

  // 关键一步：Receive 会话创建后必须 start() 才会发出第一个 ZRINIT。
  // 少了它，远端 sz 永远等不到回应 —— 界面上就是「收取」之后一直等待。
  try {
    await session.start()
    // 发出 ZRINIT 之后远端应当开始推文件；迟迟没动静就提醒，避免纯干等。
    armStallTimer(sessionId, state)
  } catch (err) {
    emit(sessionId, {
      phase: 'error',
      direction: 'receive',
      bytesDone: 0,
      bytesTotal: 0,
      message: `ZMODEM 接收启动失败：${errText(err)}`
    })
    try {
      session.abort()
    } catch {
      /* 已结束 */
    }
  }
}

async function handleOffer(
  sessionId: string,
  state: SessionState,
  offer: ZmodemOffer
): Promise<void> {
  let details: { name?: string; size?: number }
  try {
    details = offer.get_details()
  } catch {
    details = { name: 'download.bin', size: 0 }
  }
  const fileName = details.name || 'download.bin'
  const total = details.size || 0

  clearStallTimer(state)
  const target = await beginSave(state, fileName)
  if (!target) {
    // 用户放弃选目录：跳过这个文件，协议照常继续（多文件时下次还会问）
    try {
      offer.skip()
    } catch {
      /* 忽略 */
    }
    emit(sessionId, {
      phase: 'error',
      direction: 'receive',
      fileName,
      bytesDone: 0,
      bytesTotal: total,
      message: '未选择保存位置，已跳过'
    })
    return
  }

  state.fileOffset = 0
  state.resyncFrom = -1
  const chunks: Uint8Array[] = []
  let pending = 0
  let written = 0
  let queue: Promise<void> = Promise.resolve()
  let failed: string | null = null
  /** 已经按顺序认下的文件内偏移（= 已排队落盘）。续传的 ZRPOS 就报这个数 */
  let cursor = 0
  /** 对端下一位数据落在文件的哪个位置；续传后对端可能从更早处重发，靠它对账 */
  let expected = 0

  // 攒够一块再落盘：sz 的分包很小，逐包 IPC 会让传输慢到不可用
  const flush = (): void => {
    if (!pending) return
    const buf = concat(chunks)
    chunks.length = 0
    pending = 0
    const b64 = toBase64(buf)
    queue = queue.then(async () => {
      const res = await window.api.zmodem.saveAppend(target.saveId, b64)
      if (res.ok) written = res.data.bytes
      else failed = res.error
    })
  }

  // 完成信号以 offer 的 'complete'（库消费到 ZEOF 时触发）为准。
  // accept() 返回的 promise 只有在「一次协议错误都没发生」时才会兑现；
  // 一旦走了断点续传，那条链就被新的 _accept() 顶替，永远不会有结果。
  const completed = new Promise<void>((resolve) => {
    try {
      offer.on('complete', () => {
        resolve()
      })
    } catch {
      /* 库里没有这个事件时退回纯 accept() 等待 */
    }
  })

  try {
    const accepted = offer.accept({
      on_input: (payload: Uint8Array) => {
        // 续传刚落定：对端从这个位置往后发，之前已经认下的那段不能再算一遍
        if (state.resyncFrom >= 0) {
          expected = state.resyncFrom
          state.resyncFrom = -1
        }
        const start = expected
        const end = start + payload.length
        expected = end

        // 落盘接口是「只追加」的，所以续传后对端即便从 0 重来也只能跳过已认下的前缀
        // 文件尾之后的一切都是重发/串味，丢掉（否则文件会比源文件大一倍）
        if (total > 0 && start >= total) {
          state.receivedBytes += payload.length
          return
        }
        if (end <= cursor) {
          // 整块都是重发，丢掉即可
          state.receivedBytes += payload.length
          return
        }
        // 与已认下部分重叠时只保留尾巴，超出文件尾的部分截断
        let piece = start < cursor ? payload.subarray(cursor - start) : payload
        if (total > 0 && cursor + piece.length > total) {
          piece = piece.subarray(0, total - cursor)
        }
        if (!piece.length) {
          state.receivedBytes += payload.length
          return
        }

        state.receivedBytes += payload.length
        cursor += piece.length
        state.fileOffset = cursor
        chunks.push(piece)
        pending += piece.length
        if (pending >= RECEIVE_FLUSH_BYTES) flush()
        emit(sessionId, {
          phase: 'active',
          direction: 'receive',
          fileName,
          bytesDone: written + pending,
          bytesTotal: total
        })
      }
    })

    await Promise.race([accepted.then(() => undefined), completed])

    clearStallTimer(state)
    state.resyncAttempts = 0
    state.lastResyncAt = 0
    flush()
    await queue

    if (failed) {
      emit(sessionId, {
        phase: 'error',
        direction: 'receive',
        fileName,
        bytesDone: written,
        bytesTotal: total || written,
        message: failed
      })
      return
    }

    const fin = await window.api.zmodem.saveFinish(target.saveId)
    if (!fin.ok) {
      emit(sessionId, {
        phase: 'error',
        direction: 'receive',
        fileName,
        bytesDone: written,
        bytesTotal: total || written,
        message: fin.error
      })
      return
    }
    emit(sessionId, {
      phase: 'done',
      direction: 'receive',
      fileName,
      bytesDone: fin.data.size,
      bytesTotal: total || fin.data.size,
      message: `已保存到 ${fin.data.path}`
    })
  } catch (err) {
    // 已经收到的字节先落盘，不论后面是续传还是放弃都不能丢
    flush()
    await queue.catch(() => undefined)

    if (resyncReceive(sessionId, state, err)) {
      // 续传链路已建立：不结束流程，等对端从断点续发（由 'complete' 收尾）
      armStallTimer(sessionId, state, fileName)
      return
    }

    // 真的失败：把远端还在喷的二进制挡在终端之外，并把已收到的部分收尾，
    // 否则用户既丢了文件又看不到任何解释。
    state.suppressUntil = Date.now() + GARBLE_SUPPRESS_MS
    let message = errText(err)
    const fin2 = await window.api.zmodem.saveFinish(target.saveId).catch(() => null)
    if (fin2?.ok && fin2.data.size > 0) {
      message = `传输中断：${message}（已保留前 ${fin2.data.size} 字节）`
    }
    emit(sessionId, {
      phase: 'error',
      direction: 'receive',
      fileName,
      bytesDone: written,
      bytesTotal: total || written,
      message
    })
  }
}

/**
 * 发送方向：进传输前把库里几条「一旦对端不配合就永远挂着」的路径拆掉。
 *
 * 1) 库自带的保活每 5 秒把 _next_header_handler 换成 {ZACK} 再发一帧 ZSINIT，
 *    而 send_offer 自己也要在这张表上装 {ZSKIP, ZRPOS}。两者互相覆盖，谁后装谁赢；
 *    输的那一方等到的头部落进空表 → 库抛 "Unhandled header: ZACK" → 会话判死。
 *    这里直接停掉库的保活，改用我们自己的（见 startSendKeepalive）。
 * 2) _ensure_receiver_escapes_ctrl_chars() 只是给对端补一帧 ZSINIT 并等它的 ZACK，
 *    全程没有超时。对端不回（rz 认为这是冗余帧，或者根本没在跑）就永远停在 0 字节。
 *    标记「已收到 ZACK」跳过这个等待，自己补发一次 ZSINIT 把协商做完。
 * 3) 迟到 / 重复的确认帧不能当作协议错误 —— 那是 recoverFromError -> abort，
 *    用户看到的就是「文件传完了但界面报错、rz 又弹一次」。装一个兜底处理器吞掉它们。
 */
function primeSendSession(session: ZmodemSession): void {
  const raw = session as unknown as SendSessionInternals

  // 停掉库的保活链：清掉当前定时器，并把 _start_keepalive 固定成空函数，
  // 否则已经进入 .then 的那一轮会把保活重新拉起来（库的 _stop_keepalive 还拼错了字段名）
  if (raw._keepalive_timeout !== undefined && raw._keepalive_timeout !== null) {
    clearTimeout(raw._keepalive_timeout as ReturnType<typeof setTimeout>)
  }
  raw._keepalive_promise = null
  raw._start_keepalive = () => {}

  raw._got_ZSINIT_ZACK = true
  installSendHeaderFallback(session)

  // 协商控制字符转义：我们自己发一帧 ZSINIT（rz 会回 ZACK，回不回都不影响后续）
  try {
    raw._send_ZSINIT?.()
  } catch {
    /* 协商是尽力而为，失败时按库的默认（强制转义）继续 */
  }
}

/** 发送方向允许被静默吞掉的头部：确认帧与对端的重发/握手噪声 */
const BENIGN_SEND_HEADERS = new Set(['ZACK', 'ZRINIT', 'ZSINIT', 'ZFIN', 'ZRQINIT'])

/**
 * 给会话装一个「没人认领的头部」兜底。
 * 库的 _consume_header 找不到处理器就抛错，而这个错会一路走到 abort ——
 * 一张迟到的 ZACK 就足以把已经传完的文件判成失败。这里只吞协议噪声，
 * 真正需要处理的头部（ZRPOS/ZDATA…）仍按原逻辑抛。
 */
function installSendHeaderFallback(session: ZmodemSession): void {
  const raw = session as unknown as SendSessionInternals
  const original = raw._consume_header
  if (typeof original !== 'function') return

  raw._consume_header = function patched(this: unknown, hdr: { NAME: string }) {
    const self = this as { _next_header_handler?: Record<string, unknown> | null }
    const table = self._next_header_handler
    // 有处理器就照原样交出去（库里会自己把表清掉）
    if (table && table[hdr.NAME]) {
      original.call(self, hdr)
      return
    }
    // 没人认领的确认帧直接丢掉。注意不能顺手把表清空：
    // 表里此刻可能正等着 ZRPOS/ZSKIP，清掉就等于把真正的应答也一起弄丢。
    if (BENIGN_SEND_HEADERS.has(hdr.NAME)) return
    original.call(self, hdr)
  }
}

/**
 * 等远端确认时的自身保活：rz 等 ZFILE 有超时（lrzsz 会重试几轮 ZRINIT 后退出），
 * 而用户挑一个几 MB 的文件很容易超过它。每 SEND_KEEPALIVE_MS 补一帧 ZSINIT 把它按住。
 * 返回的停止函数在真正开始传数据前必须调用 —— 传输中插协议帧没有意义。
 */
function startSendKeepalive(session: ZmodemSession, state: SessionState): () => void {
  const raw = session as unknown as SendSessionInternals
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const tick = (): void => {
    if (stopped) return
    if (state.active !== session) {
      stopped = true
      return
    }
    try {
      raw._send_ZSINIT?.()
    } catch {
      stopped = true
      return
    }
    timer = setTimeout(tick, SEND_KEEPALIVE_MS)
  }

  timer = setTimeout(tick, SEND_KEEPALIVE_MS)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

/** 发送方向用到的库内部字段（zmodem.js 没有导出这些类型） */
interface SendSessionInternals {
  _got_ZSINIT_ZACK?: boolean
  _keepalive_promise?: unknown
  _keepalive_timeout?: unknown
  _start_keepalive?: () => void
  _send_ZSINIT?: () => void
  _consume_header?: (hdr: { NAME: string }) => void
}

/** 一步等待的结果：超时不算异常，按可控失败处理 */
type SendStep<T> = { ok: true; value: T } | { ok: false; message: string }

/**
 * 给「等对端回应」加硬超时。
 * 库里的 send_offer / Transfer.end / close 都只是挂一个 promise，收不到对应头部就永不兑现，
 * 界面于是永远停在进度条上。超时后返回失败，由调用方 abort 并把原因报给用户。
 */
async function awaitSendStep<T>(
  work: Promise<T>,
  what: string
): Promise<SendStep<T>> {
  // 超时放弃后这条链仍可能以 rejection 结束，先挂一个处理器免得冒成未捕获异常
  work.catch(() => {
    /* 已按超时处理 */
  })

  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<SendStep<T>>((resolve) => {
    timer = setTimeout(() => {
      resolve({
        ok: false,
        message: `${what}：远端 ${Math.round(SEND_RESPONSE_TIMEOUT_MS / 1000)} 秒无回应`
      })
    }, SEND_RESPONSE_TIMEOUT_MS)
  })

  try {
    return await Promise.race([work.then((value) => ({ ok: true as const, value })), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 让出一次事件循环：几 MB 的文件若在一个同步循环里塞完，界面会整段冻结 */
function yieldToUi(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** 本机选文件 -> 远端 rz 接收 */
async function runSend(
  sessionId: string,
  session: ZmodemSession,
  state: SessionState
): Promise<void> {
  let stopKeepalive: (() => void) | null = null

  const keepaliveOn = (): void => {
    if (!stopKeepalive && state.active === session) {
      stopKeepalive = startSendKeepalive(session, state)
    }
  }
  const keepaliveOff = (): void => {
    stopKeepalive?.()
    stopKeepalive = null
  }

  // 一确认就开始按住对端：用户挑文件可能要几十秒，而远端 rz 等 ZFILE 有自己的超时
  //（lrzsz 重试几轮 ZRINIT 就退出）。等文件选完再保活，rz 早就走了。
  keepaliveOn()

  const pickedRes = await window.api.zmodem.pickFiles()
  const picked = pickedRes.ok ? pickedRes.data : { canceled: true, files: [] }
  if (!pickedRes.ok || picked.canceled || !picked.files.length) {
    keepaliveOff()
    // 用户取消选文件：远端 rz 还等在原地。close() 在这种「还没发过 ZFILE」的
    // 状态下会直接抛（最后一个头部仍是 ZRINIT），这时必须走 abort 把 CAN 序列
    // 发出去，否则 rz 会一直重试 ZRINIT，界面反复弹确认。
    let closed = false
    try {
      session.close()
      closed = true
    } catch {
      /* close 的前置条件不满足 */
    }
    if (!closed) {
      try {
        session.abort()
      } catch {
        /* 已结束 */
      }
    }
    emit(sessionId, {
      phase: 'error',
      direction: 'send',
      bytesDone: 0,
      bytesTotal: 0,
      message: pickedRes.ok ? '未选择文件' : pickedRes.error
    })
    return
  }

  const total = picked.files.reduce((a, f) => a + f.size, 0)
  let sent = 0
  let currentFile: string | undefined

  /**
   * 失败统一走这里：先停保活，再 abort。
   * abort 不只是「收尾好看」—— 远端 rz 还在按自己的重试节奏发 ZRINIT，
   * 不掐断的话下一次 on_detect 会让界面重新弹一次确认，用户看到的就是
   * 「传完了又让我重来一遍」。abort 会发 CAN 序列让它立刻退出。
   */
  const fail = (message: string): void => {
    stopKeepalive?.()
    stopKeepalive = null
    try {
      session.abort()
    } catch {
      /* 已结束或已中止 */
    }
    emit(sessionId, {
      phase: 'error',
      direction: 'send',
      fileName: currentFile,
      bytesDone: sent,
      bytesTotal: total,
      message
    })
  }

  for (const file of picked.files) {
    currentFile = file.name
    // 挑下一个文件的间隙同样没有数据帧，接着按住对端
    keepaliveOn()

    // 显式标注：没有它 TS 会把 `send_offer` 的返回值当成 any（zmodem.js 无自带类型），
    // 后面 transfer.get_offset()/send()/end() 就全成了不安全的 any 调用
    let transfer: ZmodemTransfer | undefined
    try {
      // 对端没在跑 rz、或者已经放弃退出时，这个 promise 永远不兑现 —— 必须带超时
      const step = await awaitSendStep(
        session.send_offer({ name: file.name, size: file.size, mtime: new Date() }),
        `等待远端接受 ${file.name}`
      )
      if (!step.ok) {
        fail(step.message)
        return
      }
      transfer = step.value
    } catch (err) {
      fail(errText(err))
      return
    }

    // 对端跳过该文件（ZSKIP），换下一个
    if (!transfer) continue

    // 数据帧马上开始：这一段里再插 ZSINIT 只会打乱对端的解包状态
    keepaliveOff()

    try {
      const bytes = fromBase64(file.data)
      let sinceYield = 0
      for (let off = transfer.get_offset(); off < bytes.length; off += SEND_CHUNK_BYTES) {
        const slice = bytes.subarray(off, Math.min(off + SEND_CHUNK_BYTES, bytes.length))
        transfer.send(slice)
        sent += slice.length
        sinceYield += slice.length
        emit(sessionId, {
          phase: 'active',
          direction: 'send',
          fileName: file.name,
          bytesDone: sent,
          bytesTotal: total
        })
        // 几 MB 的文件在一个同步循环里塞完会让渲染进程整段卡死，
        // 期间连中断按钮都点不动，所以按固定字节数定期让出
        if (sinceYield >= SEND_YIELD_BYTES) {
          sinceYield = 0
          await yieldToUi()
        }
      }

      // ZEOF 之后对端要回 ZRINIT 才算这个文件落地，这里同样不能无限等
      const endStep = await awaitSendStep(transfer.end(), `等待远端确认 ${file.name}`)
      if (!endStep.ok) {
        fail(endStep.message)
        return
      }
    } catch (err) {
      fail(errText(err))
      return
    }
  }

  keepaliveOff()

  // 收尾：close() 要求此刻的最后一个头部是 ZRINIT/ZSKIP，否则直接抛错
  // （多文件时若对端跳过了最后一个文件，条件就不成立）。文件其实已经传完了，
  // 所以这里失败只在完成事件里附一句提示，不能反过来否定传输结果。
  let closeNote: string | undefined
  try {
    const step = await awaitSendStep(Promise.resolve(session.close()), '结束会话')
    if (!step.ok) closeNote = step.message
  } catch (err) {
    closeNote = errText(err)
  }
  if (closeNote) {
    // 正常收尾没走完：会话对象还挂在 Sentry 上，不清掉的话下一次 rz 的起始帧
    // 会被这个旧会话当成「未知头部」吞掉，表现为「再传就完全没反应」。
    try {
      session.abort()
    } catch {
      /* 已结束 */
    }
  }

  emit(sessionId, {
    phase: 'done',
    direction: 'send',
    fileName: picked.files.length === 1 ? picked.files[0].name : `${picked.files.length} 个文件`,
    bytesDone: sent,
    bytesTotal: total,
    message: closeNote
  })
}

/** 该会话是否已挂载 Sentry（挂载后终端输出统一经 Sentry 转发） */
export function isZmodemAttached(sessionId: string): boolean {
  return states.has(sessionId)
}

/**
 * 这些异常的共同点：解析器手里的字节和协议状态对不上，但链路本身还活着。
 * 真实 sz 在丢包/重传时就会命中它们 —— 这时候 abort 才是错的。
 */
function isRecoverableProtocolError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return /Unhandled header:\s*ZDATA|Error correction is unimplemented|offset not ok|CRC check failed|PROTOCOL: Received unexpected data packet/i.test(
    message
  )
}

/**
 * 库内部接收状态机的最小视图。
 * zmodem.js 不导出这些成员，但断点续传必须借它们重建处理器 —— 每一项都标注了用途，
 * 升级库之后若名字变了，这里会直接失效（而不是静默走错分支）。
 */
interface RawReceiveSession {
  _input_buffer?: number[]
  _next_subpacket_handler?: unknown
  _next_header_handler?: Record<string, unknown> | null
  _file_offset?: number
  _offset_ok?: boolean
  _consume_ZDATA?: (hdr: { get_offset(): number }) => void
  _consume_ZEOF?: (hdr: { get_offset(): number }) => void
  _make_promise_for_between_files?: () => unknown
  _send_ZRINIT?: () => void
  _on_file_end?: () => void
}

/**
 * 放宽 ZDATA 头的位置校验。
 *
 * 库里的 _consume_ZDATA 一旦发现头的 offset 与自身 _file_offset 不等就抛
 * "Error correction is unimplemented."，而真 sz 收到 ZRPOS 之后经常把整帧
 * 从头重发（offset 比我们记录的更小）。位置以对端为准即可：重复的字节
 * 由 on_input 里的去重循环丢弃，不该因此把整个会话判死。
 */
function relaxDataOffset(session: ZmodemSession): void {
  const raw = session as unknown as RawReceiveSession
  const original = raw._consume_ZDATA
  if (typeof original !== 'function') return

  raw._consume_ZDATA = function (
    this: RawReceiveSession,
    hdr: { get_offset(): number }
  ): void {
    try {
      original.call(this, hdr)
    } catch (err) {
      if (!/Error correction is unimplemented/i.test(errText(err))) throw err
      this._file_offset = hdr.get_offset()
      this._offset_ok = true
    }
  }
}

/**
 * 续传时给处理器补一个 ZEOF 分支。
 *
 * _accept() 装的表只有 {ZDATA}：对端若已经发完（ZRPOS 正好落在文件尾），
 * 它会直接回 ZEOF，这里就变成 "Unhandled header: ZEOF" —— 一份收完的文件
 * 反而被判成失败。补上 ZEOF 后按库自己的收尾流程走，后续文件也能继续。
 */
function ensureEofHandler(session: ZmodemSession): void {
  const raw = session as unknown as RawReceiveSession
  const handlers = raw._next_header_handler
  if (!handlers || handlers.ZEOF) return

  handlers.ZEOF = function (this: RawReceiveSession, hdr: { get_offset(): number }): void {
    this._next_subpacket_handler = null
    try {
      this._consume_ZEOF?.(hdr)
    } catch {
      // ZEOF 的 offset 与本地不一致时也认这份文件收完：字节数由去重循环保证，
      // 不能因为一个确认帧对不上就把已经落盘的整份文件作废
      this._on_file_end?.()
    }
    try {
      this._make_promise_for_between_files?.()
      this._send_ZRINIT?.()
    } catch {
      /* 后续文件握手失败不影响本份收尾 */
    }
  }
}

/**
 * 断点续传：把解析器从错误状态里拽回来，并让对端从已经收到的字节处重发。
 *
 * 库的状态机在某一帧抛错后就把 ZDATA 处理器消费掉了，之后每帧都只会继续抛
 * "Unhandled header: ZDATA"。唯一能重建处理器的入口是内部的 _accept(offset)：
 * 它重装 {ZDATA} 处理器——顺带把 _accepted_offer/_file_offset 重新对齐——
 * 并主动发一个 ZRPOS。调用前必须先清掉异常残留的半帧，否则新处理器会先吃到脏字节。
 *
 * 注意 _accept() 会另起一个 promise，原来 offer.accept() 的那个永远不会兑现，
 * 所以完成判定不能依赖 await accept()，只能靠 offer 的 'complete' 事件（ZEOF 触发）。
 */
function resyncReceive(sessionId: string, state: SessionState, err: unknown): boolean {
  const session = state.active
  if (!session) return false
  if (!isRecoverableProtocolError(err)) return false

  const now = Date.now()
  // 坏帧往往一个接一个地来，限流 + 次数上限，避免把主线程和链路一起刷死。
  // 但「上一轮续传还没等到数据」（resyncFrom >= 0）时不限流：这时候来的多半是
  // ZRPOS 到达前就已经在链路上的旧帧，它会把刚装好的解析器再打坏一次，
  // 必须立刻重装，否则这一轮续传就白等了。
  if (state.resyncFrom < 0 && now - state.lastResyncAt < RESYNC_MIN_INTERVAL_MS) {
    return false
  }
  if (state.resyncAttempts >= RESYNC_MAX_ATTEMPTS) return false

  state.resyncAttempts += 1
  state.lastResyncAt = now

  try {
    const raw = session as unknown as {
      _input_buffer?: number[]
      _next_subpacket_handler?: unknown
    }
    // 异常抛出时输入缓冲里还留着半帧（探针里残留 10008 字节），必须清干净
    if (Array.isArray(raw._input_buffer)) raw._input_buffer.length = 0
    // 解析器可能停在「子包模式」，会把新 ZDATA 头当 payload 算 CRC → 连环 CRC 错
    raw._next_subpacket_handler = null

    // 续传报的是「文件内偏移」：多文件传输时累计字节数会把第二个文件报错位
    const offset = state.fileOffset
    // 对端可能从比 ZRPOS 更早的位置重发一整帧，先记下对账点，收数据时按它去重
    state.resyncFrom = offset
    // _accept 内部会重发 ZRPOS，对端据此从 offset 处续传
    void Promise.resolve(session._accept(offset)).catch(() => {
      /* 这条链的成败由 'complete' 事件决定，这里只防止未处理的 rejection */
    })
    // _accept 装的处理表只有 {ZDATA}：对端若正好发到文件尾会直接给 ZEOF，
    // 那份已经收完的文件就会变成 "Unhandled header: ZEOF" 而作废
    ensureEofHandler(session)
    emit(sessionId, {
      phase: 'active',
      direction: 'receive',
      bytesDone: offset,
      bytesTotal: lastProgress.get(sessionId)?.bytesTotal ?? 0,
      message: `链路抖动，已请求对端从 ${offset} 字节处续传（第 ${state.resyncAttempts} 次）`
    })
    return true
  } catch {
    return false
  }
}

/**
 * 把一段原始字节喂给会话的 Sentry。
 * raw 为 base64；没有 raw 时（例如主进程未提供）退化为直接把文本写回终端，
 * 宁可少一层协议解析也不能丢输出。
 */
export function feedZmodem(sessionId: string, rawBase64?: string, fallbackText?: string): void {
  const state = states.get(sessionId)
  if (!state) return

  if (!rawBase64) {
    if (fallbackText) state.hooks.write(fallbackText)
    return
  }

  try {
    state.sentry.consume(fromBase64(rawBase64))
  } catch (err) {
    // sz 在没看到 ZRINIT 之前会每隔几秒重发一次 ZRQINIT。若这份重传正好落进
    // 已经建立好的会话里，库会抛 "Unhandled header: ZRQINIT"。这不是错误，
    // 只是对端还没收到我们的 ZRINIT —— 此时绝不能 abort，否则文件传输半途夭折。
    if (state.active && isPeerRetransmit(err)) return

    // 丢帧 / 重传 / CRC 对不上：链路还活着，只是解析器掉了队。
    // 这里绝不能 abort —— abort 之后 Sentry 会把远端仍在推的整帧二进制直通终端，
    // 就是用户看到的满屏乱码。清缓冲 + 重装解析器 + ZRPOS 续传即可。
    if (resyncReceive(sessionId, state, err)) return

    // 真的救不回来了才复位。Sentry 里那个会话对象仍处于「已接管」状态，
    // 不 abort 的话后续输出会被它吃掉，终端看起来就像死了。
    const wasProtocol = state.inProtocol || state.everHadSession
    recoverFromError(state)
    // 协议态里这一帧是 ZMODEM 报文（二进制），写进终端就是一屏乱码；
    // 只有从没进过协议态时才按普通输出回退。
    if (fallbackText && !wasProtocol) state.hooks.write(fallbackText)
  }
}

/** 对端重发的起始帧（sz 的 ZRQINIT 重传），属于正常协议噪声 */
function isPeerRetransmit(err: unknown): boolean {
  // 不用 String(err)：传入普通对象会得到 "[object Object]"，既匹配不到也掩盖了真实原因
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  return /Unhandled header:\s*ZR?Q?INIT|Unhandled header:\s*ZRQINIT/i.test(message)
}

/**
 * 协议出错后的复位：中止会话并让字节流回到终端。
 * Sentry 会在 session_end 时把 _zsession 清空，之后输出自然恢复。
 */
function recoverFromError(state: SessionState): void {
  const stray = state.active ?? state.sentry.get_confirmed_session()
  // 掐断还挂着的确认询问，并把 prompting 复位 —— 否则后续 sz 会被
  // 「已有一个流程在路上」挡掉，永远不再弹窗。
  const cancel = state.cancelConfirm
  state.cancelConfirm = null
  state.prompting = false
  state.receivedBytes = 0
  cancel?.()
  clearStallTimer(state)
  state.active = null
  state.inProtocol = false
  state.protocolEnded = false
  state.pendingDetect = false
  state.autoConfirm = null
  state.saveDirToken = null
  state.latest = null
  clearAutoTimer(state)
  try {
    stray?.abort()
  } catch {
    /* 已结束或已中止 */
  }
  // abort 之后 Sentry 不再接管输出，而远端还在推数据帧 —— 开一个抑制窗把这些
  // 二进制挡在终端之外，否则界面会被刷成一片乱码。
  state.suppressUntil = Date.now() + GARBLE_SUPPRESS_MS
  state.resyncAttempts = 0
  state.lastResyncAt = 0
}

/** 用户主动中断当前传输（进度面板的「中断」按钮 / Esc） */
export function abortZmodem(sessionId: string): void {
  const state = states.get(sessionId)
  if (!state) return

  const wasActive = !!state.active
  const direction = state.direction ?? 'receive'
  recoverFromError(state)

  if (wasActive) {
    emit(sessionId, {
      phase: 'error',
      direction,
      bytesDone: 0,
      bytesTotal: 0,
      message: '已中断传输'
    })
  }
}

/** 会话关闭时清理 */
export function detachZmodem(sessionId: string): void {
  const state = states.get(sessionId)
  if (!state) return
  try {
    state.active?.abort()
  } catch {
    /* 忽略 */
  }
  clearAutoTimer(state)
  clearStallTimer(state)
  states.delete(sessionId)
  watchers.delete(sessionId)
  lastProgress.delete(sessionId)
}

/** 该会话当前是否有活动的 ZMODEM 传输 */
export function isZmodemActive(sessionId: string): boolean {
  return !!states.get(sessionId)?.active
}

/* ------------------------------------------------------------------ *
 *  确认交互：由 UI 注册处理器，模块只负责发起询问
 * ------------------------------------------------------------------ */

type ConfirmHandler = (direction: ZmodemDirection) => Promise<boolean>

let confirmHandler: ConfirmHandler | null = null

/** UI 注册确认处理器（ZmodemPrompt 组件挂载时调用） */
export function setZmodemConfirmHandler(fn: ConfirmHandler | null): void {
  confirmHandler = fn
}

/** 模块内部发起确认；没有注册处理器时默认拒绝，避免静默接管字节流 */
export function requestZmodemConfirm(direction: ZmodemDirection): Promise<boolean> {
  if (!confirmHandler) return Promise.resolve(false)
  return confirmHandler(direction)
}

/* ------------------------------------------------------------------ *
 *  base64 / Uint8Array 互转（渲染进程没有 Buffer）
 * ------------------------------------------------------------------ */

export function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let bin = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(bin)
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

const toBase64 = bytesToBase64

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((a, c) => a + c.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.length
  }
  return out
}

/* ------------------------------------------------------------------ *
 *  自动化测试钩子
 *  仅当构建时注入 VITE_ZM_TEST=1 时挂到 window，供无头验证使用；
 *  正常构建不会带上，避免暴露内部接口。
 *  判定用编译期字面量（Vite define 注入），不做运行时对象探测：
 *  实测 __vite_import_meta_env__ 在本项目的加载方式下取不到值。
 * ------------------------------------------------------------------ */

declare const __ZM_TEST__: boolean | undefined

const ZM_TEST_ENABLED = typeof __ZM_TEST__ !== 'undefined' && __ZM_TEST__ === true

declare global {
  interface Window {
    __zm_test?: {
      ensureZmodem: typeof ensureZmodem
      detachZmodem: typeof detachZmodem
      feedZmodem: typeof feedZmodem
      isZmodemAttached: typeof isZmodemAttached
      abortZmodem: typeof abortZmodem
      bytesToBase64: typeof bytesToBase64
      testBuildZRQINIT: () => number[]
    }
  }
}

if (ZM_TEST_ENABLED && typeof window !== 'undefined') {
  window.__zm_test = {
    ensureZmodem,
    detachZmodem,
    feedZmodem,
    isZmodemAttached,
    abortZmodem,
    bytesToBase64,
    // 构造真实的 ZMODEM 起始帧，避免测试里硬编码字节序列
    testBuildZRQINIT: (): number[] => {
      const hdr = ZmodemModule.Header.build('ZRQINIT', [0, 0, 0, 0])
      return hdr.to_hex()
    }
  }
}
