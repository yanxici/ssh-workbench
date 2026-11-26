/**
 * trzsz 主进程桥接（v2.1.6）纯逻辑回归。
 *
 * 用 esbuild 把 src/main/ssh/trzszBridge.ts 打成 CJS 直接跑线上那份代码，
 * 'trzsz' 标成 external（它是运行时依赖，不往 bundle 里塞）。
 *
 * 断言判据统一按「旧实现必红」来选：
 *   - 若不抠百分比，状态条永远 0% → C2 红；
 *   - 若取第一个百分比而不是最后一个，C3 拿到 10 → 红；
 *   - 若不做 150ms 节流，连写两帧会有两次 emit → C4 红；
 *   - 若不认 command not found，notice 永远不出现 → C5 红；
 *   - 若上传不先发 Ctrl-C 再发 trz，远端不会进接收态 → D2 红；
 *   - 若「3 秒没起来」不映射成 no-remote-trz，用户看到的是英文原文 → D3 红。
 *
 * 用法：node scripts/verify-trzsz.cjs
 * 退出码 0 = 全部通过。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const SRC = path.join(__dirname, '../src/main/ssh/trzszBridge.ts')
const out = esbuild.buildSync({
  entryPoints: [SRC],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  write: false,
  logLevel: 'silent',
  external: ['trzsz']
})
const mod = { exports: {} }
new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require)
const B = mod.exports

let pass = 0
const fails = []
function ok(cond, label, extra) {
  if (cond) pass++
  else fails.push(label + (extra === undefined ? '' : '\n    ' + JSON.stringify(extra)))
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else fails.push(label + '\n    期望 ' + e + '\n    实际 ' + a)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------- 造一个可观测的 hooks ---------- */
function makeHooks(overrides = {}) {
  const log = { sent: [], text: [], states: [], records: [] }
  const hooks = {
    sendToServer: (d) => log.sent.push(d),
    emitText: (t) => log.text.push(t),
    emitState: (s) => log.states.push(s),
    pickSaveDirectory: async () => undefined,
    pickSendFiles: async () => undefined,
    // 真实 hooks 一定有它：少了它 beginRecord 会在状态翻转时抛错
    recordTransfer: (rec) => log.records.push(rec),
    ...overrides
  }
  return { hooks, log }
}

// 整段放进 async 里：C4 的节流断言与 D 段的真实上传必须真等一下
async function main() {
/* ================= A. 握手识别 ================= */
ok(B.looksLikeTrzsz('::TRZSZ:TRANSFER:S:1.1.6:1234'), 'A1 含握手串应判为真')
ok(B.looksLikeTrzsz('before\r\n::TRZSZ:TRANSFER:D:1.1.6\r\n'), 'A2 行中握手也应判为真')
ok(!B.looksLikeTrzsz('hello world\r\n'), 'A3 普通输出应判为假')
ok(!B.looksLikeTrzsz('::TRZSZ:TRANSFER'), 'A4 前缀不完整应判为假')
ok(!B.looksLikeTrzsz(''), 'A5 空串应判为假')

/* ================= B. 录制剔除 ================= */
eq(B.stripTrzszHandshake('::TRZSZ:TRANSFER:S:1.1.6:1234\r\n'), '', 'B1 单独一行握手应被整行剔除')
eq(
  B.stripTrzszHandshake('before\r\n::TRZSZ:TRANSFER:S:1.1.6:1234\r\nafter'),
  'before\r\nafter',
  'B2 只剔握手行，前后输出保留'
)
eq(
  B.stripTrzszHandshake('::TRZSZ:TRANSFER:R:1.1.6\r\n'),
  '',
  'B3 无 :id 的握手（rz 上传）也应剔除'
)
eq(B.stripTrzszHandshake('no handshake here'), 'no handshake here', 'B4 无握手时原样返回')
ok(
  B.stripTrzszHandshake('x::TRZSZ:TRANSFER:S:1.1.6:9\r\ny').includes('y'),
  'B5 剔除后不能把后续内容一起吃掉'
)

/* ================= C. 输出过滤 + 进度抠取 ================= */
{
  const { hooks } = makeHooks()
  const s = new B.TrzszSession(hooks, 100, () => {})
  eq(s.processServerOutput('hello\r\n'), 'hello\r\n', 'C1 非握手输出应原样回给终端（一个字节都不吞）')
  ok(!s.active, 'C1b 普通输出后不应处于传输态')
  s.dispose()
}

{
  const { hooks, log } = makeHooks()
  const s = new B.TrzszSession(hooks, 100, () => {})
  const bar = 'fw.bin [██░░] 66% | 1.2 MB | 1.0 MB/s | 0:02 ETA'
  const shown = s.processServerOutput(bar)
  eq(shown, bar, 'C2 进度条文本仍要写进终端（进度条是普通输出）')
  const last = log.states[log.states.length - 1]
  ok(last && last.percent === 66, 'C2b 应从进度条抠出 66%', last)
  ok(last && last.file === 'fw.bin', 'C2c 应从 [ 之前取文件名', last)
  s.dispose()
}

{
  const { hooks, log } = makeHooks()
  const s = new B.TrzszSession(hooks, 100, () => {})
  // 同一个串里出现两个百分比：只认最后一个（真正当前进度）
  s.processServerOutput('copy 10% then 90% done [███] 90%')
  const last = log.states[log.states.length - 1]
  ok(last && last.percent === 90, 'C3 多个百分比时应取最后一个', last)
  s.dispose()
}

{
  const { hooks, log } = makeHooks()
  const s = new B.TrzszSession(hooks, 100, () => {})
  const before = log.states.length
  s.processServerOutput('a.bin [█] 10% | 1 MB')
  s.processServerOutput('a.bin [██] 20% | 1 MB')
  ok(
    log.states.length - before <= 1,
    'C4 150ms 内连写两帧只应发一次状态（否则状态条每秒被刷几十次）',
    log.states.length - before
  )
  await sleep(170)
  s.processServerOutput('a.bin [███] 30% | 1 MB')
  eq(log.states[log.states.length - 1].percent, 30, 'C4b 过了节流窗口应立刻更新')
  s.dispose()
}

{
  const { hooks, log } = makeHooks()
  const s = new B.TrzszSession(hooks, 100, () => {})
  s.processServerOutput('bash: trz: command not found\r\n')
  const last = log.states[log.states.length - 1]
  ok(last && last.notice === 'no-remote-trz', 'C5 认 command not found 并标 notice', last)
  s.dispose()
}

{
  const { hooks, log } = makeHooks()
  const s = new B.TrzszSession(hooks, 100, () => {})
  s.processServerOutput('tsz: command not found\r\n')
  ok(
    log.states[log.states.length - 1]?.notice === 'no-remote-trz',
    'C6 tsz（下载端）没装也要认出来'
  )
  s.dispose()
}

{
  const { hooks, log } = makeHooks()
  const s = new B.TrzszSession(hooks, 100, () => {})
  // sudo 前缀形态：远端用 "sudo: trz: command not found" 报，前面还有别的词
  s.processServerOutput('sudo: trz: command not found\n')
  ok(
    log.states[log.states.length - 1]?.notice === 'no-remote-trz',
    'C7 带 sudo 前缀的 not found 也要认出来'
  )
  s.dispose()
}

/* ================= D. 输入直通 / 主动上传 ================= */
{
  const { hooks, log } = makeHooks()
  const s = new B.TrzszSession(hooks, 100, () => {})
  s.processInput('l')
  s.processInput('s')
  eq(log.sent, ['l', 's'], 'D1 非传输态输入应逐帧直通远端')
  s.dispose()
}

{
  // 真实库里上传会先发 \u0003 打断当前命令，再发 trz / trz -d
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trzsz-verify-'))
  const file = path.join(dir, 'a.txt')
  fs.writeFileSync(file, 'hello')
  const { hooks, log } = makeHooks()
  const s = new B.TrzszSession(hooks, 100, () => {})
  let error = null
  const started = Date.now()
  try {
    await s.upload([file])
  } catch (e) {
    error = e
  }
  const elapsed = Date.now() - started
  eq(log.sent[0], '\u0003', 'D2 上传第一帧必须是 Ctrl-C（先把远端命令行清出来）')
  eq(log.sent[1], 'trz\r', 'D2b 第二帧必须是 trz 命令')
  ok(error instanceof Error, 'D3 远端没进入接收态时上传必须失败而不是静默等待', error && String(error))
  ok(
    error && /没装 trzsz/.test(error.message),
    'D3b "Upload does not start" 要翻译成「没装 trzsz」而不是抛英文原文',
    error && error.message
  )
  ok(
    log.states.some((st) => st.notice === 'no-remote-trz'),
    'D3c 同时要发一条 no-remote-trz 状态给界面'
  )
  ok(elapsed >= 2500 && elapsed <= 6000, 'D3d 判据依赖 trzsz 的 3 秒 dragInitTimeout', elapsed)
  s.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
}

{
  // paths 为空 → 走 pickSendFiles；用户取消 → 什么都不做
  let asked = 0
  const { hooks, log } = makeHooks({
    pickSendFiles: async (dir) => {
      asked++
      ok(dir === false, 'D4a 上传文件时应以 directory=false 询问')
      return undefined
    }
  })
  const s = new B.TrzszSession(hooks, 100, () => {})
  await s.upload([])
  eq(asked, 1, 'D4 未给路径时应弹一次文件选择框')
  eq(log.sent, [], 'D4b 用户取消后不应向远端发任何东西')
  s.dispose()
}

{
  const { hooks } = makeHooks()
  const s = new B.TrzszSession(hooks, 100, () => {})
  let threw = null
  try {
    await s.upload([])
  } catch (e) {
    threw = e
  }
  ok(threw === null, 'D5 用户取消上传不该抛错给调用方', threw && String(threw))
  s.dispose()
}

/* ================= E. 列宽 / 取消 / 管理器 ================= */
{
  const { hooks } = makeHooks()
  const s = new B.TrzszSession(hooks, 100, () => {})
  let threw = null
  try {
    s.setColumns(120)
    s.setColumns(0)
    s.setColumns(NaN)
    s.cancel()
  } catch (e) {
    threw = e
  }
  ok(threw === null, 'E1 setColumns/cancel 在非传输态不该抛错', threw && String(threw))
  s.dispose()
}

{
  const { hooks } = makeHooks()
  let idles = 0
  const s = new B.TrzszSession(hooks, 100, () => {
    idles++
  })
  s.dispose()
  s.dispose()
  eq(idles, 0, 'E2 dispose 幂等，且不该触发 idle 回收')
}

{
  B.trzszManager.reset()
  const { hooks } = makeHooks()
  const a = B.trzszManager.ensure('s1', hooks, 100)
  const b = B.trzszManager.ensure('s1', hooks, 100)
  ok(a === b, 'E3 同一会话 ensure 两次应复用同一个过滤器（否则握手会被处理两遍）')
  eq(B.trzszManager.size(), 1, 'E3b 管理器里应只有一个实例')
  B.trzszManager.drop('s1')
  eq(B.trzszManager.size(), 0, 'E4 drop 后实例应被移除')
  ok(B.trzszManager.get('s1') === undefined, 'E4b drop 之后再取应为 undefined')
  B.trzszManager.reset()
}

{
  // dispose 之后仍要能直通，不能把终端卡死
  const { hooks, log } = makeHooks()
  const s = new B.TrzszSession(hooks, 100, () => {})
  s.dispose()
  eq(s.processServerOutput('after dispose'), 'after dispose', 'E5 dispose 后输出仍原样返回')
  s.processInput('x')
  eq(log.sent, ['x'], 'E5b dispose 后输入仍直通远端')
}

/* ================= F. 跨帧握手重组 / 传输后握手不重放（R2-C2） ================= */
{
  /*
   * 13 位 ID（算上前导冒号正好 14 位）以 "00" 结尾：库里 uniqueIdExists() 对非
   * Windows shell 的这类 id 恒返回 false —— 同一串握手喂几次就算几次全新握手，
   * 于是「旧握手残留在尾巴里」的 bug 表现成每按一个键弹一次原生文件框。
   */
  // 上传侧必须真给一个文件：用户取消时库里会立刻拆掉 transfer，量不到 active 翻转
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trzsz-frame-'))
  const file = path.join(dir, 'a.txt')
  fs.writeFileSync(file, 'hello')
  const { hooks } = makeHooks({ pickSendFiles: async () => [file] })
  const s = new B.TrzszSession(hooks, 100, () => {})
  let tail = ''
  const shown = []
  // 复刻 sessionManager.flush() 的接线（trzszFor 滚动尾巴 + 重组 + 去重显示）
  const feed = (text) => {
    if (s.active && text) {
      tail = ''
      const o = s.processServerBytes(Buffer.from(text))
      if (o) shown.push(o)
      return
    }
    const re = B.reassembleTrzszHandshake(tail, text)
    tail = B.keepTrzszTail(tail, text)
    if (re.rest !== undefined) tail = B.keepTrzszTail('', re.rest)
    const out = s.processServerOutput(re.feed)
    shown.push(re.shownSkip > 0 ? out.slice(re.shownSkip) : out)
  }
  // 握手被 TCP 自适应 flush 切成两帧是常态
  feed('::TRZSZ:TRAN')
  feed('SFER:R:1.1.6:1234567890100\r\n')
  eq(
    shown.join(''),
    '::TRZSZ:TRAN' + 'SFER:R:1.1.6:1234567890100\r\n',
    'F1 跨帧握手重组后逐字符只显示一次（前缀不能双倍回显）'
  )
  ok(!s.active, 'F2 握手帧内还不算传输态（库里要等 10ms 定时器才翻转）')
  let turned = false
  for (let i = 0; i < 60 && !turned; i++) {
    await sleep(5)
    turned = s.active
  }
  ok(turned, 'F2b 定时器跑起来后 active 必须转真（否则第 2 帧二进制块会走文本路）', { turned, picked: 'file' })
  s.dispose()
  fs.rmSync(dir, { recursive: true, force: true })
}

{
  // 完整握手已留在上一帧尾巴里：本帧不能再把它拼回去重喂过滤器
  const stale = '::TRZSZ:TRANSFER:R:1.1.6:1234567890100\r\n'
  const re = B.reassembleTrzszHandshake(stale, 'l')
  eq(re.feed, 'l', 'F3 已解释过的旧握手不能被重新喂给过滤器（否则按键=重放握手）')
  eq(re.shownSkip, 0, 'F3b 没补回前缀就不该剔掉本帧字符')
  eq(re.rest, 'l', 'F3c 命中后尾巴要截到握手之后（握手整行含换行已被吃掉）')
}

{
  let dialogs = 0
  const { hooks } = makeHooks({
    pickSendFiles: async () => {
      dialogs++
      return undefined
    },
    pickSaveDirectory: async () => {
      dialogs++
      return undefined
    }
  })
  const s = new B.TrzszSession(hooks, 100, () => {})
  let tail = '::TRZSZ:TRANSFER:R:1.1.6:1234567890100\r\n'
  const emitted = []
  for (const key of ['l', 's', 'l']) {
    const re = B.reassembleTrzszHandshake(tail, key)
    tail = B.keepTrzszTail(tail, key)
    if (re.rest !== undefined) tail = B.keepTrzszTail('', re.rest)
    const out = s.processServerOutput(re.feed)
    emitted.push(re.shownSkip > 0 ? out.slice(re.shownSkip) : out)
    await sleep(30)
  }
  eq(dialogs, 0, 'F4 传输结束后敲 l/s 不能再弹传输对话框')
  eq(emitted, ['l', 's', 'l'], 'F4b 每次按键只显示自己，不回放旧握手')
  s.dispose()
}

console.log(
  fails.length === 0
    ? 'trzsz 桥接回归：全部 ' + pass + ' 条通过'
    : 'trzsz 桥接回归：' + pass + ' 通过 / ' + fails.length + ' 失败\n  - ' + fails.join('\n  - ')
)
process.exit(fails.length === 0 ? 0 : 1)
}

void main()
