/**
 * P1 纯逻辑回归（Task 1 拖放通道决策 / Task 2 多行粘贴分析）。
 *
 * 用 esbuild 把线上那份 TS 打成 CJS 直接跑，不复制粘贴实现 —— 断言针对的是
 * src/renderer/src/lib/*.ts 里真实导出的函数。
 *
 * 判据一律按「实现写错时必红」选：
 *   - decideDropAction 少了 fileCount === 0 短路 → 从命令墙拖命令卡片到终端会被
 *     判成文件上传（A3 红）；
 *   - 少了 kind === 'serial' / status !== 'connected' 短路 → 串口或断线窗格也去
 *     SFTP（A1/A2 红）；
 *   - Alt 用 || 或赋值而不是异或 → 偏好 trzsz 时按 Alt 不会翻回 sftp（A6 红）。
 *
 * 用法：node scripts/verify-paste-guard.cjs
 * 退出码 0 = 全部通过。
 */
const path = require('path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')

let pass = 0
const fails = []

function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else fails.push(label + '\n    期望 ' + e + '\n    实际 ' + a)
}

/** 把线上那份 TS 打成 CJS 并 require 回来；缺文件时记一条失败而不是抛栈 */
function load(rel) {
  const entry = path.join(ROOT, rel)
  let text
  try {
    const built = esbuild.buildSync({
      entryPoints: [entry],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node18',
      write: false,
      logLevel: 'silent',
      alias: { '@shared': path.join(ROOT, 'src/shared') }
    })
    text = built.outputFiles[0].text
  } catch (e) {
    fails.push('无法构建 ' + rel + '\n    ' + String(e.message || e).split('\n')[0])
    return null
  }
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', text)(mod, mod.exports, require)
  return mod.exports
}

/* ------------------------------------------------------------------ *
 *  A. decideDropAction —— 拖放通道决策（Task 1）
 * ------------------------------------------------------------------ */
const drop = load('src/renderer/src/lib/terminalDrop.ts')
if (drop && typeof drop.decideDropAction !== 'function') {
  fails.push('terminalDrop.ts 未导出 decideDropAction')
}

if (drop && typeof drop.decideDropAction === 'function') {
  const decide = drop.decideDropAction
  const base = { kind: 'ssh', status: 'connected', fileCount: 1, altKey: false }

  // A1 串口会话：没有 SFTP，也没有 trzsz
  eq(decide({ ...base, kind: 'serial' }), 'ignore', 'A1 串口会话必须 ignore')
  eq(decide({ ...base, kind: 'serial', fileCount: 3, altKey: true }), 'ignore', 'A1b 串口 + Alt 仍 ignore')

  // A2 未连接：连上才有 cwd 可传
  for (const status of ['connecting', 'disconnected', 'error']) {
    eq(decide({ ...base, status }), 'ignore', 'A2 状态 ' + status + ' 必须 ignore')
  }

  // A3 命令卡片拖拽：files.length === 0（Review Focus #1）
  eq(decide({ ...base, fileCount: 0 }), 'ignore', 'A3 fileCount 为 0 必须 ignore')
  eq(decide({ ...base, fileCount: 0, altKey: true }), 'ignore', 'A3b fileCount 为 0 + Alt 仍 ignore')
  eq(decide({ ...base, fileCount: -1 }), 'ignore', 'A3c 负数 fileCount 也 ignore')

  // A4 默认走 SFTP
  eq(decide(base), 'sftp', 'A4 默认通道为 sftp')
  eq(decide({ ...base, prefMode: 'sftp' }), 'sftp', 'A4b 显式 sftp 偏好')

  // A5 默认按 Alt 翻转到 trzsz
  eq(decide({ ...base, altKey: true }), 'trzsz', 'A5 默认 + Alt → trzsz')

  // A6 偏好 trzsz 时按 Alt 翻回 sftp（异或语义，不是「Alt 就是 trzsz」）
  eq(decide({ ...base, prefMode: 'trzsz' }), 'trzsz', 'A6 偏好 trzsz 直接走 trzsz')
  eq(decide({ ...base, prefMode: 'trzsz', altKey: true }), 'sftp', 'A6b 偏好 trzsz + Alt → sftp')

  // A7 空值/脏值不崩，回落默认
  eq(decide({ ...base, prefMode: undefined }), 'sftp', 'A7 prefMode 缺省回落 sftp')
  eq(decide({ ...base, prefMode: null }), 'sftp', 'A7b prefMode 为 null 回落 sftp')
}

/* ------------------------------------------------------------------ *
 *  B. analyzePaste / stripMarkdownFence —— 多行粘贴护栏（Task 2）
 * ------------------------------------------------------------------ */
const guard = load('src/renderer/src/lib/pasteGuard.ts')
if (guard && typeof guard.analyzePaste !== 'function') {
  fails.push('pasteGuard.ts 未导出 analyzePaste')
}
if (guard && typeof guard.stripMarkdownFence !== 'function') {
  fails.push('pasteGuard.ts 未导出 stripMarkdownFence')
}

if (
  guard &&
  typeof guard.analyzePaste === 'function' &&
  typeof guard.stripMarkdownFence === 'function'
) {
  const analyze = guard.analyzePaste
  const strip = guard.stripMarkdownFence
  const DANGER = ['rm -rf', 'mkfs', 'dd if=', 'shutdown', 'reboot', 'poweroff']

  // B1 单行普通命令：零打扰，粘上就发（设计文档硬要求，弹一下就毁体验）
  const single = analyze('ls -la', DANGER, true)
  eq(single.shouldConfirm, false, 'B1 单行命令不弹窗')
  eq(single.lineCount, 1, 'B1b 单行 lineCount 为 1')
  eq(single.hasTrailingNewline, false, 'B1c 单行无末尾回车')

  // B2 两行：必须确认
  const two = analyze('cd /tmp\nls', DANGER, true)
  eq(two.shouldConfirm, true, 'B2 两行必须确认')
  eq(two.lineCount, 2, 'B2b 两行 lineCount 为 2')

  // B3 开关关掉后一律不弹（用户明确表示自己承担）
  eq(analyze('cd /tmp\nls', DANGER, false).shouldConfirm, false, 'B3 关闭开关后两行不弹')
  eq(
    analyze('rm -rf /tmp/x\n', DANGER, false).shouldConfirm,
    false,
    'B3b 关闭开关后危险词也不弹'
  )

  // B4 单行 + 末尾回车 + 危险词：回车会立刻执行，这是唯一的兜底
  const dangerSingle = analyze('rm -rf /tmp/x\n', DANGER, true)
  eq(dangerSingle.shouldConfirm, true, 'B4 危险词 + 末尾回车必须确认')
  eq(dangerSingle.matchedDangers, ['rm -rf'], 'B4b matchedDangers 精确命中 rm -rf')
  eq(dangerSingle.hasTrailingNewline, true, 'B4c 识别末尾回车')
  // 末尾回车不计入行数：否则实现会用 lineCount>=2 蒙对，危险词分支永远跑不到
  eq(dangerSingle.lineCount, 1, 'B4d 末尾回车不算一行')

  // B4e 同样的命令但没末尾回车：还要用户自己敲回车，不打断
  eq(analyze('rm -rf /tmp/x', DANGER, true).shouldConfirm, false, 'B4e 危险词无末尾回车不弹')

  // B5 代码围栏：识别 + 剥离（粘文档片段是最常见场景）
  const fenced = '```bash\necho 1\necho 2\n```'
  const fenceInfo = analyze(fenced, DANGER, true)
  eq(fenceInfo.hasCodeFence, true, 'B5 识别 ``` 代码围栏')
  eq(fenceInfo.shouldConfirm, true, 'B5b 围栏多行仍要确认')
  eq(strip(fenced), 'echo 1\necho 2', 'B5c 剥掉围栏只留正文')

  // B6 非围栏原样返回（尤其别把行内反引号当围栏）
  eq(strip('echo `date`'), 'echo `date`', 'B6 行内反引号不当围栏')
  eq(strip('cd /tmp\nls'), 'cd /tmp\nls', 'B6b 非围栏文本原样返回')
  eq(analyze('echo `date`', DANGER, true).hasCodeFence, false, 'B6c 行内反引号不算围栏')

  // B7 多个危险词全收（顺序按 dangerPatterns 声明顺序，与设置页一致）
  eq(
    analyze('mkfs.ext4 /dev/sdb\ndd if=/dev/zero of=/dev/sdb', DANGER, true).matchedDangers,
    ['mkfs', 'dd if='],
    'B7 多危险词全部收集'
  )

  // B8 空串 / 纯空白
  eq(analyze('', DANGER, true).shouldConfirm, false, 'B8 空串不弹')
  eq(analyze('   \n  ', DANGER, true).lineCount, 2, 'B8b 纯空白仍按行计数')

  // B9 CRLF：Windows 剪贴板混进 \r 时行数不能被算成两倍
  eq(analyze('a\r\nb', DANGER, true).lineCount, 2, 'B9 CRLF 只算 1 个换行')
  eq(analyze('a\r\nb', DANGER, true).shouldConfirm, true, 'B9b CRLF 两行仍要确认')
}

/* ------------------------------------------------------------------ *
 *  C. countDraggedFiles —— dragover 阶段的文件数兜底（fix）
 * ------------------------------------------------------------------ */
const dropLib = load('src/renderer/src/lib/terminalDrop.ts')
if (dropLib && typeof dropLib.countDraggedFiles !== 'function') {
  fails.push('terminalDrop.ts 未导出 countDraggedFiles')
}

if (dropLib && typeof dropLib.countDraggedFiles === 'function') {
  const count = dropLib.countDraggedFiles

  // C1 files 拿得到就以它为准（drop 阶段、非 Windows 都是这条路径）
  eq(count({ files: [1, 2, 3] }), 3, 'C1 files.length 优先')

  // C2 Windows dragover 保护模式：files 恒为空，只有 items 能看出是文件
  eq(count({ files: [], items: [{ kind: 'file' }], types: ['Files'] }), 1, 'C2 files 空 + items 一个 file -> 1')
  eq(
    count({ files: [], items: [{ kind: 'file' }, { kind: 'file' }] }),
    2,
    'C2b files 空 + items 两个 file -> 2'
  )

  // C2c items 全是 string 但 types 里有 Files：拖动刚开始、内容尚未解析
  eq(count({ files: [], items: [{ kind: 'string' }], types: ['Files'] }), 1, 'C2c 只剩 types 线索 -> 1')

  // C3 命令拖拽：items 全 string 且 types 不含 Files —— 绝不能当成文件上传
  eq(
    count({ files: [], items: [{ kind: 'string' }], types: ['text/plain'] }),
    0,
    'C3 命令拖拽 -> 0'
  )
  eq(
    count({ files: [], items: [{ kind: 'string' }], types: ['text/plain', 'text/html'] }),
    0,
    'C3b 拖 HTML 片段 -> 0'
  )

  // C4 缺字段/空对象不崩：dragover 期间各平台给的字段并不齐全
  eq(count(null), 0, 'C4 dataTransfer 为 null -> 0')
  eq(count(undefined), 0, 'C4b dataTransfer 为 undefined -> 0')
  eq(count({}), 0, 'C4c 空对象 -> 0')
  eq(count({ files: [], items: [] }), 0, 'C4d files 与 items 都空 -> 0')

  // C5 files 与 items 同时有内容时不能相加（同一批文件会被数成两份）
  eq(
    count({ files: [1], items: [{ kind: 'file' }, { kind: 'file' }] }),
    1,
    'C5 files 非空时 items 不参与计数'
  )
}

/* ------------------------------------------------------------------ *
 *  汇总
 * ------------------------------------------------------------------ */
if (fails.length) {
  console.error('\n✗ verify-paste-guard 失败 ' + fails.length + ' 项（通过 ' + pass + ' 项）：\n')
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
console.log('✓ verify-paste-guard 通过：' + pass + ' 项断言')
