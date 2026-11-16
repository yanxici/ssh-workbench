/**
 * 终端输出高亮（v2.1.3）纯逻辑回归：把 src/renderer/src/lib/highlight.ts 用 esbuild
 * 打成 CJS 直接跑线上那份代码，不复制粘贴。
 *
 * 断言判据统一按「旧实现必红」来选：
 *   - 若 ANSI 不剥，被 ESC 拆开的 error 就匹配不到 → 会红；
 *   - 若 \r 当换行，一条进度条会产出多行 → 计数对不上，会红；
 *   - 若 flags 不收敛 g，第二条同规则匹配会因 lastIndex 残留而漏 → 会红；
 *   - 若颜色不校验，非法值会被原样塞进 xterm → 会红。
 *
 * 用法：node scripts/verify-highlight.cjs
 * 退出码 0 = 全部通过。
 */
const path = require('path')
const esbuild = require('esbuild')

const SRC = path.join(__dirname, '../src/renderer/src/lib/highlight.ts')
const out = esbuild.buildSync({
  entryPoints: [SRC],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  write: false,
  logLevel: 'silent'
})
const mod = { exports: {} }
new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require)
const H = mod.exports

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

const ESC = '\x1b'

/* ---------------- 1. stripAnsi ---------------- */
{
  eq(H.stripAnsi(ESC + '[31merror' + ESC + '[0m'), 'error', 'A1 CSI 颜色被剥掉')
  eq(H.stripAnsi(ESC + '[1;38;5;196mwarn' + ESC + '[m'), 'warn', 'A2 多参 CSI 被剥掉')
  // 被拆开的 error：若不剥 ANSI，正则匹配不到
  eq(H.stripAnsi('e' + ESC + '[1mr' + ESC + '[0mror'), 'error', 'A3 着色拆开的单词还原')
  eq(H.stripAnsi(ESC + ']0;title' + '\x07text'), 'text', 'A4 OSC(BEL 结尾) 被剥掉')
  eq(H.stripAnsi(ESC + ']8;;http://x' + ESC + '\\link' + ESC + ']8;;' + ESC + '\\'), 'link', 'A5 OSC(ST 结尾) 超链接被剥掉')
  eq(H.stripAnsi('a\tb'), 'a\tb', 'A6 tab 保留')
  eq(H.stripAnsi('a\rb'), 'ab', 'A7 \r 被丢弃')
  eq(H.stripAnsi(ESC + '(0lqk' + ESC + '(B'), 'lqk', 'A8 字符集切换序列被剥掉')
  eq(H.stripAnsi('中文' + ESC + '[32m正常' + ESC + '[0m'), '中文正常', 'A9 多字节字符不被破坏')
  eq(H.stripAnsi(ESC + '[999A'), '', 'A10 只有序列时输出空串')
  eq(H.stripAnsi('a\x07b'), 'ab', 'A11 BEL 被丢弃')
}

/* ---------------- 2. createLineSplitter ---------------- */
{
  const s = H.createLineSplitter()
  eq(s.feed('one\r\ntwo\r\n'), ['one', 'two'], 'B1 CRLF 按换行处理')
  eq(s.feed('partial'), [], 'B2 无换行不产出行')
  eq(s.pending, 'partial', 'B3 缓冲保留未完成行')
  eq(s.feed(' end\n'), ['partial end'], 'B4 跨帧拼成一行')

  const s2 = H.createLineSplitter()
  // 进度条：10 次 \r 重绘 + 最后换行 → 只应产出一行（最后一次内容）
  let bar = ''
  for (let i = 1; i <= 10; i++) bar += '\r' + i * 10 + '%'
  bar += '\n'
  eq(s2.feed(bar), ['100%'], 'B5 进度条重绘只产出一行')

  const s3 = H.createLineSplitter()
  eq(s3.feed(ESC + '[31mred' + ESC + '[0m\n'), ['red'], 'B6 产出的行已剥 ANSI')

  const s4 = H.createLineSplitter()
  const huge = 'x'.repeat(9000) + '\n'
  const lines4 = s4.feed(huge)
  eq(lines4.length, 1, 'B7 超长行仍产出一行')
  ok(lines4[0].length <= 8192, 'B8 超长行被截断到缓冲上限', lines4[0].length)

  const s5 = H.createLineSplitter()
  eq(s5.feed('\n\n'), ['', ''], 'B9 连续空行各算一行')
}

/* ---------------- 3. sanitizeFlags / sanitizeColor ---------------- */
{
  eq(H.sanitizeFlags('gi'), 'i', 'C1 g 被去掉')
  eq(H.sanitizeFlags('yims'), 'ims', 'C2 y 被去掉，imsu 保留并排序')
  eq(H.sanitizeFlags('xq'), '', 'C3 非法标志被清空')
  eq(H.sanitizeFlags(undefined), '', 'C4 undefined 返回空串')

  eq(H.sanitizeColor('#AABBCC'), '#AABBCC', 'C5 合法 6 位色保留')
  eq(H.sanitizeColor('  #123abc '), '#123abc', 'C6 前后空白被裁剪')
  eq(H.sanitizeColor('#abc'), undefined, 'C7 3 位简写不被接受')
  eq(H.sanitizeColor('rgba(1,2,3,0.5)'), undefined, 'C8 rgba 不被接受')
  eq(H.sanitizeColor('red'), undefined, 'C9 颜色名不被接受')
  eq(H.sanitizeColor(undefined), undefined, 'C10 undefined 返回 undefined')
}

/* ---------------- 4. compileRules ---------------- */
{
  const { compiled, errors } = H.compileRules(H.DEFAULT_RULES)
  eq(errors.length, 0, 'D1 默认规则无编译错误')
  eq(compiled.length, 2, 'D2 默认两条规则都被编译')
  ok(compiled.every((r) => r.background && r.foreground), 'D3 默认规则带色值')

  const bad = H.compileRules([
    { id: 'a', name: 'A', pattern: '(', flags: '', enabled: true },
    { id: 'b', name: 'B', pattern: '', flags: '', enabled: true },
    { id: 'c', name: 'C', pattern: 'ok', flags: '', enabled: true }
  ])
  eq(bad.errors.length, 2, 'D4 两条坏规则各报错')
  eq(bad.compiled.length, 1, 'D5 只有合法的被编译')

  const disabled = H.compileRules([
    { id: 'a', name: 'A', pattern: 'x', flags: '', enabled: false }
  ])
  eq(disabled.compiled.length, 0, 'D6 关闭的规则不参与编译')
  eq(disabled.errors.length, 0, 'D7 关闭的规则也不报错')

  const tooLong = H.compileRules([
    { id: 'a', name: 'A', pattern: 'x'.repeat(600), flags: '', enabled: true }
  ])
  eq(tooLong.errors.length, 1, 'D8 超长正则被拒')
  ok(/过长/.test(tooLong.errors[0].message), 'D9 超长报错文案可读', tooLong.errors[0].message)

  const many = H.compileRules(
    Array.from({ length: 80 }, (_, i) => ({
      id: 'r' + i,
      name: 'R' + i,
      pattern: 'p' + i,
      flags: '',
      enabled: true
    }))
  )
  eq(many.compiled.length, H.MAX_RULES, 'D10 规则条数被夹到上限')
}

/* ---------------- 5. matchRule ---------------- */
{
  const { compiled } = H.compileRules(H.DEFAULT_RULES)
  const r1 = H.matchRule(compiled, 'tar: /x: Cannot open: Permission denied')
  ok(r1 && r1.id === 'builtin-error', 'E1 error 命中', r1 && r1.id)

  const r2 = H.matchRule(compiled, 'WARNING: low memory')
  ok(r2 && r2.id === 'builtin-warn', 'E2 warn 命中（大小写不敏感）', r2 && r2.id)

  const r3 = H.matchRule(compiled, 'compile finished ok')
  eq(r3, null, 'E3 普通输出不命中')

  // g 标志若没被剥掉，第二次匹配会因 lastIndex 残留而漏
  eq(H.matchRule(compiled, 'error').id, 'builtin-error', 'E4 第一次命中')
  eq(H.matchRule(compiled, 'error').id, 'builtin-error', 'E5 第二次仍命中（无 lastIndex 残留）')

  eq(H.matchRule(compiled, ''), null, 'E6 空行不匹配')

  const order = H.compileRules([
    { id: 'first', name: '1', pattern: 'foo', flags: '', enabled: true },
    { id: 'second', name: '2', pattern: 'foo', flags: '', enabled: true }
  ])
  eq(H.matchRule(order.compiled, 'foo bar').id, 'first', 'E7 多条命中以先定义的为准')
}

/* ---------------- 6. assessPattern ---------------- */
{
  eq(H.assessPattern('(a+)+').level, 'warn', 'F1 嵌套量词被警告')
  eq(H.assessPattern('.*.*').level, 'warn', 'F2 多个 .* 被警告')
  eq(H.assessPattern('(a?)*').level, 'warn', 'F3 可选组重复被警告')
  eq(H.assessPattern('\\b(error|fail)\\b').level, 'ok', 'F4 普通正则不警告')
  eq(H.assessPattern('').level, 'ok', 'F5 空串不警告')
  ok(Array.isArray(H.assessPattern('(a+)+').reasons) && H.assessPattern('(a+)+').reasons.length > 0, 'F6 警告带原因')
}

/* ---------------- 7. normalizeHighlight ---------------- */
{
  const d = H.normalizeHighlight(undefined)
  eq(d.enabled, true, 'G1 缺省开启')
  eq(d.rules.length, 2, 'G2 缺省两条内置规则')

  const cleared = H.normalizeHighlight({ enabled: true, rules: [] })
  eq(cleared.rules.length, 0, 'G3 用户清空后不被塞回默认规则')

  const off = H.normalizeHighlight({ enabled: false, rules: [] })
  eq(off.enabled, false, 'G4 enabled:false 被保留')

  const dirty = H.normalizeHighlight({
    enabled: true,
    rules: [
      { id: '', pattern: 'x', flags: 'gy', enabled: true, background: 'red', foreground: '#00FF00' },
      { pattern: 'y' },
      { notAPattern: 1 }
    ]
  })
  eq(dirty.rules.length, 2, 'G5 缺 pattern 的条目被丢弃')
  eq(dirty.rules[0].id, 'rule-0', 'G6 空 id 被补齐')
  eq(dirty.rules[0].flags, '', 'G7 非法标志被清空')
  eq(dirty.rules[0].background, undefined, 'G8 非法颜色被丢弃')
  eq(dirty.rules[0].foreground, '#00FF00', 'G9 合法颜色保留')
  eq(dirty.rules[1].enabled, true, 'G10 缺 enabled 视为开启')

  const capped = H.normalizeHighlight({
    enabled: true,
    rules: Array.from({ length: 80 }, (_, i) => ({ id: 'r' + i, pattern: 'p', enabled: true }))
  })
  eq(capped.rules.length, H.MAX_RULES, 'G11 条数被夹到上限')
}

/* ---------------- 汇总 ---------------- */
if (fails.length) {
  console.error('\n高亮逻辑回归：' + fails.length + ' 条失败 / 共 ' + (pass + fails.length) + ' 条\n')
  for (const f of fails) console.error('  ✗ ' + f + '\n')
  process.exit(1)
}
console.log('高亮逻辑回归：全部 ' + pass + ' 条通过')
