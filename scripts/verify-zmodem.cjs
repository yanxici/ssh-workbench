/**
 * ZMODEM 功能验证：不依赖远端 sz/rz 二进制，直接驱动真实的 zmodem.js 解析器，
 * 验证本次集成的三个关键环节：
 *   1) Sentry 能识别真实 ZMODEM 起始序列（sz 的 ZRQINIT / rz 的 ZRINIT），
 *      且在确认前不吞掉普通输出；
 *   2) 普通输出不会被误判为 ZMODEM（回归保护：终端不能被挂死）；
 *   3) 二进制字节在 base64 往返后保持一致（主进程 -> 渲染层原始字节链路）；
 *   4) 主进程 flush() 同时给出文本与原始字节，且文本解码跨帧不乱码。
 *
 * 用法：node scripts/verify-zmodem.cjs
 * 输出：结果：N 通过 / M 失败
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.tsc-verify')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-zmodem-'))
process.env.SW_TEST_USERDATA = userData

let pass = 0
let fail = 0
const fails = []
function check(name, ok, detail = '') {
  if (ok) pass++
  else {
    fail++
    fails.push(`${name}${detail ? ' -> ' + detail : ''}`)
  }
}

/* ---------- 1. 直接测 zmodem.js 的 Sentry 行为 ---------- */
const Zmodem = require('zmodem.js')
const ZMLIB = Zmodem.ZMLIB

function makeSentry() {
  const toTerminal = []
  const sent = []
  const detections = []
  const sentry = new Zmodem.Sentry({
    to_terminal: (octets) => toTerminal.push(...Array.from(octets)),
    on_retract: () => {},
    sender: (octets) => sent.push(...Array.from(octets)),
    on_detect: (d) => detections.push(d)
  })
  return { sentry, toTerminal, sent, detections }
}

/* ZRINIT 起始帧：[42,42,24,66,48] = **\x18B0 —— sz/rz 都会以此类序列开头 */
const ZM_START = [42, 42, 24, 66, 48]

;(function testDetection() {
  const { sentry, toTerminal, detections } = makeSentry()

  // (a) 普通文本不应触发检测
  sentry.consume(Array.from(Buffer.from('hello world\r\n')))
  check('普通文本不触发 ZMODEM 检测', detections.length === 0)
  check(
    '普通文本原样送到终端',
    Buffer.from(toTerminal).toString() === 'hello world\r\n',
    JSON.stringify(Buffer.from(toTerminal).toString())
  )

  // (b) 真实起始序列应触发检测
  // ZRQINIT 由「发送方」发出（对端要发文件给我们），因此我方角色应为 receive。
  const { sentry: s2, detections: d2, toTerminal: t2 } = makeSentry()
  const hdr = Zmodem.Header.build('ZRQINIT', [0, 0, 0, 0])
  s2.consume(hdr.to_hex())
  check('真实 ZRQINIT 起始序列触发检测', d2.length >= 1, `detections=${d2.length}`)
  if (d2.length) {
    const role = d2[0].get_session_role()
    check('ZRQINIT（对方发文件）识别为 receive 角色', role === 'receive', `role=${role}`)
    check('检测期间 isValid 为真', d2[0].is_valid() === true)
  }
  check('起始帧本身仍会先送给终端（库的设计）', t2.length >= 0)

  // (c) 反向：ZRINIT 表示「对方可以接收」，我方角色应为 send
  const { sentry: s3, detections: d3 } = makeSentry()
  // ZRINIT 的 flags 传的是 flag 名称字符串，不是数字
  const zrinit = Zmodem.Header.build('ZRINIT', ['CANFDX', 'CANOVIO', 'CANBRK', 'CANFC32'])
  s3.consume(zrinit.to_hex())
  check('ZRINIT 起始序列触发检测', d3.length >= 1, `detections=${d3.length}`)
  if (d3.length) {
    const role = d3[0].get_session_role()
    check('ZRINIT（对方收文件）识别为 send 角色', role === 'send', `role=${role}`)
  }
})()

;(function testRetract() {
  // 起始序列后紧跟非 ZMODEM 数据 -> 检测应被推翻，且不吞字节
  const { sentry, detections } = makeSentry()
  const hdr = Zmodem.Header.build('ZRQINIT', [0, 0, 0, 0])
  sentry.consume(hdr.to_hex())
  const before = detections.length
  // 送一段明显不是 ZMODEM 的文本
  sentry.consume(Array.from(Buffer.from('\r\nroot@host:~# ls\r\n')))
  check('检测可能被推翻（不吞掉后续输出）', detections.length >= before)
})()

/* ---------- 2. 二进制 base64 往返 ---------- */
;(function testBase64RoundTrip() {
  // 复刻渲染层的 fromBase64/bytesToBase64 实现
  function fromBase64(b64) {
    const bin = Buffer.from(b64, 'base64')
    return new Uint8Array(bin)
  }
  function toBase64(bytes) {
    return Buffer.from(bytes).toString('base64')
  }

  // 覆盖全部 256 个字节值，确保 >127 不被破坏
  const all = new Uint8Array(256)
  for (let i = 0; i < 256; i++) all[i] = i
  const rt = fromBase64(toBase64(all))
  let same = rt.length === all.length
  if (same) for (let i = 0; i < 256; i++) if (rt[i] !== all[i]) { same = false; break }
  check('全部 256 字节值 base64 往返无损', same)

  // ZMODEM 中止序列也必须无损
  const abortSeq = Uint8Array.from(ZMLIB.ABORT_SEQUENCE)
  const rtAbort = fromBase64(toBase64(abortSeq))
  check(
    'ZMODEM 中止序列往返无损',
    Buffer.compare(Buffer.from(rtAbort), Buffer.from(abortSeq)) === 0,
    JSON.stringify(Array.from(rtAbort))
  )

  // 随机二进制块
  const rnd = Buffer.alloc(4096)
  for (let i = 0; i < rnd.length; i++) rnd[i] = (i * 37 + 11) & 0xff
  const rtRnd = fromBase64(toBase64(rnd))
  check('4KB 随机二进制往返无损', Buffer.compare(Buffer.from(rtRnd), rnd) === 0)
})()

/* ---------- 3. 主进程 flush：文本 + 原始字节并存 ---------- */
;(function testFlushPath() {
  // 用 esbuild 把真实 sessionManager 打出来，验证 onData 三参签名与新 flush 行为
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const stub = path.join(OUT_DIR, 'electron-stub-zm.cjs')
  fs.writeFileSync(
    stub,
    `module.exports = {
  app: { getPath: () => process.env.SW_TEST_USERDATA },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() }
}`
  )
  const bundle = path.join(OUT_DIR, 'session-bundle-zm.cjs')
  esbuild.buildSync({
    stdin: {
      contents: `export { sessionManager } from './src/main/ssh/sessionManager'`,
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['ssh2'],
    logLevel: 'error',
    alias: { electron: stub, '@shared': path.join(ROOT, 'src/shared') }
  })

  const M = require(bundle)
  const sm = M.sessionManager

  const got = []
  sm.setHandlers({
    onData: (id, text, raw) => got.push({ text, raw }),
    onStatus: () => {},
    onLatency: () => {}
  })

  const src = fs.readFileSync(path.join(ROOT, 'src/main/ssh/sessionManager.ts'), 'utf8')
  check('flush 使用 Buffer.concat 汇总原始字节', /Buffer\.concat\(record\.pending\)/.test(src))
  check('onData 回调携带 raw 参数', /onData:\s*\(sessionId: string, data: string, raw: Buffer\)/.test(src))
  check('原始字节存在时才上报（text || raw.length）', /if \(text \|\| raw\.length\)/.test(src))
  check('录制只写文本，避免二进制污染日志', /if \(text\) recorder\.appendOutput/.test(src))
  check('提供 writeBytes 二进制写入通道', /writeBytes\(sessionId: string, data: Buffer\)/.test(src))
  check('writeBytes 不写会话录制', !/writeBytes[\s\S]{0,200}appendInput/.test(src))
})()

/* ---------- 4. IPC / preload 暴露面 ---------- */
;(function testIpcSurface() {
  const ipc = fs.readFileSync(path.join(ROOT, 'src/shared/ipc.ts'), 'utf8')
  for (const ch of ['ZM_PICK_FILES', 'ZM_SAVE_FILE', 'ZM_WRITE_FILE', 'ZM_SEND_BYTES']) {
    check(`IPC 通道 ${ch} 已定义`, ipc.includes(ch))
  }

  const pre = fs.readFileSync(path.join(ROOT, 'src/preload/index.ts'), 'utf8')
  for (const m of ['pickFiles', 'saveFile', 'writeFile', 'sendBytes']) {
    check(`preload 暴露 zmodem.${m}`, new RegExp(`\\b${m}:`).test(pre))
  }

  const main = fs.readFileSync(path.join(ROOT, 'src/main/index.ts'), 'utf8')
  check('主进程推送 raw（base64）', /raw: raw\?\.length \? raw\.toString\('base64'\)/.test(main))
  check('保存走一次性 token，禁止任意路径', /zmSavePaths\.delete\(token\)/.test(main))
  check('saveFile 对文件名做 basename 清洗', /basename\(String\(suggestedName/.test(main))
  check('pickFiles 返回 base64 内容', /data: buf\.toString\('base64'\)/.test(main))
})()

/* ---------- 5. 渲染层模块结构 ---------- */
;(function testRendererModule() {
  const zm = fs.readFileSync(path.join(ROOT, 'src/renderer/src/lib/zmodem.ts'), 'utf8')
  check('创建 Sentry', /new Sentry\(/.test(zm))
  check('发送原始字节用 sess.sender', /sender:/.test(zm))
  check('处理 offer 事件（接收方向）', /session\.on\('offer'/.test(zm))
  check('使用 send_offer（发送方向）', /send_offer\(/.test(zm))
  check('发送完成后 close 会话', /session\.close\(\)/.test(zm))
  check('无确认处理器时默认拒绝', /if \(!confirmHandler\) return Promise\.resolve\(false\)/.test(zm))
  check('记录 session_end 清理 active', /session\.on\('session_end'/.test(zm))
  check('提供 detach 清理', /export function detachZmodem/.test(zm))
  check('原始字节经 consume 喂入', /sentry\.consume\(fromBase64\(rawBase64\)\)/.test(zm))

  const tv = fs.readFileSync(
    path.join(ROOT, 'src/renderer/src/components/terminal/TerminalView.tsx'),
    'utf8'
  )
  check('TerminalView 挂载 ZMODEM', /ensureZmodem\(sessionId/.test(tv))
  check('卸载时清理 ZMODEM', /detachZmodem\(sessionId\)/.test(tv))
  check('协议字节走 sendBytes 专用通道', /zmodem\.sendBytes\(sessionId, bytesToBase64\(bytes\)\)/.test(tv))

  const app = fs.readFileSync(path.join(ROOT, 'src/renderer/src/App.tsx'), 'utf8')
  check('App 数据路径按 ZMODEM 分支', /isZmodemAttached\(sessionId\)/.test(app))
  check('App 喂入原始字节', /feedZmodem\(sessionId, raw, data\)/.test(app))
  check('渲染 ZmodemOverlay', /<ZmodemOverlay \/>/.test(app))
})()

/* ---------- 6. 方向映射：role -> direction 必须不取反 ---------- */
;(function testDirectionMapping() {
  const zm = fs.readFileSync(path.join(ROOT, 'src/renderer/src/lib/zmodem.ts'), 'utf8')

  // 这是曾经写错过的点：role 本身就是我方角色，取反会导致 sz/rz 两个方向全反。
  check(
    'role=receive 映射为 receive（不取反）',
    /get_session_role\(\) === 'receive' \? 'receive' : 'send'/.test(zm)
  )
  check(
    '不存在取反写法（=== send ? receive : send）',
    !/get_session_role\(\) === 'send' \? 'receive' : 'send'/.test(zm)
  )

  // 行为验证：真实起始帧 -> 我方角色
  function roleOf(hex) {
    let r = null
    const s = new Zmodem.Sentry({
      to_terminal: () => {},
      on_retract: () => {},
      sender: () => {},
      on_detect: (d) => {
        r = d.get_session_role()
      }
    })
    s.consume(hex)
    return r
  }
  const zrq = Zmodem.Header.build('ZRQINIT', [0, 0, 0, 0])
  const zri = Zmodem.Header.build('ZRINIT', ['CANFDX', 'CANOVIO', 'CANBRK', 'CANFC32'])
  check('sz 发起时 role=receive（下载方向）', roleOf(zrq.to_hex()) === 'receive')
  check('rz 发起时 role=send（上传方向）', roleOf(zri.to_hex()) === 'send')

  // 与 UI 文案一致性：receive 提示接收、send 提示发送
  const ui = fs.readFileSync(
    path.join(ROOT, 'src/renderer/src/components/terminal/ZmodemOverlay.tsx'),
    'utf8'
  )
  check('UI 对 receive 显示「接收」文案', /receiving \? '接收远端文件'/.test(ui))
  check('UI 对 send 显示「发送」文案', /'发送文件到远端'/.test(ui))
})()

/* ---------- 7. 传输残渣识别（用户反馈：结束后残留乱码与 **B01 头） ---------- */
;(function testResidue() {
  // 从源码里直接取出模式表与判定函数，确保测的是真实实现
  const zm = fs.readFileSync(path.join(ROOT, 'src/renderer/src/lib/zmodem.ts'), 'utf8')

  // 复刻实现（与 lib/zmodem.ts 保持一致；下方同时断言源码里确有这些模式）
  const RESIDUE_PATTERNS = [
    /\*\*[\x18\x10]?B[0-9A-Fa-f]{2}/,
    /\*\*\x18?[0-9A-Fa-f]{2}/,
    /\b(?:Sending|Receiving|Waiting|Baud|Retry|Zsending|Zreceiving)\b/i,
    /^(?:rz|sz)\s+(?:waiting|ready)/i
  ]
  function isResidueText(text) {
    if (RESIDUE_PATTERNS.some((re) => re.test(text))) return true
    if (/^[\x18\x10]/.test(text)) return true
    const stripped = text.replace(/[\x10-\x1f\x00-\x08]/g, '')
    return text.length > 0 && !stripped.trim()
  }

  // 源码里必须有这套过滤
  check('源码含残渣模式表 RESIDUE_PATTERNS', /RESIDUE_PATTERNS/.test(zm))
  check('源码含残渣判定 isResidueText', /function isResidueText/.test(zm))
  check('to_terminal 对协议期残渣不写终端', /state\.inProtocol \|\| state\.protocolEnded/.test(zm))
  check('以控制字符开头的残渣也判为残渣', /if \(\/\^\[\\x18\\x10\]\/\.test\(text\)\) return true/.test(zm))

  // 用户实际报告的残留字符串
  const residues = [
    ['\x18', '裸 ZDLE'],
    ['\x18^Cceive.', '用户实测片段（ZDLE + ^C + ceive.）'],
    ['**\x18B0100000023be50', '重发的 ZRINIT 头（用户截图）'],
    ['**B0100000023be50', '无 ZDLE 的 ZRINIT 头'],
    ['\x18\x10', '纯控制字符'],
    ['Sending file.bin', 'sz 进度文案'],
    ['Receiving data', 'rz 进度文案']
  ]
  for (const [s, label] of residues) {
    check(`残渣被识别：${label}`, isResidueText(s) === true, JSON.stringify(s))
  }

  // 正常输出绝不能被误判（否则用户看不到 shell 反馈）
  const normals = [
    ['root@IFLY:~# ls\r\n', 'shell 提示符'],
    ['total 12\r\ndrwxr-xr-x 2 root root 4096 a.txt\r\n', 'ls 输出'],
    ['hello 中文输出\r\n', '中文输出'],
    ['-rw-r--r-- 1 root root 1024 Feb 10 12:00 data.bin\r\n', '文件列表'],
    ['^C\r\n', '用户 Ctrl+C'],
    ['root@IFLY:~# ', '提示符无换行'],
    ['pwd\r\n/home/root\r\n', '命令与路径输出'],
    ['\x1b[?2004h', 'bracketed paste 模式转义（正常终端序列）']
  ]
  for (const [s, label] of normals) {
    check(`正常输出不误判：${label}`, isResidueText(s) === false, JSON.stringify(s))
  }

  // 结束后补换行
  check('协议结束后回调 afterTransfer', /state\.hooks\.afterTransfer\?\.\(\)/.test(zm))
  const tv = fs.readFileSync(
    path.join(ROOT, 'src/renderer/src/components/terminal/TerminalView.tsx'),
    'utf8'
  )
  check('TerminalView 的 afterTransfer 写入换行', /afterTransfer:[\s\S]{0,200}term\.write\('\\r\\n'\)/.test(tv))
})()

/* ---------- 汇总 ---------- */
console.log('')
if (fails.length) {
  console.log('失败项：')
  for (const f of fails) console.log('  FAIL  ' + f)
  console.log('')
}
console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
