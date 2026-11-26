#!/usr/bin/env node
/**
 * 验证 P0-3 远端监听端口探测：三级降级命令 + 纯函数解析矩阵。
 *
 * 用法：node scripts/verify-tunnel-resilience.cjs
 *
 * 覆盖：
 *   1. REMOTE_PORTS_CMD 必须是单行复合脚本，含 ss / netstat / /proc 三级分段标记
 *   2. ss -tlnp：通配与 IPv6 通配归一化到 127.0.0.1，具体内网 IP 保留，IPv4-mapped 回环折叠
 *   3. 双栈 [::1] 合并：同端口有 IPv4 回环时折叠；仅 [::1] 时保留 '::1'
 *   4. GNU netstat -tlnp 与 BusyBox netstat -tln（无 PID/进程名）
 *   5. /proc/net/tcp + /proc/net/tcp6：只认状态 0A，小端 IPv4 / IPv6 与大端端口
 *   6. 排序（端口升序）、按 (targetHost, port) 去重（有进程名优先）、过滤 port <= 0
 *   7. 空输入与垃圾输入返回空数组，不抛错
 *   8. discoverRemotePorts 对不存在的会话明确报错（错误来自 sessionManager 守卫）
 *
 * P0-3 第二部分（组 9-15）：隧道断线自愈 / 随连自启 / 临时转发。
 * 这一半用真实 loopback net.Server 验端口，用 mock ssh2 Client 冒充隧道，
 * 用 stub sessionManager 控制会话就绪；判据落在「修复没落地就会红」的量上：
 * 状态字符串、端口能不能连、tunnels.json 有没有被临时转发污染。
 *   9.  被动断线挂起 reconnecting，重连后自动恢复且端口真的换了新监听
 *   10. 手动停掉的隧道不随重连复活
 *   11. autoStart 随连接自启、不跨连接串台、手动停掉后不再自启
 *   12. 临时转发端口冲突回退到系统分配端口，且绝不写 tunnels.json
 *   13. promoteQuickForward 原地过户：复用监听、旧键推 removed、释放后端口可再绑
 *   14. 重连放弃与用户关标签都清理临时转发，持久隧道落 error
 *   15. buildSafeLocalTunnelUrl 严格白名单
 */
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const { Duplex } = require('node:stream')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, '.tsc-verify')
const STUB = path.join(OUT, 'stub-remote-ports')
fs.mkdirSync(STUB, { recursive: true })

let failed = 0
let passed = 0

function check(name, ok, extra) {
  if (ok) {
    passed++
    console.log('  ok   ' + name)
  } else {
    failed++
    console.log('  FAIL ' + name + (extra === undefined ? '' : ' -> ' + JSON.stringify(extra)))
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(name, a === e, { actual: actual, expected: expected })
}

function group(title) {
  console.log('')
  console.log(title)
}

function pick(list, port) {
  return list.filter(function (p) { return p.port === port })
}

function one(list, port) {
  const hit = pick(list, port)
  return hit.length === 1 ? hit[0] : undefined
}

const SS_OUT = [
  'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
  'LISTEN 0      128        127.0.0.1:8080      0.0.0.0:*    users:(("uhttpd",pid=412,fd=6))',
  'LISTEN 0      128          0.0.0.0:80        0.0.0.0:*',
  'LISTEN 0      128             [::]:443          [::]:*',
  'LISTEN 0      128    192.168.1.10:1883     0.0.0.0:*',
  'LISTEN 0      128 [::ffff:127.0.0.1]:9000       [::]:*'
].join('\n')

const SS_DUAL = [
  'State  Recv-Q Send-Q Local Address:Port  Peer Address:Port Process',
  'LISTEN 0      128        127.0.0.1:3000      0.0.0.0:*',
  'LISTEN 0      128             [::1]:3000        [::]:*',
  'LISTEN 0      128             [::1]:5432        [::]:*'
].join('\n')

const NETSTAT_GNU = [
  'Active Internet connections (only servers)',
  'Proto Recv-Q Send-Q Local Address           Foreign Address         State       PID/Program name',
  'tcp        0      0 127.0.0.1:8080          0.0.0.0:*               LISTEN      412/uhttpd',
  'tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      1/init',
  'tcp6       0      0 :::443                  :::*                    LISTEN      512/nginx'
].join('\n')

const NETSTAT_BUSYBOX = [
  'Active Internet connections (only servers)',
  'Proto Recv-Q Send-Q Local Address           Foreign Address         State',
  'tcp        0      0 0.0.0.0:80              0.0.0.0:*               LISTEN',
  'tcp        0      0 127.0.0.1:22            0.0.0.0:*               LISTEN'
].join('\n')

const PROC_TCP = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 0100007F:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0',
  '   1: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12346 1 0000000000000000 100 0 0 10 0',
  '   2: 0100007F:1F91 0100007F:9C40 01 00000000:00000000 00:00000000 00000000     0        0 12347 1 0000000000000000 20 4 30 10 -1'
].join('\n')

const PROC_TCP6 = [
  '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   3: 00000000000000000000000001000000:1538 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12348 1 0000000000000000 100 0 0 10 0'
].join('\n')

const PROC_PAYLOAD = '__SRC:PROC__\n' + PROC_TCP + '\n__SRC:PROC6__\n' + PROC_TCP6 + '\n'
const SS_PAYLOAD = '__SRC:SS__\n' + SS_OUT + '\n'
const NETSTAT_PAYLOAD = '__SRC:NETSTAT__\n' + NETSTAT_GNU + '\n'
const BUSYBOX_PAYLOAD = '__SRC:NETSTAT__\n' + NETSTAT_BUSYBOX + '\n'

async function build() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-rports-'))
  fs.writeFileSync(
    path.join(STUB, 'electron.cjs'),
    [
      'const userData = ' + JSON.stringify(tmp),
      'module.exports = {',
      '  app: {',
      '    getPath: () => userData,',
      '    getVersion: () => \'0.0.0-test\',',
      '    getName: () => \'ssh-workbench-test\',',
      '    isPackaged: false',
      '  },',
      '  safeStorage: {',
      '    isEncryptionAvailable: () => false,',
      '    encryptString: (s) => Buffer.from(s),',
      '    decryptString: (b) => b.toString()',
      '  }',
      '}'
    ].join('\n') + '\n'
  )
  const bundle = path.join(STUB, 'remote-ports.cjs')
  await esbuild.build({
    stdin: {
      contents: "export { REMOTE_PORTS_CMD, parseRemotePorts, discoverRemotePorts } from './src/main/ssh/remotePorts'",
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['electron', 'ssh2'],
    logLevel: 'error',
    alias: { '@shared': path.join(ROOT, 'src/shared') },
    plugins: [
      {
        name: 'stub-electron',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: path.join(STUB, 'electron.cjs') }))
        }
      }
    ]
  })
  return require(bundle)
}

function groupCommand(mod) {
  group('组 1：三级降级探测命令')
  const cmd = mod.REMOTE_PORTS_CMD
  check('命令是非空字符串', typeof cmd === 'string' && cmd.length > 0)
  check('单行（不含换行，execCollect 直接执行）', typeof cmd === 'string' && cmd.indexOf('\n') === -1, cmd)
  check('第一级用 command -v ss 探测', /command -v ss/.test(cmd))
  check('第二级用 command -v netstat 探测', /command -v netstat/.test(cmd))
  check('含 ss 分段标记 __SRC:SS__', cmd.indexOf('__SRC:SS__') !== -1)
  check('含 netstat 分段标记 __SRC:NETSTAT__', cmd.indexOf('__SRC:NETSTAT__') !== -1)
  check('含 /proc/net/tcp 兜底', cmd.indexOf('/proc/net/tcp') !== -1)
  check('含 /proc/net/tcp6 兜底与标记 __SRC:PROC6__', cmd.indexOf('/proc/net/tcp6') !== -1 && cmd.indexOf('__SRC:PROC6__') !== -1)
  check('ss 优先带 -p（尽量拿进程名）', /ss -tlnp/.test(cmd))
}

function groupSs(mod) {
  group('组 2：ss -tlnp 解析与地址归一化')
  const list = mod.parseRemotePorts(SS_PAYLOAD)
  eq('端口集合与升序', list.map(function (p) { return p.port }), [80, 443, 1883, 8080, 9000])

  const p80 = one(list, 80)
  check('0.0.0.0:80 归一化 targetHost=127.0.0.1', !!p80 && p80.targetHost === '127.0.0.1', p80)
  check('0.0.0.0:80 不算 loopback（同网段可达）', !!p80 && p80.isLoopback === false, p80 && p80.isLoopback)
  check('0.0.0.0:80 proto=tcp', !!p80 && p80.proto === 'tcp', p80 && p80.proto)

  const p443 = one(list, 443)
  check('[::]:443 归一化 targetHost=127.0.0.1', !!p443 && p443.targetHost === '127.0.0.1', p443)
  check('[::]:443 记 proto=tcp6', !!p443 && p443.proto === 'tcp6', p443 && p443.proto)
  check('[::]:443 不算 loopback', !!p443 && p443.isLoopback === false, p443 && p443.isLoopback)

  const p8080 = one(list, 8080)
  check('127.0.0.1:8080 保留 address', !!p8080 && p8080.address === '127.0.0.1', p8080)
  check('127.0.0.1:8080 targetHost=127.0.0.1', !!p8080 && p8080.targetHost === '127.0.0.1', p8080)
  check('127.0.0.1:8080 isLoopback=true', !!p8080 && p8080.isLoopback === true, p8080 && p8080.isLoopback)
  check('从 users:(("uhttpd",pid=412 提取进程名', !!p8080 && p8080.process === 'uhttpd', p8080 && p8080.process)
  check('从 pid=412 提取 pid', !!p8080 && p8080.pid === 412, p8080 && p8080.pid)

  const p1883 = one(list, 1883)
  check('具体内网 IP 192.168.1.10 原样保留', !!p1883 && p1883.targetHost === '192.168.1.10', p1883)
  check('内网 IP 不算 loopback', !!p1883 && p1883.isLoopback === false, p1883 && p1883.isLoopback)

  const p9000 = one(list, 9000)
  check('[::ffff:127.0.0.1]:9000 折叠为 targetHost=127.0.0.1', !!p9000 && p9000.targetHost === '127.0.0.1', p9000)
  check('[::ffff:127.0.0.1]:9000 记 proto=tcp6', !!p9000 && p9000.proto === 'tcp6', p9000 && p9000.proto)
  check('[::ffff:127.0.0.1]:9000 视为 loopback', !!p9000 && p9000.isLoopback === true, p9000 && p9000.isLoopback)
}

function groupDualStack(mod) {
  group('组 3：双栈 [::1] 合并规则')
  const list = mod.parseRemotePorts('__SRC:SS__\n' + SS_DUAL + '\n')
  eq('3000 与 5432 各一条，不重复', list.map(function (p) { return p.port }), [3000, 5432])

  const p3000 = one(list, 3000)
  check('3000 同时有 127.0.0.1 与 [::1] 时折叠为单条 127.0.0.1', !!p3000 && p3000.targetHost === '127.0.0.1', p3000)
  check('3000 折叠后 proto 取 IPv4 监听', !!p3000 && p3000.proto === 'tcp', p3000 && p3000.proto)

  const p5432 = one(list, 5432)
  check('5432 仅监听 [::1] 时保留 targetHost=::1', !!p5432 && p5432.targetHost === '::1', p5432)
  check('5432 是 loopback', !!p5432 && p5432.isLoopback === true, p5432 && p5432.isLoopback)
}

function groupNetstat(mod) {
  group('组 4：netstat 兼容（GNU 带 PID / BusyBox 无 PID）')
  const gnu = mod.parseRemotePorts(NETSTAT_PAYLOAD)
  eq('GNU netstat 端口集合', gnu.map(function (p) { return p.port }), [22, 443, 8080])
  const g8080 = one(gnu, 8080)
  check('GNU netstat 取到程序名 uhttpd', !!g8080 && g8080.process === 'uhttpd', g8080 && g8080.process)
  check('GNU netstat 取到 pid 412', !!g8080 && g8080.pid === 412, g8080 && g8080.pid)
  const g22 = one(gnu, 22)
  check('GNU netstat 通配 0.0.0.0:22 归一化', !!g22 && g22.targetHost === '127.0.0.1', g22)
  const g443 = one(gnu, 443)
  check('GNU netstat :::443 归一化到 127.0.0.1', !!g443 && g443.targetHost === '127.0.0.1', g443)
  check('GNU netstat :::443 proto=tcp6', !!g443 && g443.proto === 'tcp6', g443 && g443.proto)

  const bb = mod.parseRemotePorts(BUSYBOX_PAYLOAD)
  eq('BusyBox netstat 端口集合升序', bb.map(function (p) { return p.port }), [22, 80])
  const b80 = one(bb, 80)
  check('BusyBox 无 PID 列也能解析出 targetHost', !!b80 && b80.targetHost === '127.0.0.1', b80)
  check('BusyBox 无进程名时 process 缺省', !!b80 && b80.process === undefined, b80 && b80.process)
}

function groupProc(mod) {
  group('组 5：/proc/net/tcp 与 tcp6 兜底解析')
  const list = mod.parseRemotePorts(PROC_PAYLOAD)
  eq('只保留 0A 监听端口并升序', list.map(function (p) { return p.port }), [80, 5432, 8080])
  check('ESTABLISHED(01) 的 8081 被丢弃', pick(list, 8081).length === 0)

  const p8080 = one(list, 8080)
  check('小端 0100007F 解析为 127.0.0.1', !!p8080 && p8080.address === '127.0.0.1', p8080)
  check('端口 1F90 解析为 8080', !!p8080 && p8080.port === 8080, p8080 && p8080.port)
  check('proc IPv4 记 proto=tcp', !!p8080 && p8080.proto === 'tcp', p8080 && p8080.proto)

  const p80 = one(list, 80)
  check('00000000:0050 归一化 targetHost=127.0.0.1', !!p80 && p80.targetHost === '127.0.0.1', p80)

  const p5432 = one(list, 5432)
  check('tcp6 全零+01000000 解析为 ::1', !!p5432 && p5432.targetHost === '::1', p5432)
  check('tcp6 端口 1538 解析为 5432', !!p5432 && p5432.port === 5432, p5432 && p5432.port)
  check('tcp6 记 proto=tcp6', !!p5432 && p5432.proto === 'tcp6', p5432 && p5432.proto)
}

function groupCleanup(mod) {
  group('组 6：排序、去重与非法条目过滤')
  const messy = [
    '__SRC:SS__',
    'LISTEN 0 128 0.0.0.0:7000 0.0.0.0:*',
    'LISTEN 0 128 127.0.0.1:7000 0.0.0.0:* users:(("node",pid=99,fd=1))',
    'LISTEN 0 128 0.0.0.0:0 0.0.0.0:*',
    'LISTEN 0 128 127.0.0.1:22 0.0.0.0:*',
    ''
  ].join('\n')
  const list = mod.parseRemotePorts(messy)
  eq('端口 0 被过滤且按升序', list.map(function (p) { return p.port }), [22, 7000])
  const p7000 = one(list, 7000)
  check('同 (targetHost,port) 去重后保留带进程名的那条', !!p7000 && p7000.process === 'node', p7000)
  check('去重后 pid 也是带进程名那条的', !!p7000 && p7000.pid === 99, p7000 && p7000.pid)

  eq('空输出返回空数组', mod.parseRemotePorts(''), [])
  eq('纯标记无内容返回空数组', mod.parseRemotePorts('__SRC:SS__\n'), [])
  const junk = mod.parseRemotePorts('__SRC:SS__\nnot a listener line\nLISTEN\n')
  eq('垃圾行被忽略', junk, [])
  const noMarker = mod.parseRemotePorts('LISTEN 0 128 127.0.0.1:8080 0.0.0.0:*')
  check('缺少分段标记时仍按 ss 行形态兜底解析', noMarker.length === 1 && noMarker[0].port === 8080, noMarker)
}

async function groupGuard(mod) {
  group('组 7：discoverRemotePorts 会话守卫')
  check('discoverRemotePorts 是函数', typeof mod.discoverRemotePorts === 'function')
  let err = null
  try {
    await mod.discoverRemotePorts('no-such-session-id')
  } catch (e) {
    err = e
  }
  check('不存在的会话直接抛错', err !== null)
  check(
    '错误来自 sessionManager 的会话守卫（不是 TypeError）',
    err !== null && !(err instanceof TypeError) && /会话不存在|仅支持 SSH|尚未就绪/.test(String(err.message)),
    err && err.message
  )
}

/* ================================================================== *
 *  第二部分：隧道断线自愈 / 随连自启 / 临时转发（P0-3）
 *
 *  这一半不碰真实 SSH：用 stub sessionManager 控制会话就绪、用 mock ssh2 Client
 *  冒充隧道出口、用真实 loopback net.Server 验端口。判据都放在「修复没落地就会红」
 *  的量上：状态字符串、端口能不能连、tunnels.json 有没有被临时转发污染。
 * ================================================================== */

const STUB_SM = path.join(STUB, 'sessionManager-stub.cjs')

function writeSessionManagerStub() {
  const lines = [
    "'use strict'",
    'const sessions = new Map()',
    'const api = {',
    '  list() {',
    '    const out = []',
    '    for (const entry of sessions) {',
    '      const id = entry[0]',
    '      const s = entry[1]',
    '      out.push({ id: id, connectionId: s.connectionId, connectionName: s.title,',
    '        kind: s.kind, host: \'127.0.0.1\', username: \'u\', target: s.title,',
    '        title: s.title, status: s.status })',
    '    }',
    '    return out',
    '  },',
    '  getClient(id) {',
    '    const s = sessions.get(id)',
    '    return s ? s.client : undefined',
    '  },',
    '  statusOf(id) {',
    '    const s = sessions.get(id)',
    '    return s ? s.status : \'disconnected\'',
    '  },',
    '  kindOf(id) {',
    '    const s = sessions.get(id)',
    '    return s ? s.kind : \'ssh\'',
    '  },',
    '  isReconnecting(id) {',
    '    const s = sessions.get(id)',
    '    return Boolean(s && s.reconnecting)',
    '  },',
    '  async waitUntilReady(id) {',
    '    const s = sessions.get(id)',
    '    if (!s || s.status !== \'connected\' || !s.client) throw new Error(\'会话不存在或已断开，请先打开 SSH 连接\')',
    '  },',
    '  requireSshClient(id) {',
    '    const s = sessions.get(id)',
    '    if (!s || !s.client) throw new Error(\'会话不存在或已断开，请先打开连接\')',
    '    if (s.kind === \'serial\') throw new Error(\'该功能仅支持 SSH 会话，串口会话不提供\')',
    '    return s.client',
    '  }',
    '}',
    'const ctl = {',
    '  connect(id, opts) {',
    '    const o = opts || {}',
    '    sessions.set(id, { connectionId: o.connectionId || \'conn-1\', title: o.title || id,',
    '      kind: o.kind || \'ssh\', status: \'connected\', reconnecting: Boolean(o.reconnecting),',
    '      client: o.client || null })',
    '  },',
    '  disconnect(id) {',
    '    const s = sessions.get(id)',
    '    if (s) { s.status = \'disconnected\'; s.client = null }',
    '  },',
    '  reset() { sessions.clear() }',
    '}',
    'module.exports = { sessionManager: api, __ctl: ctl }'
  ]
  fs.writeFileSync(STUB_SM, lines.join('\n') + '\n')
}

async function buildTunnel() {
  writeSessionManagerStub()
  const bundle = path.join(STUB, 'tunnel-lifecycle.cjs')
  await esbuild.build({
    stdin: {
      contents:
        "export { tunnelManager, buildSafeLocalTunnelUrl } from './src/main/ssh/portForward'\n" +
        "export * from './src/main/store/repository'",
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['electron', 'ssh2'],
    logLevel: 'error',
    alias: { '@shared': path.join(ROOT, 'src/shared') },
    plugins: [
      {
        name: 'stub-session-manager',
        setup(b) {
          b.onResolve({ filter: /^\.\/sessionManager$/ }, (args) => {
            const importer = String(args.importer || '').replace(/\\/g, '/')
            if (!importer.endsWith('/ssh/portForward.ts')) return null
            return { path: STUB_SM, external: true }
          })
        }
      },
      {
        name: 'stub-electron',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: path.join(STUB, 'electron.cjs') }))
        }
      }
    ]
  })
  const mod = require(bundle)
  return { tm: mod.tunnelManager, url: mod.buildSafeLocalTunnelUrl, repo: mod, sm: require(STUB_SM) }
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms)
  })
}

function freePort() {
  return new Promise(function (resolve, reject) {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', function () {
      const p = s.address().port
      s.close(function () {
        resolve(p)
      })
    })
  })
}

function tryConnect(port, timeoutMs) {
  const limit = timeoutMs || 1500
  return new Promise(function (resolve) {
    const s = net.connect({ host: '127.0.0.1', port: port })
    let done = false
    const finish = function (v) {
      if (done) return
      done = true
      resolve(v)
    }
    s.once('connect', function () {
      finish(s)
    })
    s.once('error', function () {
      s.destroy()
      finish(null)
    })
    setTimeout(function () {
      if (!done) {
        s.destroy()
        finish(null)
      }
    }, limit).unref?.()
  })
}

function roundTrip(port, payload) {
  return new Promise(function (resolve) {
    const s = net.connect({ host: '127.0.0.1', port: port })
    let buf = ''
    let done = false
    const finish = function (v) {
      if (done) return
      done = true
      s.destroy()
      resolve(v)
    }
    s.once('connect', function () {
      s.write(payload)
    })
    s.on('data', function (d) {
      buf += d.toString()
      if (buf.indexOf('ECHO:') === 0) finish(buf)
    })
    s.once('error', function () {
      finish(buf || null)
    })
    setTimeout(function () {
      finish(buf || null)
    }, 2000).unref?.()
  })
}

function rebindable(port) {
  return new Promise(function (resolve) {
    const s = net.createServer()
    s.once('error', function () {
      resolve(false)
    })
    s.listen(port, '127.0.0.1', function () {
      s.close(function () {
        resolve(true)
      })
    })
  })
}

function makeFakeClient(opts) {
  const options = opts || {}
  const listeners = new Map()
  /*
   * -R 的验收面全在「服务端把连接推过来之后」：分派器按 destPort + 绑定地址选一条隧道，
   * 命中就 accept() 并把通道交出去，全不命中才 reject() 一次。这些计数与通道里
   * 收到的字节就是判据 —— 选错人事后完全看不出来，只有靠「哪个目标回声」能区分。
   */
  const fake = {
    forwardedIn: [],
    accepts: 0,
    rejects: 0,
    channels: [],
    /** 冒充服务端发起一次 'tcp connection'（details 形状同 ssh2） */
    emitConnection(details) {
      const set = listeners.get('tcp connection')
      if (!set) return 0
      let n = 0
      for (const fn of set) {
        fn(
          details,
          function accept() {
            fake.accepts += 1
            const got = []
            const ch = new Duplex({
              read() {},
              write(chunk, _enc, cb) {
                got.push(chunk.toString())
                cb()
              }
            })
            ch.received = got
            fake.channels.push(ch)
            return ch
          },
          function reject() {
            fake.rejects += 1
          }
        )
        n += 1
      }
      return n
    },
    forwarded: 0,
    forwardOut(srcHost, srcPort, dstHost, dstPort, cb) {
      // 真机上目标在远端，端口不会和本机监听撞车；本机夹具里让上游固定指向 origin，
      // 才能验证「bindPort 优先取 targetPort」这条分支而不自环。
      const port = options.forceUpstreamPort || dstPort
      const sock = net.connect({ host: dstHost, port: port })
      sock.once('connect', function () {
        fake.forwarded += 1
        cb(null, sock)
      })
      sock.once('error', function (err) {
        cb(err)
      })
    },
    forwardIn(host, port, cb) {
      fake.forwardedIn.push({ host: host, port: port })
      cb(null, port || 0)
    },
    unforwardIn(host, port, cb) {
      if (cb) cb()
    },
    on(ev, fn) {
      if (!listeners.has(ev)) listeners.set(ev, new Set())
      listeners.get(ev).add(fn)
      return fake
    },
    removeListener(ev, fn) {
      const set = listeners.get(ev)
      if (set) set.delete(fn)
      return fake
    }
  }
  return fake
}

function makeCtx(tmod, originPort) {
  const ctx = {
    tm: tmod.tm,
    url: tmod.url,
    repo: tmod.repo,
    sm: tmod.sm,
    originPort: originPort,
    events: [],
    stateOf: function (id) {
      return ctx.tm.states().find(function (s) {
        return s.tunnelId === id
      })
    }
  }
  ctx.tm.setStatusHandler(function (info) {
    ctx.events.push(info)
  })
  return ctx
}

function saveLocal(ctx, opts) {
  const input = {
    name: opts.name,
    type: 'local',
    bindHost: '127.0.0.1',
    bindPort: opts.bindPort,
    targetHost: '127.0.0.1',
    targetPort: opts.targetPort
  }
  if (opts.connectionId !== undefined) input.connectionId = opts.connectionId
  if (opts.autoStart !== undefined) input.autoStart = opts.autoStart
  return ctx.repo.saveTunnel(input)
}

async function groupResilience(ctx) {
  group('组 9：被动断线挂起 reconnecting，重连后自动恢复')
  const origin = ctx.originPort
  ctx.sm.__ctl.reset()
  const first = makeFakeClient()
  ctx.sm.__ctl.connect('S9', { connectionId: 'conn-9', client: first })
  const bindPort = await freePort()
  const cfg = await saveLocal(ctx, {
    name: '自愈',
    bindPort: bindPort,
    targetPort: origin,
    connectionId: 'conn-9'
  })
  const info = await ctx.tm.start(cfg.id, 'S9')
  check('初始 start 成功', info.status === 'active', info)
  check('初始转发可穿透到目标', (await roundTrip(bindPort, 'ping')) === 'ECHO:ping')

  ctx.events.length = 0
  ctx.tm.onSessionClosed('S9', { byUser: false, willReconnect: true })
  const closed = ctx.stateOf(cfg.id)
  check('被动断线后置为 reconnecting', Boolean(closed) && closed.status === 'reconnecting', closed)
  check(
    '挂起文案说明等待重连',
    Boolean(closed) && closed.error === '连接已断开，等待重连后自动恢复',
    closed && closed.error
  )
  check('挂起时推了 reconnecting 事件', ctx.events.some(function (e) { return e.status === 'reconnecting' }))
  const probe = await tryConnect(bindPort)
  check('挂起期间端口已释放（不留幽灵监听）', probe === null)
  if (probe) probe.destroy()

  ctx.sm.__ctl.disconnect('S9')
  const second = makeFakeClient()
  ctx.sm.__ctl.connect('S9', { connectionId: 'conn-9', client: second })
  first.forwarded = 0
  second.forwarded = 0
  ctx.events.length = 0
  await ctx.tm.onSessionConnected('S9', 'conn-9', true)
  const restored = ctx.stateOf(cfg.id)
  check('重连后自动恢复为 active', Boolean(restored) && restored.status === 'active', restored)
  check('恢复后清掉挂起文案', Boolean(restored) && restored.error === undefined, restored && restored.error)
  check('恢复后端口重新可连', (await tryConnect(bindPort)) !== null)
  const echoed = await roundTrip(bindPort, 'again')
  check('恢复后数据重新穿透', echoed === 'ECHO:again', echoed)
  check('恢复后走的是新连接（旧 client 不再被使用）', second.forwarded > 0 && first.forwarded === 0, {
    old: first.forwarded,
    next: second.forwarded
  })
  ctx.tm.stop(cfg.id)
  await ctx.repo.deleteTunnel(cfg.id)
}

async function groupManualStop(ctx) {
  group('组 10：手动停掉的隧道不随重连复活')
  ctx.sm.__ctl.reset()
  const client = makeFakeClient()
  ctx.sm.__ctl.connect('S10', { connectionId: 'conn-10', client: client })
  const bindPort = await freePort()
  const cfg = await saveLocal(ctx, {
    name: '手动停',
    bindPort: bindPort,
    targetPort: ctx.originPort,
    connectionId: 'conn-10'
  })
  await ctx.tm.start(cfg.id, 'S10')
  check('前置：隧道 active', ctx.stateOf(cfg.id)?.status === 'active')

  ctx.tm.stop(cfg.id)
  ctx.sm.__ctl.connect('S10', { connectionId: 'conn-10', client: makeFakeClient() })
  await ctx.tm.onSessionConnected('S10', 'conn-10', true)
  check('手动停掉后重连不复活', ctx.stateOf(cfg.id)?.status === 'stopped', ctx.stateOf(cfg.id))
  check('手动停掉后端口不监听', (await tryConnect(bindPort)) === null)

  ctx.tm.onSessionClosed('S10', { byUser: true, willReconnect: false })
  check('用户关标签后仍是 stopped', ctx.stateOf(cfg.id)?.status === 'stopped', ctx.stateOf(cfg.id))
  await ctx.repo.deleteTunnel(cfg.id)
}

async function groupAutoStart(ctx) {
  group('组 11：autoStart 随连接自启，手动停掉后不再自启')
  const origin = ctx.originPort
  const bindAuto = await freePort()
  const cfgAuto = await saveLocal(ctx, {
    name: '随连自启',
    bindPort: bindAuto,
    targetPort: origin,
    connectionId: 'conn-11',
    autoStart: true
  })
  const saved = (await ctx.repo.listTunnels()).find(function (t) { return t.id === cfgAuto.id })
  check('autoStart 落进 tunnels.json', Boolean(saved) && saved.autoStart === true, saved && saved.autoStart)

  const cfgNoConn = await saveLocal(ctx, { name: '无连接自启', bindPort: await freePort(), targetPort: origin, autoStart: true })
  check('没有 connectionId 时不保存 autoStart', cfgNoConn.autoStart === undefined, cfgNoConn.autoStart)
  await ctx.repo.deleteTunnel(cfgNoConn.id)

  ctx.sm.__ctl.reset()
  ctx.sm.__ctl.connect('S11S', { connectionId: 'conn-11', kind: 'serial', client: makeFakeClient() })
  await ctx.tm.onSessionConnected('S11S', 'conn-11', false)
  check('串口会话不触发隧道自启', ctx.stateOf(cfgAuto.id)?.status !== 'active', ctx.stateOf(cfgAuto.id))

  ctx.sm.__ctl.reset()
  ctx.sm.__ctl.connect('S11', { connectionId: 'conn-11', client: makeFakeClient() })
  await ctx.tm.onSessionConnected('S11', 'conn-11', false)
  check('首次连接（非重连）也自启', ctx.stateOf(cfgAuto.id)?.status === 'active', ctx.stateOf(cfgAuto.id))
  check('自启后端口可连', (await tryConnect(bindAuto)) !== null)

  ctx.tm.stop(cfgAuto.id)
  ctx.sm.__ctl.connect('S11', { connectionId: 'conn-11', client: makeFakeClient() })
  await ctx.tm.onSessionConnected('S11', 'conn-11', true)
  check('同会话手动停掉后重连不再自启', ctx.stateOf(cfgAuto.id)?.status === 'stopped', ctx.stateOf(cfgAuto.id))

  ctx.sm.__ctl.connect('S11X', { connectionId: 'conn-other', client: makeFakeClient() })
  await ctx.tm.onSessionConnected('S11X', 'conn-other', false)
  check('只对绑定的 connectionId 生效', ctx.stateOf(cfgAuto.id)?.status === 'stopped', ctx.stateOf(cfgAuto.id))
  await ctx.repo.deleteTunnel(cfgAuto.id)
}

async function groupQuickForward(ctx) {
  group('组 12：临时转发端口冲突回退，且不污染 tunnels.json')
  ctx.sm.__ctl.reset()
  const origin = ctx.originPort
  const baseline = (await ctx.repo.listTunnels()).length

  // 12a. targetPort 空闲 → bindPort 优先取 targetPort
  const preferredClient = makeFakeClient({ forceUpstreamPort: origin })
  ctx.sm.__ctl.connect('S12', { connectionId: 'conn-12', client: preferredClient })
  const freeTarget = await freePort()
  const quick = await ctx.tm.startQuickForward('S12', {
    targetHost: '127.0.0.1',
    targetPort: freeTarget,
    process: 'uhttpd'
  })
  check('临时转发直接 active', quick.status === 'active', quick)
  check('临时转发标记 ephemeral', quick.ephemeral === true, quick.ephemeral)
  check('临时转发 ID 带 ephemeral: 前缀', /^ephemeral:/.test(quick.tunnelId), quick.tunnelId)
  check('端口空闲时监听端口等于目标端口', quick.actualPort === freeTarget, {
    actualPort: quick.actualPort,
    target: freeTarget
  })
  check('临时转发只监听本机回环', Boolean(quick.ephemeralConfig) && quick.ephemeralConfig.bindHost === '127.0.0.1',
    quick.ephemeralConfig)
  check('ephemeralConfig 记下目标端口', Boolean(quick.ephemeralConfig) && quick.ephemeralConfig.targetPort === freeTarget, quick.ephemeralConfig)
  check('临时转发不写 tunnels.json', (await ctx.repo.listTunnels()).length === baseline)
  check('临时转发可穿透到目标', (await roundTrip(freeTarget, 'ping')) === 'ECHO:ping')

  // 12a-2. 双击：同会话同目标重复创建必须复用同一条，不能起第二个 net.Server
  const dup = await ctx.tm.startQuickForward('S12', {
    targetHost: '127.0.0.1',
    targetPort: freeTarget,
    process: 'uhttpd'
  })
  check('重复创建返回同一条临时转发', dup.tunnelId === quick.tunnelId, {
    dup: dup.tunnelId,
    first: quick.tunnelId
  })
  check('重复创建不新增运行时（只有一个监听）',
    ctx.tm.states().filter(function (s) {
      return s.ephemeral === true && s.sessionId === 'S12' && s.status === 'active'
    }).length === 1,
    ctx.tm.states().filter(function (s) {
      return s.ephemeral === true && s.sessionId === 'S12'
    }))
  check('重复创建后端口仍可穿透', (await roundTrip(freeTarget, 'dup')) === 'ECHO:dup')

  // 12b. 目标端口被占 + 目标端口 < 1024 → 回退系统分配端口
  const blocker = net.createServer()
  await new Promise(function (r) {
    blocker.listen(0, '127.0.0.1', r)
  })
  const busyPort = blocker.address().port
  const busyClient = makeFakeClient({ forceUpstreamPort: origin })
  ctx.sm.__ctl.connect('S12', { connectionId: 'conn-12', client: busyClient })
  const fallback = await ctx.tm.startQuickForward('S12', {
    targetHost: '127.0.0.1',
    targetPort: busyPort
  })
  check('端口冲突时回退成功（仍 active）', fallback.status === 'active', fallback)
  check('端口冲突时改用系统分配端口', fallback.actualPort !== busyPort && fallback.actualPort > 0, {
    actualPort: fallback.actualPort,
    busy: busyPort
  })
  check('回退后 ephemeralConfig 记录真实端口',
    Boolean(fallback.ephemeralConfig) && fallback.ephemeralConfig.bindPort === fallback.actualPort,
    fallback.ephemeralConfig)
  check('回退后仍可穿透', (await roundTrip(fallback.actualPort, 'fb')) === 'ECHO:fb')
  check('低端口/冲突两条路径都没写 tunnels.json', (await ctx.repo.listTunnels()).length === baseline)

  const lowPort = await ctx.tm.startQuickForward('S12', { targetHost: '127.0.0.1', targetPort: 80 })
  check('目标端口 < 1024 时不监听低端口', lowPort.actualPort !== 80, lowPort.actualPort)
  check('低端口场景也回退到可用的高端口', lowPort.actualPort > 0 && lowPort.status === 'active', lowPort)

  ctx.tm.stop(lowPort.tunnelId)
  ctx.tm.stop(fallback.tunnelId)
  ctx.tm.stop(quick.tunnelId)
  check('停掉临时转发后端口释放', (await tryConnect(freeTarget)) === null)
  await new Promise(function (r) {
    blocker.close(r)
  })
}

async function groupPromote(ctx) {
  group('组 13：promote 原地过户，旧键移除、新键接管、无幽灵监听')
  ctx.sm.__ctl.reset()
  const origin = ctx.originPort
  const client = makeFakeClient({ forceUpstreamPort: origin })
  ctx.sm.__ctl.connect('S13', { connectionId: 'conn-13', client: client })
  const target = await freePort()
  const quick = await ctx.tm.startQuickForward('S13', { targetHost: '127.0.0.1', targetPort: target, process: 'uhttpd' })
  const port = quick.actualPort
  check('前置：临时转发已监听', (await tryConnect(port)) !== null)

  ctx.events.length = 0
  const promoted = await ctx.tm.promoteQuickForward(quick.tunnelId, '提升后的隧道')
  check('promote 返回配置与运行时', Boolean(promoted && promoted.config && promoted.runtime))
  check('promote 后新 id 为持久配置 id', promoted.runtime.tunnelId === promoted.config.id, {
    runtime: promoted.runtime.tunnelId,
    config: promoted.config.id
  })
  check('promote 后仍 active', promoted.runtime.status === 'active', promoted.runtime.status)
  check('promote 复用原监听端口', promoted.runtime.actualPort === port, {
    now: promoted.runtime.actualPort,
    before: port
  })
  check('promote 后不给 ephemeral 标记', promoted.runtime.ephemeral !== true, promoted.runtime.ephemeral)
  check('promote 写入 tunnels.json', (await ctx.repo.listTunnels()).some(function (t) {
    return t.id === promoted.config.id
  }))
  check('promote 用自定义名保存', promoted.config.name === '提升后的隧道', promoted.config.name)
  check('promote 保留目标端口', promoted.config.targetPort === target, promoted.config.targetPort)
  check('promote 后端口仍在监听（无过户间隙）', (await tryConnect(port)) !== null)
  check('promote 后数据仍可穿透', (await roundTrip(port, 'pr')) === 'ECHO:pr')
  check('旧 ephemeral 键推了 removed', ctx.events.some(function (e) {
    return e.tunnelId === quick.tunnelId && e.removed === true
  }))
  check('新键推了 active', ctx.events.some(function (e) {
    return e.tunnelId === promoted.config.id && e.status === 'active'
  }))
  check('旧 ephemeral 键已从 states 移除', !ctx.stateOf(quick.tunnelId))
  check('同一个端口上没有重复运行时', ctx.tm.states().filter(function (s) {
    return s.actualPort === port
  }).length === 1)

  ctx.tm.stop(promoted.config.id)
  check('停掉过户后的隧道，端口立刻可再绑定（零幽灵监听）', await rebindable(port))
  await ctx.repo.deleteTunnel(promoted.config.id)
}

async function groupGaveUp(ctx) {
  group('组 14：重连放弃与用户关标签都清理临时转发')
  const origin = ctx.originPort

  // 14a. 重连放弃：持久隧道落 error，临时转发被删
  ctx.sm.__ctl.reset()
  const keep = makeFakeClient({ forceUpstreamPort: origin })
  ctx.sm.__ctl.connect('S14', { connectionId: 'conn-14', client: keep })
  const keepPort = await freePort()
  const persistent = await saveLocal(ctx, {
    name: '放弃回归',
    bindPort: keepPort,
    targetPort: origin,
    connectionId: 'conn-14'
  })
  await ctx.tm.start(persistent.id, 'S14')
  const tmpPort = await freePort()
  const ephemeral = await ctx.tm.startQuickForward('S14', { targetHost: '127.0.0.1', targetPort: tmpPort })
  ctx.tm.onSessionClosed('S14', { byUser: false, willReconnect: true })
  check('两条隧道都进入 reconnecting',
    ctx.stateOf(persistent.id)?.status === 'reconnecting' &&
      ctx.stateOf(ephemeral.tunnelId)?.status === 'reconnecting',
    { persistent: ctx.stateOf(persistent.id), ephemeral: ctx.stateOf(ephemeral.tunnelId) })

  ctx.events.length = 0
  ctx.tm.onReconnectGaveUp('S14')
  check('放弃重连后持久隧道落 error', ctx.stateOf(persistent.id)?.status === 'error', ctx.stateOf(persistent.id))
  check('放弃重连文案固定', ctx.stateOf(persistent.id)?.error === '重连失败，隧道已停止',
    ctx.stateOf(persistent.id)?.error)
  check('放弃重连后临时转发被移除', !ctx.stateOf(ephemeral.tunnelId))
  check('临时转发移除推了 removed 事件', ctx.events.some(function (e) {
    return e.tunnelId === ephemeral.tunnelId && e.removed === true
  }))
  check('放弃重连后临时转发端口释放', (await tryConnect(ephemeral.actualPort)) === null)
  check('持久隧道配置仍在', (await ctx.repo.listTunnels()).some(function (t) {
    return t.id === persistent.id
  }))
  await ctx.repo.deleteTunnel(persistent.id)
  ctx.tm.dispose(persistent.id)

  // 14b. 用户关标签：同样清理临时转发，持久隧道落 stopped
  ctx.sm.__ctl.reset()
  const closeClient = makeFakeClient({ forceUpstreamPort: origin })
  ctx.sm.__ctl.connect('S15', { connectionId: 'conn-15', client: closeClient })
  const p2Port = await freePort()
  const p2 = await saveLocal(ctx, {
    name: '关标签',
    bindPort: p2Port,
    targetPort: origin,
    connectionId: 'conn-15'
  })
  await ctx.tm.start(p2.id, 'S15')
  const e2 = await ctx.tm.startQuickForward('S15', { targetHost: '127.0.0.1', targetPort: await freePort() })
  ctx.events.length = 0
  ctx.tm.onSessionClosed('S15', { byUser: true, willReconnect: false })
  check('用户关标签后持久隧道为 stopped', ctx.stateOf(p2.id)?.status === 'stopped', ctx.stateOf(p2.id))
  check('用户关标签后临时转发被移除', !ctx.stateOf(e2.tunnelId))
  check('用户关标签也推 removed 事件', ctx.events.some(function (e) {
    return e.tunnelId === e2.tunnelId && e.removed === true
  }))
  check('用户关标签后端口全部释放',
    (await tryConnect(p2Port)) === null && (await tryConnect(e2.actualPort)) === null)
  await ctx.repo.deleteTunnel(p2.id)
  ctx.tm.dispose(p2.id)

  // 14c. 单参兼容：老调用点（verify-tunnel.cjs 段 4 / verify-tunnel-lifecycle.cjs）
  ctx.sm.__ctl.reset()
  ctx.sm.__ctl.connect('S16', { connectionId: 'conn-16', client: makeFakeClient({ forceUpstreamPort: origin }) })
  const legacyPort = await freePort()
  const legacy = await saveLocal(ctx, {
    name: '单参兼容',
    bindPort: legacyPort,
    targetPort: origin,
    connectionId: 'conn-16'
  })
  await ctx.tm.start(legacy.id, 'S16')
  ctx.tm.onSessionClosed('S16')
  check('单参调用保持旧语义（error）', ctx.stateOf(legacy.id)?.status === 'error', ctx.stateOf(legacy.id))
  check('单参调用保持旧文案', ctx.stateOf(legacy.id)?.error === '会话已断开，隧道已停止',
    ctx.stateOf(legacy.id)?.error)
  check('单参调用同样释放端口', (await tryConnect(legacyPort)) === null)
  await ctx.repo.deleteTunnel(legacy.id)
  ctx.tm.dispose(legacy.id)
}

function groupUrl(ctx) {
  group('组 15：buildSafeLocalTunnelUrl 严格白名单')
  check('http 正常拼装', ctx.url('http', 8080) === 'http://127.0.0.1:8080', ctx.url('http', 8080))
  check('https 正常拼装', ctx.url('https', 8443) === 'https://127.0.0.1:8443', ctx.url('https', 8443))
  check('边界端口 1 可用', ctx.url('http', 1) === 'http://127.0.0.1:1')
  check('边界端口 65535 可用', ctx.url('https', 65535) === 'https://127.0.0.1:65535')

  const bad = [
    ['http', 0],
    ['http', 70000],
    ['http', -1],
    ['http', 80.5],
    ['http', NaN],
    ['http', Infinity],
    ['http', 8080.0001]
  ]
  let rejected = 0
  for (const pair of bad) {
    let threw = false
    try {
      ctx.url(pair[0], pair[1])
    } catch {
      threw = true
    }
    if (threw) rejected++
  }
  check('非法端口一律抛错', rejected === bad.length, { rejected: rejected, total: bad.length })

  for (const proto of ['javascript', 'file', 'ftp', 'data', 'HTTP', '', ' http']) {
    let threw = false
    try {
      ctx.url(proto, 8080)
    } catch {
      threw = true
    }
    check('协议 ' + JSON.stringify(proto) + ' 被拒绝', threw)
  }
  check('永远只拼 127.0.0.1，不接受外部主机',
    !/^(?!http:\/\/127\.0\.0\.1:)/.test(ctx.url('http', 65535)))
}

function saveRemote(ctx, opts) {
  return ctx.repo.saveTunnel({
    name: opts.name,
    type: 'remote',
    bindHost: opts.bindHost,
    allowLan: true,
    bindPort: opts.bindPort,
    targetHost: '127.0.0.1',
    targetPort: opts.targetPort,
    connectionId: opts.connectionId
  })
}

function waitFor(fn, ms) {
  const limit = ms || 2000
  return new Promise(function (resolve) {
    const t0 = Date.now()
    const tick = function () {
      let v = false
      try {
        v = fn()
      } catch {
        v = false
      }
      if (v) return resolve(true)
      if (Date.now() - t0 >= limit) return resolve(false)
      setTimeout(tick, 10)
    }
    tick()
  })
}

/* 把一批 -R 隧道挂到同一个 fake client 上，返回可按 destIP/destPort 发起连接的能力 */
async function groupReverseDispatch(ctx) {
  group('组 16：-R 同客户端多隧道的连接分派（R2-H7）')
  ctx.sm.__ctl.reset()
  const client = makeFakeClient({ forceUpstreamPort: ctx.originPort })
  ctx.sm.__ctl.connect('S17', { connectionId: 'conn-17', client: client })

  const originA = net.createServer(function (s) {
    s.on('data', function (d) { s.write('A:' + d.toString()) })
    s.on('error', function () { s.destroy() })
  })
  await new Promise(function (r) { originA.listen(0, '127.0.0.1', r) })
  const originB = net.createServer(function (s) {
    s.on('data', function (d) { s.write('B:' + d.toString()) })
    s.on('error', function () { s.destroy() })
  })
  await new Promise(function (r) { originB.listen(0, '127.0.0.1', r) })

  // 两条 -R 并发绑到同一客户端（8080 / 9090 语义：不同远端端口各连各的）
  const tA = await saveRemote(ctx, { name: 'R-A', bindHost: '127.0.0.1', bindPort: 8080, targetPort: originA.address().port, connectionId: 'conn-17' })
  const tB = await saveRemote(ctx, { name: 'R-B', bindHost: '127.0.0.1', bindPort: 9090, targetPort: originB.address().port, connectionId: 'conn-17' })
  await ctx.tm.start(tA.id, 'S17')
  await ctx.tm.start(tB.id, 'S17')
  check('两条 -R 都进入 active', ctx.stateOf(tA.id)?.status === 'active' && ctx.stateOf(tB.id)?.status === 'active',
    { a: ctx.stateOf(tA.id)?.status, b: ctx.stateOf(tB.id)?.status })
  check('forwardIn 各报了一次绑定请求', client.forwardedIn.length === 2, client.forwardedIn)

  // 端口 8080 → 只有 A 的处理器能接，且真的连到了 A 的上游
  client.accepts = 0
  client.rejects = 0
  client.emitConnection({ destIP: '127.0.0.1', destPort: 8080, srcIP: '10.0.0.9', srcPort: 50000 })
  const okA = await waitFor(function () { return client.channels.length === 1 })
  check('发往 8080 的连接被 accept', okA && client.accepts === 1, { accepts: client.accepts })
  check('发往 8080 的连接不 reject 其他隧道', client.rejects === 0, client.rejects)
  if (okA) {
    const ch = client.channels[0]
    ch.push('ping')
    const echoed = await waitFor(function () { return ch.received.join('').indexOf('A:ping') === 0 })
    check('8080 的连接命中 A 的上游（不是被 9090 抢走）', echoed, ch.received.join(''))
  }

  // 端口 9090 → B
  client.emitConnection({ destIP: '127.0.0.1', destPort: 9090, srcIP: '10.0.0.9', srcPort: 50001 })
  const okB = await waitFor(function () { return client.channels.length === 2 })
  check('发往 9090 的连接被 accept', okB, client.channels.length)
  if (okB) {
    const ch = client.channels[1]
    ch.push('ping')
    const echoed = await waitFor(function () { return ch.received.join('').indexOf('B:ping') === 0 })
    check('9090 的连接命中 B 的上游', echoed, ch.received.join(''))
  }

  // 没人认领的端口：reject 只能一次（早退不 reject 会漏通道，双 listener 会双 reject）
  client.rejects = 0
  client.emitConnection({ destIP: '127.0.0.1', destPort: 1234, srcIP: '10.0.0.9', srcPort: 50002 })
  await sleep(60)
  check('未匹配端口的连接只 reject 一次', client.rejects === 1, client.rejects)

  ctx.tm.dispose(tA.id)
  ctx.tm.dispose(tB.id)
  await ctx.repo.deleteTunnel(tA.id)
  await ctx.repo.deleteTunnel(tB.id)

  /* ---- 绑定地址归一：0.0.0.0 与 127.0.0.1 同端口共存 ---- */
  client.accepts = 0
  client.rejects = 0
  client.channels.length = 0
  const tPrecise = await saveRemote(ctx, { name: 'R-精确', bindHost: '127.0.0.1', bindPort: 7070, targetPort: originA.address().port, connectionId: 'conn-17' })
  await ctx.tm.start(tPrecise.id, 'S17')
  /*
   * 0.0.0.0 需要 LAN 授权，由 saveRemote 的 allowLan: true 放行；
   * 同一客户端上它与精确绑定共存，靠 destIP 区分。
   */
  const tWild = await saveRemote(ctx, { name: 'R-通配', bindHost: '0.0.0.0', bindPort: 7070, targetPort: originB.address().port, connectionId: 'conn-17' })
  await ctx.tm.start(tWild.id, 'S17')
  check('0.0.0.0 绑定按通配对待且两条都 active',
    ctx.stateOf(tPrecise.id)?.status === 'active' && ctx.stateOf(tWild.id)?.status === 'active',
    { precise: ctx.stateOf(tPrecise.id)?.status, wild: ctx.stateOf(tWild.id)?.status })

  // 服务端上报 0.0.0.0 → 必须落到通配那条，不能被精确的 127.0.0.1 抢走
  client.emitConnection({ destIP: '0.0.0.0', destPort: 7070, srcIP: '10.0.0.9', srcPort: 51000 })
  const gotWild = await waitFor(function () { return client.channels.length === 1 })
  if (gotWild) {
    const ch = client.channels[0]
    ch.push('x')
    check('destIP 0.0.0.0 命中通配隧道（不被精确绑定抢走）',
      await waitFor(function () { return ch.received.join('').indexOf('B:x') === 0 }), ch.received.join(''))
  } else {
    check('destIP 0.0.0.0 命中通配隧道（不被精确绑定抢走）', false, '没有接受通道')
  }

  // 服务端上报 127.0.0.1 → 精确那条
  client.emitConnection({ destIP: '127.0.0.1', destPort: 7070, srcIP: '10.0.0.9', srcPort: 51001 })
  const gotPrecise = await waitFor(function () { return client.channels.length === 2 })
  if (gotPrecise) {
    const ch = client.channels[1]
    ch.push('y')
    check('destIP 127.0.0.1 命中精确绑定',
      await waitFor(function () { return ch.received.join('').indexOf('A:y') === 0 }), ch.received.join(''))
  } else {
    check('destIP 127.0.0.1 命中精确绑定', false, '没有接受通道')
  }

  /*
   * 服务端没上报 destIP（老设备/非标准实现）：不能因此把精确绑定判死，
   * 否则这类设备的 -R 全部连不通。
   */
  client.channels.length = 0
  client.emitConnection({ destPort: 7070, srcIP: '10.0.0.9', srcPort: 51002 })
  check('未上报 destIP 时仍能匹配到隧道（不退化成 reject）',
    await waitFor(function () { return client.channels.length === 1 }), client.channels.length)

  ctx.tm.dispose(tPrecise.id)
  ctx.tm.dispose(tWild.id)
  await ctx.repo.deleteTunnel(tPrecise.id)
  await ctx.repo.deleteTunnel(tWild.id)

  /* ---- 回环名归一：localhost / ::1 / [::1] / ::ffff: 都折成 127.0.0.1 ---- */
  client.channels.length = 0
  const tLocal = await saveRemote(ctx, { name: 'R-localhost', bindHost: 'localhost', bindPort: 6060, targetPort: originA.address().port, connectionId: 'conn-17' })
  await ctx.tm.start(tLocal.id, 'S17')
  const pairs = [
    ['::1', '服务端报 ::1'],
    ['[::1]', '服务端报 [::1]（带方括号）'],
    ['::ffff:127.0.0.1', '服务端报 IPv4-mapped 回环']
  ]
  for (const pair of pairs) {
    client.channels.length = 0
    client.emitConnection({ destIP: pair[0], destPort: 6060, srcIP: '10.0.0.9', srcPort: 52000 })
    check(pair[1] + '能命中 localhost 绑定的 -R',
      await waitFor(function () { return client.channels.length === 1 }), client.channels.length)
  }
  ctx.tm.dispose(tLocal.id)
  await ctx.repo.deleteTunnel(tLocal.id)

  await new Promise(function (r) { originA.close(r) })
  await new Promise(function (r) { originB.close(r) })
}

async function main() {
  const mod = await build()
  groupCommand(mod)
  groupSs(mod)
  groupDualStack(mod)
  groupNetstat(mod)
  groupProc(mod)
  groupCleanup(mod)
  await groupGuard(mod)

  const tmod = await buildTunnel()
  const originSrv = net.createServer(function (s) {
    s.on('data', function (d) {
      s.write('ECHO:' + d.toString())
    })
    s.on('error', function () {
      s.destroy()
    })
  })
  await new Promise(function (r) {
    originSrv.listen(0, '127.0.0.1', r)
  })
  const ctx = makeCtx(tmod, originSrv.address().port)

  await groupResilience(ctx)
  await groupManualStop(ctx)
  await groupAutoStart(ctx)
  await groupQuickForward(ctx)
  await groupPromote(ctx)
  await groupGaveUp(ctx)
  await groupReverseDispatch(ctx)
  groupUrl(ctx)

  for (const info of ctx.tm.states()) ctx.tm.dispose(info.tunnelId)
  await new Promise(function (r) {
    originSrv.close(r)
  })

  console.log('')
  if (failed > 0) {
    console.log('自检失败：' + failed + ' 项（通过 ' + passed + ' 项）')
    process.exit(1)
  }
  console.log('自检全部通过（' + passed + ' 项）')
}

main().catch(function (err) {
  console.error(err)
  process.exit(1)
})
