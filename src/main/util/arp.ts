/**
 * ARP 表解析（纯函数，可独立测试）。
 * 兼容三种常见输出：
 *   Windows : arp -a   → "  192.168.1.1   aa-bb-cc-dd-ee-ff   动态"
 *   Linux   : arp -an  → "? (192.168.1.1) at aa:bb:cc:dd:ee:ff [ether] on eth0"
 *   iproute2: ip neigh → "192.168.1.1 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE"
 */

const IPV4 = /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/
/*
 * 每段 1~2 位十六进制：macOS 的 arp -a 不补前导零（0:1c:42:0:0:1），
 * 只认两位的版本会把 macOS 上的条目整条漏掉，内网扫描就少了一堆设备。
 */
const MAC = /([0-9a-fA-F]{1,2}[:-]){5}[0-9a-fA-F]{1,2}/

export function parseArpTable(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const ipMatch = line.match(IPV4)
    const macMatch = line.match(MAC)
    if (!ipMatch || !macMatch) continue
    // 统一成补零的两段式，不同系统同一块网卡才会归成同一个键
    const mac = macMatch[0]
      .split(/[:-]/)
      .map((p) => p.padStart(2, '0'))
      .join(':')
      .toLowerCase()
    if (mac === 'ff:ff:ff:ff:ff:ff' || mac.startsWith('01:00:5e') || mac.startsWith('33:33')) {
      continue // 广播 / 组播地址没有意义
    }
    out[ipMatch[1]] = mac
  }
  return out
}

/* 厂商识别见 @shared/arpVendor（渲染层展示用） */
