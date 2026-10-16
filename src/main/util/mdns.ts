import dgram from 'node:dgram'
import type { MdnsService } from '@shared/types'

/**
 * 极简 mDNS（DNS-SD）发现 —— 用于在局域网内找到设备广播的服务。
 *
 * 两阶段策略：
 *   1) 查询 `_services._dns-sd._udp.local` 枚举网络上存在的服务类型；
 *   2) 对每种类型发 PTR 查询，收集实例（PTR）+ 端口（SRV）+ 地址（A）。
 *
 * 报文解析/构建是纯函数（parseDnsMessage / buildDnsQuery / resolveServices），
 * 可脱离网络单独测试（见 scripts/verify-mdns.cjs）。
 */

export const MDNS_ADDR = '224.0.0.251'
export const MDNS_PORT = 5353

export interface DnsRecord {
  name: string
  type: number
  ttl: number
  ptr?: string
  srv?: { priority: number; weight: number; port: number; target: string }
  a?: string
}

export interface ParsedDnsMessage {
  id: number
  flags: number
  questions: Array<{ name: string; type: number }>
  answers: DnsRecord[]
  additionals: DnsRecord[]
}

/** 读取 DNS 域名（支持 0xC0 压缩指针，带循环保护） */
export function readName(buf: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = []
  let next = -1
  let pos = offset
  let jumps = 0

  for (;;) {
    if (pos >= buf.length) throw new Error('DNS 名称越界')
    const len = buf[pos]
    if (len === 0) {
      pos += 1
      break
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('DNS 指针越界')
      const target = ((len & 0x3f) << 8) | buf[pos + 1]
      if (next === -1) next = pos + 2
      pos = target
      jumps += 1
      if (jumps > 32) throw new Error('DNS 指针循环')
      continue
    }
    if (pos + 1 + len > buf.length) throw new Error('DNS 标签越界')
    labels.push(buf.subarray(pos + 1, pos + 1 + len).toString('utf8'))
    pos += 1 + len
  }

  if (next === -1) next = pos
  return { name: labels.join('.'), next }
}

export function parseDnsMessage(buf: Buffer): ParsedDnsMessage {
  if (buf.length < 12) throw new Error('DNS 报文过短')
  const id = buf.readUInt16BE(0)
  const flags = buf.readUInt16BE(2)
  const qd = buf.readUInt16BE(4)
  const an = buf.readUInt16BE(6)
  const ns = buf.readUInt16BE(8)
  const ar = buf.readUInt16BE(10)

  let offset = 12
  const questions: ParsedDnsMessage['questions'] = []
  for (let i = 0; i < qd; i++) {
    const { name, next } = readName(buf, offset)
    const type = buf.readUInt16BE(next)
    offset = next + 4 // type + class
    questions.push({ name, type })
  }

  const readRecords = (count: number): DnsRecord[] => {
    const recs: DnsRecord[] = []
    for (let i = 0; i < count; i++) {
      const { name, next } = readName(buf, offset)
      const type = buf.readUInt16BE(next)
      const ttl = buf.readUInt32BE(next + 4)
      const rdlength = buf.readUInt16BE(next + 8)
      const rdOffset = next + 10

      const rec: DnsRecord = { name, type, ttl }
      if (type === 12) {
        rec.ptr = readName(buf, rdOffset).name
      } else if (type === 33) {
        rec.srv = {
          priority: buf.readUInt16BE(rdOffset),
          weight: buf.readUInt16BE(rdOffset + 2),
          port: buf.readUInt16BE(rdOffset + 4),
          target: readName(buf, rdOffset + 6).name
        }
      } else if (type === 1 && rdlength >= 4) {
        rec.a = `${buf[rdOffset]}.${buf[rdOffset + 1]}.${buf[rdOffset + 2]}.${buf[rdOffset + 3]}`
      }
      offset = rdOffset + rdlength
      recs.push(rec)
    }
    return recs
  }

  const answers = readRecords(an)
  readRecords(ns) // authority 段丢弃
  const additionals = readRecords(ar)
  return { id, flags, questions, answers, additionals }
}

/** 构建一个标准查询（mDNS 使用 ID=0、无 flags） */
export function buildDnsQuery(name: string, type = 12): Buffer {
  const labels = name.split('.').filter(Boolean)
  const nameLen = labels.reduce((n, l) => n + 1 + Buffer.byteLength(l, 'utf8'), 0) + 1
  const buf = Buffer.alloc(12 + nameLen + 4)
  buf.writeUInt16BE(0, 0)
  buf.writeUInt16BE(0, 2)
  buf.writeUInt16BE(1, 4)
  let o = 12
  for (const label of labels) {
    const bytes = Buffer.from(label, 'utf8')
    buf[o] = bytes.length
    bytes.copy(buf, o + 1)
    o += 1 + bytes.length
  }
  buf[o] = 0
  o += 1
  buf.writeUInt16BE(type, o)
  buf.writeUInt16BE(1, o + 2) // class IN
  return buf
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 从记录的并集中解出「服务实例」：PTR → 实例；SRV → 端口/主机；A → 地址 */
export function resolveServices(records: DnsRecord[]): MdnsService[] {
  const services = new Map<string, MdnsService>()
  const srvs = new Map<string, DnsRecord>()
  const addrs = new Map<string, string>()

  for (const r of records) {
    if (
      r.type === 12 &&
      r.ptr &&
      /\._(tcp|udp)\.local$/i.test(r.name) &&
      r.name !== '_services._dns-sd._udp.local'
    ) {
      services.set(r.ptr, {
        type: r.name,
        name: r.ptr.replace(new RegExp(`\\.?${escapeRegex(r.name)}$`), '')
      })
    }
    if (r.type === 33 && r.srv) srvs.set(r.name, r)
    if (r.type === 1 && r.a) addrs.set(r.name, r.a)
  }

  for (const [instance, svc] of services) {
    const srv = srvs.get(instance)
    if (srv?.srv) {
      svc.port = srv.srv.port
      svc.host = srv.srv.target
      const address = addrs.get(srv.srv.target)
      if (address) svc.address = address
    }
  }

  return [...services.values()].sort(
    (a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name)
  )
}

/**
 * 局域网 mDNS 发现（约 timeoutMs 后返回）。
 * 若环境的防火墙拦截组播，返回空数组属正常现象（UI 有说明）。
 */
export function discoverMdns(timeoutMs = 6000): Promise<MdnsService[]> {
  return new Promise<MdnsService[]>((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const records: DnsRecord[] = []
    const serviceTypes = new Set<string>()
    let finished = false

    const send = (buf: Buffer): void => {
      try {
        socket.send(buf, 0, buf.length, MDNS_PORT, MDNS_ADDR, () => {})
      } catch {
        /* ignore */
      }
    }

    const finish = (): void => {
      if (finished) return
      finished = true
      clearTimeout(phaseTimer)
      clearTimeout(endTimer)
      try {
        socket.close()
      } catch {
        /* ignore */
      }
      resolve(resolveServices(records))
    }

    socket.on('message', (msg) => {
      try {
        const parsed = parseDnsMessage(msg)
        for (const r of [...parsed.answers, ...parsed.additionals]) {
          records.push(r)
          if (r.type === 12 && r.ptr && r.name === '_services._dns-sd._udp.local') {
            serviceTypes.add(r.ptr)
          }
        }
      } catch {
        /* 忽略无法解析的报文 */
      }
    })
    socket.on('error', () => finish())

    socket.bind(() => {
      try {
        socket.addMembership(MDNS_ADDR)
      } catch {
        /* 某些环境不允许加组播组 */
      }
      send(buildDnsQuery('_services._dns-sd._udp.local', 12))
    })

    const defaultTypes = ['_ssh._tcp.local', '_http._tcp.local', '_https._tcp.local', '_smb._tcp.local']

    // 第二阶段：对枚举到的类型（或常见类型）逐类查询实例
    const phaseTimer = setTimeout(() => {
      const types = serviceTypes.size > 0 ? [...serviceTypes].slice(0, 24) : defaultTypes
      for (const type of types) send(buildDnsQuery(type, 12))
    }, Math.min(1600, Math.floor(timeoutMs / 3)))

    const endTimer = setTimeout(finish, timeoutMs)
  })
}
