/**
 * 会话日志（纯文本通道）自检：不依赖真实会话，直接驱动 recorder。
 *
 * 为什么要单独一个脚本：录制器现在一次会话写**两份**文件 —— .cast 给人回放、
 * .log 给人 grep。两份的失败方式完全不同（cast 是 JSON 行、log 是流式追加 +
 * 行首时间戳），把它们塞进别的脚本里检查会把「格式」和「会话」两件事搅在一起。
 *
 * 覆盖：
 *   1. 默认同时落 .cast 与同名的 .log
 *   2. cast 首行仍是 asciinema v2 头（不能被纯文本通道带坏）
 *   3. .log 里没有 ANSI 转义序列（否则 grep 出来每行都带控制码尾巴）
 *   4. 时间戳加在真正的行首，一个数据块不会攒出十几个
 *   5. 输入行带 "> " 前缀，事后能看出「这是谁打的」
 *   6. plainText:false → 不产生 .log
 *   7. timestamp:false → 有内容、无时间戳
 *   8. 孤立的 \r 统一成 \n（Windows 记事本与其余编辑器的分歧点）
 *   9. listSessionLogs 同时列出两种格式并带 format 字段
 *  10. 删除任一份会把它同名的另一份一起删掉
 *  11. 两种格式各自 50MB 计数：cast 截断不影响 log 继续记
 *
 * 用法：node scripts/verify-session-log.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.tsc-verify')
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-log-'))
process.env.SW_TEST_USERDATA = userData

fs.mkdirSync(OUT_DIR, { recursive: true })
const stub = path.join(OUT_DIR, 'electron-log-stub.cjs')
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
const bundle = path.join(OUT_DIR, 'session-log-bundle.cjs')
esbuild.buildSync({
  stdin: {
    contents: `
      export { recorder } from './src/main/ssh/recorder'
      export { listSessionLogs, removeSessionLog, readSessionLog, sessionLogDir } from './src/main/store/sessionLogs'
    `,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle,
  logLevel: 'error',
  alias: {
    electron: stub,
    '@shared': path.join(ROOT, 'src/shared')
  }
})
const M = require(bundle)
const { recorder } = M
const MAX_BYTES = 50 * 1024 * 1024

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
let seq = 0
const newId = () => 'logtest-' + ++seq

async function readAll(file) {
  if (!file) return ''
  return M.readSessionLog(file.path)
}

/**
 * 等文件内容满足条件再断言。
 *
 * createWriteStream 的缓冲区是异步刷的：stop() 之后立刻 read 可能读到空文件。
 * 断言本身没错，错的是「读的时机」—— 统一轮询，脚本就不会偶发红。
 */
async function waitText(file, predicate, ms = 3000) {
  if (!file) return ''
  const t0 = Date.now()
  let text = ''
  while (Date.now() - t0 < ms) {
    text = await readAll(file)
    if (predicate(text)) return text
    await sleep(10)
  }
  return text
}

/** 按标题找到这一次录制产生的两个文件（同名不同后缀） */
async function waitFiles(title) {
  for (let i = 0; i < 200; i++) {
    const list = await M.listSessionLogs()
    const cast = list.find((f) => f.format === 'cast' && f.name.endsWith(title + '.cast'))
    if (cast) {
      return {
        cast,
        log: list.find((f) => f.format === 'log' && f.name === cast.name.replace(/\.cast$/, '.log'))
      }
    }
    await sleep(10)
  }
  return {}
}

async function startRec(sessionId, title, options) {
  await recorder.start(sessionId, title, 120, 32, options)
  return waitFiles(title)
}

async function main() {
  /* 1. 默认同时落两份 */
  {
    const id = newId()
    const files = await startRec(id, 'A区-默认')
    check('默认产生 cast', !!files.cast, JSON.stringify(files.cast))
    check('默认产生同名 log', !!files.log, JSON.stringify(files.log))
    check(
      '两份同名不同后缀',
      files.cast && files.log && files.log.name === files.cast.name.replace(/\.cast$/, '.log'),
      `${files.cast && files.cast.name} / ${files.log && files.log.name}`
    )
    const head = (await waitText(files.cast, (t) => t.length > 0)).split('\n')[0]
    const parsed = JSON.parse(head)
    check('cast 首行仍是 asciinema v2 头', parsed.version === 2 && parsed.width === 120 && parsed.height === 32, head)
    recorder.stop(id)
  }

  /* 2. ANSI 剥离 + 行首时间戳 */
  {
    const id = newId()
    const files = await startRec(id, 'B区-彩色')
    // 典型的着色提示符 + 光标移动：纯文本里都不该留下
    recorder.appendOutput(id, '\u001b[32mroot@7628\u001b[0m:\u001b[1;34m/var\u001b[0m# ls\r\n')
    recorder.appendOutput(id, 'boot: ok\r\n')
    recorder.stop(id)
    const text = await waitText(files.log, (t) => /boot: ok/.test(t))
    check('纯文本不含 ESC', !text.includes('\u001b'), JSON.stringify(text.slice(0, 120)))
    check('纯文本留下了实际内容', /root@7628:\/var# ls/.test(text), JSON.stringify(text.slice(0, 160)))
    const lines = text.split('\n').filter((l) => l !== '')
    check(
      '每行一个时间戳前缀',
      lines.length === 2 && lines.every((l) => /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] /.test(l)),
      JSON.stringify(lines.slice(0, 3))
    )
    check('CRLF 变成 LF（不留裸 CR）', !text.includes('\r'), JSON.stringify(text.slice(0, 80)))
  }

  /* 3. 输入带 "> " 前缀 */
  {
    const id = newId()
    const files = await startRec(id, 'C区-输入')
    recorder.appendInput(id, 'reboot\r')
    await sleep(320)
    recorder.appendOutput(id, 'rebooting...\r\n')
    recorder.stop(id)
    const text = await waitText(files.log, (t) => /rebooting/.test(t))
    check('输入行带 "> " 标记', /\] > reboot/.test(text), JSON.stringify(text.slice(0, 160)))
    check('输出行不带 "> " 标记', /\] rebooting\.\.\./.test(text), JSON.stringify(text.slice(0, 200)))
  }

  /* 4. 关掉纯文本通道 */
  {
    const id = newId()
    const files = await startRec(id, 'D区-只cast', { plainText: false })
    check('plainText:false 时不产生 log', !files.log, JSON.stringify(files.log))
    check('plainText:false 时 cast 照旧', !!files.cast)
    recorder.stop(id)
  }

  /* 5. 关掉时间戳 */
  {
    const id = newId()
    const files = await startRec(id, 'E区-无时间戳', { timestamp: false })
    recorder.appendOutput(id, 'plain line\r\n')
    recorder.stop(id)
    const text = await waitText(files.log, (t) => /plain line/.test(t))
    check('timestamp:false 时没有时间戳前缀', /^plain line\n?$/.test(text), JSON.stringify(text))
  }

  /* 6. 一个数据块里多行：时间戳只加在行首，不重复 */
  {
    const id = newId()
    const files = await startRec(id, 'F区-多行')
    recorder.appendOutput(id, 'line1\r\nline2\r\nline3\r\n')
    recorder.stop(id)
    const text = await waitText(files.log, (t) => /line3/.test(t))
    const stamps = text.match(/\[\d{2}:\d{2}:\d{2}\.\d{3}\]/g) || []
    check('多行数据块里每行一个时间戳', stamps.length === 3, JSON.stringify(stamps))
  }

  /* 7. 列表同时列出两种格式 */
  {
    const list = await M.listSessionLogs()
    const formats = new Set(list.map((f) => f.format))
    check('listSessionLogs 同时列出 cast 与 log', formats.has('cast') && formats.has('log'), JSON.stringify([...formats]))
    check(
      '每条都带 format 字段',
      list.every((f) => f.format === 'cast' || f.format === 'log'),
      JSON.stringify(list.slice(0, 2))
    )
    check('按修改时间倒序', list.every((f, i) => i === 0 || list[i - 1].mtime >= f.mtime))
  }

  /* 8. 删一份连带另一份 */
  {
    const id = newId()
    const files = await startRec(id, 'G区-删除')
    recorder.stop(id)
    await waitText(files.cast, () => true)
    await M.removeSessionLog(files.log.path)
    const after = await M.listSessionLogs()
    check('删 log 时 cast 一并删掉', !after.some((f) => f.name === files.cast.name), JSON.stringify(after.map((f) => f.name)))
    check('删 log 后 log 也没了', !after.some((f) => f.name === files.log.name))
  }

  /* 9. 两种格式各自 50MB 计数：cast 截断不拖住 log */
  {
    const id = newId()
    const files = await startRec(id, 'H区-截断')
    const rec = recorder['recordings'].get(id)
    rec.bytes = MAX_BYTES + 1
    recorder.appendOutput(id, 'after-cast-limit\r\n')
    recorder.stop(id)
    const castText = await waitText(files.cast, (t) => /超过 50 MB 上限/.test(t))
    const logText = await waitText(files.log, (t) => /after-cast-limit/.test(t))
    check('cast 超限后落一条提示', /超过 50 MB 上限/.test(castText), JSON.stringify(castText.slice(-120)))
    check('cast 超限后不再写正文', !/after-cast-limit/.test(castText), JSON.stringify(castText.slice(-120)))
    check('log 不受 cast 截断影响', /after-cast-limit/.test(logText), JSON.stringify(logText.slice(-80)))

    // 反向：log 自己超限时停记，但 cast 继续
    const id2 = newId()
    const files2 = await startRec(id2, 'I区-截断log')
    const rec2 = recorder['recordings'].get(id2)
    rec2.textBytes = MAX_BYTES + 1
    recorder.appendOutput(id2, 'after-log-limit\r\n')
    recorder.stop(id2)
    const castText2 = await waitText(files2.cast, (t) => /after-log-limit/.test(t))
    const logText2 = await waitText(files2.log, (t) => /文本日志已超过/.test(t))
    check('log 超限后落一条提示', /文本日志已超过 50 MB 上限/.test(logText2), JSON.stringify(logText2.slice(-120)))
    check('cast 不受 log 截断影响', /after-log-limit/.test(castText2), JSON.stringify(castText2.slice(-120)))
  }

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
