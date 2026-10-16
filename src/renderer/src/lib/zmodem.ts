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
}

/** 会话结束后等待残渣到齐的窗口（远端常会补发 ZRINIT 等） */
const RESIDUE_WINDOW_MS = 600

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

function emit(sessionId: string, p: ZmodemProgress): void {
  watchers.get(sessionId)?.(p)
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
    everHadSession: false
  }

  state.sentry = new Sentry({
    to_terminal: (octets) => {
      // 协议未接管的字节：按 UTF-8 边界解码回文本再写终端
      const text = state.decoder.decode(Uint8Array.from(toOctets(octets)), { stream: true })
      if (!text) return

      // 传输期间/刚结束后出现的、形如协议残渣的输出不写终端，改为记账待清理。
      // 例如结尾的 `\x18` 会被终端渲染成一个乱码字形（用户看到的就是它）。
      if ((state.inProtocol || state.protocolEnded) && isResidueText(text)) {
        state.residueChars += text.length
        return
      }
      hooks.write(text)
    },
    on_retract: () => {
      state.prompting = false
    },
    sender: (octets) => {
      hooks.send(Uint8Array.from(toOctets(octets)))
    },
    on_detect: (detection: Detection) => {
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
  if (state.active || state.prompting) return

  // get_session_role() 返回的就是「我方角色」：
  //   'receive' = 对端 sz 发文件给我们（ZRQINIT 由发送方发出）
  //   'send'    = 对端 rz 要收文件，由我们发（ZRINIT 由接收方发出）
  // 因此直接采用，切勿取反。
  const direction: ZmodemDirection =
    detection.get_session_role() === 'receive' ? 'receive' : 'send'

  state.prompting = true
  emit(sessionId, {
    phase: 'detected',
    direction,
    bytesDone: 0,
    bytesTotal: 0
  })

  let ok = false
  try {
    ok = await hooks.confirm(direction)
  } catch {
    ok = false
  } finally {
    state.prompting = false
  }

  if (!detection.is_valid()) return

  if (!ok) {
    // 用户拒绝：发送中止序列，让远端退出 sz/rz
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

  let session: ZmodemSession
  try {
    session = detection.confirm()
  } catch {
    emit(sessionId, {
      phase: 'error',
      direction,
      bytesDone: 0,
      bytesTotal: 0,
      message: 'ZMODEM 会话启动失败'
    })
    return
  }

  state.active = session
  state.everHadSession = true

  // 进入协议态：从现在起直到会话结束，终端上出现的是协议残渣而非正常输出，
  // 交给 residue 缓冲区收集，等会话结束后统一清理（见 scheduleResidueFlush）。
  state.inProtocol = true
  state.protocolEnded = false

  session.on('session_end', () => {
    state.active = null
    state.inProtocol = false
    // 会话结束后排一次清理：远端可能还会补发一点残渣，给它一个短暂窗口
    scheduleResidueFlush(state)
  })

  if (direction === 'receive') {
    void runReceive(sessionId, session)
  } else {
    void runSend(sessionId, session)
  }
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

/** 远端 sz 发文件 -> 本机保存 */
async function runReceive(sessionId: string, session: ZmodemSession): Promise<void> {
  session.on('offer', (offer: ZmodemOffer) => {
    void (async () => {
      let details
      try {
        details = offer.get_details()
      } catch {
        details = { name: 'download.bin', size: 0 }
      }

      // 先要一个保存位置；用户取消则跳过该文件
      const pickedRes = await window.api.zmodem.saveFile(details.name || 'download.bin')
      if (!pickedRes.ok) {
        offer.skip()
        emit(sessionId, {
          phase: 'error',
          direction: 'receive',
          fileName: details.name,
          bytesDone: 0,
          bytesTotal: details.size || 0,
          message: pickedRes.error
        })
        return
      }
      const picked = pickedRes.data
      if (picked.canceled || !picked.token) {
        offer.skip()
        emit(sessionId, {
          phase: 'done',
          direction: 'receive',
          fileName: details.name,
          bytesDone: 0,
          bytesTotal: details.size || 0,
          message: '已跳过'
        })
        return
      }

      const chunks: Uint8Array[] = []
      let done = 0

      try {
        await offer.accept({
          on_input: (payload: Uint8Array) => {
            chunks.push(payload)
            done += payload.length
            emit(sessionId, {
              phase: 'active',
              direction: 'receive',
              fileName: details.name,
              bytesDone: done,
              bytesTotal: details.size || 0
            })
          }
        })

        // 合并后一次性落盘（走主进程，一次 base64 传输）
        const merged = concat(chunks)
        const writeRes = await window.api.zmodem.writeFile(picked.token, toBase64(merged))
        const size = writeRes.ok ? writeRes.data.size : merged.length
        if (!writeRes.ok) {
          emit(sessionId, {
            phase: 'error',
            direction: 'receive',
            fileName: details.name,
            bytesDone: done,
            bytesTotal: details.size || merged.length,
            message: writeRes.error
          })
          return
        }
        emit(sessionId, {
          phase: 'done',
          direction: 'receive',
          fileName: details.name,
          bytesDone: size,
          bytesTotal: details.size || merged.length
        })
      } catch (err) {
        emit(sessionId, {
          phase: 'error',
          direction: 'receive',
          fileName: details.name,
          bytesDone: done,
          bytesTotal: details.size || 0,
          message: String(err)
        })
      }
    })()
  })
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
        message: String(err)
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
        message: String(err)
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
  } catch {
    // 解析异常不应打断终端：把原文直接写出去兜底
    if (fallbackText) state.hooks.write(fallbackText)
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
  states.delete(sessionId)
  watchers.delete(sessionId)
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
    bytesToBase64,
    // 构造真实的 ZMODEM 起始帧，避免测试里硬编码字节序列
    testBuildZRQINIT: (): number[] => {
      const hdr = ZmodemModule.Header.build('ZRQINIT', [0, 0, 0, 0])
      return hdr.to_hex()
    }
  }
}
