/**
 * 串口链路自检：不依赖任何物理串口 / 虚拟串口驱动。
 *
 * 为什么能不用硬件：会话管理器把「怎么打开一个串口」收敛成了
 * Transport 接口（src/main/transport/types.ts），本脚本注入内存实现
 * （MemoryTransport）与假端口枚举器，驱动的是主进程真实的
 * sessionManager / repository 代码路径 —— 打开、合帧、写入换行、
 * 拔线、等设备插回、自动恢复、关闭清理，全都在真实代码上跑。
 *
 * 真实 SerialTransport 的字节级行为（编码、换行替换、DTR 脉冲）
 * 由本脚本后半段的纯函数断言覆盖，不需要打开设备。
 *
 * 覆盖：
 *   1. 串口连接能打开，target 显示名是「COM3 · 115200 8N1」
 *   2. 收数据走 8ms 合帧，原始字节与文本都到达上层
 *   3. 写入保留原始字符串（换行替换在传输层，不在会话层）
 *   4. 串口不支持 openShell（多终端）
 *   5. requireSshClient 对串口会话给出可读错误，而不是返回 undefined
 *   6. 拔线 → 进入 waiting-device，不进入 SSH 退避重连
 *   7. 设备插回（同 serialNumber 换了 COM 号）→ 自动恢复到新端口
 *   8. 恢复后自动发一个硬回车唤醒设备
 *   9. 用户关掉挂起的标签后，插回不会再拉起它
 *  10. 端口不存在时明确报错并置 pathPending
 *  11. 多个端口匹配同一台设备 → 报 ambiguous 而不是随便挑
 *  12. applyNewline 的 CR/LF/CRLF 替换（含先并 CRLF）
 *  13. SerialTransport 的 GBK 流式解码不切坏汉字
 *  14. DTR 只在 autoReset 时脉冲
 *  15. resolveSerialPath 三级退化顺序
 *
 * 用法：node scripts/verify-serial.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.tsc-verify')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-serial-'))
process.env.SW_TEST_USERDATA = userData

/* ---------- 打包被测代码（electron 用桩替换） ---------- */
fs.mkdirSync(OUT_DIR, { recursive: true })
const stub = path.join(OUT_DIR, 'electron-stub.cjs')
fs.writeFileSync(
  stub,
  `module.exports = {
  app: {
    getPath: () => process.env.SW_TEST_USERDATA,
    getVersion: () => '0.0.0-test',
    getName: () => 'ssh-workbench-test',
    isPackaged: false
  },
  safeStorage: { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() }
}`
)
const bundle = path.join(OUT_DIR, 'serial-bundle.cjs')
esbuild.buildSync({
  stdin: {
    contents: `
      export { sessionManager } from './src/main/ssh/sessionManager'
      export { MemoryTransport } from './src/main/transport/memoryTransport'
      export { applyNewline, normalizeInboundNewlines, SerialTransport } from './src/main/transport/serialTransport'
      export {
        SERIAL_MAX_CHAR_DELAY_MS,
        SERIAL_MAX_LINE_DELAY_MS,
        normalizeCharDelayMs,
        normalizeLineDelayMs,
        isSerialPacingOff,
        describeSerialPacing
      } from './src/shared/serialTiming'
      export { resolveSerialPath, hasStableIdentity, applyPortIdentity } from './src/main/transport/serialResolve'
      export { portsFingerprint } from './src/main/transport/serialPorts'
      export * from './src/main/store/repository'
      export { updateSettings } from './src/main/app/settingsService'
    `,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle,
  external: ['ssh2'],
  logLevel: 'error',
  alias: {
    electron: stub,
    '@shared': path.join(ROOT, 'src/shared')
  }
})
const M = require(bundle)
const sm = M.sessionManager

/* ---------- 测试框架 ---------- */
let pass = 0
let fail = 0
const fails = []
function check(name, ok, detail = '') {
  if (ok) pass++
  else {
    fail++
    fails.push(`${name}${detail ? ' — ' + detail : ''}`)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(fn, ms = 5000, describe) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await sleep(10)
  }
  const ok = fn()
  if (!ok && describe) {
    let snapshot
    try {
      snapshot = describe()
    } catch (e) {
      snapshot = `<采集失败: ${e && e.message}>`
    }
    console.log(`      [waitFor 超时 ${ms}ms] 实际: ${snapshot}`)
  }
  return ok
}
const uid = () => Math.random().toString(36).slice(2)

/* ---------- 事件采集 ---------- */
const status = new Map()
const output = new Map()
const rawBytes = new Map()
const reconnectLog = []
sm.setHandlers({
  onData: (id, d, raw) => {
    output.set(id, (output.get(id) ?? '') + d)
    if (raw) rawBytes.set(id, (rawBytes.get(id) ?? '') + raw.toString('hex'))
  },
  onStatus: (id, s) => status.set(id, s),
  onLatency: () => {}
})
sm.setReconnectHandler((e) => reconnectLog.push(e))

/* ---------- 假端口枚举器：可编程的「插拔」 ---------- */
let fakePorts = []
sm.setSerialPortLister(async () => fakePorts)

/* ---------- 假传输层工厂：记录每一次 open ---------- */
const opened = []
sm.setSerialTransportFactory((cfg, events) => {
  const t = new M.MemoryTransport({ kind: 'serial' }, events)
  opened.push({ cfg: { ...cfg }, transport: t })
  return t
})

/** 当前最新的假传输层（用于模拟对端发数据 / 拔线） */
function latest() {
  return opened[opened.length - 1]
}

async function main() {
  await M.updateSettings({ latencyProbe: false, autoLog: false, autoReconnect: true })

  const CH340 = {
    path: 'COM3',
    manufacturer: 'wch.cn',
    serialNumber: 'CH340-0001',
    pnpId: 'USB\\VID_1A86&PID_7523\\5&1A2B3C4D&0&1'
  }
  fakePorts = [CH340]

  const conn = await M.saveConnection({
    name: '设备控制台',
    kind: 'serial',
    host: '',
    port: 0,
    username: '',
    authType: 'password',
    group: '默认',
    tags: [],
    serial: {
      path: 'COM3',
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      charset: 'utf-8',
      newline: 'cr',
      autoReset: false,
      usbSerialNumber: 'CH340-0001',
      usbPnpId: 'USB\\VID_1A86&PID_7523\\5&1A2B3C4D&0&1'
    }
  })
  check('串口连接已保存 kind=serial', conn.kind === 'serial', `kind=${conn.kind}`)
  check('串口连接 host 落成空串', conn.host === '' && conn.port === 0, `host=${conn.host} port=${conn.port}`)
  check('串口参数已落盘', conn.serial && conn.serial.baudRate === 115200, JSON.stringify(conn.serial))

  /* 1. 打开 */
  const A = uid()
  await sm.open(A, conn.id, 80, 24)
  check('A 已连接', status.get(A) === 'connected', `status=${status.get(A)}`)
  const info = sm.list().find((s) => s.id === A)
  check('kind 为 serial', info && info.kind === 'serial', `kind=${info && info.kind}`)
  check(
    'target 是「端口 · 波特率 数据位校验停止位」',
    info && info.target === 'COM3 · 115200 8N1',
    `target=${info && info.target}`
  )
  check('传输层被创建并 open', opened.length === 1 && latest().cfg.path === 'COM3')

  /* 2. 收数据（合帧） */
  const t = latest().transport
  t.emitData(Buffer.from('boot: ok\r\n'), 'boot: ok\r\n')
  check(
    '上层收到串口输出',
    await waitFor(() => /boot: ok/.test(output.get(A) ?? ''), 2000, () => JSON.stringify(output.get(A))),
  )
  check('原始字节也到达上层（ZMODEM 用）', /626f6f743a206f6b/.test(rawBytes.get(A) ?? ''), rawBytes.get(A) || '<空>')

  /* 3. 写入 */
  sm.write(A, 'help\n')
  check('写入原样落到传输层', latest().transport.written.includes('help\n'), JSON.stringify(latest().transport.written))
  sm.writeBytes(A, Buffer.from([0x01, 0x03]))
  check('writeBytes 落到传输层', latest().transport.writtenBytes.length === 1)

  /* 4. 不支持多终端 */
  let shellErr = ''
  try {
    await sm.openShell(uid(), conn.id, A, 80, 24)
  } catch (e) {
    shellErr = e.message
  }
  check('串口拒绝新建终端', /串口会话不支持多终端/.test(shellErr), shellErr)

  /* 5. requireSshClient 可读错误 */
  let sshErr = ''
  try {
    sm.requireSshClient(A)
  } catch (e) {
    sshErr = e.message
  }
  check('requireSshClient 对串口给可读错误', /仅支持 SSH 会话/.test(sshErr), sshErr)

  /* 6. 拔线 → waiting-device */
  reconnectLog.length = 0
  latest().transport.emitClose(new Error('device unplugged'))
  check(
    '拔线后进入 waiting-device',
    await waitFor(() => reconnectLog.some((e) => e.phase === 'waiting-device'), 3000, () =>
      JSON.stringify(reconnectLog)
    )
  )
  check('挂起状态可查询', sm.isWaitingDevice(A) === true)
  check('挂起期间没有走 SSH 退避重连', !reconnectLog.some((e) => e.phase === 'scheduled'), JSON.stringify(reconnectLog))
  check('会话已从列表移除', !sm.list().some((s) => s.id === A))

  /* 7. 插回：同 serialNumber 换了 COM 号 */
  fakePorts = [{ ...CH340, path: 'COM7' }]
  const beforeOpen = opened.length
  await sm.resumeSerialSessions()
  check('插回后重新打开了一次', opened.length === beforeOpen + 1, `opens=${opened.length}`)
  check('恢复时用的是新端口 COM7', latest().cfg.path === 'COM7', `path=${latest().cfg.path}`)
  check('恢复到 connected', status.get(A) === 'connected', `status=${status.get(A)}`)
  check('发出 restored 事件', reconnectLog.some((e) => e.phase === 'restored'), JSON.stringify(reconnectLog.map((e) => e.phase)))
  check('恢复后不再挂起', sm.isWaitingDevice(A) === false)

  /* 8. 恢复后发硬回车 */
  check(
    '恢复后自动发硬回车唤醒',
    latest().transport.written.includes('\r'),
    JSON.stringify(latest().transport.written)
  )

  /* 9. 关掉挂起的标签后，插回不拉起 */
  const B = uid()
  await sm.open(B, conn.id, 80, 24)
  latest().transport.emitClose(new Error('unplugged again'))
  await waitFor(() => sm.isWaitingDevice(B), 3000)
  check('B 已挂起', sm.isWaitingDevice(B))
  sm.close(B)
  const beforeB = opened.length
  await sm.resumeSerialSessions()
  check('关掉的挂起会话不会被插回拉起', opened.length === beforeB, `opens=${opened.length - beforeB}`)
  check('B 的挂起项已清除', sm.isWaitingDevice(B) === false)

  /* 10. 端口不存在 */
  fakePorts = []
  let notFound = ''
  const C = uid()
  try {
    await sm.open(C, conn.id, 80, 24)
  } catch (e) {
    notFound = e.message
  }
  check('端口不存在时报可读错误', /当前不存在/.test(notFound), notFound)
  check('报错时提示重新选择端口', /重新选择端口/.test(notFound), notFound)
  const savedAfter = (await M.listConnections()).find((c) => c.id === conn.id)
  check('端口丢失后置 pathPending', savedAfter.serial.pathPending !== false, JSON.stringify(savedAfter.serial))

  /* 11. 多端口匹配同一台设备 → ambiguous */
  fakePorts = [
    { ...CH340, path: 'COM4' },
    { ...CH340, path: 'COM5' }
  ]
  let ambiguous = ''
  try {
    await sm.open(uid(), conn.id, 80, 24)
  } catch (e) {
    ambiguous = e.message
  }
  check('多端口匹配时报 ambiguous', /2 个串口匹配同一台设备/.test(ambiguous), ambiguous)
  check('ambiguous 时列出候选端口', /COM4/.test(ambiguous) && /COM5/.test(ambiguous), ambiguous)

  /* 12. applyNewline */
  check('CR 模式把 LF 换成 CR', M.applyNewline('a\nb', 'cr') === 'a\rb', JSON.stringify(M.applyNewline('a\nb', 'cr')))
  check('LF 模式把 CR 换成 LF', M.applyNewline('a\rb', 'lf') === 'a\nb')
  check('CRLF 模式把裸 CR 换成 CRLF', M.applyNewline('a\rb', 'crlf') === 'a\r\nb', JSON.stringify(M.applyNewline('a\rb', 'crlf')))
  check(
    'CRLF 模式不会把已有 CRLF 变成 CRCRLF',
    M.applyNewline('a\r\nb', 'crlf') === 'a\r\nb',
    JSON.stringify(M.applyNewline('a\r\nb', 'crlf'))
  )

  /* 12b. normalizeInboundNewlines：设备只发 LF 时补 CR */
  const inb = M.normalizeInboundNewlines
  check(
    '裸 LF 补成 CRLF',
    inb('a\nb', false).text === 'a\r\nb',
    JSON.stringify(inb('a\nb', false).text)
  )
  check(
    '已是 CRLF 时不重复补 CR',
    inb('a\r\nb', false).text === 'a\r\nb',
    JSON.stringify(inb('a\r\nb', false).text)
  )
  check(
    '跨帧 CR|LF 不被拆成 CRCRLF',
    inb('a\r', false).lastWasCR === true &&
      inb('\nb', true).text === '\nb' &&
      inb('\nb', true).lastWasCR === false,
    JSON.stringify([inb('a\r', false), inb('\nb', true)])
  )
  check(
    '一帧内 CR 开头接 LF 也不补',
    inb('\r\nx', true).text === '\r\nx',
    JSON.stringify(inb('\r\nx', true).text)
  )
  check(
    '末尾残留 CR 会传给下一帧',
    inb('x\r', false).text === 'x\r' && inb('x\r', false).lastWasCR === true,
    JSON.stringify(inb('x\r', false))
  )
  check(
    '没有换行时原样返回',
    inb('hello', false).text === 'hello' && inb('hello', true).text === 'hello',
    JSON.stringify([inb('hello', false), inb('hello', true)])
  )
  check(
    '没有换行但末尾是 CR 时仍记录状态',
    inb('hello\r', false).lastWasCR === true,
    JSON.stringify(inb('hello\r', false))
  )
  check(
    '连续多个裸 LF 各自补 CR',
    inb('a\n\nb', false).text === 'a\r\n\r\nb',
    JSON.stringify(inb('a\n\nb', false).text)
  )

  /* 13. GBK 流式解码不切坏汉字 */
  const iconv = require('iconv-lite')
  const bytes = iconv.encode('中文测试', 'gbk')

  /**
   * 造一个假端口。serialport 的 SerialPort 是 EventEmitter 形状，
   * 这里只需要它被 SerialTransport 用到的那些成员。
   */
  function makeFakePort({ dtrCalls = null } = {}) {
    const port = {
      isOpen: false,
      open: (cb) => {
        port.isOpen = true
        cb && cb(null)
      },
      write: () => true,
      close: (cb) => {
        port.isOpen = false
        cb && cb(null)
      },
      drain: () => {},
      on: () => {},
      set: (opts, cb) => {
        if (dtrCalls) dtrCalls.push(opts)
        cb && cb(null)
      }
    }
    return port
  }

  const gbkPort = makeFakePort()
  const stGbk = new M.SerialTransport(
    {
      config: {
        path: 'COM9',
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        charset: 'gbk',
        newline: 'cr'
      },
      portFactory: () => gbkPort
    },
    { onData: () => {}, onClose: () => {} }
  )
  await stGbk.open({ cols: 80, rows: 24 })
  // 从第 3 字节切断：'中' 是 2 字节，'文' 的 2 字节会被劈成两半
  const decoded = stGbk['decode'](bytes.subarray(0, 3)) + stGbk['decode'](bytes.subarray(3))
  check('GBK 分片解码不切坏汉字', decoded === '中文测试', JSON.stringify(decoded))

  /* 14. DTR 只在 autoReset 时脉冲 */
  const noResetCalls = []
  const stNoReset = new M.SerialTransport(
    {
      config: {
        path: 'COM10',
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        charset: 'utf-8',
        newline: 'cr',
        autoReset: false
      },
      portFactory: () => makeFakePort({ dtrCalls: noResetCalls })
    },
    { onData: () => {}, onClose: () => {} }
  )
  await stNoReset.open({ cols: 80, rows: 24 })
  check('autoReset=false 时不碰 DTR', noResetCalls.length === 0, JSON.stringify(noResetCalls))

  const resetCalls = []
  const stReset = new M.SerialTransport(
    {
      config: {
        path: 'COM11',
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        charset: 'utf-8',
        newline: 'cr',
        autoReset: true
      },
      portFactory: () => makeFakePort({ dtrCalls: resetCalls })
    },
    { onData: () => {}, onClose: () => {} }
  )
  await stReset.open({ cols: 80, rows: 24 })
  check('autoReset=true 时脉冲 DTR', resetCalls.length >= 2, JSON.stringify(resetCalls))
  check(
    'DTR 脉冲先拉低再释放',
    resetCalls[0] && resetCalls[0].dtr === false && resetCalls[resetCalls.length - 1].dtr === true,
    JSON.stringify(resetCalls)
  )
  check('DTR 脉冲不碰 RTS', resetCalls.every((o) => o.rts === undefined), JSON.stringify(resetCalls))

  /* 14b. 写入真的走 applyNewline 且落到端口 */
  const written = []
  const writePort = makeFakePort()
  writePort.write = (d) => {
    written.push(Buffer.isBuffer(d) ? d.toString('hex') : d)
    return true
  }
  const stWrite = new M.SerialTransport(
    {
      config: {
        path: 'COM12',
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        charset: 'utf-8',
        newline: 'crlf'
      },
      portFactory: () => writePort
    },
    { onData: () => {}, onClose: () => {} }
  )
  await stWrite.open({ cols: 80, rows: 24 })
  stWrite.write('ls\n')
  stWrite.writeBytes(Buffer.from([0x02, 0x10]))
  check('write 按配置换行后落端口', written[0] === 'ls\r\n', JSON.stringify(written))
  check('writeBytes 原样落端口（不经换行替换）', written[1] === '0210', JSON.stringify(written))

  /* 14b-2. 入站：只发 LF 的设备在 Transport 层就被补成 CRLF，raw 不动 */
  function makeEmittingPort() {
    const handlers = {}
    const port = {
      isOpen: false,
      open: (cb) => {
        port.isOpen = true
        cb && cb(null)
      },
      write: () => true,
      close: (cb) => {
        port.isOpen = false
        cb && cb(null)
      },
      drain: () => {},
      on: (ev, fn) => {
        handlers[ev] = fn
      },
      set: (_opts, cb) => cb && cb(null),
      emitData: (buf) => handlers.data && handlers.data(buf)
    }
    return port
  }
  const inboundSeen = []
  const emitPort = makeEmittingPort()
  const stInbound = new M.SerialTransport(
    {
      config: {
        path: 'COM14',
        baudRate: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
        charset: 'utf-8',
        newline: 'cr'
      },
      portFactory: () => emitPort
    },
    { onData: (raw, text) => inboundSeen.push({ raw: raw.toString('hex'), text }), onClose: () => {} }
  )
  await stInbound.open({ cols: 80, rows: 24 })
  emitPort.emitData(Buffer.from('root@IFLY:~# ls\n', 'utf-8'))
  check(
    '入站裸 LF 被补成 CRLF',
    inboundSeen.length === 1 && inboundSeen[0].text === 'root@IFLY:~# ls\r\n',
    JSON.stringify(inboundSeen)
  )
  check(
    '入站 raw 原样透传（ZMODEM 判帧靠它）',
    inboundSeen[0] && inboundSeen[0].raw === Buffer.from('root@IFLY:~# ls\n', 'utf-8').toString('hex'),
    inboundSeen[0] && inboundSeen[0].raw
  )
  // 分两帧发出一个 CRLF：第一帧以 CR 结尾、第二帧以 LF 开头
  inboundSeen.length = 0
  emitPort.emitData(Buffer.from('a\r', 'utf-8'))
  emitPort.emitData(Buffer.from('\nb\n', 'utf-8'))
  check(
    '跨帧 CRLF 只补裸 LF 那一处',
    inboundSeen.map((s) => s.text).join('') === 'a\r\nb\r\n',
    JSON.stringify(inboundSeen.map((s) => s.text))
  )

  /* 14c. 发送节奏：逐字符 / 行间延迟 */
  function pacingCfg(extra) {
    return {
      path: 'COM13',
      baudRate: 115200,
      dataBits: 8,
      stopBits: 1,
      parity: 'none',
      flowControl: 'none',
      charset: 'utf-8',
      newline: 'crlf',
      ...extra
    }
  }
  function makeRecorderPort() {
    const port = makeFakePort()
    const chunks = []
    port.write = (d) => {
      chunks.push(Buffer.isBuffer(d) ? d.toString('hex') : d)
      return true
    }
    return { port, chunks }
  }
  async function openPaced(extra) {
    const rec = makeRecorderPort()
    const st = new M.SerialTransport(
      { config: pacingCfg(extra), portFactory: () => rec.port },
      { onData: () => {}, onClose: () => {} }
    )
    await st.open({ cols: 80, rows: 24 })
    return { st, chunks: rec.chunks }
  }

  // 两个延迟都是 0：必须还走原来的整段直发快路径（一次 write，不被拆散）
  {
    const { st, chunks } = await openPaced({ charDelayMs: 0, lineDelayMs: 0 })
    st.write('ls -l\r\n')
    check('无节奏配置时整段一次写出', chunks.length === 1 && chunks[0] === 'ls -l\r\n', JSON.stringify(chunks))
    st.close()
  }

  // 逐字符延迟：每个字符单独落端口，拼起来与原始内容一致（保序、不丢字）
  {
    const { st, chunks } = await openPaced({ charDelayMs: 5 })
    const t0 = Date.now()
    st.write('abc')
    // write 必须立即返回：节流不能把主进程的键盘输入卡住
    const returnedEarly = chunks.length <= 1
    const done = await waitFor(() => chunks.join('') === 'abc', 2000)
    const elapsed = Date.now() - t0
    check('逐字符延迟：全部字符最终送达', done, JSON.stringify(chunks))
    check('逐字符延迟：一次只落一个字符', chunks.every((c) => c.length === 1), JSON.stringify(chunks))
    check('逐字符延迟：write 立即返回不阻塞', returnedEarly, JSON.stringify(chunks))
    check('逐字符延迟：字符之间真的停了', elapsed >= 8, String(elapsed))
    st.close()
  }

  // 汉字按码点切，不能把一个字符劈成两个残字节
  {
    const { st, chunks } = await openPaced({ charDelayMs: 2 })
    st.write('中a')
    const done = await waitFor(() => chunks.join('') === '中a', 2000)
    check('逐字符延迟不劈开汉字', done && chunks[0] === '中', JSON.stringify(chunks))
    st.close()
  }

  // 行间延迟只在本行发完时生效一次；CRLF 不能被算成两次行尾
  {
    const { st, chunks } = await openPaced({ lineDelayMs: 50 })
    const t0 = Date.now()
    st.write('a\r\nb')
    const done = await waitFor(() => chunks.join('') === 'a\r\nb', 3000)
    const elapsed = Date.now() - t0
    check('行间延迟：整行最终送达', done, JSON.stringify(chunks))
    check('行间延迟：真的等了', elapsed >= 45, String(elapsed))
    check('行间延迟：CRLF 只停一次', elapsed < 120, String(elapsed))
    st.close()
  }

  // 没有换行时不触发行间延迟：否则「每行停一下」会变成「每段停一下」
  {
    const { st, chunks } = await openPaced({ lineDelayMs: 200 })
    const t0 = Date.now()
    st.write('abc')
    const elapsed = Date.now() - t0
    check('无换行时不等行间延迟', elapsed < 100 && chunks.join('') === 'abc', String(elapsed) + ' ' + JSON.stringify(chunks))
    st.close()
  }

  // 文本与二进制混排：二进制整块写，但必须排在前面那段文本之后
  {
    const { st, chunks } = await openPaced({ charDelayMs: 3 })
    st.write('ab')
    st.writeBytes(Buffer.from([0x02, 0x10]))
    st.write('c')
    const done = await waitFor(() => chunks.join('') === 'ab0210c', 3000)
    check('文本与 bytes 混排保持顺序', done, JSON.stringify(chunks))
    check('二进制不被逐字节拆分', chunks.indexOf('0210') >= 0, JSON.stringify(chunks))
    st.close()
  }

  // 关端口时必须丢掉没发完的队列，否则下次 pump 会撞到已释放的 port
  {
    const { st, chunks } = await openPaced({ charDelayMs: 20 })
    st.write('abcdefgh')
    st.close()
    await sleep(80)
    const left = st['queue']
    check('关闭时清空待发送队列', !left || left.length === 0, JSON.stringify(chunks))
    check('关闭后不再继续写端口', chunks.length <= 2, JSON.stringify(chunks))
  }

  // 取值收敛：界面/导入的脏数据不能突破上限，也不能变成负数
  check('字符延迟上限收敛', M.normalizeCharDelayMs(100000) === M.SERIAL_MAX_CHAR_DELAY_MS)
  check('行间延迟上限收敛', M.normalizeLineDelayMs(100000) === M.SERIAL_MAX_LINE_DELAY_MS)
  check('负延迟当 0', M.normalizeCharDelayMs(-5) === 0 && M.normalizeLineDelayMs(-5) === 0)
  check('非法延迟当 0', M.normalizeCharDelayMs('abc') === 0 && M.normalizeLineDelayMs(null) === 0)
  check('小数向下取整', M.normalizeCharDelayMs(7.9) === 7)
  check(
    'isSerialPacingOff 只认两个都为 0',
    M.isSerialPacingOff({ charDelayMs: 0, lineDelayMs: 0 }) &&
      M.isSerialPacingOff({}) &&
      !M.isSerialPacingOff({ charDelayMs: 1, lineDelayMs: 0 })
  )
  check('关闭节奏时说明文案为空', M.describeSerialPacing({}) === '')
  check(
    '开启节奏时说明文案带两个值',
    M.describeSerialPacing({ charDelayMs: 5, lineDelayMs: 100 }) === '每字符 5ms · 换行后 100ms',
    M.describeSerialPacing({ charDelayMs: 5, lineDelayMs: 100 })
  )

  /* 14d. 在线切波特率：port.update，不重开端口 */
  {
    const updates = []
    const port = makeFakePort()
    port.update = (opts, cb) => {
      updates.push(opts)
      if (cb) cb(null)
    }
    const st = new M.SerialTransport(
      { config: pacingCfg({}), portFactory: () => port },
      { onData: () => {}, onClose: () => {} }
    )
    // 未打开就切：必须报错，而不是静默改掉 config 让界面以为成功了
    let closedErr = ''
    try {
      await st.setBaudRate(57600)
    } catch (e) {
      closedErr = e.message
    }
    check('未打开时切波特率报错', /串口未打开/.test(closedErr), closedErr)

    await st.open({ cols: 80, rows: 24 })
    const applied = await st.setBaudRate(57600)
    check('切波特率走 port.update', updates.length === 1 && updates[0].baudRate === 57600, JSON.stringify(updates))
    check('返回实际生效值', applied === 57600, String(applied))
    // 传输层留存的 config 必须跟着变：拔插恢复重建时用的是最后生效的速率
    check('生效值写回 config', st['config'].baudRate === 57600, String(st['config'].baudRate))

    // 脏值收敛到当前速率，而不是把端口改成 0 让它静默失联
    const fallbackApplied = await st.setBaudRate(0)
    check('非法波特率回落当前值', fallbackApplied === 57600, String(fallbackApplied))
    const capped = await st.setBaudRate(9_000_000)
    check('超上限回落当前值', capped === 57600, String(capped))

    // 驱动不支持 update：报可读错误
    const noUpdate = makeFakePort()
    const st2 = new M.SerialTransport(
      { config: pacingCfg({}), portFactory: () => noUpdate },
      { onData: () => {}, onClose: () => {} }
    )
    await st2.open({ cols: 80, rows: 24 })
    let unsupported = ''
    try {
      await st2.setBaudRate(57600)
    } catch (e) {
      unsupported = e.message
    }
    check('驱动不支持 update 时报可读错误', /不支持在线改波特率/.test(unsupported), unsupported)
    st.close()
    st2.close()
  }

  /* 14e. BREAK：先拉低再释放，时长夹在 50..2000 */
  {
    const sets = []
    const port = makeFakePort({ dtrCalls: sets })
    const st = new M.SerialTransport(
      { config: pacingCfg({}), portFactory: () => port },
      { onData: () => {}, onClose: () => {} }
    )
    let closedErr = ''
    try {
      await st.sendBreak()
    } catch (e) {
      closedErr = e.message
    }
    check('未打开时发 BREAK 报错', /串口未打开/.test(closedErr), closedErr)

    await st.open({ cols: 80, rows: 24 })
    sets.length = 0
    const t0 = Date.now()
    await st.sendBreak(50)
    const elapsed = Date.now() - t0
    const brkOn = sets.findIndex((s) => s.brk === true)
    const brkOff = sets.findIndex((s) => s.brk === false)
    check('BREAK 先拉低', brkOn >= 0, JSON.stringify(sets))
    check('BREAK 收尾必须释放', brkOff > brkOn, JSON.stringify(sets))
    check('BREAK 时长真的保持', elapsed >= 45, String(elapsed))
    // 释放失败会让 TX 钉死在地上 —— 这里验证「拉低成功也要释放」这条路径存在
    check('BREAK 只碰 brk 字段', sets.every((s) => Object.keys(s).length === 1 && 'brk' in s), JSON.stringify(sets))

    // 过短会被夹到 50ms：短于这个量级不少 UART 根本认不出帧错误
    sets.length = 0
    const t1 = Date.now()
    await st.sendBreak(1)
    check('BREAK 过短被夹到下限', Date.now() - t1 >= 45, String(Date.now() - t1))
    st.close()
  }

  /* 14f. 会话层：串口专有操作只对待串口，且改了显示名 */
  {
    fakePorts = [{ ...CH340 }]
    const S = uid()
    // 注入一个「有串口专有能力」的假传输层：会话层按能力探测，不认 instanceof
    const withSerial = (cfg, events) => {
      const t = new M.MemoryTransport({ kind: 'serial' }, events)
      t.appliedBaud = []
      t.setBaudRate = async (baud) => {
        t.appliedBaud.push(baud)
        return baud
      }
      t.broke = 0
      t.sendBreak = async () => {
        t.broke += 1
      }
      opened.push({ cfg: { ...cfg }, transport: t })
      return t
    }
    sm.setSerialTransportFactory(withSerial)
    await sm.open(S, conn.id, 80, 24)
    const before = sm.list().find((s) => s.id === S)
    check('list() 带上当前波特率', before && before.baudRate === 115200, JSON.stringify(before && before.baudRate))

    const applied = await sm.setSerialBaudRate(S, 57600)
    const after = sm.list().find((s) => s.id === S)
    check('会话层切波特率转发到传输层', applied === 57600 && latest().transport.appliedBaud[0] === 57600)
    // 端口号会被前面的用例改写过，这里只断言速率那一段跟着变
    check(
      '切完显示名跟着变',
      after && after.target.endsWith(' · 57600 8N1'),
      after && after.target
    )
    check('切完 list() 的 baudRate 也变', after && after.baudRate === 57600, String(after && after.baudRate))

    await sm.sendSerialBreak(S)
    check('会话层 BREAK 转发到传输层', latest().transport.broke === 1, String(latest().transport.broke))

    // 非串口会话：给出可读错误，而不是 TypeError
    let wrongKind = ''
    try {
      await sm.setSerialBaudRate('no-such-session', 57600)
    } catch (e) {
      wrongKind = e.message
    }
    check('不存在的会话有可读错误', /会话不存在或已断开/.test(wrongKind), wrongKind)
    sm.close(S)
    await sleep(50)
    sm.setSerialTransportFactory((cfg, events) => {
      const t = new M.MemoryTransport({ kind: 'serial' }, events)
      opened.push({ cfg: { ...cfg }, transport: t })
      return t
    })
  }

  /* 15. resolveSerialPath 三级退化 */
  const cfg = { path: 'COM99', usbSerialNumber: 'SN-1', usbPnpId: 'PNP-1' }
  const ports = [
    { path: 'COM1', serialNumber: 'SN-1', pnpId: 'PNP-X' },
    { path: 'COM2', pnpId: 'PNP-1' },
    { path: 'COM99' }
  ]
  const r1 = M.resolveSerialPath(cfg, ports)
  check('按 serialNumber 优先匹配', r1.ok && r1.path === 'COM1' && r1.via === 'serial', JSON.stringify(r1))
  const r2 = M.resolveSerialPath({ path: 'COM99', usbPnpId: 'PNP-1' }, ports)
  check('无 serialNumber 时按 pnpId 匹配', r2.ok && r2.path === 'COM2' && r2.via === 'pnp', JSON.stringify(r2))
  const r3 = M.resolveSerialPath({ path: 'COM99' }, ports)
  check('无 USB 身份时退到 path', r3.ok && r3.path === 'COM99' && r3.via === 'path', JSON.stringify(r3))
  const r4 = M.resolveSerialPath({ path: 'COM99', usbSerialNumber: 'NOPE' }, ports)
  check('身份对不上时不退回旧 path', r4.ok === false && r4.reason === 'not-found', JSON.stringify(r4))
  // 平台给不出身份（Linux 常见）：整个列表都没有 serialNumber/pnpId，
  // 此时按 path 退化是唯一能连上的路，不能判成失配
  const linuxPorts = [{ path: '/dev/ttyUSB0' }, { path: '/dev/ttyUSB1' }]
  const r5 = M.resolveSerialPath(
    { path: '/dev/ttyUSB1', usbSerialNumber: 'STALE' },
    linuxPorts
  )
  check(
    '环境无身份信息时退到 path（Linux）',
    r5.ok === true && r5.path === '/dev/ttyUSB1' && r5.via === 'path',
    JSON.stringify(r5)
  )
  check('hasStableIdentity 认 serialNumber', M.hasStableIdentity({ path: 'X', usbSerialNumber: 'S' }) === true)
  check('hasStableIdentity 不认裸 path', M.hasStableIdentity({ path: 'COM1' }) === false)

  /* 16. 指纹能发现「换了一台设备但端口号相同」 */
  const fp1 = M.portsFingerprint([{ path: 'COM3', serialNumber: 'A' }])
  const fp2 = M.portsFingerprint([{ path: 'COM3', serialNumber: 'B' }])
  check('指纹能区分同端口不同设备', fp1 !== fp2, `${fp1} vs ${fp2}`)

  sm.close(A)
  await sleep(50)
  fs.rmSync(userData, { recursive: true, force: true })
  fs.rmSync(bundle, { force: true })
  fs.rmSync(stub, { force: true })

  console.log(`通过 ${pass}  失败 ${fail}`)
  fails.slice(0, 20).forEach((f) => console.log('  ✗ ' + f))
  process.exit(fail ? 1 : 0)
}

process.on('uncaughtException', (e) => {
  console.log('未捕获异常: ' + (e && e.stack))
  process.exit(2)
})
main().catch((e) => {
  console.log('测试中断: ' + (e && e.stack))
  process.exit(2)
})
