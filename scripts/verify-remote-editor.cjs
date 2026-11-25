/**
 * 内置远程编辑器逻辑与行为回归（WP5）：
 *   1. 行号 / 光标行列计算
 *   2. 查找（区分大小写 / 忽略大小写 / 循环上下匹配）
 *   3. 单项替换 / 全部替换（避免正则特殊字符误伤）
 *   4. Tab / Shift+Tab 单行与多行缩进/反缩进
 *   5. RemoteEditorDialog 与 sftpStore 接线契约（Ctrl+S 原地保存、编码展示、脏状态关闭确认）
 *
 * 用法：node scripts/verify-remote-editor.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, '.tsc-verify')
fs.mkdirSync(OUT, { recursive: true })

let failed = 0
function check(name, ok, extra) {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failed++
    console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`)
  }
}

async function main() {
  const dialogSrc = fs.readFileSync(
    path.join(ROOT, 'src/renderer/src/components/files/RemoteEditorDialog.tsx'),
    'utf8'
  )
  const storeSrc = fs.readFileSync(
    path.join(ROOT, 'src/renderer/src/stores/sftpStore.ts'),
    'utf8'
  )

  check('WP5: sftpStore.saveEditor 支持 close 可选参数以原地保存', /close\?:\s*boolean/.test(storeSrc))
  check('WP5: RemoteEditorDialog 接收并展示 encoding', /encoding/.test(dialogSrc))
  check('WP5: RemoteEditorDialog 支持 Ctrl+S 保存', /key\.toLowerCase\(\)\s*===\s*'s'/.test(dialogSrc))
  check('WP5: RemoteEditorDialog 包含未保存关闭确认状态', /confirmClose/.test(dialogSrc))
  check(
    'WP5: RemoteEditorDialog 查找/替换跳转不强抢输入框焦点',
    /const focusMatch[\s\S]{0,400}stealFocus/.test(dialogSrc)
  )
  check(
    'WP5: RemoteEditorDialog 在 window 上绑定 keydown 以防按钮禁用后失焦',
    /window\.addEventListener\(\s*'keydown'/.test(dialogSrc)
  )
  check(
    '编辑区容器不混用 modal-body（flex:1 会覆盖 h-[56vh] 导致高度塌陷）',
    !/className="[^"]*\bmodal-body\b[^"]*\bh-\[56vh\]/.test(dialogSrc) &&
      /className="[^"]*\bflex\b[^"]*\bh-\[56vh\][^"]*\bmin-h-0\b[^"]*\boverflow-hidden\b/.test(dialogSrc)
  )
  check(
    '编辑器 textarea 不使用 h-full 阻断 flex stretch',
    !/<textarea[\s\S]{0,300}\bh-full\b/.test(dialogSrc)
  )

  const bundle = path.join(OUT, 'remote-editor.cjs')
  await esbuild.build({
    stdin: {
      contents: `
        export {
          getLineCol,
          countLines,
          findMatches,
          stepMatchIndex,
          replaceMatch,
          replaceAllMatches,
          applyTabIndent
        } from './src/renderer/src/lib/editorText'
      `,
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'error'
  })

  const {
    getLineCol,
    countLines,
    findMatches,
    stepMatchIndex,
    replaceMatch,
    replaceAllMatches,
    applyTabIndent
  } = require(bundle)

  // 行列与总行数
  check('空文本总行数为 1', countLines('') === 1)
  check('三行文本总行数为 3', countLines('a\nb\nc') === 3)
  const lc0 = getLineCol('abc\ndef\nghi', 0)
  check('偏移 0 -> 行 1 列 1', lc0.line === 1 && lc0.col === 1, lc0)
  const lc1 = getLineCol('abc\ndef\nghi', 6)
  check('偏移 6 -> 行 2 列 3', lc1.line === 2 && lc1.col === 3, lc1)

  // 查找（大小写敏感 vs 忽略大小写）
  const sample = 'Foo bar foo FOO'
  check('空查询返回空数组', findMatches(sample, '', false).length === 0)
  const mInsensitive = findMatches(sample, 'foo', false)
  check('忽略大小写命中 3 处', mInsensitive.length === 3 && mInsensitive[0].start === 0 && mInsensitive[2].start === 12, mInsensitive)
  const mSensitive = findMatches(sample, 'foo', true)
  check('区分大小写只命中 1 处', mSensitive.length === 1 && mSensitive[0].start === 8, mSensitive)

  // 上下循环定位
  check('从偏移 1 找下一个 -> 第 2 处（index 1）', stepMatchIndex(mInsensitive, 1, 'next') === 1)
  check('从末尾找下一个 -> 绕回 index 0', stepMatchIndex(mInsensitive, 15, 'next') === 0)
  check('从偏移 0 找上一个 -> 绕回最后一处（index 2）', stepMatchIndex(mInsensitive, 0, 'prev') === 2)
  check('从偏移 10 找上一个 -> index 1', stepMatchIndex(mInsensitive, 10, 'prev') === 1)

  // 单项替换 & 全部替换（含正则元字符）
  const r1 = replaceMatch(sample, mInsensitive[1], 'baz')
  check('单项替换精确替换目标区间', r1.text === 'Foo bar baz FOO' && r1.caret === 11, r1)
  const rAll = replaceAllMatches('a.b a.b A.B', 'a.b', '$1', false)
  check('全部替换按字面量不误解析正则与 $1', rAll.text === '$1 $1 $1' && rAll.count === 3, rAll)

  // Tab / Shift+Tab 缩进
  const t1 = applyTabIndent('hello', 2, 2, false)
  check('单光标 Tab 插入 2 空格', t1.text === 'he  llo' && t1.start === 4 && t1.end === 4, t1)

  const t2 = applyTabIndent('  hello', 5, 5, true)
  check('单光标 Shift+Tab 去掉行首 2 空格', t2.text === 'hello' && t2.start === 3 && t2.end === 3, t2)

  const t3 = applyTabIndent('\thello', 3, 3, true)
  check('单光标 Shift+Tab 去掉行首 1 个制表符', t3.text === 'hello' && t3.start === 2 && t3.end === 2, t3)

  const multi = 'line1\nline2\nline3'
  const t4 = applyTabIndent(multi, 2, 10, false)
  check('多行选区 Tab 给每行加 2 空格', t4.text === '  line1\n  line2\nline3' && t4.start === 4 && t4.end === 14, t4)

  const t5 = applyTabIndent('  line1\n  line2\nline3', 4, 14, true)
  check('多行选区 Shift+Tab 还原缩进', t5.text === 'line1\nline2\nline3' && t5.start === 2 && t5.end === 10, t5)

  // 边界：首行为空行（text[0] === '\n'）且 start === 0
  const tLeading1 = applyTabIndent('\n  abc', 0, 1, false)
  check('首行空行选中 [0,1] 按 Tab 不复制文本', tLeading1.text === '  \n  abc', tLeading1)
  const tLeading2 = applyTabIndent('\n  abc', 0, 0, true)
  check('首行空行光标在 0 按 Shift+Tab 不误删第二行缩进', tLeading2.text === '\n  abc' && tLeading2.start === 0, tLeading2)
  const tLeading3 = applyTabIndent('\nline2', 0, 6, false)
  check('首行空行全选按 Tab 给两行都缩进', tLeading3.text === '  \n  line2', tLeading3)

  console.log(`\n${failed === 0 ? '远程编辑器回归全部通过' : `${failed} 项失败`}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('校验异常:', e)
  process.exit(2)
})
