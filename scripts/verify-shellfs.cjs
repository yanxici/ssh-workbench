#!/usr/bin/env node
/**
 * P0 Task 3 自检：纯 Shell / BusyBox 文件与流传输模块（src/main/ssh/shellFs.ts）。
 *
 * 覆盖七组断言：
 *   1. shQuote —— 所有危险字符都必须落在单引号内，且往返可还原（Review Focus #2）。
 *   2. assertSafeRemovePath —— 空串 / 根 / . / .. 一律拒绝，且拒绝时绝不发出任何远端命令。
 *   3. parseLsOutput —— GNU 与 BusyBox 两种 ls 输出、含空格名、软链、设备节点、setuid、
 *      ACL 后缀、CRLF 换行、目录优先排序、权限串反算。
 *   4. mock Client 驱动的读写 —— shellReadText 的超限/二进制拦截与 raw 字节透传、
 *      shellWriteText 的备份-写入-回滚三段语义。
 *   5. shellUploadFile / shellDownloadFile —— 字节一致、.part 原子替换、取消清理、进度回调。
 *   6. shellList / shellListMany / shellWalkRemote —— 命令形态、并发上限、深度与数量上限。
 *   7. 元数据命令 —— mkdir/rename/chmod/remove 的命令形态与参数校验。
 *
 * 假远端只认「shellFs 真会发出去的那几条命令」：命令拼错或漏引号时 extractArgs 取不到
 * 参数，用例立刻红，而不是被宽松的正则掩盖。
 */
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { EventEmitter } = require('node:events')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, '.tsc-verify')
fs.mkdirSync(OUT, { recursive: true })

let failed = 0
let passed = 0
function check(name, cond, extra) {
  if (cond) {
    passed++
    console.log('  ok   ' + name)
  } else {
    failed++
    console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''))
  }
}
function group(title) {
  console.log('\n' + title)
}

/* ------------------------------------------------------------------ */
/* 命令行解析：把 POSIX 单引号参数取出来，并审计引号外是否残留元字符      */
/* ------------------------------------------------------------------ */

/**
 * 提取命令里全部单引号包裹的参数。
 *
 * 兼作 shQuote 的往返校验器：shQuote 的产物必须能被它还原成原始字符串，
 * 否则说明转义写错（例如 a'b 被拼成 'a'b'）。
 * 支持 POSIX 的 '\'' 续接写法。
 */
function extractArgs(cmd) {
  const out = []
  let i = 0
  while (i < cmd.length) {
    if (cmd[i] !== "'") {
      i++
      continue
    }
    let buf = ''
    i++
    while (i < cmd.length) {
      if (cmd[i] === "'") {
        if (cmd[i + 1] === '\\' && cmd[i + 2] === "'" && cmd[i + 3] === "'") {
          buf += "'"
          i += 4
          continue
        }
        i++
        break
      }
      buf += cmd[i]
      i++
    }
    out.push(buf)
  }
  return out
}

/**
 * 审计引号外的字符：只允许普通路径字符与反斜杠转义。
 * 一旦 $ 反引号 ; | & > < 括号 空白 出现在引号外，就说明存在注入面。
 */
function unquotedMetachars(cmd) {
  const bad = []
  let i = 0
  let quoted = false
  while (i < cmd.length) {
    const c = cmd[i]
    if (c === "'") {
      quoted = !quoted
      i++
      continue
    }
    if (!quoted) {
      if (c === '\\') {
        i += 2
        continue
      }
      if (/[$`;&|<>(){}\s*?\[\]#~!"]/.test(c)) bad.push(c)
    }
    i++
  }
  return bad
}

/* ------------------------------------------------------------------ */
/* 假远端：只认 shellFs 会发出的命令                                    */
/* ------------------------------------------------------------------ */

function makeChannel() {
  const ch = new EventEmitter()
  ch.stderr = new EventEmitter()
  const stdin = []
  const state = { finished: false, closed: false, closedByUs: false, writes: 0, ended: false }
  ch.state = state

  ch.write = (buf) => {
    stdin.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
    state.writes++
    // 每 3 次写返回一次 false 并异步补 drain：逼实现真的处理背压
    if (state.writes % 3 === 0) {
      setImmediate(() => {
        if (!state.closed) ch.emit('drain')
      })
      return false
    }
    return true
  }
  ch.end = () => {
    if (state.ended) return
    state.ended = true
    const all = Buffer.concat(stdin)
    if (typeof ch._onStdinEnd === 'function') ch._onStdinEnd(all)
  }
  ch.close = () => {
    if (state.closed) return
    state.closedByUs = true
    state.closed = true
    setImmediate(() => ch.emit('close', null, 'SSH_MSG_CHANNEL_CLOSE'))
  }
  ch.pause = () => {}
  ch.resume = () => {}
  ch.signal = () => {}

  ch._finish = (code, stderrText, stdoutBuf) => {
    if (state.finished) return
    state.finished = true
    const data = stdoutBuf || Buffer.alloc(0)
    const step = 8192
    let off = 0
    const pump = () => {
      if (state.closedByUs) return
      if (off < data.length) {
        ch.emit('data', data.subarray(off, off + step))
        off += step
        setImmediate(pump)
        return
      }
      if (stderrText) ch.stderr.emit('data', Buffer.from(stderrText, 'utf8'))
      if (state.closed) return
      state.closed = true
      ch.emit('exit', code, null)
      ch.emit('close', code, null)
    }
    setImmediate(pump)
  }
  return ch
}

class FakeShell {
  constructor() {
    this.files = new Map()
    this.dirs = new Set(['/'])
    this.lsFixtures = new Map()
    this.lsErrors = new Map()
    this.cmdLog = []
    this.unknown = []
    this.failCommands = []
    this.lsDelayMs = 0
    this.concurrency = { now: 0, max: 0 }
    this.home = '/root'
  }

  client() {
    const shell = this
    return {
      exec(cmd, a, b) {
        const cb = typeof a === 'function' ? a : b
        shell.dispatch(cmd, cb)
      }
    }
  }

  /** 让某条命令以非 0 退出，用于测「备份失败绝不写入」「写入失败要回滚」 */
  failOn(pattern, code, stderr) {
    this.failCommands.push({ match: pattern, code, stderr: stderr || 'boom' })
  }

  dispatch(cmd, cb) {
    this.cmdLog.push(cmd)
    const args = extractArgs(cmd)
    const ch = makeChannel()
    const enc = (s) => Buffer.from(s, 'utf8')
    const concurrency = this.concurrency
    concurrency.now++
    concurrency.max = Math.max(concurrency.max, concurrency.now)
    const release = () => {
      concurrency.now--
    }
    const self = this
    const later = (fn) => {
      if (self.lsDelayMs > 0) setTimeout(fn, self.lsDelayMs)
      else setImmediate(fn)
    }
    const fail = self.failCommands.find((f) => f.match.test(cmd))
    const reply = (code, stderrText, stdoutBuf) => {
      // 结算放到延时里：并发上限要看「命令真正占用」的区间，而不是 dispatch 的同一 tick
      later(() => {
        release()
        if (fail) {
          ch._finish(fail.code, fail.stderr, Buffer.alloc(0))
          return
        }
        ch._finish(code, stderrText, stdoutBuf)
      })
    }

    cb(null, ch)

    // ---- 列目录（--full-time 与回退两支在同一条命令里）----
    if (/^LC_ALL=C ls -la/.test(cmd)) {
      const raw = args[0] || '/'
      const dir = raw.replace(/\/+$/, '') || '/'
      if (self.lsErrors.has(dir)) {
        reply(2, self.lsErrors.get(dir), Buffer.alloc(0))
        return
      }
      const fixture = self.lsFixtures.has(dir) ? self.lsFixtures.get(dir) : 'total 0\n'
      reply(0, '', enc(fixture))
      return
    }

    // ---- home ----
    if (/^pwd 2>\/dev\/null \|\| printf/.test(cmd)) {
      reply(0, '', enc(self.home + '\n'))
      return
    }

    // ---- 取大小 ----
    if (/^wc -c < /.test(cmd)) {
      const target = args[0]
      const buf = self.files.get(target)
      if (!buf) {
        reply(1, 'wc: ' + target + ': No such file or directory', Buffer.alloc(0))
        return
      }
      reply(0, '', enc(String(buf.length) + '\n'))
      return
    }

    // ---- 存在性 ----
    if (/^\[ -e /.test(cmd)) {
      const target = args[0]
      reply(self.files.has(target) || self.dirs.has(target) ? 0 : 1, '', Buffer.alloc(0))
      return
    }

    // ---- 备份 ----
    if (/^cp -f -- /.test(cmd)) {
      const from = self.files.get(args[0])
      if (!from) {
        reply(1, 'cp: ' + args[0] + ': No such file or directory', Buffer.alloc(0))
        return
      }
      self.files.set(args[1], Buffer.from(from))
      reply(0, '', Buffer.alloc(0))
      return
    }

    // ---- 写入：cat > <target>（未 end 前不结算）----
    if (/^cat > /.test(cmd)) {
      const target = args[0]
      ch._onStdinEnd = (all) => {
        if (fail) {
          release()
          later(() => ch._finish(fail.code, fail.stderr, Buffer.alloc(0)))
          return
        }
        if (cmd.indexOf('&& mv -f -- ') >= 0) {
          // 上传命令是 cat > <part> && mv -f -- <part> <target>：要么整体成功，要么什么都不发生
          self.files.delete(target)
          self.files.set(args[args.length - 1], Buffer.from(all))
        } else {
          self.files.set(target, Buffer.from(all))
        }
        release()
        later(() => ch._finish(0, '', Buffer.alloc(0)))
      }
      return
    }

    // ---- 回滚：cat <bak> > <target> ----
    if (/^cat '/.test(cmd) && / > /.test(cmd)) {
      const src = self.files.get(args[0])
      if (!src) {
        reply(1, 'cat: ' + args[0] + ': No such file or directory', Buffer.alloc(0))
        return
      }
      self.files.set(args[1], Buffer.from(src))
      reply(0, '', Buffer.alloc(0))
      return
    }

    // ---- 读文件 ----
    if (/^cat -- /.test(cmd)) {
      const buf = self.files.get(args[0])
      if (!buf) {
        reply(1, 'cat: ' + args[0] + ': No such file or directory', Buffer.alloc(0))
        return
      }
      reply(0, '', buf)
      return
    }

    // ---- 原子替换 ----
    if (/^mv -f -- /.test(cmd)) {
      const src = self.files.get(args[0])
      if (!src) {
        reply(1, 'mv: ' + args[0] + ': No such file or directory', Buffer.alloc(0))
        return
      }
      self.files.delete(args[0])
      self.files.set(args[1], src)
      reply(0, '', Buffer.alloc(0))
      return
    }

    // ---- 删除 ----
    if (/^rm -rf -- /.test(cmd) || /^rm -f -- /.test(cmd)) {
      self.files.delete(args[0])
      reply(0, '', Buffer.alloc(0))
      return
    }

    // ---- 建目录 ----
    if (/^mkdir -p -- /.test(cmd)) {
      self.dirs.add(args[0])
      reply(0, '', Buffer.alloc(0))
      return
    }
    if (/^mkdir -- /.test(cmd)) {
      self.dirs.add(args[0])
      reply(0, '', Buffer.alloc(0))
      return
    }

    // ---- 权限 ----
    if (/^chmod [0-7]+ -- /.test(cmd)) {
      reply(0, '', Buffer.alloc(0))
      return
    }

    self.unknown.push(cmd)
    reply(127, 'sh: not found', Buffer.alloc(0))
  }
}

function eq(name, actual, expected) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  check(name, a === e, { actual, expected })
}

/* ------------------------------------------------------------------ */
/* ls 夹具                                                              */
/* ------------------------------------------------------------------ */

// GNU coreutils --full-time：纳秒 + 时区，末尾带 . 与 ..
const LS_GNU = [
  'total 12',
  'drwxr-xr-x 2 root root 4096 2024-11-24 01:02:03.000000000 +0800 .',
  'drwxr-xr-x 3 root root 4096 2024-11-24 01:02:03.000000000 +0800 ..',
  'drwxr-xr-x 2 root root 4096 2024-11-24 01:02:03.123456789 +0800 bin',
  '-rw-r--r-- 1 root root 1234 2024-11-24 01:02:03.000000000 +0800 file with space.txt',
  'lrwxrwxrwx 1 root root 12 2024-11-24 01:02:03.000000000 +0800 busybox -> /bin/busybox',
  'crw-rw-rw- 1 root root 1, 3 1970-01-01 00:00:00.000000000 +0000 null',
  '-rwsr-xr-x 1 root root 100 2024-11-24 01:02:03.000000000 +0800 sudobin',
  'drwxr-xr-x+ 2 root root 4096 2024-11-24 01:02:03.000000000 +0800 acl dir',
  ''
].join('\n')

// BusyBox 经典 ls -la：月名 + 时间/年份，设备节点 major, minor 占两列
const LS_BUSYBOX = [
  'total 8',
  'drwxr-xr-x    2 root     root          4096 Nov 24 01:02 etc',
  '-rw-r--r--    1 root     root           512 Nov 24  2024 profile',
  'crw-rw-rw-    1 root     root        1,   3 Jan  1  1970 null',
  'lrwxrwxrwx    1 root     root             7 Nov 24 01:02 sh -> busybox',
  ''
].join('\n')

function byName(list, n) {
  return list.filter((f) => f.name === n)[0]
}

/* ------------------------------------------------------------------ */
/* 1. shQuote                                                          */
/* ------------------------------------------------------------------ */

function groupShQuote(mod) {
  group('1. shQuote 单引号转义（Review Focus #2：路径不可注入）')
  const cases = [
    '/var/log',
    'a b',
    "a'b",
    '$HOME',
    'BUQID',
    '$(rm -rf /)',
    '-rf',
    'a;rm -rf /',
    'a|b',
    'a&&b',
    'a>b',
    '中文 目录',
    "it's $(id)",
    ''
  ]
  for (const s of cases) {
    const q = mod.shQuote(s)
    const bad = unquotedMetachars(q)
    check('shQuote(' + JSON.stringify(s) + ') 引号外无元字符', bad.length === 0, { quoted: q, bad })
    eq('shQuote(' + JSON.stringify(s) + ') 可无损还原', extractArgs(q), [s])
  }
  check('shQuote 对 -rf 加了引号', mod.shQuote('-rf').indexOf("'") === 0)
  eq('shQuote 不做二次转义（a b 原样）', extractArgs(mod.shQuote('a b')), ['a b'])
}

/* ------------------------------------------------------------------ */
/* 2. assertSafeRemovePath                                            */
/* ------------------------------------------------------------------ */

async function groupSafeRemove(mod) {
  group('2. assertSafeRemovePath 删除路径硬校验')
  const bads = ['', '   ', '/', '///', '.', '..', './', '../', '/.', '/..', 'a/..', '~/']
  for (const b of bads) {
    let threw = false
    let msg = ''
    try {
      mod.assertSafeRemovePath(b)
    } catch (e) {
      threw = true
      msg = e && e.message
    }
    check('拒绝删除 ' + JSON.stringify(b), threw, msg || '未抛错')
  }
  eq('放行 /tmp/a', mod.assertSafeRemovePath('/tmp/a'), '/tmp/a')
  eq('放行相对路径 build/tmp', mod.assertSafeRemovePath('build/tmp'), 'build/tmp')
  check('放行 /tmp/a/（保留原值或去尾斜杠均可）', mod.assertSafeRemovePath('/tmp/a/').replace(/\/+$/, '') === '/tmp/a')

  // 拒绝时必须发生在 exec 之前：一条远端命令都不许发出去
  const shell = new FakeShell()
  for (const bad of ['/', '..', '']) {
    let rejected = false
    try {
      await mod.shellRemove(shell.client(), bad)
    } catch (e) {
      rejected = true
    }
    check('shellRemove(' + JSON.stringify(bad) + ') 拒绝', rejected)
  }
  eq('拒绝时未发出任何 rm 命令', shell.cmdLog.filter((c) => /^rm /.test(c)), [])
}

/* ------------------------------------------------------------------ */
/* 3. parseLsOutput                                                    */
/* ------------------------------------------------------------------ */

function groupParseLs(mod) {
  group('3. parseLsOutput 兼容 GNU --full-time 与 BusyBox ls -la')
  const gnu = mod.parseLsOutput('/bin', LS_GNU)
  eq('跳过 total/. /.. 后共 6 条', gnu.length, 6)
  eq('目录优先 + zh-CN 排序', gnu.map((f) => f.name), ['acl dir', 'bin', 'busybox', 'file with space.txt', 'null', 'sudobin'])

  const bin = byName(gnu, 'bin')
  check('bin 是目录且非软链', bin && bin.type === 'directory' && bin.isLink === false, bin)
  check('drwxr-xr-x 反算 mode=0o755', bin && (bin.mode & 0o777) === 0o755, bin && bin.mode)
  check('modeStr=drwxr-xr-x', bin && bin.modeStr === 'drwxr-xr-x', bin && bin.modeStr)
  check('目录 size=4096', bin && bin.size === 4096, bin && bin.size)
  eq('path 由 dir 拼出', bin && bin.path, '/bin/bin')
  check('mtime 解析为毫秒（按 +0800 换算）', bin && Math.abs(bin.mtime - Date.UTC(2024, 10, 23, 17, 2, 3)) < 2000, bin && bin.mtime)

  const spaced = byName(gnu, 'file with space.txt')
  check('含空格文件名完整保留', !!spaced, gnu.map((f) => f.name))
  check('含空格文件 size=1234', spaced && spaced.size === 1234, spaced && spaced.size)

  const link = byName(gnu, 'busybox')
  check('软链 type=symlink', link && link.type === 'symlink', link)
  check('软链 isLink=true', link && link.isLink === true, link)
  eq('软链 name 不含 -> 目标', link && link.name, 'busybox')
  check('软链 size=12', link && link.size === 12, link && link.size)

  const dev = byName(gnu, 'null')
  eq('设备节点不错列', dev && dev.name, 'null')
  check('设备节点 size=0', dev && dev.size === 0, dev && dev.size)

  const suid = byName(gnu, 'sudobin')
  check('setuid 反算 mode=0o4755', suid && suid.mode === 0o4755, suid && suid.mode.toString(8))
  eq('setuid modeStr=-rwsr-xr-x', suid && suid.modeStr, '-rwsr-xr-x')

  const acl = byName(gnu, 'acl dir')
  check('ACL 后缀不破坏权限解析', acl && (acl.mode & 0o777) === 0o755 && acl.type === 'directory', acl && acl.modeStr)

  const bb = mod.parseLsOutput('/etc', LS_BUSYBOX)
  eq('BusyBox 共 4 条', bb.length, 4)
  eq('BusyBox 目录优先', bb.map((f) => f.name), ['etc', 'null', 'profile', 'sh'])
  check('BusyBox 月名+时间格式 size=512', byName(bb, 'profile') && byName(bb, 'profile').size === 512, byName(bb, 'profile'))
  check('BusyBox 月名+年份可解析 mtime', byName(bb, 'profile') && byName(bb, 'profile').mtime > 0, byName(bb, 'profile') && byName(bb, 'profile').mtime)
  check('BusyBox 设备节点 major,miner 不错列', byName(bb, 'null') && byName(bb, 'null').size === 0, byName(bb, 'null'))
  check('BusyBox 软链拆解', byName(bb, 'sh') && byName(bb, 'sh').type === 'symlink' && byName(bb, 'sh').isLink === true, byName(bb, 'sh'))

  eq('CRLF 输出同样可解析', mod.parseLsOutput('/bin', LS_GNU.replace(/\n/g, '\r\n')).length, 6)
  eq('空输出返回空数组', mod.parseLsOutput('/bin', ''), [])
  eq('错误文本返回空数组', mod.parseLsOutput('/bin', 'ls: /bin: Permission denied'), [])
}
/* ------------------------------------------------------------------ */
/* 4. shellReadText / shellWriteText                                   */
/* ------------------------------------------------------------------ */

async function groupReadWrite(mod) {
  group('4. shellReadText / shellWriteText（mock Client）')
  const detect = (buf) => ({ content: buf.toString('utf8'), encoding: 'utf-8' })

  // ---- 超限拒读 ----
  const s1 = new FakeShell()
  s1.files.set('/big.txt', Buffer.alloc(10, 0x41))
  let err1 = null
  try {
    await mod.shellReadText(s1.client(), '/big.txt', detect, 4)
  } catch (e) {
    err1 = e
  }
  check('超过 maxBytes 直接拒读', !!err1 && /过大/.test(err1.message), err1 && err1.message)
  eq('超限时不再发 cat 命令', s1.cmdLog.filter((c) => /^cat -- /.test(c)), [])

  // ---- NUL 字节判二进制 ----
  const s2 = new FakeShell()
  s2.files.set('/bin.dat', Buffer.from([0x41, 0x00, 0x42]))
  let err2 = null
  try {
    await mod.shellReadText(s2.client(), '/bin.dat', detect, 1024)
  } catch (e) {
    err2 = e
  }
  check('含 NUL 判二进制拒读', !!err2 && /二进制/.test(err2.message), err2 && err2.message)

  // ---- UTF-8 原始字节无损透传 ----
  const s3 = new FakeShell()
  const utf8 = Buffer.from('中文测试 ✓\n', 'utf8')
  s3.files.set('/a.txt', utf8)
  let captured = null
  const r3 = await mod.shellReadText(s3.client(), '/a.txt', (buf) => {
    captured = Buffer.from(buf)
    return { content: buf.toString('utf8'), encoding: 'utf-8' }
  }, 1024)
  check('UTF-8 字节原样交给 detectEncoding', captured && captured.equals(utf8), captured && captured.toString('hex'))
  eq('UTF-8 内容正确', r3.content, '中文测试 ✓\n')
  check('wc -c 先于 cat', s3.cmdLog[0].indexOf('wc -c < ') === 0, s3.cmdLog)

  // ---- GBK 原始字节同样无损（编码判定由注入函数负责）----
  const s4 = new FakeShell()
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
  s4.files.set('/gbk.txt', gbk)
  let capturedGbk = null
  const r4 = await mod.shellReadText(s4.client(), '/gbk.txt', (buf) => {
    capturedGbk = Buffer.from(buf)
    return { content: '中文', encoding: 'gb18030' }
  }, 1024)
  check('GBK 字节原样交给 detectEncoding', capturedGbk && capturedGbk.equals(gbk), capturedGbk && capturedGbk.toString('hex'))
  eq('GBK 编码标记透传', r4.encoding, 'gb18030')

  // ---- 新文件：不备份，直接写 ----
  const s5 = new FakeShell()
  await mod.shellWriteText(s5.client(), '/new.txt', Buffer.from('hello', 'utf8'))
  eq('新文件不备份', s5.cmdLog.filter((c) => /^cp -f -- /.test(c)), [])
  eq('新文件内容写入成功', s5.files.get('/new.txt') && s5.files.get('/new.txt').toString(), 'hello')

  // ---- 存在原文件：先备份再原地覆写 ----
  const s6 = new FakeShell()
  s6.files.set('/old.txt', Buffer.from('v1', 'utf8'))
  await mod.shellWriteText(s6.client(), '/old.txt', Buffer.from('v2', 'utf8'))
  check('存在时先 cp -f 备份', s6.cmdLog.some((c) => c === "cp -f -- '/old.txt' '/old.txt.swb-bak'"), s6.cmdLog)
  check('备份先于写入', s6.cmdLog.findIndex((c) => /^cp -f -- /.test(c)) < s6.cmdLog.findIndex((c) => /^cat > /.test(c)), s6.cmdLog)
  eq('覆写后的内容正确', s6.files.get('/old.txt') && s6.files.get('/old.txt').toString(), 'v2')

  // ---- 备份失败：立即报错，绝不写入 ----
  const s7 = new FakeShell()
  s7.files.set('/old.txt', Buffer.from('v1', 'utf8'))
  s7.failOn(/^cp -f -- /, 1, 'cp: cannot create regular file')
  let err7 = null
  try {
    await mod.shellWriteText(s7.client(), '/old.txt', Buffer.from('v2', 'utf8'))
  } catch (e) {
    err7 = e
  }
  check('备份失败要报错', !!err7 && /备份/.test(err7.message), err7 && err7.message)
  eq('备份失败后绝不写文件', s7.cmdLog.filter((c) => /^cat > /.test(c)), [])
  eq('备份失败后原内容不变', s7.files.get('/old.txt').toString(), 'v1')

  // ---- 写入失败：用备份回滚 ----
  const s8 = new FakeShell()
  s8.files.set('/old.txt', Buffer.from('v1', 'utf8'))
  s8.failOn(/^cat > '/, 1, 'No space left on device')
  let err8 = null
  try {
    await mod.shellWriteText(s8.client(), '/old.txt', Buffer.from('v2', 'utf8'))
  } catch (e) {
    err8 = e
  }
  check('写入失败要报错', !!err8, err8 && err8.message)
  check('写入失败触发 cat <bak> > <target> 回滚', s8.cmdLog.some((c) => c === "cat '/old.txt.swb-bak' > '/old.txt'"), s8.cmdLog)
  eq('回滚后内容为旧值', s8.files.get('/old.txt').toString(), 'v1')
}

/* ------------------------------------------------------------------ */
/* 5. 流式上传 / 下载                                                  */
/* ------------------------------------------------------------------ */

function makeHooks(overrides) {
  const st = { transferred: 0, total: 0, calls: 0 }
  const hooks = {
    isPaused: () => false,
    isCancelled: () => false,
    waitIfPaused: () => Promise.resolve(),
    onProgress: (t, total) => {
      st.transferred = t
      st.total = total
      st.calls++
    }
  }
  if (overrides) Object.assign(hooks, overrides)
  return { hooks, st }
}

function payload(n) {
  const buf = Buffer.alloc(n)
  for (let i = 0; i < n; i++) buf[i] = (i * 31 + 7) & 0xff
  return buf
}

async function groupTransfers(mod, tmp) {
  group('5. shellUploadFile / shellDownloadFile（真实本地文件 + mock exec 流）')
  const big = payload(300 * 1024)

  // ---- 上传：字节一致 + 原子 rename + 进度 ----
  const upLocal = path.join(tmp, 'up.bin')
  fs.writeFileSync(upLocal, big)
  const s1 = new FakeShell()
  const h1 = makeHooks()
  await mod.shellUploadFile(s1.client(), upLocal, '/tmp/up.bin', h1.hooks)
  const got = s1.files.get('/tmp/up.bin')
  check('上传后远端字节完全一致', !!got && got.equals(big), got && got.length)
  check('上传走 .part + && mv -f 原子替换', s1.cmdLog.some((c) => c.indexOf("cat > '/tmp/up.bin.swb-part' && mv -f -- ") === 0), s1.cmdLog)
  check('上传后 .part 不残留', !s1.files.has('/tmp/up.bin.swb-part'))
  check('上传进度总量正确', h1.st.total === big.length, h1.st.total)
  check('上传进度收尾等于总量', h1.st.transferred === big.length, h1.st.transferred)
  check('上传背压下多次回调进度', h1.st.calls >= 2, h1.st.calls)
  eq('上传全程无未知命令', s1.unknown, [])

  // ---- 上传取消：清理 .part，目标文件不变 ----
  const s2 = new FakeShell()
  let cancelled = false
  const h2 = makeHooks({
    isCancelled: () => cancelled,
    onProgress: () => {
      cancelled = true
    }
  })
  let err2 = null
  try {
    await mod.shellUploadFile(s2.client(), upLocal, '/tmp/cancel.bin', h2.hooks)
  } catch (e) {
    err2 = e
  }
  check('上传取消要抛取消错误', !!err2 && /取消|cancel/i.test(err2.message), err2 && err2.message)
  check('上传取消后尽力清理 .part', s2.cmdLog.some((c) => /^rm -f -- /.test(c)), s2.cmdLog)
  check('上传取消后目标文件未生成', !s2.files.has('/tmp/cancel.bin'))

  // ---- 下载：字节一致 + .part 收敛 + 进度 ----
  const s3 = new FakeShell()
  s3.files.set('/tmp/down.bin', big)
  const downLocal = path.join(tmp, 'down.bin')
  const h3 = makeHooks()
  await mod.shellDownloadFile(s3.client(), '/tmp/down.bin', downLocal, h3.hooks)
  const localBuf = fs.readFileSync(downLocal)
  check('下载后本地字节完全一致', localBuf.equals(big), localBuf.length)
  check('下载先 wc -c 取总大小', s3.cmdLog[0].indexOf('wc -c < ') === 0, s3.cmdLog)
  check('下载后 .part 不残留', !fs.existsSync(downLocal + '.part'))
  check('下载进度总量正确', h3.st.total === big.length, h3.st.total)
  check('下载进度收尾等于总量', h3.st.transferred === big.length, h3.st.transferred)
  eq('下载全程无未知命令', s3.unknown, [])

  // ---- 下载取消：清理 .part ----
  const s4 = new FakeShell()
  s4.files.set('/tmp/d2.bin', big)
  const d2 = path.join(tmp, 'd2.bin')
  let c4 = false
  const h4 = makeHooks({
    isCancelled: () => c4,
    onProgress: () => {
      c4 = true
    }
  })
  let err4 = null
  try {
    await mod.shellDownloadFile(s4.client(), '/tmp/d2.bin', d2, h4.hooks)
  } catch (e) {
    err4 = e
  }
  check('下载取消要抛取消错误', !!err4 && /取消|cancel/i.test(err4.message), err4 && err4.message)
  check('下载取消后清理 .part', !fs.existsSync(d2 + '.part'))
  check('下载取消后不生成目标文件', !fs.existsSync(d2))

  // ---- 下载失败（cat 非 0）：清理 .part 并抛错 ----
  const s5 = new FakeShell()
  s5.files.set('/tmp/e.bin', Buffer.from('x'))
  const e5 = path.join(tmp, 'e.bin')
  s5.failOn(/^cat -- /, 1, 'cat: read error')
  let err5 = null
  try {
    await mod.shellDownloadFile(s5.client(), '/tmp/e.bin', e5, makeHooks().hooks)
  } catch (e) {
    err5 = e
  }
  check('下载失败要报错', !!err5, err5 && err5.message)
  check('下载失败后清理 .part', !fs.existsSync(e5 + '.part'))
}
/* ------------------------------------------------------------------ */
/* 6. shellList / shellListMany / shellWalkRemote                       */
/* ------------------------------------------------------------------ */

function lsFile(name, size) {
  return '-rw-r--r--    1 root     root     ' + String(size).padStart(8) + ' 2024-11-24 01:02:03.000000000 +0000 ' + name
}
function lsDir(name) {
  return 'drwxr-xr-x    2 root     root         4096 2024-11-24 01:02:03.000000000 +0000 ' + name
}

async function groupListing(mod) {
  group('6. shellList / shellListMany / shellWalkRemote')

  // ---- 单目录：命令形态（含 --full-time 回退与目录补斜杠）----
  const s1 = new FakeShell()
  s1.lsFixtures.set('/etc', ['total 4', lsDir('etc'), lsFile('profile', 512), ''].join('\n'))
  const r1 = await mod.shellList(s1.client(), '/etc')
  eq('shellList 命令形态（补斜杠 + --full-time 回退）', s1.cmdLog[0], "LC_ALL=C ls -la --full-time -- '/etc/' 2>/dev/null || LC_ALL=C ls -la -- '/etc/'")
  eq('shellList 解析结果', r1.map((f) => f.name), ['etc', 'profile'])
  eq('shellList 条目 path 带目录前缀', byName(r1, 'profile').path, '/etc/profile')

  const s2 = new FakeShell()
  await mod.shellList(s2.client(), '/')
  check('shellList 根目录不补出 //', s2.cmdLog[0].indexOf("--full-time -- '/' 2>/dev/null") > 0, s2.cmdLog[0])

  const s3 = new FakeShell()
  await mod.shellList(s3.client(), '/a/')
  check('shellList 尾部多斜杠归一为一层', s3.cmdLog[0].indexOf("--full-time -- '/a/' 2>/dev/null") > 0, s3.cmdLog[0])

  // ---- 失败要抛错并带上 stderr 原文 ----------------
  const s4 = new FakeShell()
  s4.lsErrors.set('/nope', 'ls: /nope: No such file or directory')
  let err4 = null
  try {
    await mod.shellList(s4.client(), '/nope')
  } catch (e) {
    err4 = e
  }
  check('shellList 失败要抛错', !!err4, err4 && err4.message)
  check('shellList 错误里带 stderr 原文', !!err4 && /No such file/.test(err4.message), err4 && err4.message)

  // ---- 批量：并发上限 4，单个目录失败不影响其余 -----
  const s5 = new FakeShell()
  s5.lsDelayMs = 8
  const dirs = []
  for (let i = 1; i <= 8; i++) {
    const d = '/d' + i
    dirs.push(d)
    s5.lsFixtures.set(d, ['total 0', lsFile('f' + i, i), ''].join('\n'))
  }
  s5.lsErrors.set('/d5', 'ls: /d5: Permission denied')
  const many = await mod.shellListMany(s5.client(), dirs)
  eq('批量成功 7 个目录', Object.keys(many.dirs).sort(), ['/d1', '/d2', '/d3', '/d4', '/d6', '/d7', '/d8'])
  eq('批量失败目录进 errors', Object.keys(many.errors), ['/d5'])
  check('批量 errors 带 stderr 原文', /Permission denied/.test(many.errors['/d5'] || ''), many.errors['/d5'])
  check('批量并发不超过 4', s5.concurrency.max <= 4, s5.concurrency.max)
  check('批量并发真的用满 4', s5.concurrency.max === 4, s5.concurrency.max)

  // ---- 递归遍历：深度与数量上限 -------------------
  const s6 = new FakeShell()
  s6.lsFixtures.set('/r', ['total 0', lsDir('sub'), lsFile('a.txt', 10), ''].join('\n'))
  s6.lsFixtures.set('/r/sub', ['total 0', lsDir('deep'), lsFile('b.txt', 20), ''].join('\n'))
  s6.lsFixtures.set('/r/sub/deep', ['total 0', lsFile('c.txt', 30), ''].join('\n'))
  const walkAll = await mod.shellWalkRemote(s6.client(), '/r', 1000, 9)
  const relsAll = walkAll.map((e) => e.relPath).sort()
  eq('递归遍历条目齐备', relsAll, ['a.txt', 'sub', 'sub/b.txt', 'sub/deep', 'sub/deep/c.txt'])
  eq('递归条目带 size', byName(walkAll.map((e) => ({ name: e.relPath, v: e })), 'sub/b.txt').v.size, 20)
  check('目录条目 isDir=true', byName(walkAll.map((e) => ({ name: e.relPath, v: e })), 'sub').v.isDir === true)
  check('文件条目 isDir=false', byName(walkAll.map((e) => ({ name: e.relPath, v: e })), 'a.txt').v.isDir === false)
  check('remotePath 是绝对路径', byName(walkAll.map((e) => ({ name: e.relPath, v: e })), 'sub/b.txt').v.remotePath === '/r/sub/b.txt', walkAll.map((e) => e.remotePath))

  const s7 = new FakeShell()
  s7.lsFixtures = s6.lsFixtures
  const walkD2 = await mod.shellWalkRemote(s7.client(), '/r', 1000, 2)
  const relsD2 = walkD2.map((e) => e.relPath).sort()
  check('maxDepth=2 仍列出第二层目录本身', relsD2.indexOf('sub/deep') >= 0, relsD2)
  check('maxDepth=2 不再深入第三层', relsD2.indexOf('sub/deep/c.txt') < 0, relsD2)

  const s8 = new FakeShell()
  s8.lsFixtures = s6.lsFixtures
  const walkCap = await mod.shellWalkRemote(s8.client(), '/r', 2, 9)
  eq('maxFiles 截断生效', walkCap.length, 2)
}

/* ------------------------------------------------------------------ */
/* 7. 元数据命令                                                       */
/* ------------------------------------------------------------------ */

async function groupMetadata(mod) {
  group('7. mkdir / rename / chmod / remove / home 命令形态')

  const s1 = new FakeShell()
  await mod.shellMkdir(s1.client(), '/a/b', true)
  eq('recursive mkdir 走 mkdir -p', s1.cmdLog[0], "mkdir -p -- '/a/b'")

  const s2 = new FakeShell()
  await mod.shellMkdir(s2.client(), '/a/b', false)
  eq('非递归 mkdir 不走 -p', s2.cmdLog[0], "mkdir -- '/a/b'")

  const s3 = new FakeShell()
  s3.files.set('/a x', Buffer.from('x', 'utf8'))
  await mod.shellRename(s3.client(), '/a x', '/b y')
  eq('rename 走 mv -f -- 且两个参数都加引号', s3.cmdLog[0], "mv -f -- '/a x' '/b y'")

  const s4 = new FakeShell()
  await mod.shellChmod(s4.client(), '/a x', 0o755)
  eq('chmod 用八进制', s4.cmdLog[0], "chmod 755 -- '/a x'")

  const s5 = new FakeShell()
  let chmodBad = 0
  for (const m of [0o77777, -1]) {
    try {
      await mod.shellChmod(s5.client(), '/a', m)
    } catch (e) {
      chmodBad++
    }
  }
  eq('非法 mode 全部拒绝', chmodBad, 2)
  eq('非法 mode 不发出任何命令', s5.cmdLog, [])

  const s6 = new FakeShell()
  await mod.shellRemove(s6.client(), '/tmp/a')
  eq('remove 走 rm -rf --', s6.cmdLog[0], "rm -rf -- '/tmp/a'")

  const s7 = new FakeShell()
  s7.home = '/home/embedded'
  const home = await mod.shellHome(s7.client())
  eq('home 取 pwd 输出', home, '/home/embedded')
  check('home 命令带 pwd 兜底', s7.cmdLog[0].indexOf('pwd 2>/dev/null || printf') === 0, s7.cmdLog[0])

  const s8 = new FakeShell()
  s8.home = 'relative/path'
  const home2 = await mod.shellHome(s8.client())
  eq('home 非绝对路径兜底为 /', home2, '/')
}

/* ------------------------------------------------------------------ */
/* 8. SFTP 子系统缺失的降级判定（Task 4 / Review Focus #3）               */
/* ------------------------------------------------------------------ */

/**
 * 只有「远端根本没有 sftp 子系统」才允许降级到纯 Shell 通道。
 *
 * 这一组是防误触红线：把瞬态网络错误、MaxSessions 并发上限、单目录权限错误
 * 判成降级，会让一台完全正常的服务器莫名其妙走慢速 shell 通道。
 */
function groupSftpFallback(mod) {
  group('8. isSftpSubsystemUnavailableError —— 只对子系统缺失降级')

  const degrade = [
    'Unable to start subsystem: sftp',
    'Unable to start SFTP subsystem: ...',
    'Received exit code 1 while establishing SFTP session',
    'Received exit code 127 while establishing SFTP session',
    'Received unexpected SFTP session termination',
    'Expected VERSION packet, got ...',
    'sftp-server: not found',
  ]
  for (const msg of degrade) {
    check('降级：' + msg, mod.isSftpSubsystemUnavailableError(new Error(msg)) === true)
  }

  const keep = [
    '(SSH) Channel open failure: open failed',
    'Channel is not open',
    'Not connected',
    'Connection lost before handshake',
    'ECONNRESET',
    'Timed out while waiting',
    'Permission denied',
    'No such file',
  ]
  for (const msg of keep) {
    check('不降级：' + msg, mod.isSftpSubsystemUnavailableError(new Error(msg)) === false)
  }

  check(
    '包装成中文前缀后仍识别',
    mod.isSftpSubsystemUnavailableError(
      new Error('无法启动 SFTP 子系统：Unable to start subsystem: sftp')
    ) === true
  )
  check(
    '非 Error 输入不炸',
    mod.isSftpSubsystemUnavailableError(undefined) === false &&
      mod.isSftpSubsystemUnavailableError(null) === false &&
      mod.isSftpSubsystemUnavailableError({}) === false
  )
  check(
    '裸字符串输入可用',
    mod.isSftpSubsystemUnavailableError('sftp-server: not found') === true
  )
}

/* ------------------------------------------------------------------ */
/* 构建被测模块                                                        */
/* ------------------------------------------------------------------ */

/**
 * 单独打一个只导出判定函数的 bundle。
 *
 * 走 sftpManager 会牵进 ssh2 / iconv-lite 与整个传输引擎；这里把它们标记成
 * external，只求判定逻辑本身，不启动任何真实连接。
 */
async function buildFallbackClassifier() {
  const stub = path.join(OUT, 'electron-stub-shellfs.cjs')
  const bundle = path.join(OUT, 'sftp-fallback-bundle.cjs')
  const entry = "export { isSftpSubsystemUnavailableError } from './src/main/ssh/sftpManager'"

  await esbuild.build({
    stdin: {
      contents: entry,
      resolveDir: ROOT,
      loader: 'ts',
      sourcefile: 'sftp-fallback-entry.ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['ssh2', 'iconv-lite'],
    logLevel: 'error',
    alias: { '@shared': path.join(ROOT, 'src/shared') },
    plugins: [
      {
        name: 'stub-electron',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: stub }))
        }
      }
    ]
  })
  return require(bundle)
}

async function build() {
  const stub = path.join(OUT, 'electron-stub-shellfs.cjs')
  fs.writeFileSync(
    stub,
    [
      "const os = require('node:os')",
      'const TMP = os.tmpdir()',
      'exports.app = {',
      '  getPath: () => TMP,',
      '  getName: () => \'ssh-workbench\',',
      '  getVersion: () => \'0.0.0\',',
      '  isPackaged: false',
      '}',
      'exports.safeStorage = {',
      '  isEncryptionAvailable: () => false,',
      '  encryptString: (s) => Buffer.from(String(s), \'utf8\'),',
      '  decryptString: (b) => Buffer.from(b).toString(\'utf8\')',
      '}',
      ''
    ].join('\n')
  )

  const bundle = path.join(OUT, 'shellfs-bundle.cjs')
  const entry = [
    'export {',
    '  shQuote, parseLsOutput, assertSafeRemovePath, shellHome, shellList, shellListMany,',
    '  shellMkdir, shellRemove, shellRename, shellChmod, shellReadText, shellWriteText,',
    '  shellUploadFile, shellDownloadFile, shellWalkRemote',
    "} from './src/main/ssh/shellFs'"
  ].join('\n')

  await esbuild.build({
    stdin: { contents: entry, resolveDir: ROOT, loader: 'ts', sourcefile: 'shellfs-entry.ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['ssh2'],
    logLevel: 'error',
    alias: { '@shared': path.join(ROOT, 'src/shared') },
    plugins: [
      {
        name: 'stub-electron',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: stub }))
        }
      }
    ]
  })
  return require(bundle)
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  console.log('P0 Task 3 自检：shellFs（BusyBox/POSIX 纯 Shell 回退）')
  const mod = await build()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swb-shellfs-'))
  try {
    groupShQuote(mod)
    await groupSafeRemove(mod)
    groupParseLs(mod)
    await groupReadWrite(mod)
    await groupTransfers(mod, tmp)
    await groupListing(mod)
    await groupMetadata(mod)
    groupSftpFallback(await buildFallbackClassifier())
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch (e) {
      /* 清理失败不影响判定 */
    }
  }

  console.log('')
  if (failed > 0) {
    console.log('自检失败：' + failed + ' 项失败，' + passed + ' 项通过')
    process.exit(1)
  }
  console.log('自检全部通过（' + passed + ' 项）')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})