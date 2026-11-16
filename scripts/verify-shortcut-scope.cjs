/**
 * 快捷键冲突检测的作用域自检（阶段 4）。
 *
 * 背景：项目**本来就有**冲突检测（lib/shortcutConflict.ts，99 行，设置面板里还有
 * 冲突提示与「一键恢复冲突项」）。阶段 0 的审计说「没有冲突检测」是错的 ——
 * 当时只 grep 了 matchShortcut 相关模式，漏掉了这个文件。
 *
 * 真正缺的是**作用域**：原实现只按「归一化后的键」分组，把跨作用域重复也判成冲突。
 * 具体后果：终端内搜索默认就是 Ctrl+F（terminal 作用域），用户想再给某个全局动作
 * 设 Ctrl+F 会被拦下，而这两个键实际不会同时触发。
 *
 * 4 条断言（全走真实函数，不 mock）：
 *   1. 默认映射无冲突；
 *   2. 全局动作设成 Ctrl+F（与终端搜索同名）**不算冲突**；
 *   3. 同一作用域内重复（两个 global 动作都用 Ctrl+K）**算冲突**；
 *   4. checkSingleConflict 也按作用域判断（跨作用域返回 null）。
 *
 * 区分度：把 SHORTCUT_SCOPE 的判断去掉（即退回原实现），第 2 条会红。
 *
 * 用法：node scripts/verify-shortcut-scope.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.tsc-verify')
fs.mkdirSync(OUT_DIR, { recursive: true })
const bundle = path.join(OUT_DIR, 'shortcut-conflict-bundle.cjs')
esbuild.buildSync({
  stdin: {
    contents: `export { detectShortcutConflicts, checkSingleConflict } from './src/renderer/src/lib/shortcutConflict'\nexport { SHORTCUT_SCOPE, SHORTCUT_ACTIONS, resolveShortcuts } from './src/renderer/src/lib/shortcuts'`,
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
const M = require(bundle)

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : '')) }
}

console.log('\n[快捷键冲突 · 作用域]')

/* 1. 默认映射无冲突 */
const base = M.detectShortcutConflicts(undefined)
check('默认映射无冲突', base.length === 0, base)

/* 2. 跨作用域同名不冲突 */
const cross = M.detectShortcutConflicts({ commandCenter: 'Ctrl+F' })
check('全局动作设 Ctrl+F（与终端搜索同名）不算冲突', cross.length === 0, cross)

/* 3. 同作用域重复算冲突 */
const same = M.detectShortcutConflicts({ commandCenter: 'Ctrl+N' })
check('两个 global 动作都用 Ctrl+N 算冲突', same.length === 1 && same[0].actions.length === 2 && same[0].scope === 'global', same)

/* 4. 单键检查同样按作用域 */
const singleCross = M.checkSingleConflict('Ctrl+F', 'commandCenter', undefined, 'global')
check('checkSingleConflict 跨作用域返回 null', singleCross === null, singleCross)
const singleSame = M.checkSingleConflict('Ctrl+K', 'settings', undefined, 'global')
check('checkSingleConflict 同作用域命中命令中心', !!singleSame && singleSame.id === 'commandCenter', singleSame)

/* 5. 作用域表覆盖全部动作（防止新增动作漏登记而默认落 global 造成误判） */
const actions = M.SHORTCUT_ACTIONS.map((a) => a.id)
const missing = actions.filter((id) => !M.SHORTCUT_SCOPE[id])
check('每个动作都登记了作用域（缺 ' + missing.length + '）', missing.length === 0, missing)

console.log('\n通过 ' + pass + '  失败 ' + fail)
process.exit(fail === 0 ? 0 : 1)
