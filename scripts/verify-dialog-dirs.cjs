/**
 * 对话框默认目录记忆自检（自建记忆，不指望 OS 记住上次目录）。
 *
 * 背景：
 *   Electron 的 `dialog.show*Dialog` 不保证记住上次浏览的目录（上游 Electron 43 起更是
 *   在没给 `defaultPath` 时直接落到「下载」）。本项目有 13 处系统对话框，
 *   逐个手写 defaultPath 会漂移，所以收敛到 util/dialogDirs.ts。
 *
 * 断言要点（每条都问过「修复没落地时会不会红」）：
 *   1. 无记忆时回下载目录 —— 若 Policy 退回「不传 defaultPath」，这条仍绿，
 *      所以下面 2/3 才是真正的区分度断言；
 *   2. 传了文件名 → 拼接出「记忆目录/文件名」，且文件名里的分隔符被压掉；
 *   3. 记忆按类别隔离 —— 固件选过的目录不能污染报告导出的起点；
 *   4. 记忆目录失效（不存在 / 是文件）时退回下载目录，绝不把坏路径塞给对话框；
 *   5. 相对路径不被当成记忆（Windows 上相对路径给对话框 = 卡顿 + 落点不明）。
 *
 * 用 electron 桩替换 app.getPath，不启动 Electron，纯函数级验证。
 *
 * 用法：node scripts/verify-dialog-dirs.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.tsc-verify')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-dlg-'))
const downloads = path.join(tmp, 'Downloads')
const home = path.join(tmp, 'home')
const firmwareDir = path.join(tmp, 'firmware')
const reportDir = path.join(tmp, 'reports')
for (const d of [downloads, home, firmwareDir, reportDir]) fs.mkdirSync(d, { recursive: true })
const aFile = path.join(tmp, 'not-a-dir.txt')
fs.writeFileSync(aFile, 'x')

fs.mkdirSync(OUT_DIR, { recursive: true })
const stub = path.join(OUT_DIR, 'electron-stub-dlg.cjs')
fs.writeFileSync(
  stub,
  `module.exports = {
  app: {
    getPath: (k) => {
      const m = { downloads: ${JSON.stringify(downloads)}, home: ${JSON.stringify(home)}, userData: ${JSON.stringify(tmp)} }
      if (!(k in m)) throw new Error('unknown path ' + k)
      return m[k]
    }
  }
}`
)
const bundle = path.join(OUT_DIR, 'dialogdirs-bundle.cjs')
esbuild.buildSync({
  stdin: {
    contents: `export * from './src/main/util/dialogDirs'`,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle,
  logLevel: 'error',
  alias: { electron: stub, '@shared': path.join(ROOT, 'src/shared') }
})
const M = require(bundle)

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : '')) }
}

console.log('\n[对话框默认目录]')

/* 1. 无记忆 → 下载目录 */
M.resetDialogDirs()
check('无记忆时回下载目录', M.dialogDefaultPath('file') === downloads, M.dialogDefaultPath('file'))

/* 2. 传文件名 → 拼接；分隔符被压平 */
M.resetDialogDirs()
M.rememberDialogDir('file', firmwareDir)
check('记住目录后文件名拼接正确', M.dialogDefaultPath('file', 'fw.bin') === path.join(firmwareDir, 'fw.bin'), M.dialogDefaultPath('file', 'fw.bin'))
check(
  '文件名里的分隔符被压掉（不能借文件名跳出目录）',
  M.dialogDefaultPath('file', '..\\..\\evil.txt') === path.join(firmwareDir, '.._.._evil.txt'),
  M.dialogDefaultPath('file', '..\\..\\evil.txt')
)

/* 3. 类别隔离 */
M.resetDialogDirs()
M.rememberDialogDir('firmware', firmwareDir)
check('类别隔离：固件目录不影响报告导出', M.dialogDefaultPath('report') === downloads, M.dialogDefaultPath('report'))
check('类别隔离：固件类本身仍生效', M.dialogDefaultPath('firmware') === firmwareDir, M.dialogDefaultPath('firmware'))

/* 4. 记忆失效回退 */
M.resetDialogDirs()
M.rememberDialogDir('file', path.join(tmp, 'gone-dir'))
check('目录不存在时不记忆，回退下载目录', M.dialogDefaultPath('file') === downloads, M.dialogDefaultPath('file'))
M.resetDialogDirs()
M.rememberDialogDir('file', aFile)
check('路径是文件时不记忆，回退下载目录', M.dialogDefaultPath('file') === downloads, M.dialogDefaultPath('file'))

/* 5. 相对路径不记忆 */
M.resetDialogDirs()
M.rememberDialogDir('file', 'relative/dir')
check('相对路径不记忆', M.dialogDefaultPath('file') === downloads, M.dialogDefaultPath('file'))

/* 6. rememberDialogPick：文件取父目录，目录取自身 */
M.resetDialogDirs()
M.rememberDialogPick('file', path.join(firmwareDir, 'a.bin'), false)
check('选文件后记父目录', M.dialogDefaultPath('file') === firmwareDir, M.dialogDefaultPath('file'))
M.resetDialogDirs()
M.rememberDialogPick('folder', reportDir, true)
check('选目录后记该目录', M.dialogDefaultPath('folder') === reportDir, M.dialogDefaultPath('folder'))

/* 7. undefined / 空值不炸 */
M.resetDialogDirs()
M.rememberDialogPick('file', undefined, false)
M.rememberDialogDir('file', undefined)
check('未选择时不炸且保持下载目录', M.dialogDefaultPath('file') === downloads, M.dialogDefaultPath('file'))

fs.rmSync(tmp, { recursive: true, force: true })
console.log('\n通过 ' + pass + '  失败 ' + fail)
process.exit(fail === 0 ? 0 : 1)
