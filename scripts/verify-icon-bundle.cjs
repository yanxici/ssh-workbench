/**
 * 图标导入方式的回归（命名空间导入不许回来）+ 主 chunk 体积护栏。
 *
 * 为什么要有这个脚本：
 *   本仓图标库仍是 lucide-react 0.469 —— `import * as Lucide from 'lucide-react'`
 *   这种命名空间导入会把整个 barrel 拖进包里，tree-shaking 裁不掉。上游把 lucide
 *   升到 1.x（7,061 个导出）时正被这件事咬过：renderer 主 chunk 从 2,677 kB 涨到
 *   3,274 kB（+597 kB），改成具名导入后回落到 1,802 kB。本仓当前主 chunk ~1,614 kB，
 *   护栏阈值 2,300 kB。
 *
 *   这类问题类型检查与 UI e2e 都发现不了：构建成功、功能正常、只是变胖几百 kB。
 *   所以只能用量化断言把它钉住。
 *
 * 两条断言：
 *   1. 白名单里每个图标名都要在 COMMAND_ICONS 里（防止漏写导致卡片渲染成默认图标）；
 *   2. 主 chunk 不得超过上限（防止有人顺手把具名导入改回命名空间导入）。
 *
 * 判据的区分度：把 icons.ts 改回 `import * as Lucide` 后，第 2 条会红（3,274 kB > 2,300 kB）。
 *
 * 用法：node scripts/verify-icon-bundle.cjs
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const ICONS = path.join(ROOT, 'src/renderer/src/lib/icons.ts')
const ASSETS = path.join(ROOT, 'out/renderer/assets')

/* 主 chunk 上限：当前 1,802 kB，给足余量到 2,300 kB。
 * 命名空间导入的实测值是 3,274 kB，会被这条拦下。 */
const MAX_MAIN_CHUNK_BYTES = 2300 * 1024

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : '')) }
}

console.log('\n[图标库升级]')

const src = fs.readFileSync(ICONS, 'utf-8')

/* 1. 不许再出现命名空间导入 */
check(
  'icons.ts 不使用命名空间导入（否则 7061 个图标全进产物）',
  !/import\s+\*\s+as\s+Lucide\s+from\s+['\"]lucide-react['\"]/.test(src),
  '仍有 import * as Lucide'
)

/* 2. 白名单里的每个名字都要能被解析 */
const listed = [...src.matchAll(/^\s+'([A-Za-z0-9]+)'/gm)].map((m) => m[1])
const imported = [...src.matchAll(/^\s+([A-Za-z0-9]+),?$/gm)].map((m) => m[1])
const missing = listed.filter((n) => !imported.includes(n))
check(
  `白名单 ${listed.length} 个图标都已具名导入（缺 ${missing.length}）`,
  missing.length === 0,
  missing
)

/* 3. 注册表覆盖白名单 */
const regStart = src.indexOf('const REGISTRY')
const regEnd = src.indexOf('}', regStart)
const regBody = regStart >= 0 ? src.slice(regStart, regEnd) : ''
const inRegistry = listed.filter((n) => new RegExp('\\b' + n + '\\b').test(regBody))
check(
  `REGISTRY 覆盖白名单（${inRegistry.length}/${listed.length}）`,
  inRegistry.length === listed.length,
  listed.filter((n) => !inRegistry.includes(n))
)

/* 4. 主 chunk 体积上限（需要先 build） */
let chunk = null
if (fs.existsSync(ASSETS)) {
  const files = fs.readdirSync(ASSETS).filter((f) => /^index-.*\.js$/.test(f))
  if (files.length) {
    chunk = files.map((f) => ({ f, size: fs.statSync(path.join(ASSETS, f)).size })).sort((a, b) => b.size - a.size)[0]
  }
}
check(
  `renderer 主 chunk 未超上限（上限 ${Math.round(MAX_MAIN_CHUNK_BYTES / 1024)} kB）`,
  chunk !== null && chunk.size <= MAX_MAIN_CHUNK_BYTES,
  chunk ? `${chunk.f} = ${Math.round(chunk.size / 1024)} kB` : '未找到 out/renderer/assets（先 npm run build）'
)

console.log('\n通过 ' + pass + '  失败 ' + fail)
process.exit(fail === 0 ? 0 : 1)
