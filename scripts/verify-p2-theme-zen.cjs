/**
 * P2「精密仪表外壳 + 主题精简」回归。
 *
 * 判据分四块，每块都能独立变红：
 *   1. 主题兼容层：normalizeColorTheme 把 7 套里的 3 套旧 ID 映射到 vscode，
 *      合法 ID 原样返回 —— 这是「老配置不炸」的唯一入口；
 *   2. 设置迁移：v2 配置（theme:'dark' + colorTheme:'nord'）升到 v3 后
 *      colorTheme 变 vscode，但 theme 必须仍是 dark（v2 的 theme='light' 不能重跑），
 *      字体/栏宽等用户自定义值一个都不许丢；
 *   3. 4 套配色：ID 顺序、「brand 互不相同且不再有硬编码 39 201 63」、
 *      8 组变体的 WCAG 对比度（ink/on-brand 相对 app/panel/brand >= 4.5:1）、
 *      亮色下 raised 或 edge 必须与 app 有差（白底白框塌陷判据）；
 *   4. Zen 专注模式状态机（Task 5 加入）：开启记快照并收起双栏、退出精确还原、
 *      期间手动展开任一栏自动退出。
 *
 * 为什么不用 playwright/真 Electron：这些判据全是纯数据（变量表、设置对象、
 * 状态机返回值），一旦搬进真窗口，跑一次要 20 秒且会被 GPU/字体差异干扰。
 * 唯一需要「真跑」的是设置读写 —— 这里用临时 userData 真的读一次 settings.json，
 * 断言的是**迁移后的对象**，不是源码里有没有那行代码。
 *
 * 用法：node scripts/verify-p2-theme-zen.cjs
 */
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, '.tsc-verify')
fs.mkdirSync(OUT, { recursive: true })

let failed = 0
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name)
  else {
    failed++
    console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''))
  }
}

/**
 * electron 的桩。
 *
 * app.getPath 读环境变量而不是写死路径：同一个 bundle 要在多个临时 userData
 * 之间来回切（每个场景一份 settings.json），路径必须在 require 那一刻才确定。
 */
const ELECTRON_STUB = [
  "exports.app = {",
  "  getPath: () => process.env.P2_SETTINGS_TMP,",
  "  getVersion: () => '0.0.0-test',",
  "  getName: () => 'ssh-workbench-test',",
  "  isPackaged: false",
  "}",
  "exports.safeStorage = {",
  "  isEncryptionAvailable: () => false,",
  "  encryptString: (s) => Buffer.from(s),",
  "  decryptString: (b) => b.toString()",
  "}",
  "exports.net = { request: () => ({ on() {}, end() {}, write() {}, abort() {} }) }",
  ''
].join('\n')

async function bundle(name, entryContents) {
  const stub = path.join(OUT, 'electron-stub-' + name + '.cjs')
  fs.writeFileSync(stub, ELECTRON_STUB, 'utf8')
  const outfile = path.join(OUT, name + '.cjs')
  await esbuild.build({
    stdin: { contents: entryContents, resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    external: ['ssh2'],
    logLevel: 'error',
    alias: {
      '@shared': path.join(ROOT, 'src', 'shared'),
      '@': path.join(ROOT, 'src', 'renderer', 'src')
    },
    plugins: [
      {
        name: 'stub-electron',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: stub }))
        }
      }
    ]
  })
  return outfile
}

/** 丢掉 require 缓存重新加载：每个场景都要一份干净的 JsonStore 内存缓存 */
function loadFresh(outfile) {
  delete require.cache[require.resolve(outfile)]
  return require(outfile)
}

/** 相对亮度（WCAG 2.1 定义） */
function luminance(rgb) {
  const ch = String(rgb)
    .trim()
    .split(/\s+/)
    .map((v) => Number(v) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)))
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}

/** 对比度，保留两位小数方便读报告 */
function contrast(a, b) {
  const la = luminance(a)
  const lb = luminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100
}

async function main() {
  /* ---------------- 1. 主题兼容层 ---------------- */
  console.log('\ncompat: normalizeColorTheme 是老的 7 套 ID 的唯一出口')
  const compatOut = await bundle('p2-compat', "export * from './src/shared/themeCompat'")
  const compat = loadFresh(compatOut)

  check(
    'ACTIVE_COLOR_THEMES 恰好是 4 套且顺序稳定',
    JSON.stringify(compat.ACTIVE_COLOR_THEMES) === JSON.stringify(['vscode', 'mono', 'solarized', 'dracula']),
    compat.ACTIVE_COLOR_THEMES
  )
  for (const id of ['vscode', 'mono', 'solarized', 'dracula']) {
    check('合法 ID 原样保留：' + id, compat.normalizeColorTheme(id) === id, compat.normalizeColorTheme(id))
  }
  for (const id of ['nord', 'workbench', 'onedark', 'gruvbox', 'no-such-theme', '', undefined, null]) {
    check(
      '退役/未知 ID 回落 vscode：' + String(id),
      compat.normalizeColorTheme(id) === 'vscode',
      compat.normalizeColorTheme(id)
    )
  }

  /* ---------------- 2. 设置迁移 ---------------- */
  console.log('\nmigration: v3 只迁配色，不动用户的 dark/light 与自定义值')
  const settingsOut = await bundle(
    'p2-settings',
    "export { getSettings, DEFAULT_SETTINGS } from './src/main/store/repo/settings'"
  )

  async function settingsAfter(stored) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2-settings-'))
    fs.mkdirSync(path.join(tmp, 'data'), { recursive: true })
    if (stored !== null) {
      fs.writeFileSync(path.join(tmp, 'data', 'settings.json'), JSON.stringify(stored, null, 2), 'utf8')
    }
    process.env.P2_SETTINGS_TMP = tmp
    const mod = loadFresh(settingsOut)
    const value = await mod.getSettings()
    return { value, tmp, mod }
  }

  const legacy = await settingsAfter({
    uiShellVersion: 2,
    theme: 'dark',
    colorTheme: 'nord',
    terminal: { fontSize: 15 }
  })
  check('v2 -> v3 后 uiShellVersion 变成 3', legacy.value.uiShellVersion === 3, legacy.value.uiShellVersion)
  check('退役配色 nord 迁到 vscode', legacy.value.colorTheme === 'vscode', legacy.value.colorTheme)
  check('用户的 dark 偏好不被 v2 规则二次覆盖', legacy.value.theme === 'dark', legacy.value.theme)
  check('自定义字号保留', legacy.value.terminal.fontSize === 15, legacy.value.terminal.fontSize)
  fs.rmSync(legacy.tmp, { recursive: true, force: true })

  const keep = await settingsAfter({ uiShellVersion: 2, theme: 'system', colorTheme: 'mono' })
  check('仍在的配色不改写：mono', keep.value.colorTheme === 'mono', keep.value.colorTheme)
  check('跟随系统的 theme 保留', keep.value.theme === 'system', keep.value.theme)
  fs.rmSync(keep.tmp, { recursive: true, force: true })

  const modern = await settingsAfter({
    uiShellVersion: 3,
    theme: 'dark',
    colorTheme: 'dracula',
    terminal: { fontSize: 11, lineHeight: 1.5 },
    layout: { sidebar: 333 }
  })
  check('已是 v3 时配色不被动', modern.value.colorTheme === 'dracula', modern.value.colorTheme)
  check('已是 v3 时字号/行高不被动', modern.value.terminal.fontSize === 11 && modern.value.terminal.lineHeight === 1.5, modern.value.terminal)
  check('已是 v3 时侧栏宽度不被动', modern.value.layout.sidebar === 333, modern.value.layout)
  fs.rmSync(modern.tmp, { recursive: true, force: true })

  const handEdited = await settingsAfter({ uiShellVersion: 3, theme: 'light', colorTheme: 'onedark' })
  check('手改配置文件写回来的退役 ID 也兜底成 vscode', handEdited.value.colorTheme === 'vscode', handEdited.value.colorTheme)
  fs.rmSync(handEdited.tmp, { recursive: true, force: true })

  const empty = await settingsAfter(null)
  check('首装默认配色是 vscode', empty.value.colorTheme === 'vscode', empty.value.colorTheme)
  check('默认设置对象本身也是 vscode', empty.mod.DEFAULT_SETTINGS.colorTheme === 'vscode', empty.mod.DEFAULT_SETTINGS.colorTheme)
  fs.rmSync(empty.tmp, { recursive: true, force: true })

  /* ---------------- 3. 4 套配色 ---------------- */
  console.log('\npalette: 4 套主题彼此可辨，8 组变体全部满足 WCAG 4.5:1')
  const themeOut = await bundle(
    'p2-themes',
    "export * from './src/renderer/src/theme/colorThemes'"
  )
  const themes = loadFresh(themeOut)
  const defs = themes.COLOR_THEMES

  check('COLOR_THEMES 恰好 4 套', defs.length === 4, defs.map((t) => t.id))
  check(
    '4 套 ID 顺序稳定且与共享层一致',
    JSON.stringify(defs.map((t) => t.id)) === JSON.stringify(['vscode', 'mono', 'solarized', 'dracula']),
    defs.map((t) => t.id)
  )
  check(
    '每套都有英文风格标签 tagline（不新增中文硬编码）',
    defs.every((t) => typeof t.tagline === 'string' && t.tagline.length > 0 && !/[\u4e00-\u9fff]/.test(t.tagline)),
    defs.map((t) => t.tagline)
  )
  check('每套 swatch 为 3 个十六进制色', defs.every((t) => Array.isArray(t.swatch) && t.swatch.length === 3 && t.swatch.every((c) => /^#[0-9a-fA-F]{6}$/.test(c))), defs.map((t) => t.swatch))

  const darkBrands = defs.map((t) => t.dark.vars.brand)
  check('4 套暗色 brand 互不相同', new Set(darkBrands).size === 4, darkBrands)
  check(
    '已彻底移除旧硬编码亮绿 39 201 63',
    darkBrands.filter((b) => b === '39 201 63').length === 0,
    darkBrands
  )
  check(
    '各主题暗色画布互不相同',
    new Set(defs.map((t) => t.dark.vars.app)).size === 4,
    defs.map((t) => t.dark.vars.app)
  )
  check(
    '各主题终端底色互不相同',
    new Set(defs.map((t) => t.dark.terminal.background)).size === 4,
    defs.map((t) => t.dark.terminal.background)
  )

  for (const t of defs) {
    for (const mode of ['dark', 'light']) {
      const v = t[mode].vars
      const inkApp = contrast(v.ink, v.app)
      const inkPanel = contrast(v.ink, v.panel)
      const onBrand = contrast(v['on-brand'], v.brand)
      const onAccent = contrast(v['on-accent'], v.accent)
      check(t.id + '/' + mode + ' 具备 chrome 外框层变量', typeof v.chrome === 'string' && v.chrome.trim().length > 0, v.chrome)
      check(t.id + '/' + mode + ' ink 对 app >= 4.5:1', inkApp >= 4.5, inkApp)
      check(t.id + '/' + mode + ' ink 对 panel >= 4.5:1', inkPanel >= 4.5, inkPanel)
      check(t.id + '/' + mode + ' on-brand 对 brand >= 4.5:1', onBrand >= 4.5, onBrand)
      check(t.id + '/' + mode + ' on-accent 对 accent >= 4.5:1', onAccent >= 4.5, onAccent)
      console.log(
        '    ' +
          (t.id + '/' + mode).padEnd(18) +
          ' ink/app ' +
          inkApp.toFixed(2).padStart(6) +
          '  ink/panel ' +
          inkPanel.toFixed(2).padStart(6) +
          '  on-brand ' +
          onBrand.toFixed(2).padStart(5) +
          '  on-accent ' +
          onAccent.toFixed(2).padStart(5)
      )
    }
  }

  for (const t of defs) {
    check(
      t.id + ' 亮色外框与画布有层次差异',
      t.light.vars.chrome !== t.light.vars.app && (t.light.vars.raised !== t.light.vars.app || t.light.vars.edge !== t.light.vars.app),
      [t.light.vars.chrome, t.light.vars.raised, t.light.vars.app, t.light.vars.edge]
    )
  }

  check(
    '退役 ID 在取色时回落 VSCODE',
    ['nord', 'onedark', 'workbench', 'nope'].every((id) => themes.getColorTheme(id).id === 'vscode'),
    ['nord', 'onedark', 'workbench', 'nope'].map((id) => themes.getColorTheme(id).id)
  )
  check(
    'getThemeVariant 未知 ID 取默认画布',
    themes.getThemeVariant('nope', true).vars.app === defs[0].dark.vars.app,
    themes.getThemeVariant('nope', true).vars.app
  )

  /* ---------------- 5. Zen 专注模式状态机 ---------------- */
  console.log('\nzen: 开启收双栏、退出精准还原、期间手动展栏自动退出')

  const zenFile = await bundle('p2-zen', "export * from './src/renderer/src/lib/zenState'")
  const zen = loadFresh(zenFile)

  // 1) 双栏全开 → 开启后全收，快照记的是「开启前那一眼」
  const zenOn = zen.enterZen({ sidebarVisible: true, commandRailVisible: true })
  check(
    'enterZen 收起双栏并置 zenMode',
    zenOn.sidebarVisible === false && zenOn.commandRailVisible === false && zenOn.zenMode === true,
    zenOn
  )
  check(
    'enterZen 快照保存开启前的双栏状态',
    zenOn.zenSnapshot && zenOn.zenSnapshot.sidebarVisible === true && zenOn.zenSnapshot.commandRailVisible === true,
    zenOn.zenSnapshot
  )
  const zenOff = zen.exitZen(zenOn.zenSnapshot)
  check(
    'exitZen 按快照精准恢复双栏并清快照',
    zenOff.sidebarVisible === true &&
      zenOff.commandRailVisible === true &&
      zenOff.zenMode === false &&
      zenOff.zenSnapshot === null,
    zenOff
  )

  // 2) 原本只开侧栏、命令栏是收着的 → 退出后命令栏必须还是收着的
  const zenOn2 = zen.enterZen({ sidebarVisible: true, commandRailVisible: false })
  const zenOff2 = zen.exitZen(zenOn2.zenSnapshot)
  check(
    '原本命令栏收起时，退出 Zen 不擅自展开它',
    zenOff2.sidebarVisible === true && zenOff2.commandRailVisible === false,
    zenOff2
  )

  // 3) 真 store 联动：不是测纯函数，而是走 layoutStore 的真实 action，
  //    这样「写了 reconcile 却忘了在 store 里调用」这张假绿跑不掉
  const storeFile = await bundle(
    'p2-layout-store',
    "export { useLayoutStore } from './src/renderer/src/stores/layoutStore'"
  )
  const layout = loadFresh(storeFile).useLayoutStore
  const layoutState = () => layout.getState()
  const resetLayout = () =>
    layout.setState({ sidebarVisible: true, commandRailVisible: true, zenMode: false, zenSnapshot: null })

  resetLayout()
  layoutState().toggleZenMode()
  check(
    'store: toggleZenMode 开启后双栏收起',
    layoutState().zenMode === true &&
      layoutState().sidebarVisible === false &&
      layoutState().commandRailVisible === false,
    layoutState()
  )
  layoutState().setSidebarVisible(true)
  check(
    'store: Zen 中手动展开侧栏 → 自动退出并清快照',
    layoutState().zenMode === false &&
      layoutState().zenSnapshot === null &&
      layoutState().sidebarVisible === true,
    layoutState()
  )

  resetLayout()
  layoutState().toggleZenMode()
  layoutState().setCommandRailVisible(true)
  check(
    'store: Zen 中手动展开命令栏 → 自动退出并清快照',
    layoutState().zenMode === false &&
      layoutState().zenSnapshot === null &&
      layoutState().commandRailVisible === true,
    layoutState()
  )

  /*
   * 活动栏是所有可见性入口里最容易漏的那个：Zen 收起侧栏后，
   * 活动栏是唯一还露在外面的控件，用户点图标就是要展栏。
   * 这条断言走的是真 store 的 toggleActivityView —— 只测 panePatch
   * 会漏掉「store 里那两处没接 panePatch」这个真实缺陷。
   */
  resetLayout()
  layoutState().toggleZenMode()
  layoutState().toggleActivityView('connections')
  check(
    'store: Zen 中经由活动栏（同一条目）展开侧栏 → 自动退出并清快照',
    layoutState().zenMode === false &&
      layoutState().zenSnapshot === null &&
      layoutState().sidebarVisible === true,
    layoutState()
  )

  resetLayout()
  layoutState().toggleZenMode()
  layoutState().toggleActivityView('files')
  check(
    'store: Zen 中经由活动栏（切到别的条目）展开侧栏 → 自动退出并清快照',
    layoutState().zenMode === false &&
      layoutState().zenSnapshot === null &&
      layoutState().sidebarVisible === true &&
      layoutState().activityView === 'files',
    layoutState()
  )

  resetLayout()
  layoutState().toggleZenMode()
  layoutState().setActivityView('history')
  check(
    'store: Zen 中 setActivityView 展开侧栏 → 自动退出并清快照',
    layoutState().zenMode === false &&
      layoutState().zenSnapshot === null &&
      layoutState().sidebarVisible === true,
    layoutState()
  )

  resetLayout()
  layoutState().toggleZenMode()
  layoutState().toggleZenMode()
  check(
    'store: 再按一次 toggle 退出并还原双栏',
    layoutState().zenMode === false &&
      layoutState().sidebarVisible === true &&
      layoutState().commandRailVisible === true,
    layoutState()
  )

  // 4) 快照精确性：只开侧栏时进 Zen 再退出，命令栏不能被顺手展开
  layout.setState({ sidebarVisible: true, commandRailVisible: false, zenMode: false, zenSnapshot: null })
  layoutState().toggleZenMode()
  layoutState().toggleZenMode()
  check(
    'store: 原本命令栏收起时退出 Zen 仍是收起',
    layoutState().sidebarVisible === true && layoutState().commandRailVisible === false,
    layoutState()
  )
  resetLayout()

  console.log('')
  if (failed > 0) {
    console.log('P2 主题/Zen 回归失败：' + failed + ' 项\n')
    process.exit(1)
  }
  console.log('P2 主题/Zen 回归全部通过\n')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
