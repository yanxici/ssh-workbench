/**
 * 网段工具（纯函数，可独立测试）。
 * 用于设备发现：本机网卡 → 建议扫描网段 → 展开主机清单。
 */

export function ipToInt(ip: string): number {
  const parts = ip.split('.').map(Number)
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    throw new Error(`非法 IPv4 地址：${ip}`)
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0
}

export function intToIp(n: number): string {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
}

export function prefixToMask(prefix: number): number {
  if (prefix <= 0) return 0
  if (prefix >= 32) return 0xffffffff >>> 0
  return (0xffffffff << (32 - prefix)) >>> 0
}

export function maskToPrefix(netmask: string): number {
  const mask = ipToInt(netmask)
  let prefix = 0
  for (let i = 31; i >= 0; i--) {
    if ((mask >>> i) & 1) prefix += 1
    else break
  }
  return prefix
}

/** 由地址 + 掩码推导网段（如 192.168.1.37 + 255.255.255.0 → 192.168.1.0/24） */
export function cidrFromAddress(address: string, netmask: string): string {
  const prefix = maskToPrefix(netmask)
  const network = ipToInt(address) & prefixToMask(prefix)
  return `${intToIp(network >>> 0)}/${prefix}`
}

export function parseCidr(cidr: string): { network: number; prefix: number } {
  const m = cidr.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/)
  if (!m) throw new Error(`非法网段：${cidr}（示例：192.168.1.0/24）`)
  const prefix = Number(m[2])
  if (prefix < 16 || prefix > 32) {
    throw new Error('仅支持 /16 ~ /32 的网段（更大范围请缩小后再扫描）')
  }
  const addr = ipToInt(m[1])
  const network = addr & prefixToMask(prefix)
  return { network: network >>> 0, prefix }
}

/**
 * 展开网段内可扫描的主机地址（剔除网络号与广播地址）。
 * maxHosts 用于保护：超大网段直接拒绝而不是压垮扫描器。
 */
export function expandCidrHosts(cidr: string, maxHosts = 1024): string[] {
  const { network, prefix } = parseCidr(cidr)
  const count = 2 ** (32 - prefix)
  if (count > maxHosts + 2) {
    throw new Error(`网段过大（${count - 2} 台主机），请使用 /22 及更小的范围`)
  }
  const hosts: string[] = []
  for (let i = 1; i < count - 1; i++) {
    hosts.push(intToIp((network + i) >>> 0))
  }
  return hosts
}
