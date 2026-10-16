/**
 * mDNS 报文解析/构建自检（手工构造带压缩指针的真实报文，无需网络）。
 * 用法：node node_modules/typescript/bin/tsc -p tsconfig.verify.json && node scripts/verify-mdns.cjs
 */
const {
  parseDnsMessage,
  buildDnsQuery,
  readName,
  resolveServices
} = require('../.tsc-verify/main/util/mdns.js')

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

const u16 = (n) => {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n)
  return b
}
const u32 = (n) => {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n)
  return b
}

function encodeName(name) {
  const labels = name.split('.').filter(Boolean)
  const parts = labels.map((l) => {
    const b = Buffer.from(l, 'utf8')
    return Buffer.concat([Buffer.from([b.length]), b])
  })
  return Buffer.concat([...parts, Buffer.from([0])])
}

function record(nameBuf, type, ttl, rdata) {
  return Buffer.concat([nameBuf, u16(type), u16(1), u32(ttl), u16(rdata.length), rdata])
}

/* ------------------------------------------------------------------ *
 * 构造一个"真实形状"的 mDNS 响应：
 *   AN: PTR _services._dns-sd._udp.local → _http._tcp.local
 *       PTR _http._tcp.local → Office Printer._http._tcp.local
 *   AR: SRV Office Printer._http._tcp.local → 0 0 80 printer.local
 *       A   printer.local → 192.168.1.50   （名字用压缩指针指回 SRV 的 target）
 * ------------------------------------------------------------------ */
const name1 = encodeName('_services._dns-sd._udp.local')
const name2 = encodeName('_http._tcp.local')
const name3 = encodeName('Office Printer._http._tcp.local')
const name4 = encodeName('printer.local')

const headerLen = 12
const rec1 = record(name1, 12, 4500, name2)
const rec2 = record(name2, 12, 4500, name3)
const o3 = headerLen + rec1.length + rec2.length
// SRV rdata: priority(2)+weight(2)+port(2)+target
const srvRdata = Buffer.concat([u16(0), u16(0), u16(80), name4])
const rec3 = record(name3, 33, 120, srvRdata)
// A 记录的名字用压缩指针指向 SRV rdata 里 printer.local 的起始偏移
const srvTargetOffset = o3 + name3.length + 10 + 6
const pointerName = Buffer.from([0xc0 | (srvTargetOffset >> 8), srvTargetOffset & 0xff])
const rec4 = Buffer.concat([pointerName, u16(1), u16(1), u32(120), u16(4), Buffer.from([192, 168, 1, 50])])

const header = Buffer.alloc(12)
header.writeUInt16BE(0x8400, 2) // response + authoritative
header.writeUInt16BE(2, 6) // ANCOUNT：2 条 PTR（服务枚举 + 实例）
header.writeUInt16BE(2, 10) // ARCOUNT：2 条（SRV + A）
const packet = Buffer.concat([header, rec1, rec2, rec3, rec4])

console.log('== 报文解析（含压缩指针）==')
let parsed
{
  parsed = parseDnsMessage(packet)
  check('answers 数量 = 2', parsed.answers.length === 2, String(parsed.answers.length))
  check('additionals 数量 = 2', parsed.additionals.length === 2, String(parsed.additionals.length))
  check('服务枚举 PTR 正确', parsed.answers[0].ptr === '_http._tcp.local', parsed.answers[0].ptr)
  check('实例 PTR 正确', parsed.answers[1].ptr === 'Office Printer._http._tcp.local', parsed.answers[1].ptr)
  check('SRV 端口 = 80', parsed.additionals[0].srv?.port === 80, JSON.stringify(parsed.additionals[0].srv))
  check('SRV target = printer.local', parsed.additionals[0].srv?.target === 'printer.local')
  check('A 记录名字经压缩指针解析 = printer.local', parsed.additionals[1].name === 'printer.local', parsed.additionals[1].name)
  check('A 记录地址 = 192.168.1.50', parsed.additionals[1].a === '192.168.1.50', parsed.additionals[1].a)
}

console.log('== 服务聚合 ==')
{
  const services = resolveServices([...parsed.answers, ...parsed.additionals])
  check('聚合出 1 个服务实例', services.length === 1, JSON.stringify(services))
  const svc = services[0]
  check('类型 = _http._tcp.local', svc?.type === '_http._tcp.local')
  check('实例名去掉类型后缀 = Office Printer', svc?.name === 'Office Printer', svc?.name)
  check('端口 = 80', svc?.port === 80)
  check('地址 = 192.168.1.50（经 SRV → A 关联）', svc?.address === '192.168.1.50')
}

console.log('== 查询构建 ↔ 解析 往返 ==')
{
  const query = buildDnsQuery('_ssh._tcp.local', 12)
  const q = parseDnsMessage(query)
  check('QDCOUNT = 1', q.questions.length === 1)
  check('查询名往返一致', q.questions[0].name === '_ssh._tcp.local', q.questions[0].name)
  check('查询类型 = PTR(12)', q.questions[0].type === 12)
  check('ID = 0（mDNS 约定）', q.id === 0)
}

console.log('== 恶意/畸形报文 ==')
{
  check('过短报文抛错', (() => {
    try { parseDnsMessage(Buffer.from([0, 1, 2])); return false } catch { return true }
  })())
  check('自指压缩指针触发循环保护', (() => {
    try { readName(Buffer.from([0xc0, 0x00]), 0); return false } catch { return true }
  })())
  check('标签越界抛错', (() => {
    try { readName(Buffer.from([0x0a, 1, 2]), 0); return false } catch { return true }
  })())
  check('声明 5 条记录但数据缺失 → 抛错而不是死循环', (() => {
    const bad = Buffer.alloc(12)
    bad.writeUInt16BE(5, 6)
    try { parseDnsMessage(bad); return false } catch { return true }
  })())
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
