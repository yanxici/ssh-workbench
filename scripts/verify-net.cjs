/**
 * 网段工具与 ARP 解析自检（无需构建环境）。
 * 用法：node node_modules/typescript/bin/tsc -p tsconfig.verify.json && node scripts/verify-net.cjs
 */
const {
  ipToInt,
  intToIp,
  maskToPrefix,
  cidrFromAddress,
  expandCidrHosts,
  parseCidr
} = require('../.tsc-verify/main/util/cidr.js')
const { parseArpTable } = require('../.tsc-verify/main/util/arp.js')
const { guessVendor } = require('../.tsc-verify/shared/arpVendor.js')

let pass = 0
let fail = 0

function check(name, condition, detail) {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}${detail !== undefined ? `  -> ${detail}` : ''}`)
  }
}

console.log('== IP / 网段 ==')
{
  check('ipToInt / intToIp 往返一致', intToIp(ipToInt('192.168.1.37')) === '192.168.1.37')
  check('边界 IP 正常', intToIp(ipToInt('255.255.255.255')) === '255.255.255.255')
  check('非法 IP 抛错', (() => {
    try { ipToInt('999.1.1.1'); return false } catch { return true }
  })())
  check('掩码 /24 → prefix 24', maskToPrefix('255.255.255.0') === 24)
  check('掩码 /16 → prefix 16', maskToPrefix('255.255.0.0') === 16)
  check('掩码 /20 → prefix 20', maskToPrefix('255.255.240.0') === 20)
  check('192.168.1.37/255.255.255.0 → 192.168.1.0/24', cidrFromAddress('192.168.1.37', '255.255.255.0') === '192.168.1.0/24')
  check('172.16.33.7/255.255.240.0 → 172.16.32.0/20', cidrFromAddress('172.16.33.7', '255.255.240.0') === '172.16.32.0/20')

  const hosts24 = expandCidrHosts('192.168.1.0/24')
  check('/24 展开 254 台主机', hosts24.length === 254, String(hosts24.length))
  check('首尾正确（.1 ... .254）', hosts24[0] === '192.168.1.1' && hosts24[253] === '192.168.1.254')
  check('不含网络号与广播地址', !hosts24.includes('192.168.1.0') && !hosts24.includes('192.168.1.255'))

  const hosts30 = expandCidrHosts('10.0.0.4/30')
  check('/30 展开 2 台', hosts30.length === 2 && hosts30[0] === '10.0.0.5' && hosts30[1] === '10.0.0.6', JSON.stringify(hosts30))

  check('非字节对齐网段（192.168.1.77/24 → 1.0/24）', parseCidr('192.168.1.77/24').network === ipToInt('192.168.1.0'))

  check('超大网段被拒绝', (() => {
    try { expandCidrHosts('10.0.0.0/8'); return false } catch { return true }
  })())
  check('非法格式被拒绝', (() => {
    try { expandCidrHosts('192.168.1.0'); return false } catch { return true }
  })())
  check('/32 无主机', expandCidrHosts('192.168.1.1/32').length === 0)
}

console.log('== ARP 表解析（三种格式）==')
{
  const windows = [
    '接口: 192.168.1.5 --- 0x8',
    '  Internet 地址         物理地址              类型',
    '  192.168.1.1           b8-27-eb-11-22-33     动态',
    '  192.168.1.255         ff-ff-ff-ff-ff-ff     静态',
    '  224.0.0.22            01-00-5e-00-00-16     静态'
  ].join('\r\n')
  const table1 = parseArpTable(windows)
  check('Windows：正常条目解析（连字符归一为冒号）', table1['192.168.1.1'] === 'b8:27:eb:11:22:33', JSON.stringify(table1))
  check('Windows：广播 MAC 被过滤', table1['192.168.1.255'] === undefined)
  check('Windows：组播 MAC 被过滤', table1['224.0.0.22'] === undefined)

  const linux = [
    '? (192.168.10.1) at 00:0c:29:aa:bb:cc [ether] on eth0',
    '? (192.168.10.20) at dc:a6:32:01:02:03 [ether] on eth0'
  ].join('\n')
  const table2 = parseArpTable(linux)
  check('Linux arp -an 格式解析', table2['192.168.10.1'] === '00:0c:29:aa:bb:cc')
  check('Linux 多条记录', Object.keys(table2).length === 2)

  const iproute = '192.168.1.50 dev eth0 lladdr 7c:df:a1:12:34:56 REACHABLE\n192.168.1.60 dev eth0 lladdr D8-A0-1D-AA-BB-CC STALE'
  const table3 = parseArpTable(iproute)
  check('ip neigh 格式解析', table3['192.168.1.50'] === '7c:df:a1:12:34:56')
  check('大写/连字符 MAC 归一化', table3['192.168.1.60'] === 'd8:a0:1d:aa:bb:cc', table3['192.168.1.60'])

  check('空文本返回空表', Object.keys(parseArpTable('')).length === 0)
  check('垃圾行不崩溃', Object.keys(parseArpTable('hello world\n???\n12345')).length === 0)
}

console.log('== MAC 厂商识别 ==')
{
  check('树莓派 OUI 命中', guessVendor('b8:27:eb:11:22:33') === '树莓派')
  check('ESP32 OUI 命中', guessVendor('7c:df:a1:12:34:56') === '乐鑫 ESP32')
  check('未知 OUI 返回 undefined', guessVendor('aa:bb:cc:dd:ee:ff') === undefined)
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
