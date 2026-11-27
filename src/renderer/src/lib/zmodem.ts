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
// 相对路径而非 @/ 别名：scripts/verify-zmodem-renderer.cjs 用 esbuild 单独打包
// 这个文件跑无头回归，那里只配了 @shared 一个别名，@/ 会直接解析失败
import { uid } from './utils'
import { reportZmodemRecord } from './zmodemRecord'
import { tNow } from '../i18n/core'

/** 传输方向：send = 本机发给远端（对端 rz）；receive = 远端发给本机（对端 sz） */
export type ZmodemDirection = 'send' | 'receive'

export interface ZmodemProgress {
  /**
   * 'detected' 待确认，'active' 传输中，'done' 完成，'error' 失败，'canceled' 用户主动放弃。
   *
   * canceled 与 error 必须分开：用户点了「中断」既不是成功也不是故障，
   * 记进历史账本时用灰色而不是红色，否则用户会以为是自己网络坏了。
   */
  phase: 'detected' | 'active' | 'done' | 'error' | 'canceled'
  direction: ZmodemDirection
  fileName?: string
  bytesDone: number
  bytesTotal: number
  message?: string
  /**
   * 本次传输的稳定 id：进度帧每 150ms 换一次对象，历史账本却要靠它
   * 把「开始 / 收尾」两次写入认成同一条记录。
   */
  transferId?: string
  /** 本机路径：接收方向是落盘文件，发送方向是源文件。拿不到就留空。 */
  localPath?: string
  /** 远端路径：ZMODEM 两端都不告诉对端路径，恒为空，保留字段是为了口径统一。 */
  remotePath?: string
  /** 多文件批次中的当前序号（从 1 开始） */
  fileIndex?: number
  /** 多文件批次的总文件数 */
  fileCount?: number
}

interface SessionState {
  sessionId: string
  sentry: Sentry
  /** 协议未接管时的解码器，保证多字节字符跨帧不乱码 */
  decoder: TextDecoder
  active: ZmodemSession | null
  /** 是否已经向用户弹出确认（避免重复弹窗） */
  prompting: boolean
  /**
   * 确认/选目录流程的代次。每次 handleDetect 开启新流程都自增一次，
   * 长 await（弹窗、选目录）回来时用它判断「这次流程还是不是当初那次」。
   *
   * 不能只看 prompting/promptSessionId：state 是按会话存的，promptSessionId
   * 恒等于 sessionId 永远相等；而 detachZmodem 后重建的 state 是新对象，
   * 旧流程拿着闭包里的 state 继续跑，能通过身份校验却已经没人认它了 ——
   * 它会回填 lastProgress、向一个已关闭的会话发 10×CAN。
   * 代次一旦对不上就整段放弃。
   */
  promptGen: number
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
  /**
   * 最后一次「确实写进文件」的时刻 —— 静默看门狗的真实时钟。
   *
   * 不能用 lastDataAt：对端被 kill 后常会反复重发同一段，字节在流但一块都
   * 落不了盘。以收包为时钟的话计时器永远被推迟，界面就停在某个百分比不动，
   * 既不报错也不续传。只有落盘推进才算活着。
   */
  lastProgressAt: number
  /** 本轮静默续传已经试了几次（有新进展即清零） */
  idleResumes: number
  /** 「一直没等到第一块数据」这条提示是否已经发过：只提示一次，但看门狗要继续跑 */
  startupNoticed: boolean
  /** 连续 fileOffset===0 触发看门狗的次数（第 1 次提示，第 2 次判终态 error） */
  startupStalls: number
  /** 本次传输的记录 id（历史账本用）；null 表示还没有真正开始 */
  transferId: string | null
  /** 本次传输的开始时刻（记录里的 startedAt） */
  transferStartedAt: number
  /** 本机落盘路径（接收）或源文件路径（发送），记录里展示用 */
  transferLocalPath: string
  /** 当前接收文件的代际编号：防止前一份异步收尾踩掉下一份的状态与定时器 */
  offerGen: number
  /** 收到 ZEOF 后是否等本份落盘完再发 ZRINIT（避免多文件并发竞态） */
  deferNextZrinit: boolean
  /** 已消费 ZEOF，等待 saveFinish 完成后补发 ZRINIT */
  pendingZrinit: boolean
  /** 本次接收批次已进入的文件计数（从 1 计） */
  batchIndex: number
  /** 本次接收批次估算的总文件数 */
  batchTotal: number
  /** 接收方向是否跳过目标目录中已下载过的同名同大小文件 */
  skipExisting: boolean
  /** 本次接收批次实际下载保存成功的文件数 */
  batchSaved: number
  /** 本次接收批次因已存在而跳过的文件数 */
  batchSkipped: number
  /** 最近一次跳过的文件名/路径/字节数（用于全批跳过或尾文件跳过时收尾提示） */
  lastSkippedName: string
  lastSkippedPath: string
  lastSkippedSize: number
  /** 唤醒正在等待 ZEOF 的当前 handleOffer（用于 feedZmodem 不可恢复异常或用户中断时收尾） */
  abortOffer: ((kind: 'error' | 'canceled', reason?: string) => void) | null
  /** 上次向 UI watcher 推送 active 进度的时间戳（节流高频 1KB 分包重渲） */
  lastWatchAt: number
  /** 上次推送给 watcher 的关键状态指纹（阶段/文件/文案变化时跳过节流立即推） */
  lastWatchKey: string
  /** 节流窗口尾部补发定时器（避免最后一帧进度丢在 60ms 窗口内） */
  throttleTrail?: ReturnType<typeof setTimeout>
  /** 等待尾部补发的最新 active 进度快照 */
  pendingWatchSnapshot: ZmodemProgress | null
  /** 已针对哪个停滞偏移发过前向空洞补包请求（-1 表示未触发，避免假活流无限刷 ZRPOS） */
  gapResyncOffset: number
  /** 最近一次发送 10×CAN 中止序列的时间戳（用于 350ms 后远端仍在吐 raw 数据时补发） */
  lastAbortSendAt: number
  /** 中断后允许自动补发 10×CAN 的剩余次数（防止 purgeline 吞包导致 lrzsz 卡死） */
  abortFollowups: number
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

/**
 * 标准 ZMODEM / lrzsz 中止序列：10× CAN (0x18) + 10× BS (0x08)。
 *
 * zmodem.js 默认只发 5× CAN + 5× BS，而 Linux lrzsz 在 zsendfdata() 流式发数据时
 * 会先吃掉第 1 个 CAN 再进 getinsync() -> zgethdr()，剩下的 4 个 CAN 不足 5 个，
 * 随后被 0x08 重置计数，导致远端 sz 永久卡在原始模式（ISIG=0 / ECHO=0 / OPOST=0）。
 * 连续发 10 个 CAN（偶数个，即使溢到 readline 也是成对 Ctrl-X Ctrl-X）再跟 10 个 BS，
 * 与 lrzsz 自身的 canit() 完全一致，可稳定把远端 sz/rz 退回 shell。
 */
const ZMODEM_ABORT_BYTES = new Uint8Array([
  24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
  8, 8, 8, 8, 8, 8, 8, 8, 8, 8
])

/** 中断后若远端仍在持续吐 raw 数据，两次自动补发 10×CAN 的最小间隔与上限 */
const ABORT_FOLLOWUP_INTERVAL_MS = 350
const ABORT_FOLLOWUP_MAX = 2

/** 两次续传请求之间的最小间隔：坏帧连续抛错时不能让 ZRPOS 刷屏 */
const RESYNC_MIN_INTERVAL_MS = 150

/** 单个文件最多续传几次，超过就认定对端链路已经不可用 */
const RESYNC_MAX_ATTEMPTS = 64

/**
 * 传输中途静默时，最多主动「叫醒」对端几次。真 sz 收到 ZRPOS 会从该处重发，
 * 但已经被 kill 掉的 sz 只会让每一轮都白等一个静默窗口 —— 所以这里必须封顶，
 * 到点如实报错，不能让界面永远停在最后一个百分比。
 */
const IDLE_RESUME_MAX = 3

/** 静默看门狗的超时。抽成对象是为了让无头回归能把它调小（真实 15 秒太慢） */
export const receiveWatchdog = {
  idleMs: RECEIVE_STALL_MS,
  autoConfirmMs: AUTO_CONFIRM_TIMEOUT_MS
}

/** 接收落盘队列最大在途 IPC 数（背压上限） */
const RECEIVE_MAX_IN_FLIGHT = 2

/** 接收时攒够这么多字节就落盘一次，避免整份文件驻留渲染进程内存 */
const RECEIVE_FLUSH_BYTES = 256 * 1024

/**
 * 单次喂给 zmodem.js 的字节上限。
 *
 * 库用 `push.apply(arr, input)` 摊平输入，实参个数 = 本批字节数，
 * 几十万就会 RangeError（Maximum call stack size exceeded）。
 * 16KB 与库自己的 MAX_CHUNK_LENGTH 对齐，切成这样既不会爆栈，
 * 也保证一个子包不会被切断在两次调用之间（解析器自己会缓存残留）。
 */
const FEED_SLICE_BYTES = 16 * 1024

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
/* eslint-disable no-control-regex -- 见下一行注释 */
/* ZDLE(0x18)/DLE(0x10) 是控制字符，写进正则才能认协议帧，有意为之 */
const RESIDUE_PATTERNS: RegExp[] = [
  // ZMODEM 头魔数 **\x18B01 等
  /\*\*[\x18\x10]?B[0-9A-Fa-f]{2}/,
  /\*\*\x18?[0-9A-Fa-f]{2}/,
  // 纯控制字符（ZDLE 残留）
  /^\s*[\x18\x10]+$/,
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

/** 每个会话的进度回调集合（支持浮层、侧栏传输 Tab、全屏传输面板同时订阅） */
const watchers = new Map<string, Set<(p: ZmodemProgress) => void>>()

/** 高频 active 进度推送给 UI watcher 的最小间隔（毫秒）；阶段/文件切换与终态永不节流 */
const WATCH_THROTTLE_MS = 60

/**
 * 每个会话的最后一条进度。
 *
 * 界面切换标签页会重建 watcher（watchZmodem 只在挂载时订阅一次），
 * 而「等待确认 / 等待远端起始帧」这类阶段不会再有新事件推送 ——
 * 只有实时推送的话，切走再切回来面板就永远空着，用户既看不到状态
 * 也点不到「中断」，于是整个界面卡在那儿退不出来。
 */
const lastProgress = new Map<string, ZmodemProgress>()

/**
 * 历史账本：一次传输只在「真正开始」与「终态」各写一条。
 *
 * 进度帧一概不落盘 —— 150ms 一条 IPC 加整份 JSON 重写会把磁盘打满，
 * 而进度本身对事后排查没有价值（要看的是传完了没、失败原因是什么）。
 */
const startedRecords = new Set<string>()
const recordStartedAt = new Map<string, number>()

function trackRecord(sessionId: string, p: ZmodemProgress): void {
  if (!p.transferId) return
  const st = states.get(sessionId)
  const finished = p.phase === 'done' || p.phase === 'error' || p.phase === 'canceled'
  if (!finished && p.phase !== 'active') return
  if (!finished && startedRecords.has(p.transferId)) return
  /*
   * 一个字节都没动就取消的，不留记录：用户点「取消」拒绝确认、或在选目录时
   * 关掉对话框，这类空任务只会把账本刷成一堆 0 字节行，真正传过的反而被挤下去。
   * 0 字节文件正常收完（done）则照常入账。
   */
  if (finished && !startedRecords.has(p.transferId) && p.bytesDone === 0 && p.phase !== 'done') {
    return
  }
  startedRecords.add(p.transferId)
  reportZmodemRecord({
    id: p.transferId,
    sessionId,
    // ZMODEM 的 send 是「本机 -> 远端」，与记录里的 upload 同义
    direction: p.direction === 'send' ? 'upload' : 'download',
    status: p.phase === 'active' ? 'running' : p.phase === 'done' ? 'done' : p.phase === 'error' ? 'error' : 'canceled',
    fileName: p.fileName,
    localPath: p.localPath,
    remotePath: p.remotePath,
    size: p.bytesTotal,
    transferred: p.bytesDone,
    startedAt: recordStartedAt.get(p.transferId) ?? st?.transferStartedAt ?? Date.now(),
    // 只有失败才把文案当错误；完成时的 message 是「已保存到 …」这类说明
    error: p.phase === 'error' ? p.message : undefined,
    note: p.phase === 'done' ? p.message : undefined
  })
  if (finished) {
    startedRecords.delete(p.transferId)
    recordStartedAt.delete(p.transferId)
    // 多文件收尾可能与下一份交错：只清理属于自己的那条，不能把下一份的 id 抹掉
    if (st && st.transferId === p.transferId) {
      st.transferId = null
      st.transferStartedAt = 0
      st.transferLocalPath = ''
    }
  }
}

function clearWatchThrottle(state: SessionState): void {
  if (state.throttleTrail) {
    clearTimeout(state.throttleTrail)
    state.throttleTrail = undefined
  }
  state.pendingWatchSnapshot = null
}

function emit(sessionId: string, p: ZmodemProgress): void {
  // 路径与 id 都由会话状态统一注入：几十处 emit 不用各自拼一遍
  const st = states.get(sessionId)
  const full: ZmodemProgress = st
    ? {
        ...p,
        transferId: p.transferId ?? st.transferId ?? undefined,
        localPath: p.localPath ?? (st.transferLocalPath || undefined)
      }
    : p
  lastProgress.set(sessionId, full)
  trackRecord(sessionId, full)

  const subs = watchers.get(sessionId)
  if (!subs || subs.size === 0) {
    if (st && full.phase !== 'active') clearWatchThrottle(st)
    return
  }

  // 高频 active 分包（7MB 约 7000 包）按 60ms 节流通知 UI，并在窗口尾补发最新一帧，
  // 避免最后进度停留在上一包；阶段切换、换文件、有提示文案、满 100% 或终态一律立刻送达。
  if (st && full.phase === 'active') {
    const key = `${full.phase}|${full.transferId ?? ''}|${full.fileName ?? ''}|${full.message ?? ''}`
    const now = Date.now()
    const reachedEnd = full.bytesTotal > 0 && full.bytesDone >= full.bytesTotal
    if (key === st.lastWatchKey && !reachedEnd && now - st.lastWatchAt < WATCH_THROTTLE_MS) {
      st.pendingWatchSnapshot = full
      if (!st.throttleTrail) {
        const delay = Math.max(1, WATCH_THROTTLE_MS - (now - st.lastWatchAt))
        st.throttleTrail = setTimeout(() => {
          st.throttleTrail = undefined
          const pendingSnap = st.pendingWatchSnapshot
          st.pendingWatchSnapshot = null
          if (!pendingSnap || states.get(sessionId) !== st) return
          st.lastWatchAt = Date.now()
          const curSubs = watchers.get(sessionId)
          if (curSubs) for (const cb of curSubs) cb(pendingSnap)
        }, delay)
      }
      return
    }
    clearWatchThrottle(st)
    st.lastWatchKey = key
    st.lastWatchAt = now
  } else if (st) {
    clearWatchThrottle(st)
    st.lastWatchKey = ''
    st.lastWatchAt = 0
  }

  for (const cb of subs) cb(full)
}

/**
 * 读取某个会话当前的进度快照（界面重挂载时用来恢复面板）。
 *
 * 只恢复「还没结束」的快照。done / error 是终态：面板自己会在 2.5s / 6s 后收起，
 * 但快照会一直留到会话关闭 —— 若这里原样返回，用户每切走再切回这个标签页，
 * 已经结束的传输条就会重新冒出来再消失一次，看起来像「浮层自己乱闪」。
 * 终态快照仍然留在 lastProgress 里给内部看门狗（stall / 续传）读 bytesTotal 用，
 * 只是不再往界面上恢复。
 */
export function getZmodemProgress(sessionId: string): ZmodemProgress | null {
  const snap = lastProgress.get(sessionId)
  if (!snap) return null
  if (snap.phase === 'done' || snap.phase === 'error' || snap.phase === 'canceled') return null
  return snap
}

/** 按会话 + 传输记录 id 读取进行中的 ZMODEM 实时进度（供侧栏与全屏传输记录表使用） */
export function getZmodemRecordProgress(
  sessionId: string,
  transferId: string
): ZmodemProgress | null {
  const snap = lastProgress.get(sessionId)
  if (!snap || snap.phase !== 'active') return null
  if (snap.transferId !== transferId) return null
  return snap
}

/** UI 注册进度监听（支持多订阅者共存），返回取消函数 */
export function watchZmodem(
  sessionId: string,
  cb: (p: ZmodemProgress) => void
): () => void {
  let subs = watchers.get(sessionId)
  if (!subs) {
    subs = new Set()
    watchers.set(sessionId, subs)
  }
  subs.add(cb)
  return () => {
    const cur = watchers.get(sessionId)
    if (!cur) return
    cur.delete(cb)
    if (cur.size === 0) watchers.delete(sessionId)
  }
}

function toOctets(input: number[] | Uint8Array): number[] {
  return Array.isArray(input) ? input : Array.from(input)
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function formatAbortMessage(reason: string, savedBytes = 0): string {
  return savedBytes > 0
    ? tNow('term.zmodem.abortWithSaved', { reason, bytes: savedBytes })
    : tNow('term.zmodem.abortReason', { reason })
}

export type SendBytesOutcome = { ok: boolean; reason?: string }

/** 确认弹窗返回值：兼容历史 boolean，以及带接收选项的对象 */
export type ZmodemConfirmResult = boolean | { accepted: boolean; skipExisting?: boolean }

export interface ZmodemHooks {
  /** 写回终端（普通输出或被协议交回的字节） */
  write: (text: string) => void
  /** 向 SSH 通道发送原始字节；若返回 Promise<{ok:false, reason}>，渲染层立即报错中止 */
  send: (bytes: Uint8Array) => void | Promise<SendBytesOutcome | void>
  /** 询问用户是否开始传输；resolve(true) 或 resolve({ accepted: true }) 才接管 */
  confirm: (direction: ZmodemDirection, sessionId?: string) => Promise<ZmodemConfirmResult>
  /**
   * 传输结束后的收尾（可选）。
   * 远端 sz/rz 退出时一般不会补 \r\n，提示符会与传输进度挤在同一行，
   * 这里让 UI 补一个换行，并清掉可能残留的未完成控制序列。
   */
  afterTransfer?: () => void
}

/** 经 hooks.send 发送原始协议字节；底层明确返回 {ok:false} 时立即报错中止，不再干等 20s 超时 */
function sendRaw(sessionId: string, state: SessionState, bytes: Uint8Array): void {
  const res = state.hooks.send(bytes)
  if (!res || typeof (res as Promise<unknown>).then !== 'function') return
  void Promise.resolve(res).then(
    (out) => {
      if (!out || out.ok !== false || !state.active) return
      const reason = out.reason || 'send failed'
      const direction = state.direction ?? 'receive'
      const abortOffer = state.abortOffer
      const snap = lastProgress.get(sessionId)
      recoverFromError(state)
      if (abortOffer) {
        abortOffer('error', reason)
      } else {
        emit(sessionId, {
          phase: 'error',
          direction,
          fileName: snap?.fileName,
          bytesDone: snap?.bytesDone ?? 0,
          bytesTotal: snap?.bytesTotal ?? 0,
          fileIndex: snap?.fileIndex,
          fileCount: snap?.fileCount,
          message: formatAbortMessage(reason)
        })
      }
    },
    () => {
      /* hooks.send 意外 reject 不向外抛未捕获异常 */
    }
  )
}

/** 向对端发送标准 10×CAN+10×BS 中止序列，并武装后续补发计数器 */
function sendAbortSequence(state: SessionState, armFollowups = true): void {
  sendRaw(state.sessionId, state, ZMODEM_ABORT_BYTES)
  state.lastAbortSendAt = Date.now()
  if (armFollowups) state.abortFollowups = ABORT_FOLLOWUP_MAX
}

/** 用 10×CAN+10×BS 中止 zmodem.js 会话（屏蔽其默认残缺的 5×CAN，同时正常触发 session_end） */
function abortSessionCleanly(state: SessionState, session: ZmodemSession | null): void {
  if (!session) return
  sendAbortSequence(state)
  try {
    ;(session as unknown as { set_sender?: (fn: () => void) => void }).set_sender?.(() => {})
    session.abort()
  } catch {
    /* 已结束或已中止 */
  }
}

/**
 * 中断后的 5 秒抑制窗过滤：拦下协议残渣、二进制乱码（\uFFFD）、远端 sz 原始模式（OPOST=0）
 * 在途纯文本文件分片（含裸 \n 或超长块）与非 ANSI 控制字符；
 * 同时放行 sz 退出回到 cooked 模式后的正常 shell 提示符（如 "root@host:~$ " 或 "\r\nroot@IFLY:~# "）。
 */
function isPostAbortJunk(text: string): boolean {
  if (isResidueText(text) || text.includes('\uFFFD')) return true
  if (/(?:^|[^\r])\n/.test(text)) return true
  if (text.length > 256) return true
  /* eslint-disable-next-line no-control-regex -- 识别中断后残留的协议与原始控制字符 */
  if (/[\x00-\x06\x08\x0b\x0c\x0e-\x1a\x1c-\x1f]/.test(text)) return true
  return false
}

/**
 * 为一个会话建立 Sentry。重复调用直接返回，不重复挂载。
 * 挂载后该会话的终端输出必须经由 feedZmodem 走 Sentry 转发。
 */
export function ensureZmodem(sessionId: string, hooks: ZmodemHooks): void {
  attachZmodem(sessionId, hooks)
}

/**
 * 为一个会话建立 Sentry。重复调用刷新 hooks 闭包并返回已有实例。
 */
export function attachZmodem(sessionId: string, hooks: ZmodemHooks): void {
  const existing = states.get(sessionId)
  if (existing) {
    existing.hooks = hooks
    return
  }

  const state: SessionState = {
    sessionId,
    // Sentry 构造时就要拿到全部回调，这里通过闭包引用 state 以便后续替换
    sentry: null as unknown as Sentry,
    decoder: new TextDecoder('utf-8'),
    active: null,
    prompting: false,
    promptGen: 0,
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
    resyncAttempts: 0,
    lastProgressAt: 0,
    idleResumes: 0,
    startupNoticed: false,
    startupStalls: 0,
    transferId: null,
    transferStartedAt: 0,
    transferLocalPath: '',
    offerGen: 0,
    deferNextZrinit: false,
    pendingZrinit: false,
    batchIndex: 0,
    batchTotal: 0,
    skipExisting: true,
    batchSaved: 0,
    batchSkipped: 0,
    lastSkippedName: '',
    lastSkippedPath: '',
    lastSkippedSize: 0,
    abortOffer: null,
    lastWatchAt: 0,
    lastWatchKey: '',
    pendingWatchSnapshot: null,
    gapResyncOffset: -1,
    lastAbortSendAt: 0,
    abortFollowups: 0
  }

  state.sentry = new Sentry({
    to_terminal: (octets) => {
      // 协议未接管的字节：按 UTF-8 边界解码回文本再写终端
      const text = state.decoder.decode(Uint8Array.from(toOctets(octets)), { stream: true })
      if (!text) return

      // 协议中止后的抑制窗：拦截协议残渣、二进制乱码及 raw 模式在途文本分片，
      // 远端退回 shell 后立刻出现的正常 cooked 模式提示符照常放行。
      if (Date.now() < state.suppressUntil) {
        if (isPostAbortJunk(text)) {
          state.residueChars += text.length
          if (
            state.abortFollowups > 0 &&
            Date.now() - state.lastAbortSendAt >= ABORT_FOLLOWUP_INTERVAL_MS
          ) {
            state.abortFollowups -= 1
            sendAbortSequence(state, false)
          }
          return
        }
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
      state.hooks.write(text)
    },
    on_retract: () => {
      // 检测被推翻只影响「还能不能用这次 Detection」，不代表用户的流程结束了：
      // prompting 由 handleDetect 显式管理（远端重发起始帧也会触发 retract，
      // 这里清掉会让用户在选择目录期间又冒出第二个弹窗）。
      // 用户已经表达过同意时保持 autoConfirm，等下一次检测自动接管。
      if (!state.autoConfirm) state.pendingDetect = false
    },
    sender: (octets) => {
      sendRaw(sessionId, state, Uint8Array.from(toOctets(octets)))
    },
    on_detect: (detection: Detection) => {
      state.pendingDetect = true
      // 远端在等回应时会不断重发起始帧；每次检测都覆盖「最新」，用户答复后用最新的那次接手，
      // 避免拿着已经失效的 Detection 去 confirm（那会抛 Stale ZMODEM session，界面就卡住了）。
      state.latest = detection
      void handleDetect(sessionId, state, detection)
    }
  })

  states.set(sessionId, state)
}

async function handleDetect(
  sessionId: string,
  state: SessionState,
  detection: Detection
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
  // 记下这次流程的代次：确认弹窗与选目录都是长 await，回来时必须能判断
  // 期间会话有没有被关掉/重开，以及这次流程是不是已经被更新的一次取代
  const promptGen = ++state.promptGen
  emit(sessionId, {
    phase: 'detected',
    direction,
    bytesDone: 0,
    bytesTotal: 0
  })

  // 确认询问必须可被取消：用户点「中断」时 abortZmodem 会调用 cancelConfirm，
  // 让这里立刻得到 false 继续走拒绝分支，而不是永远吊在 await 上。
  let answer: ZmodemConfirmResult = false
  try {
    answer = await new Promise<ZmodemConfirmResult>((resolve) => {
      let settled = false
      const finish = (v: ZmodemConfirmResult): void => {
        if (settled) return
        settled = true
        if (state.cancelConfirm === cancel) state.cancelConfirm = null
        resolve(v)
      }
      const cancel = (): void => finish(false)
      state.cancelConfirm = cancel
      state.hooks.confirm(direction, sessionId).then(finish, () => finish(false))
    })
  } catch {
    answer = false
  } finally {
    state.cancelConfirm = null
  }

  /*
   * 确认弹窗关掉之后、写任何状态之前先校验代次：会话被关闭（detachZmodem
   * 已把 state 从表里摘掉）或用户已中断（recoverFromError 自增代次）时，
   * 这里必须静默退出 —— 否则会给一个已经不存在的会话 emit 进度、
   * 甚至发出中止序列。
   */
  if (states.get(sessionId) !== state || state.promptGen !== promptGen) return

  const ok = typeof answer === 'boolean' ? answer : !!answer?.accepted
  const skipExisting = typeof answer === 'boolean' ? true : answer?.skipExisting !== false

  if (!ok) {
    state.prompting = false
    // 用户拒绝：发送中止序列，让远端退出 sz/rz
    state.autoConfirm = null
    state.pendingDetect = false
    clearAutoTimer(state)
    try {
      sendAbortSequence(state, false)
    } catch {
      /* 忽略 */
    }
    emit(sessionId, {
      phase: 'canceled',
      direction,
      bytesDone: 0,
      bytesTotal: 0,
      message: tNow('term.zmodem.canceled')
    })
    return
  }

  if (direction === 'receive') {
    state.skipExisting = skipExisting
  }

  // 接收方向：先定下保存文件夹（多文件 sz 只问一次），再向远端要数据。
  // 顺序很重要 —— 必须在 confirm/start 之前问，否则远端已经在等 ZRPOS，
  // 用户挑目录的几十秒会被它当成超时。
  if (direction === 'receive' && !state.saveDirToken) {
    const picked = await pickSaveDir()
    /*
     * 选目录期间会话可能已被关闭（detachZmodem 会 states.delete）或用户已中断。
     * 旧代码不看这个，选完目录照样 startSession，于是在一个已经关掉的标签上
     * 把传输"复活"，或者拿失效的 Detection 去 confirm 而抛 Stale。
     */
    if (states.get(sessionId) !== state || state.promptGen !== promptGen || !state.latest) {
      return
    }
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
        phase: 'canceled',
        direction,
        bytesDone: 0,
        bytesTotal: 0,
        message: tNow('term.zmodem.noDirCanceled')
      })
      return
    }
    state.saveDirToken = picked.token
  }

  // 选目录回来后到真正 start 之间还可能被外部打断（关标签、Esc 中断），再校验一次代次
  if (states.get(sessionId) !== state || state.promptGen !== promptGen) return
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
      message: tNow('term.zmodem.waitResendHeader')
    })
    return
  }

  state.autoConfirm = null
  state.pendingDetect = false
  state.latest = null
  state.direction = direction
  state.suppressUntil = 0
  state.abortFollowups = 0
  clearAutoTimer(state)

  state.active = session
  state.everHadSession = true

  // 进入协议态：从现在起直到会话结束，终端上出现的是协议残渣而非正常输出，
  // 交给 residue 缓冲区收集，等会话结束后统一清理（见 scheduleResidueFlush）。
  state.inProtocol = true
  state.protocolEnded = false

  session.on('session_end', () => {
    const wasReceive = state.direction === 'receive'
    const skippedCount = state.batchSkipped
    const savedCount = state.batchSaved
    const lastSkippedName = state.lastSkippedName
    const lastSkippedPath = state.lastSkippedPath
    const lastSkippedSize = state.lastSkippedSize
    const finalIndex = state.batchIndex
    const finalTotal = state.batchTotal
    const rawSess = session as unknown as { aborted?: () => boolean }
    const abortedSession = typeof rawSess.aborted === 'function' ? rawSess.aborted() : false

    state.active = null
    state.inProtocol = false
    state.direction = null
    state.saveDirToken = null
    state.autoConfirm = null
    state.pendingDetect = false
    state.latest = null
    state.receivedBytes = 0
    state.fileOffset = 0
    state.resyncFrom = -1
    state.gapResyncOffset = -1
    clearWatchThrottle(state)
    state.resyncAttempts = 0
    state.lastResyncAt = 0
    state.lastProgressAt = 0
    state.idleResumes = 0
    state.startupNoticed = false
    state.startupStalls = 0
    state.transferId = null
    state.transferStartedAt = 0
    state.transferLocalPath = ''
    state.deferNextZrinit = false
    state.pendingZrinit = false
    state.batchIndex = 0
    state.batchTotal = 0
    state.skipExisting = true
    state.batchSaved = 0
    state.batchSkipped = 0
    state.lastSkippedName = ''
    state.lastSkippedPath = ''
    state.lastSkippedSize = 0
    state.lastWatchAt = 0
    state.lastWatchKey = ''
    clearAutoTimer(state)
    clearStallTimer(state)
    // 会话结束后排一次清理：远端可能还会补发一点残渣，给它一个短暂窗口
    scheduleResidueFlush(state)

    // 批量下载尾文件（或全批）走 ZSKIP 跳过时，收尾由 ZFIN -> session_end 落定，
    // 这里把状态从 active 切到 done 并给出汇总（不带 transferId，不污染传输记录表）
    if (wasReceive && !abortedSession && skippedCount > 0) {
      const prev = lastProgress.get(sessionId)
      if (prev && prev.phase === 'active') {
        const batchMeta = finalTotal > 1 ? { fileIndex: finalIndex, fileCount: finalTotal } : {}
        const singleSkip = savedCount === 0 && skippedCount === 1
        const msg =
          savedCount > 0
            ? tNow('term.zmodem.receiveSummary', { saved: savedCount, skipped: skippedCount })
            : skippedCount > 1
              ? tNow('term.zmodem.allSkipped', { count: skippedCount })
              : tNow('term.zmodem.singleSkipped', { path: lastSkippedPath || lastSkippedName })
        emit(sessionId, {
          phase: 'done',
          direction: 'receive',
          fileName: lastSkippedName || prev.fileName,
          bytesDone: singleSkip ? lastSkippedSize : 0,
          bytesTotal: singleSkip ? lastSkippedSize : 0,
          ...batchMeta,
          localPath: singleSkip ? lastSkippedPath || undefined : undefined,
          message: msg
        })
      }
    }
  })

  // 接收方向进传输前补齐状态机短板（多帧 ZDATA / 0 字节文件 ZEOF / _file_info 清理 /
  // 延迟 ZRINIT 避开多文件并发竞态 / 文件间重传兜底 / 安全的位置校验）
  if (direction === 'receive') {
    primeReceiveSession(session, state)
  }

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
          : state.fileOffset + subpacket.get_payload().length
      const ack = ZmodemModule.Header.build(
        'ZACK',
        ZmodemModule.ENCODELIB.pack_u32_le(offset)
      ).to_hex()
      sendRaw(sessionId, state, Uint8Array.from(ack))
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
  // 在入口捕获方向，避免异步超时回调时被上一次会话清理清空
  const direction = state.autoConfirm ?? state.direction ?? 'receive'
  state.autoTimer = setTimeout(() => {
    state.autoTimer = undefined
    if (state.active) return
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
      message: tNow('term.zmodem.autoTimeout', { cmd: direction === 'send' ? 'rz' : 'sz' })
    })
  }, receiveWatchdog.autoConfirmMs)
}

/** 会话已建立、但远端迟迟不发数据时的提示（不 abort，只提醒用户可以中断） */
function clearStallTimer(state: SessionState): void {
  if (state.stallTimer) {
    clearTimeout(state.stallTimer)
    state.stallTimer = undefined
  }
}

/**
 * 静默看门狗。
 *
 * 之前这里只管「一个字节都还没收到」的情况，而且收到过数据就直接 return —— 结果是
 * 大文件传到一半双方互相干等（对端等我方 ZACK/ZRPOS，我方等对端数据），谁都不抛错，
 * 界面就永远停在最后一个百分比。真实世界里 sz 被 kill、链路丢窗口、SFTP 网关断流
 * 都会长这个样子，而它们全都不会让解析器抛异常。
 *
 * 现在：按「最后一次收到文件数据」计时，超时就用 _accept() 重装解析器并重发 ZRPOS，
 * 让对端从断点续发；连着 IDLE_RESUME_MAX 轮都还是静默才认定对方已经死了，如实报错。
 * 计时器只有一个，收到数据时只更新时间戳（每包都 clear/set 会白白抖动几千次）。
 */
function armStallTimer(
  sessionId: string,
  state: SessionState,
  fileName?: string,
  offerGen?: number
): void {
  clearStallTimer(state)
  state.stallTimer = setTimeout(() => {
    state.stallTimer = undefined
    if (!state.active) return
    if (offerGen !== undefined && state.offerGen !== offerGen) return
    // 按「落盘进展」计时，不按收包：对端反复重发被丢弃的区间时字节在流，
    // 但文件长度不动，那种状态和彻底静默一样需要干预。
    const idleFor = Date.now() - state.lastProgressAt
    if (state.lastProgressAt > 0 && idleFor < receiveWatchdog.idleMs) {
      armStallTimer(sessionId, state, fileName, offerGen)
      return
    }
    // 判据用 fileOffset（已落盘）而不是 receivedBytes（收到的字节）：
    // 对端反复重发被丢弃的区间时 receivedBytes 会涨，fileOffset 不动，
    // 那种情况该走下面的续传/放弃逻辑，不是「远端还没开始发」。
    if (state.fileOffset === 0) {
      state.startupStalls += 1
      const snap = lastProgress.get(sessionId)
      const waitedSec = Math.max(1, Math.round((receiveWatchdog.idleMs * state.startupStalls) / 1000))
      const msg =
        state.startupStalls === 1
          ? tNow('term.zmodem.startupStall1')
          : tNow('term.zmodem.startupStallN', { sec: waitedSec })
      if (state.startupStalls === 1) {
        state.startupNoticed = true
        emit(sessionId, {
          phase: 'active',
          direction: 'receive',
          fileName: fileName ?? snap?.fileName,
          bytesDone: 0,
          bytesTotal: snap?.bytesTotal ?? 0,
          fileIndex: snap?.fileIndex,
          fileCount: snap?.fileCount,
          message: msg
        })
        armStallTimer(sessionId, state, fileName, offerGen)
        return
      }
      const abortOffer = state.abortOffer
      emit(sessionId, {
        phase: 'error',
        direction: 'receive',
        fileName: fileName ?? snap?.fileName,
        bytesDone: 0,
        bytesTotal: snap?.bytesTotal ?? 0,
        fileIndex: snap?.fileIndex,
        fileCount: snap?.fileCount,
        message: msg
      })
      recoverFromError(state)
      // 释放挂着的 handleOffer，但不重复发第二条 error
      abortOffer?.('canceled')
      return
    }

    const snap = lastProgress.get(sessionId)
    const offset = state.fileOffset
    if (state.idleResumes >= IDLE_RESUME_MAX) {
      const reason = tNow('term.zmodem.idleExhausted', { max: IDLE_RESUME_MAX })
      const abortFn = state.abortOffer
      recoverFromError(state)
      if (abortFn) {
        abortFn('error', reason)
      } else {
        emit(sessionId, {
          phase: 'error',
          direction: 'receive',
          fileName: fileName ?? snap?.fileName,
          bytesDone: offset,
          bytesTotal: snap?.bytesTotal ?? offset,
          fileIndex: snap?.fileIndex,
          fileCount: snap?.fileCount,
          message: formatAbortMessage(reason, offset)
        })
      }
      return
    }

    state.idleResumes += 1
    const resumed = resumeFromOffset(
      sessionId,
      state,
      tNow('term.zmodem.idleResuming', {
        sec: Math.round(receiveWatchdog.idleMs / 1000),
        offset,
        count: state.idleResumes
      })
    )
    if (resumed) {
      armStallTimer(sessionId, state, fileName, offerGen)
      return
    }
    const failReason = tNow('term.zmodem.stallFailed')
    const abortFn = state.abortOffer
    recoverFromError(state)
    if (abortFn) {
      abortFn('error', failReason)
    } else {
      emit(sessionId, {
        phase: 'error',
        direction: 'receive',
        fileName: fileName ?? snap?.fileName,
        bytesDone: offset,
        bytesTotal: snap?.bytesTotal ?? offset,
        fileIndex: snap?.fileIndex,
        fileCount: snap?.fileCount,
        message: formatAbortMessage(failReason, offset)
      })
    }
  }, receiveWatchdog.idleMs)
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
  // 用户取消重选文件夹属于正常操作：保持当前会话/传输不受影响，绝不能把活跃记录标为 error
  if (!picked) return false
  state.saveDirToken = picked.token
  const snap = lastProgress.get(sessionId)
  emit(sessionId, {
    phase: snap && snap.phase !== 'done' ? snap.phase : 'detected',
    direction: 'receive',
    fileName: snap?.fileName,
    bytesDone: snap?.bytesDone ?? 0,
    bytesTotal: snap?.bytesTotal ?? 0,
    message: tNow('term.zmodem.savingTo', { dir: picked.dir })
  })
  return true
}

type BeginSaveOptions = {
  skipExisting?: boolean
  size?: number | null
  mtime?: number | null
}

type BeginSaveResult =
  | { ok: true; skipped: true; path: string; size: number }
  | { ok: true; skipped: false; data: { saveId: string; path: string } }
  | { ok: false; canceled: true; reason?: string }
  | { ok: false; canceled: false; reason: string }

/** 提取 ZFILE 的修改时间（统一换算为 epoch 秒，无效返回 null） */
function extractMtimeSeconds(mtime: Date | number | null | undefined): number | null {
  if (mtime instanceof Date) {
    const sec = Math.floor(mtime.getTime() / 1000)
    return Number.isFinite(sec) && sec > 0 ? sec : null
  }
  if (typeof mtime === 'number' && Number.isFinite(mtime) && mtime > 0) {
    return mtime > 1e12 ? Math.floor(mtime / 1000) : Math.floor(mtime)
  }
  return null
}

/**
 * 在已选目录里建目标文件（开启 skipExisting 时先判定是否已下载过；否则重名自动编号）。
 * 只有目录令牌过期才重选一次目录；磁盘/权限等真实落盘失败直接返回 error，绝不伪装成用户取消。
 */
async function beginSave(
  state: SessionState,
  fileName: string,
  opts?: BeginSaveOptions
): Promise<BeginSaveResult> {
  let lastError = 'saveBegin failed'
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!state.saveDirToken) {
      const picked = await pickSaveDir()
      if (!picked) return { ok: false, canceled: true }
      state.saveDirToken = picked.token
    }
    try {
      const res = await window.api.zmodem.saveBegin(state.saveDirToken, fileName, opts)
      if (res.ok) {
        if ('skipped' in res.data && res.data.skipped) {
          return { ok: true, skipped: true, path: res.data.path, size: res.data.size }
        }
        return {
          ok: true,
          skipped: false,
          data: { saveId: res.data.saveId, path: res.data.path }
        }
      }
      lastError = res.error || lastError
      if (!/\u5df2\u5931\u6548/.test(lastError)) return { ok: false, canceled: false, reason: lastError }
    } catch (err) {
      return { ok: false, canceled: false, reason: errText(err) }
    }
    state.saveDirToken = null
  }
  return { ok: false, canceled: false, reason: lastError }
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
  const startGen = state.offerGen
  try {
    const startP = session.start()
    // 发出 ZRINIT 之后远端应当开始推文件；迟迟没动静就提醒，避免纯干等。
    // 带上 startGen：一旦第一个 offer 到达，启动看门狗自动让位给文件级看门狗。
    armStallTimer(sessionId, state, undefined, startGen)
    await startP
  } catch (err) {
    emit(sessionId, {
      phase: 'error',
      direction: 'receive',
      bytesDone: 0,
      bytesTotal: 0,
      message: tNow('term.zmodem.receiveStartFailed', { err: errText(err) })
    })
    abortSessionCleanly(state, session)
  }
}

/**
 * 当前文件落盘收尾后，补发在 ZEOF 里延后的 ZRINIT，通知远端推送下一份文件（或 ZFIN）。
 * 只在当前代际仍匹配时执行：若对端已流水线提前推了下一份 ZFILE，绝不能补发过期 ZRINIT。
 */
function flushPendingZrinit(state: SessionState, myGen: number): void {
  if (state.offerGen !== myGen) return
  state.deferNextZrinit = false
  if (!state.pendingZrinit) return
  state.pendingZrinit = false
  const raw = state.active as unknown as RawReceiveSession | null
  try {
    raw?._send_ZRINIT?.()
  } catch {
    /* 会话已结束或已中止 */
  }
}

async function handleOffer(
  sessionId: string,
  state: SessionState,
  offer: ZmodemOffer
): Promise<void> {
  const myGen = ++state.offerGen
  state.pendingZrinit = false
  state.deferNextZrinit = false

  let details: {
    name?: string
    size?: number | null
    mtime?: Date | number | null
    files_remaining?: number
  }
  try {
    details = offer.get_details()
  } catch {
    details = { name: 'download.bin', size: null }
  }
  const fileName = details.name || 'download.bin'
  const remoteSize =
    typeof details.size === 'number' && Number.isFinite(details.size) && details.size >= 0
      ? details.size
      : null
  const remoteMtime = extractMtimeSeconds(details.mtime)
  const total = remoteSize ?? 0

  // 批次序号：对端 ZFILE 的 files_remaining 包含当前文件本身（如 3 -> 2 -> 1）
  const myFileIndex = ++state.batchIndex
  const remaining =
    typeof details.files_remaining === 'number' && details.files_remaining > 0
      ? details.files_remaining
      : 1
  state.batchTotal = Math.max(state.batchTotal, myFileIndex + remaining - 1)
  const myFileCount = state.batchTotal
  const batchMeta =
    myFileCount > 1 ? { fileIndex: myFileIndex, fileCount: myFileCount } : {}

  clearStallTimer(state)
  const saveRes = await beginSave(state, fileName, {
    skipExisting: state.skipExisting,
    size: remoteSize,
    mtime: remoteMtime
  })
  if (!saveRes.ok) {
    if (saveRes.canceled) {
      // 用户放弃选目录：跳过这个文件，协议照常继续（多文件时下次还会问）
      try {
        offer.skip()
      } catch {
        /* 忽略 */
      }
      emit(sessionId, {
        phase: 'canceled',
        direction: 'receive',
        fileName,
        bytesDone: 0,
        bytesTotal: total,
        ...batchMeta,
        message: tNow('term.zmodem.noSavePathSkipped')
      })
      return
    }
    // 真实落盘初始化失败（权限/磁盘满等）：不调用 skip，按错误终止整批
    recoverFromError(state)
    emit(sessionId, {
      phase: 'error',
      direction: 'receive',
      fileName,
      bytesDone: 0,
      bytesTotal: total,
      ...batchMeta,
      message: saveRes.reason
    })
    return
  }

  // 目标目录已有同名同大小且未过期的文件：直接发 ZSKIP 跳过，零流量进入下一份或 ZFIN
  if (saveRes.skipped) {
    if (state.offerGen !== myGen || !state.active) return
    state.batchSkipped += 1
    state.lastSkippedName = fileName
    state.lastSkippedPath = saveRes.path
    state.lastSkippedSize = saveRes.size
    state.transferId = null
    state.transferLocalPath = ''
    state.fileOffset = 0
    state.startupStalls = 0
    state.lastProgressAt = 0
    emit(sessionId, {
      phase: 'active',
      direction: 'receive',
      fileName,
      bytesDone: saveRes.size,
      bytesTotal: Math.max(total, saveRes.size),
      ...batchMeta,
      localPath: saveRes.path,
      message:
        myFileCount > 1
          ? tNow('term.zmodem.fileSkippedBatch', { index: myFileIndex, total: myFileCount })
          : tNow('term.zmodem.fileSkippedSingle')
    })
    const raw = state.active as unknown as RawReceiveSession | null
    if (raw) raw._current_transfer = null
    try {
      offer.skip()
    } catch {
      /* 会话可能已结束或中止 */
    }
    if (state.offerGen === myGen && state.active) {
      armStallTimer(sessionId, state, undefined, myGen)
    }
    return
  }
  const target = saveRes.data

  // 等待 beginSave IPC 期间若会话已中止或已切到新 offer，释放本文件句柄并清理占位/临时覆盖文件
  if (state.offerGen !== myGen || !state.active) {
    await window.api.zmodem.saveFinish(target.saveId, { canceled: true }).catch(() => null)
    return
  }

  state.fileOffset = 0
  state.resyncFrom = -1
  state.gapResyncOffset = -1
  state.lastProgressAt = 0
  state.idleResumes = 0
  state.startupNoticed = false
  state.startupStalls = 0
  state.deferNextZrinit = true
  /*
   * 每个文件一条独立记录与本地常量：多文件 sz 即使发生收尾交错，
   * 也不会把下一份文件的 transferId / localPath 串到上一份上。
   */
  const myTransferId = uid()
  const myStartedAt = Date.now()
  const myLocalPath = target.path
  recordStartedAt.set(myTransferId, myStartedAt)
  state.transferId = myTransferId
  state.transferStartedAt = myStartedAt
  state.transferLocalPath = myLocalPath

  const chunks: Uint8Array[] = []
  let pending = 0
  let written = 0
  let inFlight = 0
  let queue: Promise<void> = Promise.resolve()
  let failed: string | null = null
  /** 已经按顺序认下的文件内偏移（= 已排队落盘）。续传的 ZRPOS 就报这个数 */
  let cursor = 0
  /** 对端下一位数据落在文件的哪个位置；续传后对端可能从更早处重发，靠它对账 */
  let expected = 0

  // 攒够一块再落盘并施加背压：最多保留 RECEIVE_MAX_IN_FLIGHT 块在途写入；
  // 一旦 saveAppend 失败立即置 failed 并唤醒 abortOffer 中止后续入队
  const flush = (force = false): void => {
    if (failed || !pending) return
    if (!force && inFlight >= RECEIVE_MAX_IN_FLIGHT) return
    const buf = concat(chunks)
    chunks.length = 0
    pending = 0
    const b64 = toBase64(buf)
    inFlight += 1
    queue = queue
      .then(async () => {
        if (failed) return
        const res = await window.api.zmodem.saveAppend(target.saveId, b64)
        if (res.ok) {
          written = res.data.bytes
        } else {
          failed = res.error
          state.abortOffer?.('error', failed)
        }
      })
      .finally(() => {
        inFlight -= 1
        if (!failed && pending >= RECEIVE_FLUSH_BYTES) flush()
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

  // 供 feedZmodem 不可恢复异常或 abortZmodem 主动唤醒，避免 handleOffer 永远挂死在
  // Promise.race 上导致界面与传输管理表停在「100% / 进行中」
  const abortBox: { outcome: { kind: 'error' | 'canceled'; reason?: string } | null } = {
    outcome: null
  }
  const aborted = new Promise<void>((resolve) => {
    state.abortOffer = (kind, reason) => {
      if (abortBox.outcome) return
      abortBox.outcome = { kind, reason }
      resolve()
    }
  })

  try {
    emit(sessionId, {
      phase: 'active',
      direction: 'receive',
      fileName,
      bytesDone: 0,
      bytesTotal: total,
      ...batchMeta,
      transferId: myTransferId,
      localPath: myLocalPath
    })

    const accepted = offer.accept({
      on_input: (payload: Uint8Array) => {
        if (failed) return
        // 数据还在流动：给静默看门狗续命。
        //
        // 注意这里**不能**顺手把 idleResumes 清零。对端被 kill 之后常常进入
        // 「反复重发同一段」的状态：字节在流，但我们一块都落不了盘（下面两条
        // 早退分支只累加 receivedBytes，不推进 fileOffset）。若在收包处清零，
        // 计数器永远撞不到上限，resumeFromOffset 会用同一个 fileOffset 无限
        // 重发 ZRPOS —— 进度条在跳，文件长度不动。清零只放在真正写盘的
        // fileOffset 推进处。
        // 续传刚落定：对端从这个位置往后发，之前已经认下的那段不能再算一遍
        if (state.resyncFrom >= 0) {
          expected = state.resyncFrom
          state.resyncFrom = -1
        }
        const start = expected
        const end = start + payload.length
        expected = end

        // 落盘接口是「只追加」的：前向跳洞（start > cursor）说明中间缺段，不能直接拼；
        // 重叠重发段（end <= cursor）直接丢弃；而实时增长的日志文件（如 robotTestDebug.log）
        // 在传输期间会超出 ZFILE 的初始 stat 大小，只要是连续流（start <= cursor）就应照常接收，
        // 保持 state.fileOffset 与协议层一致，避免卡死在 100%。
        if (start > cursor) {
          state.receivedBytes += payload.length
          const now = Date.now()
          if (
            state.gapResyncOffset !== cursor &&
            state.resyncAttempts < RESYNC_MAX_ATTEMPTS &&
            now - state.lastResyncAt >= RESYNC_MIN_INTERVAL_MS
          ) {
            state.gapResyncOffset = cursor
            state.resyncAttempts += 1
            state.lastResyncAt = now
            resumeFromOffset(
              sessionId,
              state,
              tNow('term.zmodem.gapResync', { start, cursor })
            )
          }
          return
        }
        if (end <= cursor) {
          // 整块都是重发，丢掉即可
          state.receivedBytes += payload.length
          return
        }
        const piece = start < cursor ? payload.subarray(cursor - start) : payload
        if (!piece.length) {
          state.receivedBytes += payload.length
          return
        }

        state.receivedBytes += payload.length
        cursor += piece.length
        state.fileOffset = cursor
        state.gapResyncOffset = -1
        // 真正落盘了才算「有进展」：看门狗按它计时，续传次数上限按它清零
        state.lastProgressAt = Date.now()
        state.idleResumes = 0
        chunks.push(piece)
        pending += piece.length
        if (pending >= RECEIVE_FLUSH_BYTES) flush()
        emit(sessionId, {
          phase: 'active',
          direction: 'receive',
          fileName,
          bytesDone: cursor,
          bytesTotal: total > 0 ? Math.max(total, cursor) : 0,
          ...batchMeta,
          transferId: myTransferId,
          localPath: myLocalPath
        })
      }
    })

    // 数据阶段的看门狗。之前 handleOffer 一进来就 clearStallTimer 却从不重新 arm，
    // 于是「文件已经开始传」的整个窗口根本没有任何超时保护 —— 这正是大文件卡死的现场。
    armStallTimer(sessionId, state, fileName, myGen)

    await Promise.race([accepted.then(() => undefined), completed, aborted])

    if (state.offerGen === myGen) {
      state.abortOffer = null
      clearStallTimer(state)
      state.resyncAttempts = 0
      state.lastResyncAt = 0
      state.lastProgressAt = 0
      state.idleResumes = 0
    }

    // 用户主动中断 / 会话卸载：abortZmodem 已发出 canceled 事件，释放主进程写句柄并清理 0 字节空占位文件
    if (abortBox.outcome?.kind === 'canceled') {
      await queue.catch(() => undefined)
      await window.api.zmodem.saveFinish(target.saveId, { canceled: true }).catch(() => null)
      return
    }

    // feedZmodem 遇到不可恢复协议错误（如对端 5×CAN、续传耗尽或 saveAppend 失败）：落盘已收字节并报错
    if (abortBox.outcome?.kind === 'error') {
      if (state.active) recoverFromError(state)
      if (!failed) flush(true)
      await queue.catch(() => undefined)
      const reason = abortBox.outcome.reason || 'ZMODEM error'
      const finErr = await window.api.zmodem
        .saveFinish(target.saveId, { aborted: true })
        .catch(() => null)
      const savedBytes = finErr?.ok ? finErr.data.size : written
      const message = formatAbortMessage(reason, savedBytes)
      emit(sessionId, {
        phase: 'error',
        direction: 'receive',
        fileName,
        bytesDone: savedBytes,
        bytesTotal: Math.max(total, savedBytes),
        ...batchMeta,
        transferId: myTransferId,
        localPath: myLocalPath,
        message
      })
      return
    }

    flush(true)
    await queue

    if (failed) {
      /*
       * 写盘失败（磁盘满等）必须把主进程那边的句柄和 claimedPaths 一起放掉：
       * 只 emit 不给 saveFinish，那个文件会被锁 30 分钟，且 .part 一直留着。
       */
      await window.api.zmodem.saveFinish(target.saveId, { aborted: true }).catch(() => null)
      emit(sessionId, {
        phase: 'error',
        direction: 'receive',
        fileName,
        bytesDone: written,
        bytesTotal: Math.max(total, written),
        ...batchMeta,
        transferId: myTransferId,
        localPath: myLocalPath,
        message: failed
      })
      flushPendingZrinit(state, myGen)
      return
    }

    const fin = await window.api.zmodem.saveFinish(target.saveId)
    if (!fin.ok) {
      // 收尾本身失败也要放掉主进程占位，否则下一个同名文件会撞 claimedPaths
      await window.api.zmodem.saveFinish(target.saveId, { aborted: true }).catch(() => null)
      emit(sessionId, {
        phase: 'error',
        direction: 'receive',
        fileName,
        bytesDone: written,
        bytesTotal: Math.max(total, written),
        ...batchMeta,
        transferId: myTransferId,
        localPath: myLocalPath,
        message: fin.error
      })
      flushPendingZrinit(state, myGen)
      return
    }
    state.batchSaved += 1
    const skipSuffix =
      state.batchSkipped > 0 ? tNow('term.zmodem.skipSuffix', { count: state.batchSkipped }) : ''
    emit(sessionId, {
      phase: 'done',
      direction: 'receive',
      fileName,
      bytesDone: fin.data.size,
      bytesTotal: Math.max(total, fin.data.size),
      ...batchMeta,
      transferId: myTransferId,
      localPath: fin.data.path,
      message:
        myFileCount > 1
          ? tNow('term.zmodem.savedBatch', {
              index: myFileIndex,
              total: myFileCount,
              path: fin.data.path,
              skipSuffix
            })
          : tNow('term.zmodem.savedSingle', { path: fin.data.path })
    })
    flushPendingZrinit(state, myGen)
  } catch (err) {
    if (state.offerGen === myGen) state.abortOffer = null
    // 已经收到的字节先落盘，不论后面是续传还是放弃都不能丢。
    // 异常本身不代表停滞，所以这里只落盘、不碰 lastProgressAt：
    // 续传后若对端仍不推进，看门狗会按原有时钟正常升级到报错。
    // 必须 flush(true)：异常路径下收尾残留（Zrinit/ZFIN 之类）也要落盘，
    // 只 flush() 会把手上这段丢掉，续传从错误偏移接上，文件被写坏。
    flush(true)
    await queue.catch(() => undefined)

    if (resyncReceive(sessionId, state, err)) {
      // 续传链路已建立：不结束流程，等对端从断点续发（由 'complete' 收尾）
      armStallTimer(sessionId, state, fileName, myGen)
      return
    }

    // 真的失败：把远端还在喷的二进制挡在终端之外，并把已收到的部分收尾，
    // 否则用户既丢了文件又看不到任何解释。
    /*
     * 先掐掉静默看门狗。旧实现在这条分支上既不 clearStallTimer 也不
     * recoverFromError：state.active 仍非空、inProtocol 仍为 true，Sentry 继续
     * 吞掉终端的所有后续输出且不会向远端发 10×CAN；15 秒后僵尸定时器还会拿着
     * 已作废的 offerGen 再发一次脏 ZRPOS，弹出第二条互不相干的报错。
     * 结果是「报了一次错，终端从此变哑巴」—— 只能重开标签。
     */
    clearStallTimer(state)
    if (state.offerGen === myGen) {
      state.deferNextZrinit = false
      state.pendingZrinit = false
    }
    state.suppressUntil = Date.now() + GARBLE_SUPPRESS_MS
    const fin2 = await window.api.zmodem
      .saveFinish(target.saveId, { aborted: true })
      .catch(() => null)
    const saved2 = fin2?.ok ? fin2.data.size : 0
    const message = saved2 > 0 ? formatAbortMessage(errText(err), saved2) : errText(err)
    emit(sessionId, {
      phase: 'error',
      direction: 'receive',
      fileName,
      bytesDone: written,
      bytesTotal: total || written,
      ...batchMeta,
      transferId: myTransferId,
      localPath: myLocalPath,
      message
    })
    /*
     * 收尾完成后再复位协议状态（recoverFromError 会清 active / inProtocol
     * 并停掉 Sentry 的吞字节逻辑）。必须排在 emit 与 saveFinish 之后：
     * 它会把 batchIndex / latest 等字段清空，emit 里那几行还要用。
     */
    recoverFromError(state)
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
        message: tNow('term.zmodem.sendStepTimeout', {
          what,
          sec: Math.round(SEND_RESPONSE_TIMEOUT_MS / 1000)
        })
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
      abortSessionCleanly(state, session)
    }
    emit(sessionId, {
      // 选文件时点「取消」是用户主动放弃，不是故障；
      // 只有选择器本身报错（pickedRes.ok === false）才算失败
      phase: pickedRes.ok ? 'canceled' : 'error',
      direction: 'send',
      bytesDone: 0,
      bytesTotal: 0,
      message: pickedRes.ok ? tNow('term.zmodem.noFileSelected') : pickedRes.error
    })
    return
  }

  const total = picked.files.reduce((a, f) => a + f.size, 0)
  let sent = 0
  let currentFile: string | undefined
  /**
   * 被对端 ZSKIP 掉的文件名。
   * lrzsz 的 rz 默认「目标已存在就跳过」，这是最常见的一种「正常但什么都没传」：
   * 必须记下来 —— 全部被跳过时界面会永远停在 detected，单文件被跳过还会谎报 done。
   */
  const skipped: string[] = []

  /**
   * 失败统一走这里：先停保活，再 abort。
   * abort 不只是「收尾好看」—— 远端 rz 还在按自己的重试节奏发 ZRINIT，
   * 不掐断的话下一次 on_detect 会让界面重新弹一次确认，用户看到的就是
   * 「传完了又让我重来一遍」。abort 会发 CAN 序列让它立刻退出。
   */
  const fail = (message: string): void => {
    stopKeepalive?.()
    stopKeepalive = null
    abortSessionCleanly(state, session)
    emit(sessionId, {
      phase: 'error',
      direction: 'send',
      fileName: currentFile,
      bytesDone: sent,
      bytesTotal: total,
      message
    })
  }

  state.transferStartedAt = Date.now()

  for (let fileIdx = 0; fileIdx < picked.files.length; fileIdx++) {
    const file = picked.files[fileIdx]
    const sendBatchMeta =
      picked.files.length > 1
        ? { fileIndex: fileIdx + 1, fileCount: picked.files.length }
        : {}
    currentFile = file.name
    // 每个文件一条记录：多文件时只留一行看不出哪个没送到
    state.transferId = uid()
    state.transferLocalPath = file.path ?? ''
    // 挑下一个文件的间隙同样没有数据帧，接着按住对端
    keepaliveOn()

    // 显式标注：没有它 TS 会把 `send_offer` 的返回值当成 any（zmodem.js 无自带类型），
    // 后面 transfer.get_offset()/send()/end() 就全成了不安全的 any 调用
    let transfer: ZmodemTransfer | undefined
    try {
      // 对端没在跑 rz、或者已经放弃退出时，这个 promise 永远不兑现 —— 必须带超时
      const step = await awaitSendStep(
        session.send_offer({ name: file.name, size: file.size, mtime: new Date() }),
        tNow('term.zmodem.waitAccept', { name: file.name })
      )
      if (!step.ok) {
        // 超时多半是对端已经跳过这个文件（rz 目标已存在），批量时不能整批失败
        if (picked.files.length > 1 && /\u65e0\u56de\u5e94|\u8d85\u65f6|timeout/i.test(step.message)) {
          skipped.push(file.name)
          continue
        }
        fail(step.message)
        return
      }
      transfer = step.value
    } catch (err) {
      fail(errText(err))
      return
    }

    // 对端跳过该文件（ZSKIP），换下一个
    if (!transfer) {
      skipped.push(file.name)
      continue
    }

    // 数据帧马上开始：这一段里再插 ZSINIT 只会打乱对端的解包状态
    keepaliveOff()

    try {
      const bytes = fromBase64(file.data)
      const fileStartOffset = transfer.get_offset()
      let sinceYield = 0
      for (let off = fileStartOffset; off < bytes.length; off += SEND_CHUNK_BYTES) {
        if (state.active !== session) return
        const slice = bytes.subarray(off, Math.min(off + SEND_CHUNK_BYTES, bytes.length))
        transfer.send(slice)
        sent += slice.length
        sinceYield += slice.length
        emit(sessionId, {
          phase: 'active',
          direction: 'send',
          fileName: file.name,
          bytesDone: off + slice.length - fileStartOffset,
          bytesTotal: file.size,
          ...sendBatchMeta
        })
        // 几 MB 的文件在一个同步循环里塞完会让渲染进程整段卡死，
        // 期间连中断按钮都点不动，所以按固定字节数定期让出
        if (sinceYield >= SEND_YIELD_BYTES) {
          sinceYield = 0
          await yieldToUi()
        }
      }

      // ZEOF 之后对端要回 ZRINIT 才算这个文件落地，这里同样不能无限等
      const endStep = await awaitSendStep(
        transfer.end(),
        tNow('term.zmodem.waitConfirmFile', { name: file.name })
      )
      if (state.active !== session) return
      if (!endStep.ok) {
        fail(endStep.message)
        return
      }
      if (picked.files.length > 1) {
        emit(sessionId, {
          phase: 'done',
          direction: 'send',
          fileName: file.name,
          bytesDone: file.size - fileStartOffset,
          bytesTotal: file.size,
          ...sendBatchMeta
        })
      }
    } catch (err) {
      if (state.active !== session) return
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
    const step = await awaitSendStep(
      Promise.resolve(session.close()),
      tNow('term.zmodem.closingSession')
    )
    if (!step.ok) closeNote = step.message
  } catch (err) {
    closeNote = errText(err)
  }
  if (closeNote) {
    // 正常收尾没走完：会话对象还挂在 Sentry 上，不清掉的话下一次 rz 的起始帧
    // 会被这个旧会话当成「未知头部」吞掉，表现为「再传就完全没反应」。
    abortSessionCleanly(state, session)
  }

  // 一个文件都没送出去（全被 ZSKIP）：这是「没传成」，绝不能报 done
  if (skipped.length === picked.files.length) {
    emit(sessionId, {
      phase: 'canceled',
      direction: 'send',
      fileName:
        skipped.length === 1
          ? skipped[0]
          : tNow('term.zmodem.fileCount', { count: skipped.length }),
      bytesDone: 0,
      bytesTotal: total,
      message: closeNote ?? tNow('term.zmodem.allRemoteSkipped')
    })
    return
  }

  const skipNote =
    skipped.length > 0
      ? tNow('term.zmodem.someRemoteSkipped', {
          count: skipped.length,
          closeNote: closeNote ? tNow('term.zmodem.semicolonNote', { note: closeNote }) : ''
        })
      : closeNote

  if (picked.files.length === 1) {
    emit(sessionId, {
      phase: 'done',
      direction: 'send',
      fileName: picked.files[0].name,
      bytesDone: sent,
      bytesTotal: total,
      message: skipNote
    })
  } else if (skipNote) {
    emit(sessionId, {
      phase: 'done',
      direction: 'send',
      fileName: tNow('term.zmodem.fileCount', { count: picked.files.length }),
      bytesDone: sent,
      bytesTotal: total,
      transferId: undefined,
      message: skipNote
    })
  }
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
  _accepted_offer?: boolean
  _file_info?: unknown
  _current_transfer?: unknown
  _got_ZFIN?: boolean
  _bytes_after_OO?: number[]
  _consume_first?: () => void
  _consume_ZDATA?: (hdr: { get_offset(): number }) => void
  _consume_ZDATA_data?: unknown
  _consume_ZEOF?: (hdr: { get_offset(): number }) => void
  _make_promise_for_between_files?: () => unknown
  _accept?: (offset?: number) => Promise<unknown>
  _send_ZRINIT?: () => void
  _send_ZRPOS?: () => void
  _on_file_end?: () => void
  _on_session_end?: () => void
  _swb_rearm_in_file?: () => boolean
}

/**
 * 接收方向进传输前补齐 zmodem.js 的多文件与实网短板：
 *
 * 1) _consume_ZDATA：放宽「回退重发」的位置校验（hdrOff <= state.fileOffset）并同步
 *    state.resyncFrom 让 on_input 去重；若出现前向跳洞（hdrOff > state.fileOffset），
 *    仍抛错交由续传发 ZRPOS，防止丢包被静默拼坏。
 * 2) _accept：同时挂载 { ZDATA, ZEOF } 且消费 ZDATA 后保留 ZDATA ——
 *    a) 0 字节文件在 ZRPOS(0) 后直接发 ZEOF(0)（无 ZDATA），原库会抛 Unhandled header: ZEOF；
 *    b) 真实 lrzsz 在窗口边界（ZCRCW）或帧尾（ZCRCE）后会发下一帧 ZDATA，原库把 ZDATA 丢掉
 *       会触发无谓的续传甚至丢弃缓冲中的帧；
 *    c) ZEOF 偏移不一致兜底时必须同时清空 _file_info 与 _current_transfer，否则多文件
 *       第二份的 ZFILE 会抛 "PROTOCOL: second ZFILE data subpacket received" 直接中止整批；
 *    d) 延后 ZEOF 里的 ZRINIT 到本份文件 flush/saveFinish 完成之后再发，消除前后两份并发互踩。
 * 3) _make_promise_for_between_files：在文件间隙兜底对端重发的 ZEOF / ZRQINIT，以及
 *    等待 beginSave IPC 期间可能重发的 ZFILE，避免把整批多文件下载判死。
 */
function primeReceiveSession(session: ZmodemSession, state: SessionState): void {
  const raw = session as unknown as RawReceiveSession

  const origConsumeZdata = raw._consume_ZDATA
  if (typeof origConsumeZdata === 'function') {
    raw._consume_ZDATA = function (
      this: RawReceiveSession,
      hdr: { get_offset(): number }
    ): void {
      const hdrOff = hdr.get_offset()
      try {
        origConsumeZdata.call(this, hdr)
      } catch (err) {
        if (!/Error correction is unimplemented/i.test(errText(err))) throw err
        if (hdrOff > state.fileOffset) throw err
        this._file_offset = hdrOff
        this._offset_ok = true
        state.resyncFrom = hdrOff
      }
    }
  }

  const origBetween = raw._make_promise_for_between_files
  if (typeof origBetween === 'function') {
    raw._make_promise_for_between_files = function (this: RawReceiveSession) {
      const ret = origBetween.call(this)
      const handlers = this._next_header_handler as
        | Record<string, (this: RawReceiveSession, hdr: unknown) => void>
        | null
        | undefined
      if (handlers) {
        const origZfile = handlers.ZFILE
        if (typeof origZfile === 'function') {
          handlers.ZFILE = function (this: RawReceiveSession, hdr: unknown) {
            origZfile.call(this, hdr)
            const origSub = this._next_subpacket_handler as
              | ((this: RawReceiveSession, subpacket: unknown) => void)
              | null
              | undefined
            if (typeof origSub === 'function') {
              this._next_subpacket_handler = function (
                this: RawReceiveSession,
                subpacket: unknown
              ) {
                const pendingHandlers: Record<
                  string,
                  (this: RawReceiveSession, h: unknown) => void
                > = {
                  ZFILE() {
                    this._next_subpacket_handler = function (this: RawReceiveSession) {
                      this._next_subpacket_handler = null
                      if (!this._next_header_handler) {
                        this._next_header_handler = pendingHandlers
                      }
                    }
                  },
                  ZRQINIT() {
                    this._next_header_handler = pendingHandlers
                  },
                  ZEOF() {
                    this._next_header_handler = pendingHandlers
                  }
                }
                this._next_header_handler = pendingHandlers
                origSub.call(this, subpacket)
              }
            }
          }
        }
        if (!handlers.ZRQINIT) {
          handlers.ZRQINIT = function (this: RawReceiveSession) {
            this._next_header_handler = handlers
            if (!state.pendingZrinit) this._send_ZRINIT?.()
          }
        }
        if (!handlers.ZEOF) {
          handlers.ZEOF = function (this: RawReceiveSession) {
            this._next_header_handler = handlers
            if (!state.pendingZrinit) this._send_ZRINIT?.()
          }
        }
      }
      return ret
    }
  }

  const origConsumeFirst = raw._consume_first
  if (typeof origConsumeFirst === 'function') {
    raw._consume_first = function (this: RawReceiveSession): void {
      if (this._got_ZFIN) {
        const buf = this._input_buffer
        if (!Array.isArray(buf) || buf.length < 2) return
        let ooAt = -1
        for (let i = 0; i + 1 < buf.length; i++) {
          if (buf[i] === 79 && buf[i + 1] === 79) {
            ooAt = i
            break
          }
        }
        if (ooAt >= 0) {
          const trailing = buf.slice(ooAt + 2)
          buf.length = 0
          this._bytes_after_OO = trailing
          this._on_session_end?.()
          return
        }
        // ZFIN 后若先到了换行/控制符或末尾半个 'O'，继续等 'OO'；若已直接回到提示符则干净收尾
        const waitingForOO = buf.every(
          (b, idx) =>
            b === 0x0d ||
            b === 0x0a ||
            b === 0x8a ||
            b === 0x8d ||
            b === 0x11 ||
            b === 0x13 ||
            (b === 79 && idx === buf.length - 1)
        )
        if (waitingForOO) return
        this._bytes_after_OO = buf.splice(0)
        this._on_session_end?.()
        return
      }
      origConsumeFirst.call(this)
    }
  }

  if (typeof raw._accept === 'function') {
    const buildInFileHandlers = (
      resolveAccept?: () => void
    ): Record<string, (this: RawReceiveSession, hdr: { get_offset(): number }) => void> => {
      const inFileHandlers: Record<
        string,
        (this: RawReceiveSession, hdr: { get_offset(): number }) => void
      > = {
        ZDATA(hdr) {
          this._consume_ZDATA?.(hdr)
          this._next_subpacket_handler = this._consume_ZDATA_data
          this._next_header_handler = inFileHandlers
        },
        ZEOF(hdr) {
          this._next_subpacket_handler = null
          try {
            this._consume_ZEOF?.(hdr)
          } catch {
            // ZEOF 偏移不一致时仍认本份收完，同时清掉 _file_info/_current_transfer，
            // 防止下一份 ZFILE 撞上 "second ZFILE data subpacket received"
            this._on_file_end?.()
            this._file_info = null
            this._current_transfer = null
          }
          this._accepted_offer = false
          this._make_promise_for_between_files?.()
          resolveAccept?.()
          if (state.deferNextZrinit) {
            state.pendingZrinit = true
          } else {
            this._send_ZRINIT?.()
          }
        }
      }
      return inFileHandlers
    }

    raw._swb_rearm_in_file = function (this: RawReceiveSession): boolean {
      if (!this._accepted_offer) return false
      if (Array.isArray(this._input_buffer)) this._input_buffer.length = 0
      this._next_subpacket_handler = null
      this._file_offset = state.fileOffset
      this._next_header_handler = buildInFileHandlers()
      return true
    }

    raw._accept = function patchedAccept(
      this: RawReceiveSession,
      offset?: number
    ): Promise<void> {
      this._accepted_offer = true
      this._file_offset = offset || 0

      const ret = new Promise<void>((resolveAccept) => {
        this._next_header_handler = buildInFileHandlers(resolveAccept)
      })

      this._send_ZRPOS?.()
      return ret
    }
  }
}

/**
 * 断点续传：把解析器从错误状态里拽回来，并让对端从已经收到的字节处重发。
 *
 * 库的状态机在某一帧抛错后就把 ZDATA 处理器消费掉了，之后每帧都只会继续抛
 * "Unhandled header: ZDATA"。唯一能重建处理器的入口是内部的 _accept(offset)：
 * 它重装 {ZDATA, ZEOF} 处理器——顺带把 _accepted_offer/_file_offset 重新对齐——
 * 并主动发一个 ZRPOS。调用前必须先清掉异常残留的半帧，否则新处理器会先吃到脏字节。
 *
 * 注意 _accept() 会另起一个 promise，原来 offer.accept() 的那个永远不会兑现，
 * 所以完成判定不能依赖 await accept()，只能靠 offer 的 'complete' 事件（ZEOF 触发）。
 */
function resyncReceive(sessionId: string, state: SessionState, err: unknown): boolean {
  const session = state.active
  if (!session) return false
  if (!isRecoverableProtocolError(err)) return false
  const raw = session as unknown as RawReceiveSession
  if (!raw._accepted_offer) return false
  if (state.resyncAttempts >= RESYNC_MAX_ATTEMPTS) return false

  const now = Date.now()
  // 150ms 限流窗内不再重复发 ZRPOS（高延迟链路如 315ms RTT 下上一轮 ZRPOS 还在路上），
  // 但必须清掉坏帧残留并重装解析器且确认重装成功才返回 true，同时计入尝试次数上限。
  if (now - state.lastResyncAt < RESYNC_MIN_INTERVAL_MS) {
    if (raw._swb_rearm_in_file?.() !== true) return false
    state.resyncAttempts += 1
    state.resyncFrom = state.fileOffset
    return true
  }

  state.resyncAttempts += 1
  state.lastResyncAt = now
  return resumeFromOffset(
    sessionId,
    state,
    tNow('term.zmodem.jitterResync', {
      offset: state.fileOffset,
      count: state.resyncAttempts
    })
  )
}

/**
 * 从当前文件偏移重新咬住链路：清掉半帧残留、重装解析器、重发 ZRPOS。
 * 抛错续传和静默看门狗走的是同一条路 —— 前者有异常可依，后者只能靠猜，
 * 但两者需要的动作完全一样。
 */
function resumeFromOffset(sessionId: string, state: SessionState, message: string): boolean {
  const session = state.active
  if (!session) return false
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
    // 续传请求就是本轮的新基准：从现在起再等一个完整静默窗，没有新字节才升级。
    // 不重置的话，连续两次续传会挨着发出去（时钟还停在上一次落盘的时刻）。
    state.lastProgressAt = Date.now()
    // _accept 内部已统一挂载 {ZDATA, ZEOF} 并重发 ZRPOS，对端据此从 offset 处续传
    void Promise.resolve(session._accept(offset)).catch(() => {
      /* 这条链的成败由 'complete' 事件决定，这里只防止未处理的 rejection */
    })
    const snap = lastProgress.get(sessionId)
    emit(sessionId, {
      phase: 'active',
      direction: 'receive',
      fileName: snap?.fileName,
      bytesDone: offset,
      bytesTotal: snap?.bytesTotal ?? 0,
      fileIndex: snap?.fileIndex,
      fileCount: snap?.fileCount,
      message
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
    // 必须切片喂：zmodem.js 内部用 `_input_buffer.push.apply(buf, input)` 把整批字节
    // 摊进数组，参数个数等于这批字节数。一次喂几十万字节就是几十万个实参，
    // JS 直接抛 RangeError: Maximum call stack size exceeded —— 大文件传到中途
    // 必然命中（链路越快、合帧越大越早炸），小文件因为每批都很小才侥幸没事。
    const bytes = fromBase64(rawBase64)
    for (let i = 0; i < bytes.length; i += FEED_SLICE_BYTES) {
      state.sentry.consume(bytes.subarray(i, Math.min(bytes.length, i + FEED_SLICE_BYTES)))
    }
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
    const wasActive = !!state.active
    const direction = state.direction ?? 'receive'
    const abortOffer = state.abortOffer
    const reason = errText(err)
    const snap = lastProgress.get(sessionId)
    recoverFromError(state)
    // 绝不静默冻死：唤醒挂着的 handleOffer 落盘并上报 error，或直接发 error 通知 UI
    if (abortOffer) {
      abortOffer('error', reason)
    } else if (wasActive) {
      emit(sessionId, {
        phase: 'error',
        direction,
        fileName: snap?.fileName,
        bytesDone: snap?.bytesDone ?? 0,
        bytesTotal: snap?.bytesTotal ?? 0,
        fileIndex: snap?.fileIndex,
        fileCount: snap?.fileCount,
        message: formatAbortMessage(reason)
      })
    }
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
  return /Unhandled header:\s*ZR?Q?INIT/i.test(message)
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
  // 自增代次：让还在 await 里的那次确认/选目录流程回来时判定自己已过期，
  // 否则它复位状态之后照样往下走，把刚中止的传输又拉起来
  state.promptGen += 1
  state.receivedBytes = 0
  state.fileOffset = 0
  state.resyncFrom = -1
  state.gapResyncOffset = -1
  state.startupStalls = 0
  cancel?.()
  clearStallTimer(state)
  clearWatchThrottle(state)
  state.active = null
  state.inProtocol = false
  state.direction = null
  state.protocolEnded = false
  state.pendingDetect = false
  state.autoConfirm = null
  state.saveDirToken = null
  state.latest = null
  state.deferNextZrinit = false
  state.pendingZrinit = false
  state.batchIndex = 0
  state.batchTotal = 0
  state.skipExisting = true
  state.batchSaved = 0
  state.batchSkipped = 0
  state.lastSkippedName = ''
  state.lastSkippedPath = ''
  state.lastSkippedSize = 0
  state.abortOffer = null
  state.lastWatchAt = 0
  state.lastWatchKey = ''
  clearAutoTimer(state)
  abortSessionCleanly(state, stray)
  // abort 之后 Sentry 不再接管输出，而远端还在推数据帧 —— 开一个抑制窗把这些
  // 协议残渣与 raw 模式文件流挡在终端之外，否则界面会被刷成一片乱码。
  state.suppressUntil = Date.now() + GARBLE_SUPPRESS_MS
  state.resyncAttempts = 0
  state.lastResyncAt = 0
}

/** 用户主动中断当前传输（进度面板的「中断」按钮 / Esc） */
export function abortZmodem(sessionId: string): void {
  const state = states.get(sessionId)
  if (!state) return

  const wasActive = !!state.active
  /*
   * 「在等」也分好几种：等远端重发、等用户确认、等用户选目录。
   * 这些状态下 state.active 是 null，旧代码因此一条终态事件都不发 ——
   * lastProgress 永远停在 detected，切走再切回来浮层又活了，
   * 而且捕获阶段的 Esc 监听器还在，用户按 Esc 只关掉浮层关不掉流程。
   */
  const hadRemoteWait =
    state.pendingDetect || !!state.autoConfirm || state.inProtocol || state.prompting
  const direction = state.direction ?? 'receive'
  const abortOffer = state.abortOffer
  const prevTransferId = state.transferId ?? undefined
  const prevLocalPath = state.transferLocalPath || undefined
  const snap = lastProgress.get(sessionId)
  recoverFromError(state)
  if (!wasActive && hadRemoteWait) {
    sendAbortSequence(state)
  }
  abortOffer?.('canceled')

  // 只要还有任何在途/等待中的流程，就必须发终态：这是浮层与 Esc 监听的唯一出口
  if (wasActive || hadRemoteWait) {
    emit(sessionId, {
      phase: 'canceled',
      direction,
      fileName: snap?.fileName,
      bytesDone: snap?.bytesDone ?? 0,
      bytesTotal: snap?.bytesTotal ?? 0,
      fileIndex: snap?.fileIndex,
      fileCount: snap?.fileCount,
      transferId: prevTransferId,
      localPath: prevLocalPath,
      message: tNow('term.zmodem.abortedTransfer')
    })
  }
}

/** 会话关闭时清理 */
export function detachZmodem(sessionId: string): void {
  const state = states.get(sessionId)
  if (!state) return
  const abortOffer = state.abortOffer
  if (state.residueTimer) {
    clearTimeout(state.residueTimer)
    state.residueTimer = undefined
  }
  recoverFromError(state)
  abortOffer?.('canceled')
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

type ConfirmHandler = (
  sessionId: string,
  direction: ZmodemDirection
) => Promise<ZmodemConfirmResult>

let confirmHandler: ConfirmHandler | null = null

/** UI 注册确认处理器（ZmodemPrompt 组件挂载时调用） */
export function setZmodemConfirmHandler(fn: ConfirmHandler | null): void {
  confirmHandler = fn
}

/** 模块内部发起确认；没有注册处理器时默认拒绝，避免静默接管字节流 */
export function requestZmodemConfirm(
  sessionId: string,
  direction: ZmodemDirection
): Promise<ZmodemConfirmResult> {
  if (!confirmHandler) return Promise.resolve(false)
  return confirmHandler(sessionId, direction)
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
