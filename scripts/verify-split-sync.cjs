/**
 * verify-split-sync.cjs —— P1-4 分屏同步输入 / 后台标签未读的纯函数自检
 *
 * 判据（写死在这里，改实现就得同时改判据）：
 *   - 同步输入只对「当前标签内、状态 connected 的叶子窗格」广播：
 *     少一条状态过滤 → A4 红；少一条「只在本树里取」→ A6 红；
 *     单窗格忘了短路 → A2 红。这三种错法都会把字节打到用户没盯着的终端里，
 *     是这一组里唯一有「输错机器」风险的断言，所以判据卡得很死。
 *   - 未读圆点必须能区分「真的离开过」和「切标签途中的抖动」：
 *     少了 grace 判定 → B2 红；少了控制符剥离 → B4/B5 红。
 *     误报的代价是用户对这个圆点彻底失去信任（一直在亮 = 等于没有）。
 *
 * 直接跑线上源码（esbuild 打包 + new Function），不复制粘贴实现。
 */
const fs = require('fs')
const path = require('path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')

let pass = 0
const fails = []

function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) {
    pass++
    return
  }
  fails.push(label + '：期望 ' + b + '，实际 ' + a)
}

function load(rel) {
  try {
    const out = esbuild.buildSync({
      entryPoints: [path.join(ROOT, rel)],
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'node18',
      write: false,
      logLevel: 'silent',
      alias: {
        '@shared': path.join(ROOT, 'src', 'shared'),
        '@': path.join(ROOT, 'src', 'renderer', 'src')
      }
    })
    const mod = { exports: {} }
    new Function('module', 'exports', 'require', out.outputFiles[0].text)(
      mod,
      mod.exports,
      require
    )
    return mod.exports
  } catch (e) {
    fails.push('无法构建 ' + rel + ' ' + String((e && e.message) || e).slice(0, 400))
    return null
  }
}

const lib = load(path.join('src', 'renderer', 'src', 'lib', 'tabUnread.ts'))
const resolveSyncTargets = lib && lib.resolveSyncTargets
const shouldMarkUnread = lib && lib.shouldMarkUnread

if (lib && typeof resolveSyncTargets !== 'function') fails.push('tabUnread 缺少导出 resolveSyncTargets')
if (lib && typeof shouldMarkUnread !== 'function') fails.push('tabUnread 缺少导出 shouldMarkUnread')

/* ---------------- A. resolveSyncTargets ---------------- */

const leaf = (sessionId) => ({ type: 'leaf', sessionId })
const split = (a, b) => ({ type: 'split', id: 's-' + a.sessionId + '-' + b.sessionId, dir: 'row', ratio: 0.5, children: [a, b] })

if (typeof resolveSyncTargets === 'function') {
  // 三格：a/b 连上、c 断线
  const tri = split(leaf('a'), split(leaf('b'), leaf('c')))
  const conn = (id) => ({ id, status: 'connected' })
  const disc = (id) => ({ id, status: 'disconnected' })

  // A1 同步关：只回自己
  eq(resolveSyncTargets(tri, false, [conn('a'), conn('b'), conn('c')], 'a'), ['a'], 'A1 同步关只返 [selfId]')
  // A2 单窗格树：即便同步开着也只回自己
  eq(resolveSyncTargets(leaf('a'), true, [conn('a'), conn('b')], 'a'), ['a'], 'A2 单窗格强制 [selfId]')
  // A3 没有树（普通标签）
  eq(resolveSyncTargets(undefined, true, [conn('a'), conn('b')], 'a'), ['a'], 'A3 无树只返 [selfId]')
  // A4 三格里两连一断：只回 connected 的两格
  eq(
    resolveSyncTargets(tri, true, [conn('a'), conn('b'), disc('c')], 'a'),
    ['a', 'b'],
    'A4 只广播给 connected 叶子'
  )
  // A4b 焦点在 b 上，顺序仍是树序（a 在前）
  eq(
    resolveSyncTargets(tri, true, [conn('a'), conn('b'), disc('c')], 'b'),
    ['a', 'b'],
    'A4b 目标顺序按树序而非焦点序'
  )
  // A4c 焦点自己断线时仍要把自己排在最前（否则这一格敲的字会丢）
  eq(
    resolveSyncTargets(tri, true, [disc('a'), conn('b'), conn('c')], 'a'),
    ['a', 'b', 'c'],
    'A4c self 不在 connected 集合里也排最前'
  )
  // A5 三格全连：三格全收到
  eq(
    resolveSyncTargets(tri, true, [conn('a'), conn('b'), conn('c')], 'b'),
    ['a', 'b', 'c'],
    'A5 全连时三格都收'
  )
  // A6 会话列表里有别的标签的会话（z 也是 connected），但它不在这棵树里 —— 绝不能带上
  eq(
    resolveSyncTargets(tri, true, [conn('a'), conn('b'), disc('c'), conn('z')], 'a'),
    ['a', 'b'],
    'A6 不含其他标签的会话'
  )
  // A7 树里有、sessions 里没有（还没登记）：状态未知，不能当成 connected
  eq(
    resolveSyncTargets(tri, true, [conn('a'), conn('b')], 'a'),
    ['a', 'b'],
    'A7 未知状态的叶子被排除'
  )
  // A8 connecting 也不算连上
  eq(
    resolveSyncTargets(tri, true, [conn('a'), { id: 'b', status: 'connecting' }, disc('c')], 'a'),
    ['a'],
    'A8 connecting 不参与广播'
  )
  // A9 self 不属于这棵树（防御性：绝不要把输入打到别的标签）
  eq(
    resolveSyncTargets(tri, true, [conn('a'), conn('b'), conn('c')], 'z'),
    ['z'],
    'A9 self 不在树里时只回自己'
  )
  // A10 四格（上限）全连
  const quad = split(split(leaf('a'), leaf('b')), split(leaf('c'), leaf('d')))
  eq(
    resolveSyncTargets(quad, true, [conn('a'), conn('b'), conn('c'), conn('d')], 'c'),
    ['a', 'b', 'c', 'd'],
    'A10 四格全连'
  )
}

/* ---------------- B. shouldMarkUnread ---------------- */

if (typeof shouldMarkUnread === 'function') {
  const base = { isVisibleInActiveTab: false, status: 'connected', data: 'make: done', now: 100000, leftAt: 90000 }

  // B1 正在看的标签：永不记未读
  eq(shouldMarkUnread({ ...base, isVisibleInActiveTab: true }), false, 'B1 当前标签内不记未读')
  // B2 刚离开不到 500ms（切标签途中的抖动）
  eq(shouldMarkUnread({ ...base, leftAt: 99700 }), false, 'B2 离开不足 500ms 不记未读')
  // B3 离开够久且有可见文本
  eq(shouldMarkUnread(base), true, 'B3 离开够久且有输出 → 记未读')
  // B4 纯 ANSI 控制序列（清屏 / 改色）
  eq(
    shouldMarkUnread({ ...base, data: '\u001B[0m\u001B[2J\u001B[H\u001B[1;32m\u001B[0m' }),
    false,
    'B4 纯 ANSI 不误报'
  )
  // B5 纯空白与回车
  eq(shouldMarkUnread({ ...base, data: '\r\n   \r\n\t\r' }), false, 'B5 纯空白不误报')
  // B6 空串
  eq(shouldMarkUnread({ ...base, data: '' }), false, 'B6 空串不误报')
  // B7 从没在这个标签里待过（leftAt 缺失）：不需要 grace
  eq(shouldMarkUnread({ ...base, leftAt: undefined }), true, 'B7 leftAt 缺失时直接记账')
  // B8 自定义 graceMs
  eq(shouldMarkUnread({ ...base, leftAt: 99400, graceMs: 1000 }), false, 'B8 graceMs 可调')
  eq(shouldMarkUnread({ ...base, leftAt: 99000, graceMs: 1000 }), true, 'B8b 超过自定义 grace 才记账')
  // B9 断开/错误/连接中的会话不记账（没有输出才正常）
  eq(shouldMarkUnread({ ...base, status: 'disconnected', leftAt: undefined }), false, 'B9 disconnected 不记账')
  eq(shouldMarkUnread({ ...base, status: 'error', leftAt: undefined }), false, 'B9b error 不记账')
  eq(shouldMarkUnread({ ...base, status: 'connecting', leftAt: undefined }), false, 'B9c connecting 不记账')
  // B10 带色文本：剥掉控制符后仍有内容
  eq(shouldMarkUnread({ ...base, data: '\u001B[32mDone\u001B[0m\r\n' }), true, 'B10 带色文本仍记账')
  // B11 只有 OSC 标题（窗口标题变化，不是输出）
  eq(shouldMarkUnread({ ...base, data: '\u001B]0;root@host: ~\u0007' }), false, 'B11 OSC 标题不误报')
  // B12 恰好 500ms：算离开够久
  eq(shouldMarkUnread({ ...base, leftAt: 99500 }), true, 'B12 恰好 500ms 记账')
  // B13 只有光标移动序列（TUI 重绘）
  eq(shouldMarkUnread({ ...base, data: '\u001B[10;20H\u001B[K' }), false, 'B13 光标移动不误报')
  // B14 制表符 + 文本
  eq(shouldMarkUnread({ ...base, data: '\tOK\r\n' }), true, 'B14 制表符+文本仍记账')
}

if (fails.length) {
  console.error('')
  console.error('✗ verify-split-sync 失败 ' + fails.length + ' 项（通过 ' + pass + ' 项）：')
  console.error('')
  for (const f of fails) console.error('  - ' + f)
  console.error('')
  process.exit(1)
}
console.log('✓ verify-split-sync 通过：' + pass + ' 项断言')
