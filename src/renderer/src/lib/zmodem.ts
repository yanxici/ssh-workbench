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
 *   3) 协议解析抛错后 Sentry 仍持有会话对象，后续输出全被吞掉（终端像死了），
 *      必须在 catch 里 abort 并复位状态。
 */

import * as ZmodemModule from 'zmodem.js'
import { Sentry, type Detection, type ZmodemSession, type ZmodemOffer } from 'zmodem.js'

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
  /** 接收看门狗：会话建立后远端迟迟不发数据时提示用户，而不是干等 */
  stallTimer?: ReturnType<typeof setTimeout>
}

/** 会话结束后等待残渣到齐的窗口（远端常会补发 ZRINIT 等） */
const RESIDUE_WINDOW_MS = 600

/** 等远端重发起始帧的最长时间，超时即判定对方已经放弃 */
const AUTO_CONFIRM_TIMEOUT_MS = 20000

/** 会话建立后等第一份数据的最长时间 */
const RECEIVE_STALL_MS = 15000

/** 接收时攒够这么多字节就落盘一次，避免整份文件驻留渲染进程内存 */
const RECEIVE_FLUSH_BYTES = 256 * 1024

/**
 * 识别「协议残渣」行：远端传输结束后残留的控制字符回显、重发的 ZRINIT 头、
 * 以及 sz/rz 的进度文案。用于把这类内容记入 residueChars 而不是当作正常输出。
 */
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
    receivedBytes: 0
  }

  state.sentry = new Sentry({
    to_terminal: (octets) => {
      // 协议未接管的字节：按 UTF-8 边界解码回文本再写终端
      const text = state.decoder.decode(Uint8Array.from(toOctets(octets)), { stream: true })
      if (!text) return

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
    clearAutoTimer(state)
    clearStallTimer(state)
    // 会话结束后排一次清理：远端可能还会补发一点残渣，给它一个短暂窗口
    scheduleResidueFlush(state)
  })

  if (direction === 'receive') {
    void runReceive(sessionId, session, state)
  } else {
    void runSend(sessionId, session)
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

  const chunks: Uint8Array[] = []
  let pending = 0
  let written = 0
  let queue: Promise<void> = Promise.resolve()
  let failed: string | null = null

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

  try {
    await offer.accept({
      on_input: (payload: Uint8Array) => {
        state.receivedBytes += payload.length
        chunks.push(payload)
        pending += payload.length
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

    clearStallTimer(state)
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
    emit(sessionId, {
      phase: 'error',
      direction: 'receive',
      fileName,
      bytesDone: written + pending,
      bytesTotal: total,
      message: errText(err)
    })
  }
}

/** 本机选文件 -> 远端 rz 接收 */
async function runSend(sessionId: string, session: ZmodemSession): Promise<void> {
  const pickedRes = await window.api.zmodem.pickFiles()
  const picked = pickedRes.ok ? pickedRes.data : { canceled: true, files: [] }
  if (!pickedRes.ok || picked.canceled || !picked.files.length) {
    try {
      session.close()
    } catch {
      /* 忽略 */
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

  for (const file of picked.files) {
    let transfer
    try {
      transfer = await session.send_offer({
        name: file.name,
        size: file.size,
        mtime: new Date()
      })
    } catch (err) {
      emit(sessionId, {
        phase: 'error',
        direction: 'send',
        fileName: file.name,
        bytesDone: sent,
        bytesTotal: total,
        message: errText(err)
      })
      return
    }

    // 对端跳过该文件
    if (!transfer) continue

    try {
      const bytes = fromBase64(file.data)
      // 分片发送，便于上报进度；64KB 与常见 ZMODEM 实现的分块接近
      const CHUNK = 64 * 1024
      for (let off = transfer.get_offset(); off < bytes.length; off += CHUNK) {
        const slice = bytes.subarray(off, Math.min(off + CHUNK, bytes.length))
        transfer.send(slice)
        sent += slice.length
        emit(sessionId, {
          phase: 'active',
          direction: 'send',
          fileName: file.name,
          bytesDone: sent,
          bytesTotal: total
        })
      }
      await transfer.end()
    } catch (err) {
      emit(sessionId, {
        phase: 'error',
        direction: 'send',
        fileName: file.name,
        bytesDone: sent,
        bytesTotal: total,
        message: errText(err)
      })
      return
    }
  }

  try {
    session.close()
  } catch {
    /* 忽略 */
  }

  emit(sessionId, {
    phase: 'done',
    direction: 'send',
    fileName: picked.files.length === 1 ? picked.files[0].name : `${picked.files.length} 个文件`,
    bytesDone: sent,
    bytesTotal: total
  })
}

/** 该会话是否已挂载 Sentry（挂载后终端输出统一经 Sentry 转发） */
export function isZmodemAttached(sessionId: string): boolean {
  return states.has(sessionId)
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

    // 其它解析异常不能只吞掉：Sentry 里那个会话对象仍然处于「已接管」状态，
    // 不 abort 的话后续所有输出都会被它吃掉，终端看起来就像死了。
    recoverFromError(state)
    if (fallbackText) state.hooks.write(fallbackText)
  }
}

/** 对端重发的起始帧（sz 的 ZRQINIT 重传），属于正常协议噪声 */
function isPeerRetransmit(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '')
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
