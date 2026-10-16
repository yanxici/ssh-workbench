/**
 * ZMODEM 接入后的终端解码回归验证。
 *
 * 风险点：挂上 Sentry 后，终端文本不再由主进程的 StringDecoder 直接给出，
 * 而是由渲染层 TextDecoder 在 Sentry 的 to_terminal 里解码。
 * 若两者的流式解码行为不一致，中文（多字节 UTF-8）在跨帧处会乱码。
 *
 * 本脚本复刻「主进程 flush 分帧」与「渲染层 Sentry 解码」两条链路，
 * 用同一串含中文的字节流按不同切分方式喂入，断言结果一致且无乱码。
 *
 * 用法：node scripts/verify-zmodem-decode.cjs
 */
const fs = require('fs')
const path = require('path')
const { StringDecoder } = require('string_decoder')
const { TextDecoder } = require('util')

const ROOT = path.join(__dirname, '..')
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

/** 主进程链路：Buffer[] -> StringDecoder 文本 */
function mainText(chunks) {
  const dec = new StringDecoder('utf8')
  let out = ''
  for (const c of chunks) out += dec.write(c)
  return out
}

/** 渲染链路：同一批字节 -> TextDecoder(stream) 文本（模拟 Sentry.to_terminal 逐段解码） */
function rendererText(chunks) {
  const dec = new TextDecoder('utf-8')
  let out = ''
  for (const c of chunks) out += dec.decode(c, { stream: true })
  out += dec.decode()
  return out
}

const SAMPLE = '登录成功：设备型号 GW-200，温度 23.5℃\r\nroot@host:~# ls -l\r\n'

;(function testIdenticalDecoding() {
  const full = Buffer.from(SAMPLE, 'utf8')

  // 1) 整块
  check('整块解码一致', mainText([full]) === rendererText([full]))
  check('整块无乱码', mainText([full]) === SAMPLE)

  // 2) 在「每个字节」处切分（最严苛：多字节字符被彻底打散）
  const bytes = Array.from(full, (b) => Buffer.from([b]))
  check('逐字节切分：两条链路解码一致', mainText(bytes) === rendererText(bytes))
  check('逐字节切分：结果仍等于原文', mainText(bytes) === SAMPLE, JSON.stringify(mainText(bytes).slice(0, 40)))

  // 3) 随机切分 200 次，每次都要一致
  let mismatch = 0
  for (let t = 0; t < 200; t++) {
    const chunks = []
    let i = 0
    while (i < full.length) {
      const n = 1 + Math.floor(Math.random() * 5)
      chunks.push(full.subarray(i, Math.min(i + n, full.length)))
      i += n
    }
    if (mainText(chunks) !== rendererText(chunks)) mismatch++
  }
  check('随机切分 200 次全部一致', mismatch === 0, `不一致 ${mismatch} 次`)

  // 4) 反向：解码 + 重新编码应还原字节（保证没有信息丢失）
  const rt = Buffer.from(mainText([full]), 'utf8')
  check('解码后重编码可还原原始字节', Buffer.compare(rt, full) === 0)
})()

;(function testSourcesVerify() {
  // 断言源码确实用了流式解码，而不是每段独立解码（后者会切断多字节字符）
  const zm = fs.readFileSync(path.join(ROOT, 'src/renderer/src/lib/zmodem.ts'), 'utf8')
  check('渲染层使用 TextDecoder', /new TextDecoder\('utf-8'\)/.test(zm))
  check('渲染层流式解码（stream: true）', /decode\(Uint8Array\.from\(toOctets\(octets\)\), \{ stream: true \}\)/.test(zm))

  const sm = fs.readFileSync(path.join(ROOT, 'src/main/ssh/sessionManager.ts'), 'utf8')
  check('主进程仍保留 StringDecoder', /decoder: StringDecoder/.test(sm))
  check('主进程一次性解码合并后的字节', /record\.decoder\.write\(raw\)/.test(sm))
})()

console.log('')
if (fails.length) {
  console.log('失败项：')
  for (const f of fails) console.log('  FAIL  ' + f)
  console.log('')
}
console.log(`结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
