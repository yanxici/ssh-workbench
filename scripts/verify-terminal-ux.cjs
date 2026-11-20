/**
 * 终端交互体验回归（WP1 / WP2 / WP3）：
 *   1. WP1：右键「发送文件…」不再被 startUpload([]) 静默吞掉
 *   2. WP2：默认 Ctrl+C / Ctrl+V；有选区复制（不清选区），无选区 Ctrl+C 透传 SIGINT；不保留 Ctrl+Shift+C/V 兜底
 *   3. WP3：右键快速复制粘贴（Shift+右键出菜单）、Ctrl+滚轮临时缩放钳制、终端缓冲纯文本提取
 *
 * 用法：node scripts/verify-terminal-ux.cjs
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

function ev(key, { ctrl = false, shift = false, alt = false, meta = false } = {}) {
  return { key, ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta }
}

async function main() {
  // ---- WP1：静态反证（右键发送文件不能走被 paths.length === 0 拦截的分支）----
  const tvSrc = fs.readFileSync(
    path.join(ROOT, 'src/renderer/src/components/terminal/TerminalView.tsx'),
    'utf8'
  )
  check(
    'WP1: 右键「发送文件…」不再调用 startUpload([]) 被空数组拦截',
    !/startUpload\(\s*\[\s*\]\s*\)/.test(tvSrc)
  )
  check(
    'WP1: 右键「发送文件…」走主进程弹框路径（window.api.trzsz.upload(sessionId)）',
    /window\.api\.trzsz\.upload\(\s*sessionId\s*\)/.test(tvSrc)
  )

  // ---- WP2 & WP3 纯函数行为断言 ----
  const bundle = path.join(OUT, 'terminal-ux.cjs')
  await esbuild.build({
    stdin: {
      contents: `
        export { SHORTCUT_ACTIONS, resolveShortcuts } from './src/renderer/src/lib/shortcuts'
        export {
          decideTerminalCopy,
          decideRightClickAction,
          stepTempFontSize,
          extractTerminalLines,
          extractTerminalBuffer,
          TEMP_FONT_MIN,
          TEMP_FONT_MAX
        } from './src/renderer/src/lib/terminalUx'
      `,
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'error',
    alias: { '@shared': path.join(ROOT, 'src/shared') }
  })

  const {
    resolveShortcuts,
    decideTerminalCopy,
    decideRightClickAction,
    stepTempFontSize,
    extractTerminalLines,
    extractTerminalBuffer,
    TEMP_FONT_MIN,
    TEMP_FONT_MAX
  } = require(bundle)

  // WP2: 默认快捷键
  const defaults = resolveShortcuts(undefined)
  check('WP2: 默认 terminalCopy === Ctrl+C', defaults.terminalCopy === 'Ctrl+C', defaults.terminalCopy)
  check('WP2: 默认 terminalPaste === Ctrl+V', defaults.terminalPaste === 'Ctrl+V', defaults.terminalPaste)

  // WP2: 智能 Ctrl+C 判定
  check(
    'WP2: Ctrl+C 有选区 -> copy',
    decideTerminalCopy(ev('c', { ctrl: true }), 'Ctrl+C', true) === 'copy'
  )
  check(
    'WP2: Ctrl+C 无选区 -> passthrough（透传 SIGINT）',
    decideTerminalCopy(ev('c', { ctrl: true }), 'Ctrl+C', false) === 'passthrough'
  )
  check(
    'WP2: 默认模式下 Ctrl+Shift+C 不作为兜底复制 -> unmatched',
    decideTerminalCopy(ev('c', { ctrl: true, shift: true }), 'Ctrl+C', true) === 'unmatched'
  )
  check(
    'WP2: 自定义为 Ctrl+Shift+C 时无选区 -> noop（不透传）',
    decideTerminalCopy(ev('c', { ctrl: true, shift: true }), 'Ctrl+Shift+C', false) === 'noop'
  )
  check(
    'WP2: 自定义为 Ctrl+Shift+C 时有选区 -> copy',
    decideTerminalCopy(ev('c', { ctrl: true, shift: true }), 'Ctrl+Shift+C', true) === 'copy'
  )

  // WP2: TerminalView 源码护栏（复制不清选区 + Ctrl+V preventDefault 防双粘贴）
  check(
    'WP2: TerminalView 复制后不调用 clearSelection()',
    !/clearSelection\s*\(/.test(tvSrc)
  )
  check(
    'WP2: TerminalView 粘贴快捷键分支调用 e.preventDefault() 防双粘贴',
    /matchShortcut\(e,\s*map\.terminalPaste\)[\s\S]{0,200}e\.preventDefault\(\)/.test(tvSrc)
  )

  // WP3: 右键行为判定
  check(
    'WP3: 关闭右键快速粘贴时永远弹菜单',
    decideRightClickAction(false, false, false) === 'menu' &&
      decideRightClickAction(false, false, true) === 'menu'
  )
  check(
    'WP3: 开启右键快速粘贴 + 无选区 -> paste',
    decideRightClickAction(true, false, false) === 'paste'
  )
  check(
    'WP3: 开启右键快速粘贴 + 有选区 -> copy',
    decideRightClickAction(true, false, true) === 'copy'
  )
  check(
    'WP3: 开启右键快速粘贴 + Shift 键 -> menu',
    decideRightClickAction(true, true, false) === 'menu' &&
      decideRightClickAction(true, true, true) === 'menu'
  )

  // WP3: Ctrl+滚轮临时字号钳制
  check('WP3: 向上滚（deltaY < 0）字号 +1', stepTempFontSize(13.5, -100) === 14.5)
  check('WP3: 向下滚（deltaY > 0）字号 -1', stepTempFontSize(13.5, 100) === 12.5)
  check('WP3: 上限钳制到 TEMP_FONT_MAX', stepTempFontSize(TEMP_FONT_MAX, -100) === TEMP_FONT_MAX)
  check('WP3: 下限钳制到 TEMP_FONT_MIN', stepTempFontSize(TEMP_FONT_MIN, 100) === TEMP_FONT_MIN)
  check('WP3: deltaY === 0 不变', stepTempFontSize(14, 0) === 14)

  // WP3: 终端缓冲纯文本提取（合并 isWrapped 续行 + 裁剪尾部空行）
  const exported = extractTerminalLines([
    { text: 'root@box:~# echo hi', isWrapped: false },
    { text: 'very-long-line-part1-', isWrapped: false },
    { text: 'part2-wrapped', isWrapped: true },
    { text: '', isWrapped: false },
    { text: 'after blank', isWrapped: false },
    { text: '', isWrapped: false },
    { text: '   ', isWrapped: false }
  ])
  check(
    'WP3: 缓冲提取正确拼接续行、保留中间空行、裁掉尾部空白行',
    exported === 'root@box:~# echo hi\nvery-long-line-part1-part2-wrapped\n\nafter blank',
    exported
  )

  // WP3: Ctrl+wheel 捕获阶段监听 + stopPropagation（防止 TUI 吞掉缩放事件）
  check(
    'WP3: Ctrl+wheel 在 capture 阶段监听并 stopPropagation',
    /addEventListener\(\s*'wheel'\s*,\s*onWheel\s*,\s*\{\s*passive:\s*false\s*,\s*capture:\s*true\s*\}\s*\)/.test(tvSrc) &&
      /removeEventListener\(\s*'wheel'\s*,\s*onWheel\s*,\s*\{\s*capture:\s*true\s*\}\s*\)/.test(tvSrc) &&
      /onWheel[\s\S]{0,200}e\.stopPropagation\(\)/.test(tvSrc)
  )

  // WP3: extractTerminalBuffer 软换行处不裁剪行尾空格
  const fakeTerm = {
    buffer: {
      active: {
        length: 2,
        getLine(i) {
          if (i === 0) {
            return {
              isWrapped: false,
              translateToString: (trimRight) => (trimRight ? 'hello' : 'hello ')
            }
          }
          if (i === 1) {
            return {
              isWrapped: true,
              translateToString: (trimRight) => (trimRight ? 'world' : 'world   ')
            }
          }
          return undefined
        }
      }
    }
  }
  const wrappedText = extractTerminalBuffer(fakeTerm)
  check(
    'WP3: extractTerminalBuffer 在下一行 isWrapped=true 时保留行尾空格',
    wrappedText === 'hello world',
    wrappedText
  )

  console.log(`\n${failed === 0 ? '终端体验回归全部通过' : `${failed} 项失败`}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('校验异常:', e)
  process.exit(2)
})
