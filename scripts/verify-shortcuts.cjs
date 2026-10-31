/**
 * 验证快捷键解析与匹配，重点是新增的「忽略 Shift」反匹配。
 *
 * 用法：node scripts/verify-shortcuts.cjs
 *
 * 背景：Ctrl+Shift+Tab（上一个标签）此前永远不可达 —— App.tsx 里
 * `matchShortcut(e, map.nextTab)` 在 shift 上精确比对，nextTab 默认是
 * Ctrl+Tab（无 shift），所以 Ctrl+Shift+Tab 直接返回 null，
 * 分支内的 `e.shiftKey ? -1 : 1` 反向逻辑是死代码。
 * 现在用 matchShortcutIgnoringShift 承接反向，本脚本锁住这个行为。
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

/** 构造一个最小的 KeyboardEvent 替身（纯函数只读这几个字段） */
function ev(key, { ctrl = false, shift = false, alt = false, meta = false } = {}) {
  return { key, ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta }
}

async function main() {
  const bundle = path.join(OUT, 'shortcuts.cjs')
  await esbuild.build({
    stdin: {
      contents: `
        export {
          parseShortcut, matchShortcut, matchShortcutIgnoringShift,
          resolveShortcuts, SHORTCUT_ACTIONS
        } from './src/renderer/src/lib/shortcuts'
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
    parseShortcut,
    matchShortcut,
    matchShortcutIgnoringShift,
    resolveShortcuts,
    SHORTCUT_ACTIONS
  } = require(bundle)

  // ---- parseShortcut ----
  const p1 = parseShortcut('Ctrl+Shift+W')
  check('解析 Ctrl+Shift+W', p1 && p1.ctrl && p1.shift && !p1.alt && p1.key === 'w', p1)
  const p2 = parseShortcut('Ctrl+,')
  check('解析 Ctrl+, 单键', p2 && p2.key === ',', p2)
  const p3 = parseShortcut('control + alt + b')
  check('容错空格与 control 别名', p3 && p3.ctrl && p3.alt && p3.key === 'b', p3)
  check('空串返回 null', parseShortcut('') === null)
  check('只有修饰键返回 null', parseShortcut('Ctrl+Shift') === null)

  // ---- matchShortcut 精确比对 ----
  check('Ctrl+F 命中 Ctrl+F', matchShortcut(ev('f', { ctrl: true }), 'Ctrl+F') !== null)
  check('Ctrl+Shift+F 不命中 Ctrl+F（shift 精确比对）',
    matchShortcut(ev('f', { ctrl: true, shift: true }), 'Ctrl+F') === null)
  check('Ctrl+F 不命中 Ctrl+Shift+F',
    matchShortcut(ev('f', { ctrl: true }), 'Ctrl+Shift+F') === null)
  check('meta 视作 ctrl（mac）', matchShortcut(ev('f', { meta: true }), 'Ctrl+F') !== null)
  check('alt 不同不命中', matchShortcut(ev('f', { ctrl: true, alt: true }), 'Ctrl+F') === null)

  // ---- 关键：Ctrl+Shift+Tab 反向可达 ----
  const nextTabCombo = 'Ctrl+Tab'
  check('Ctrl+Tab 命中 nextTab',
    matchShortcut(ev('Tab', { ctrl: true }), nextTabCombo) !== null)
  check('Ctrl+Shift+Tab 不命中 nextTab（这就是历史上的死分支）',
    matchShortcut(ev('Tab', { ctrl: true, shift: true }), nextTabCombo) === null)
  check('Ctrl+Shift+Tab 命中「忽略 Shift」版（修复后）',
    matchShortcutIgnoringShift(ev('Tab', { ctrl: true, shift: true }), nextTabCombo) !== null)
  check('Ctrl+Tab 也命中「忽略 Shift」版',
    matchShortcutIgnoringShift(ev('Tab', { ctrl: true }), nextTabCombo) !== null)
  check('Ctrl+Alt+Tab 不被「忽略 Shift」误命中',
    matchShortcutIgnoringShift(ev('Tab', { ctrl: true, alt: true }), nextTabCombo) === null)
  check('无修饰的 Tab 不被命中',
    matchShortcutIgnoringShift(ev('Tab'), nextTabCombo) === null)
  check('Ctrl+Shift+Q 不命中 Ctrl+Tab',
    matchShortcutIgnoringShift(ev('q', { ctrl: true, shift: true }), nextTabCombo) === null)

  // ---- resolveShortcuts：缺失项回退默认 ----
  const map = resolveShortcuts(undefined)
  check('未配置时全部回退默认值',
    SHORTCUT_ACTIONS.every((a) => map[a.id] === a.default), map)
  const custom = resolveShortcuts({ terminalSearch: 'Ctrl+G' })
  check('自定义 terminalSearch 生效', custom.terminalSearch === 'Ctrl+G', custom.terminalSearch)
  check('其余项仍回退默认', custom.closeTab === 'Ctrl+Shift+W', custom.closeTab)

  // ---- 终端三项确实在动作表里（死配置修复的前提） ----
  for (const id of ['terminalSearch', 'terminalCopy', 'terminalPaste']) {
    check(`动作表包含 ${id}`, SHORTCUT_ACTIONS.some((a) => a.id === id))
  }

  console.log(`\n${failed === 0 ? '快捷键回归全部通过' : `${failed} 项失败`}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('校验异常:', e)
  process.exit(2)
})
