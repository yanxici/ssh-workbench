/**
 * 串口端口解析：把保存的连接配置映射到「当前真实存在的端口」。
 *
 * 为什么需要这一步：Windows 上 COM 号是按枚举顺序分配的，拔掉再插上、
 * 或者插到另一个 USB 口，COM3 可能变成 COM7，而另一台同型号设备可能正好占了
 * COM3。直接拿保存的路径去开，轻则打不开，重则连到别人的设备上敲命令 ——
 * 后者在现场是不可接受的。
 *
 * 匹配优先级（对应 SerialConfig 上 usbSerialNumber / usbPnpId 的注释）：
 *   1. serialNumber —— 芯片出厂唯一，最可靠；CP210x、FTDI 普遍有
 *   2. pnpId        —— 含 VID/PID/序列号；廉价 CH340 往往只有 VID/PID，
 *                      同型号两台就分不开，所以放在第二位而非第一位
 *   3. 保存的 path  —— 两者都没有时的最后手段，只能信 COM 号
 */
import type { SerialConfig, SerialPortInfo } from '@shared/types'

export type SerialResolveResult =
  | { ok: true; path: string; /** 通过什么匹配到的，用于在界面上解释 */ via: 'serial' | 'pnp' | 'path' }
  | { ok: false; reason: 'not-found' | 'ambiguous'; candidates: SerialPortInfo[] }

/** 端口是否具备可用于重连的稳定身份 */
export function hasStableIdentity(cfg: Pick<SerialConfig, 'usbSerialNumber' | 'usbPnpId'>): boolean {
  return Boolean(cfg.usbSerialNumber || cfg.usbPnpId)
}

/**
 * 在一份端口列表里找出配置对应的端口。
 *
 * 返回 ambiguous 而不是随便挑一个：两台同型号 CH340 都在时，猜错等于
 * 把命令敲到别人的设备上，必须让用户自己选。
 *
 * 同样地，**存了 USB 身份却对不上时不退化到 COM 号**：那说明现在插在
 * 这个端口上的不是当初那台设备（换了芯片、或者端口号被别的设备占了），
 * 静默连上去就是往陌生设备敲命令。这种情况返回 not-found，让界面提示重选。
 *
 * 唯一的例外是「这个平台根本给不出身份」：Linux 的 /dev/ttyUSB0 常常没有
 * serialNumber/pnpId，整个列表都是空身份。此时按身份判定会让 Linux 用户
 * 永远连不上，所以只有列表里确实存在带身份的设备、且无一匹配时才算失配。
 */
export function resolveSerialPath(cfg: SerialConfig, ports: SerialPortInfo[]): SerialResolveResult {
  const wantSn = cfg.usbSerialNumber?.trim()
  const wantPnp = cfg.usbPnpId?.trim()
  const hasIdentity = Boolean(wantSn || wantPnp)
  // 这个环境是否能提供身份信息（一个都没有，说明驱动/平台不给）
  const envHasIdentity = ports.some((p) => p.serialNumber?.trim() || p.pnpId?.trim())

  if (wantSn) {
    const hits = ports.filter((p) => p.serialNumber?.trim() === wantSn)
    if (hits.length === 1) return { ok: true, path: hits[0].path, via: 'serial' }
    if (hits.length > 1) return { ok: false, reason: 'ambiguous', candidates: hits }
  }

  if (wantPnp) {
    const hits = ports.filter((p) => p.pnpId?.trim() === wantPnp)
    if (hits.length === 1) return { ok: true, path: hits[0].path, via: 'pnp' }
    if (hits.length > 1) return { ok: false, reason: 'ambiguous', candidates: hits }
  }

  // 存了身份、环境也认得出身份、但没有一台对得上 —— 不是当初那台设备
  if (hasIdentity && envHasIdentity) {
    return { ok: false, reason: 'not-found', candidates: [] }
  }

  // 退化到端口路径：只有确实存在才算命中，不存在就是 not-found（提示重选）
  const byPath = ports.find((p) => p.path === cfg.path)
  if (byPath) return { ok: true, path: byPath.path, via: 'path' }

  return { ok: false, reason: 'not-found', candidates: [] }
}

/**
 * 把当前端口列表里某一项的身份写回配置（用户选定端口后调用）。
 * 保存身份是为了下次拔插能靠它找回同一台设备。
 */
export function applyPortIdentity(
  cfg: SerialConfig,
  port: SerialPortInfo | undefined
): SerialConfig {
  return {
    ...cfg,
    path: port?.path ?? cfg.path,
    usbSerialNumber: port?.serialNumber?.trim() || undefined,
    usbPnpId: port?.pnpId?.trim() || undefined,
    pathPending: false
  }
}
