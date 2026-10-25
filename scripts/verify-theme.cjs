/**
 * 配色主题自检：colorThemes.ts 的完整性与合法性。
 * 重点防御：
 *   1. 每个主题必须同时提供 dark / light 两套（否则某种明暗组合会缺色）
 *   2. 变量必须齐全（缺一个 --c-xxx 会让对应 tailwind 类失效，静默变透明）
 *   3. 颜色必须是「R G B」三通道数字（tailwind <alpha-value> 依赖此格式）
 *   4. 未知主题 id 必须回落到默认主题（vscode），老配置不能崩
 *   5. 各主题在暗色下应真正互不相同（防止复制粘贴漏改）
 * 用法：node scripts/verify-theme.cjs
 */
const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const out = path.join(ROOT, '.tsc-verify', 'color-themes.cjs')
fs.mkdirSync(path.dirname(out), { recursive: true })
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'src/renderer/src/theme/colorThemes.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error'
})
const { COLOR_THEMES, getColorTheme, getThemeVariant, getXtermTheme } = require(out)

let pass = 0
let fail = 0
function ok(name, cond, detail) {
  if (cond) pass++
  else {
    fail++
    console.log(`  ✗ ${name}${detail ? `\n    ${detail}` : ''}`)
  }
}

// 与 styles/index.css 的 :root / .light 一一对应，缺一不可
const REQUIRED_VARS = [
  'app',
  'panel',
  'raised',
  'hover',
  'edge',
  'edge-soft',
  'ink',
  'ink-2',
  'ink-3',
  // 外壳重构（P4-d）后新增：品牌绿 / 品牌底上的字色 / 选中态
  'brand',
  'on-brand',
  'select',
  'accent',
  'success',
  'warning',
  'danger'
]

const TERMINAL_KEYS = [
  'background',
  'foreground',
  'cursor',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white'
]

/* ---------- 1. 主题清单 ---------- */
// 7 套：v1.0.0 的 6 套 + 界面重构时新增的 vscode（默认浅色规范配色）
ok('主题数量为 7', COLOR_THEMES.length === 7, `实际 ${COLOR_THEMES.length}`)
const ids = COLOR_THEMES.map((t) => t.id)
ok('主题 id 无重复', new Set(ids).size === ids.length, ids.join(','))
ok('包含 workbench 默认主题', ids.includes('workbench'))

/* ---------- 2. 结构完整性 ---------- */
for (const t of COLOR_THEMES) {
  ok(`${t.id}: 有名称`, typeof t.name === 'string' && t.name.length > 0)
  ok(`${t.id}: swatch 为 3 色`, Array.isArray(t.swatch) && t.swatch.length === 3)
  for (const mode of ['dark', 'light']) {
    const v = t[mode]
    ok(`${t.id}.${mode}: 变体存在`, !!v)
    if (!v) continue
    for (const key of REQUIRED_VARS) {
      const val = v.vars[key]
      ok(`${t.id}.${mode}: 变量 ${key} 存在`, typeof val === 'string' && val.length > 0)
      if (typeof val === 'string') {
        ok(
          `${t.id}.${mode}: ${key} 为 R G B 三通道`,
          /^\d{1,3} \d{1,3} \d{1,3}$/.test(val),
          `得到 "${val}"`
        )
        const [r, g, b] = val.split(' ').map(Number)
        ok(
          `${t.id}.${mode}: ${key} 通道在 0-255`,
          r >= 0 && r <= 255 && g >= 0 && g <= 255 && b >= 0 && b <= 255,
          `得到 "${val}"`
        )
      }
    }
    ok(
      `${t.id}.${mode}: 无多余变量`,
      Object.keys(v.vars).length === REQUIRED_VARS.length,
      `实际 ${Object.keys(v.vars).length} 个`
    )
    for (const key of TERMINAL_KEYS) {
      ok(`${t.id}.${mode}: 终端色 ${key} 存在`, typeof v.terminal[key] === 'string')
    }
    ok(
      `${t.id}.${mode}: 终端背景与前景不同`,
      v.terminal.background !== v.terminal.foreground
    )
  }
}

/* ---------- 3. 暗色主题之间必须真正有差异 ---------- */
const darkApps = COLOR_THEMES.map((t) => t.id + ':' + t.dark.vars.app)
ok('各主题暗色背景互不相同', new Set(darkApps).size === COLOR_THEMES.length, darkApps.join('  '))
const darkAccents = COLOR_THEMES.map((t) => t.id + ':' + t.dark.vars.accent)
ok('各主题暗色强调色互不相同', new Set(darkAccents).size === COLOR_THEMES.length)
const termBgs = COLOR_THEMES.map((t) => t.dark.terminal.background)
ok('各主题终端背景互不相同', new Set(termBgs).size === COLOR_THEMES.length, termBgs.join('  '))

/* ---------- 4. 回退行为 ---------- */
ok('未知 id 回落到 vscode（默认主题）', getColorTheme('not-a-theme').id === 'vscode')
ok('undefined 回落到 vscode', getColorTheme(undefined).id === 'vscode')
ok('空字符串回落到 vscode', getColorTheme('').id === 'vscode')
ok('已知 id 正常返回', getColorTheme('dracula').id === 'dracula')
ok('getThemeVariant dark 命中暗色', getThemeVariant('nord', true).vars.app === '36 41 51')
ok('getThemeVariant light 命中亮色', getThemeVariant('nord', false).vars.app === '236 239 244')
ok(
  '未知 id 的 variant 也回落',
  getThemeVariant('zzz', true).vars.app === COLOR_THEMES[0].dark.vars.app
)
ok('getXtermTheme 返回终端调色板', getXtermTheme('gruvbox', true).background === '#1D2021')
ok('getXtermTheme 亮色', getXtermTheme('gruvbox', false).background === '#FBF1C7')

/* ---------- 5. 明暗两套变量必须不同（否则切换明暗无效果） ---------- */
for (const t of COLOR_THEMES) {
  ok(`${t.id}: 明暗背景不同`, t.dark.vars.app !== t.light.vars.app)
  ok(`${t.id}: 明暗前景不同`, t.dark.vars.ink !== t.light.vars.ink)
  ok(`${t.id}: 明暗终端背景不同`, t.dark.terminal.background !== t.light.terminal.background)
}

/* ---------- 6. 亮色主题必须真的够亮（防止暗色值误填进 light） ---------- */
for (const t of COLOR_THEMES) {
  const [r, g, b] = t.light.vars.app.split(' ').map(Number)
  const luma = 0.299 * r + 0.587 * g + 0.114 * b
  ok(`${t.id}: 亮色背景亮度 > 128`, luma > 128, `亮度 ${luma.toFixed(1)}`)
  const [dr, dg, db] = t.dark.vars.app.split(' ').map(Number)
  const dluma = 0.299 * dr + 0.587 * dg + 0.114 * db
  ok(`${t.id}: 暗色背景亮度 < 128`, dluma < 128, `亮度 ${dluma.toFixed(1)}`)
}

/* ---------- 7. 对比度：正文可读性下限（WCAG 相对亮度比 >= 4.5） ---------- */
function relLuma(v) {
  const [r, g, b] = v.split(' ').map((n) => {
    const c = Number(n) / 255
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function contrast(a, b) {
  const l1 = relLuma(a)
  const l2 = relLuma(b)
  const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}
for (const t of COLOR_THEMES) {
  for (const mode of ['dark', 'light']) {
    const v = t[mode]
    const c = contrast(v.vars.ink, v.vars.panel)
    ok(
      `${t.id}.${mode}: 正文对比度 >= 7`,
      c >= 7,
      `ink/panel = ${c.toFixed(2)}`
    )
    const c2 = contrast(v.vars['ink-2'], v.vars.panel)
    ok(`${t.id}.${mode}: 次要文字对比度 >= 3.5`, c2 >= 3.5, `ink-2/panel = ${c2.toFixed(2)}`)
    const c3 = contrast(v.vars.ink, v.vars.app)
    ok(`${t.id}.${mode}: 正文在 app 底对比度 >= 7`, c3 >= 7, `ink/app = ${c3.toFixed(2)}`)
  }
}

/* ---------- 8. 终端前景/背景对比度 ---------- */
for (const t of COLOR_THEMES) {
  for (const mode of ['dark', 'light']) {
    const tm = t[mode].terminal
    const c = contrast(hexToRgbStr(tm.foreground), hexToRgbStr(tm.background))
    ok(`${t.id}.${mode}: 终端前景对比度 >= 7`, c >= 7, `${tm.foreground} on ${tm.background} = ${c.toFixed(2)}`)
  }
}
function hexToRgbStr(hex) {
  const h = hex.replace('#', '')
  const n = parseInt(h, 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

/* ---------- 9. 随机压测：任意 id 组合查询都不抛异常 ---------- */
const POOL = [...ids, 'not-a-theme', '', undefined, null, 'DRACULA', '  ', '0']
let rndFail = 0
for (let i = 0; i < 2000; i++) {
  const id = POOL[Math.floor(Math.random() * POOL.length)]
  const dark = Math.random() < 0.5
  try {
    const v = getThemeVariant(id, dark)
    if (Object.keys(v.vars).length !== REQUIRED_VARS.length) rndFail++
    if (!v.terminal.background) rndFail++
    const x = getXtermTheme(id, dark)
    if (!x.foreground) rndFail++
  } catch (e) {
    rndFail++
  }
}
ok('随机 2000 次查询无异常/无缺变量', rndFail === 0, `失败 ${rndFail} 次`)

/* ---------- 10. 源码接线断言：设置面板与终端确实用了新主题 ---------- */
const fsx = require('fs')
const settingsSrc = fsx.readFileSync(
  path.join(ROOT, 'src/renderer/src/components/settings/SettingsPanel.tsx'),
  'utf8'
)
ok('设置面板渲染 ColorThemeGallery', settingsSrc.includes('<ColorThemeGallery'))
ok('设置面板提交 colorTheme', settingsSrc.includes('update({ colorTheme: v })'))

const storeSrc = fsx.readFileSync(path.join(ROOT, 'src/renderer/src/stores/settingsStore.ts'), 'utf8')
ok('settingsStore 写入 CSS 变量', storeSrc.includes('setProperty(`--c-${key}`'))
ok('settingsStore load 时应用主题', storeSrc.includes('applyTheme(settings.theme, settings.colorTheme)'))
ok('settingsStore update 时应用主题', storeSrc.includes('applyTheme(next.theme, next.colorTheme)'))

const termSrc = fsx.readFileSync(
  path.join(ROOT, 'src/renderer/src/components/terminal/TerminalView.tsx'),
  'utf8'
)
ok('TerminalView 初始化用 getXtermTheme', termSrc.includes('getXtermTheme(settings.colorTheme'))
ok('TerminalView 订阅 colorTheme', termSrc.includes('settings.colorTheme)'))
ok('TerminalView 不再引用已删除模块', !termSrc.includes('terminalThemes'))

ok(
  '旧的 terminalThemes.ts 已删除',
  !fsx.existsSync(path.join(ROOT, 'src/renderer/src/theme/terminalThemes.ts'))
)

/* ---------- 11. 数据模型断言 ---------- */
const typesSrc = fsx.readFileSync(path.join(ROOT, 'src/shared/types.ts'), 'utf8')
ok('types.ts 定义 ColorThemeId', typesSrc.includes('export type ColorThemeId'))
ok('AppSettings 含 colorTheme', typesSrc.includes('colorTheme?: ColorThemeId'))
const repoSrc = fsx.readFileSync(path.join(ROOT, 'src/main/store/repository.ts'), 'utf8')
ok('主进程 DEFAULT_SETTINGS 含 colorTheme', repoSrc.includes("colorTheme: 'vscode'"))

/* ---------- 12. CSS 变量表与主题定义必须对得上 ---------- */
const cssSrc = fsx.readFileSync(path.join(ROOT, 'src/renderer/src/styles/index.css'), 'utf8')
for (const key of REQUIRED_VARS) {
  ok(`index.css 声明了 --c-${key}`, cssSrc.includes(`--c-${key}:`))
}

console.log(`\n配色主题自检：通过 ${pass}  失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
