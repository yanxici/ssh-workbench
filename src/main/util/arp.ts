/**
 * ARP 表解析（纯函数，可独立测试）。
 * 兼容三种常见输出：
 *   Windows : arp -a   → "  192.168.1.1   aa-bb-cc-dd-ee-ff   动态"
 *   Linux   : arp -an  → "? (192.168.1.1) at aa:bb:cc:dd:ee:ff [ether] on eth0"
 *   iproute2: ip neigh → "192.168.1.1 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE"
 */

const IPV4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/
const MAC = /([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}/

export function parseArpTable(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const ipMatch = line.match(IPV4)
    const macMatch = line.match(MAC)
    if (!ipMatch || !macMatch) continue
    const mac = macMatch[0].replace(/-/g, ':').toLowerCase()
    if (mac === 'ff:ff:ff:ff:ff:ff' || mac.startsWith('01:00:5e') || mac.startsWith('33:33')) {
      continue // 广播 / 组播地址没有意义
    }
    out[ipMatch[1]] = mac
  }
  return out
}

/* 厂商识别见 @shared/arpVendor（渲染层展示用） */
