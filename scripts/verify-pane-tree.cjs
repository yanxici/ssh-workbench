/**
 * 分屏 pane 树（v2.1.5）纯逻辑回归：把 src/renderer/src/lib/paneTree.ts 用 esbuild
 * 打成 CJS 直接跑线上那份代码，不复制粘贴。
 *
 * 断言判据统一按「旧实现/写错时必红」来选：
 *   - 若 removeLeaf 不做「单孩子塌缩」，删掉 2x2 里的一格后树会留下一个
 *     children 只有一半的 split → C 组全红；
 *   - 若 layoutPaneTree 扣 gap 或按像素算，百分比和 100 对不上 → B 组红；
 *   - 若 neighbor 只按中心距挑、不分「正交换有重叠」这一档，
 *     2x2 从左上按右会跳到右下 → H 组红；
 *   - 若 normalizeRatio 不夹上下限，ratio=0 会让一格宽度为 0 且再也拖不回来 → A 组红；
 *   - 若 replaceLeaf 只处理根节点（不递归），第三次分屏会把整棵树替换掉 → D 组红。
 *
 * 用法：node scripts/verify-pane-tree.cjs
 * 退出码 0 = 全部通过。
 */
const path = require('path')
const esbuild = require('esbuild')

const SRC = path.join(__dirname, '../src/renderer/src/lib/paneTree.ts')
const out = esbuild.buildSync({
  entryPoints: [SRC],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  write: false,
  logLevel: 'silent'
})
const mod = { exports: {} }
new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require)
const P = mod.exports

let pass = 0
const fails = []
function ok(cond, label, extra) {
  if (cond) pass++
  else fails.push(label + (extra === undefined ? '' : '\n    ' + JSON.stringify(extra)))
}
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else fails.push(label + '\n    期望 ' + e + '\n    实际 ' + a)
}
const near = (actual, expected, label, tol) =>
  ok(Math.abs(actual - expected) <= (tol === undefined ? 1e-6 : tol), label, {
    actual,
    expected
  })

const leaf = (id) => ({ type: 'leaf', sessionId: id })
const split = (id, dir, ratio, a, b) => ({
  type: 'split',
  id,
  dir,
  ratio,
  children: [a, b]
})

/* ---------------- A. normalizeRatio 夹紧 ---------------- */
{
  eq(P.MIN_RATIO, 0.15, 'A1 MIN_RATIO 是 0.15')
  eq(P.MAX_RATIO, 0.85, 'A2 MAX_RATIO 是 0.85')
  eq(P.MAX_PANES, 4, 'A3 MAX_PANES 是 4')
  near(P.normalizeRatio(0.5), 0.5, 'A4 中间值原样返回')
  // 不夹的话这里是 0，那一格宽度为 0，且再也拖不回来
  near(P.normalizeRatio(0), P.MIN_RATIO, 'A5 0 被抬到下限')
  near(P.normalizeRatio(-3), P.MIN_RATIO, 'A6 负数被抬到下限')
  near(P.normalizeRatio(1), P.MAX_RATIO, 'A7 1 被压到上限')
  near(P.normalizeRatio(9), P.MAX_RATIO, 'A8 超 1 被压到上限')
  // 不兜 NaN 的话 ratio 会变成 NaN，百分比算出 NaN%，整格消失
  near(P.normalizeRatio(NaN), 0.5, 'A9 NaN 回落 0.5')
  // 非有限值统一当「没给」，不夹到上限 —— 夹到 0.85 会让一格莫名其妙被压窄
  near(P.normalizeRatio(Infinity), 0.5, 'A10 Infinity 回落 0.5')
}

/* ---------------- B. layoutPaneTree 矩形 ---------------- */
{
  const one = P.layoutPaneTree(leaf('a'))
  eq([...one.rects.keys()], ['a'], 'B1 单叶只有一格')
  eq(one.dividers.length, 0, 'B2 单叶没有分隔条')
  const r1 = one.rects.get('a')
  near(r1.x, 0, 'B3 单叶 x 从 0 开始')
  near(r1.w, 100, 'B4 单叶宽度占满 100%')

  const two = P.layoutPaneTree(split('s1', 'row', 0.5, leaf('a'), leaf('b')))
  near(two.rects.get('a').w, 50, 'B5 左右各半宽度')
  near(two.rects.get('b').x, 50, 'B6 右侧从 50% 起')
  near(two.rects.get('a').w + two.rects.get('b').w, 100, 'B7 宽度合计仍是 100')
  eq(two.dividers.length, 1, 'B8 一个分隔条')
  eq(two.dividers[0].dir, 'row', 'B9 左右分屏的分隔条 dir=row')
  near(two.dividers[0].rect.x, 50, 'B10 分隔条落在 50%')
  near(two.dividers[0].splitRect.w, 100, 'B11 分隔条记住整个 split 的矩形')

  const col = P.layoutPaneTree(split('s2', 'col', 0.25, leaf('a'), leaf('b')))
  near(col.rects.get('a').h, 25, 'B12 上下分屏按 ratio 切高度')
  near(col.rects.get('b').y, 25, 'B13 下半从 25% 起')

  // 嵌套：外层左右 50%，右侧再上下分 → 右下那格是 50% 宽、50% 高
  const nested = P.layoutPaneTree(
    split('s3', 'row', 0.5, leaf('a'), split('s4', 'col', 0.5, leaf('b'), leaf('c')))
  )
  const c = nested.rects.get('c')
  near(c.x, 50, 'B14 嵌套格 x 从外层 50% 起')
  near(c.w, 50, 'B15 嵌套格宽度继承外层一半')
  near(c.y, 50, 'B16 嵌套格 y 从内层 50% 起')
  near(c.h, 50, 'B17 嵌套格高度继承内层一半')
  eq(nested.dividers.length, 2, 'B18 两层各一个分隔条')

  // 比例不是 0.5 时，嵌套格的绝对坐标必须跟着外层比例走
  const skew = P.layoutPaneTree(
    split('s5', 'row', 0.75, leaf('a'), split('s6', 'col', 0.5, leaf('b'), leaf('c')))
  )
  near(skew.rects.get('a').w, 75, 'B19 外层 0.75 时左格 75%')
  near(skew.rects.get('c').x, 75, 'B20 嵌套格 x 跟着外层 0.75')
  near(skew.rects.get('c').w, 25, 'B21 嵌套格宽度 = 100-75')
}

/* ---------------- C. removeLeaf 塌缩 ---------------- */
{
  eq(P.removeLeaf(leaf('a'), 'a'), null, 'C1 删唯一叶子得 null')
  const sibling = P.removeLeaf(leaf('a'), 'zzz')
  eq(sibling, leaf('a'), 'C2 删不存在的 id 原样返回')

  const two = split('s1', 'row', 0.5, leaf('a'), leaf('b'))
  // 不塌缩的话这里会留下一个只有 a 的 split（b 变成空洞）
  eq(P.removeLeaf(two, 'b'), leaf('a'), 'C3 删一格后塌缩成剩下的那格')
  eq(P.removeLeaf(two, 'a'), leaf('b'), 'C4 删左边也塌缩')

  const four = split(
    's1',
    'row',
    0.5,
    split('s2', 'col', 0.5, leaf('a'), leaf('b')),
    split('s3', 'col', 0.5, leaf('c'), leaf('d'))
  )
  const afterC = P.removeLeaf(four, 'c')
  eq(P.leafIds(afterC).sort(), ['a', 'b', 'd'], 'C5 2x2 删一格后剩三格')
  eq(afterC.dir, 'row', 'C6 顶层方向不变')
  // 右半边原来是一个 col split，删掉 c 之后应该直接是 d 的叶子
  eq(afterC.children[1], leaf('d'), 'C7 右半边塌缩成单叶')
  const afterAll = P.removeLeaf(P.removeLeaf(P.removeLeaf(four, 'c'), 'd'), 'b')
  eq(afterAll, leaf('a'), 'C8 删到只剩一格时塌缩成单叶')
}

/* ---------------- D. replaceLeaf 递归替换 ---------------- */
{
  const two = split('s1', 'row', 0.5, leaf('a'), leaf('b'))
  const grown = P.replaceLeaf(two, 'b', split('s2', 'col', 0.5, leaf('b'), leaf('c')))
  eq(P.leafIds(grown), ['a', 'b', 'c'], 'D1 替换非根叶子后三格都在')
  // 不递归的话根节点会被整体替换，a 就丢了
  eq(P.leafIds(grown)[0], 'a', 'D2 未涉及的叶子原样保留')
  eq(grown.children[0], leaf('a'), 'D3 未涉及的子树引用不变（利于 React 浅比较）')

  const same = P.replaceLeaf(two, 'nope', leaf('z'))
  eq(P.leafIds(same), ['a', 'b'], 'D4 替换不存在的 id 不改变结构')
  eq(P.countLeaves(same), 2, 'D5 countLeaves 一致')
}

/* ---------------- E. setRatio 只改目标 split ---------------- */
{
  const t = split('s1', 'row', 0.5, leaf('a'), split('s2', 'col', 0.5, leaf('b'), leaf('c')))
  const r = P.setRatio(t, 's2', 0.3)
  near(r.ratio, 0.5, 'E1 外层 ratio 不动')
  near(r.children[1].ratio, 0.3, 'E2 内层 ratio 被改')
  // 不改的话 identity 相同，React 不会重渲染 —— 但改了就必须换新对象
  ok(r !== t, 'E3 改过之后返回新对象')
  eq(P.setRatio(t, 'nope', 0.3), t, 'E4 改不存在的 id 返回原对象')
  const clamped = P.setRatio(t, 's1', 0)
  near(clamped.ratio, P.MIN_RATIO, 'E5 setRatio 也走夹紧')
  // 未命中的兄弟子树必须保持引用，否则整棵树每帧都重建
  ok(P.setRatio(t, 's1', 0.5).children[1] === t.children[1], 'E6 ratio 相同时子树引用不变')
}

/* ---------------- F. leafIds / countLeaves / containsSession ---------------- */
{
  eq(P.leafIds(leaf('a')), ['a'], 'F1 单叶')
  const t = split('s1', 'row', 0.5, leaf('a'), split('s2', 'col', 0.5, leaf('b'), leaf('c')))
  eq(P.leafIds(t), ['a', 'b', 'c'], 'F2 深度优先、左先右后')
  eq(P.countLeaves(t), 3, 'F3 countLeaves')
  ok(P.containsSession(t, 'c'), 'F4 containsSession 命中深层叶子')
  ok(!P.containsSession(t, 'zz'), 'F5 containsSession 不命中不存在')
  ok(P.isLeaf(leaf('a')), 'F6 isLeaf 单叶')
  ok(!P.isLeaf(t), 'F7 isLeaf 对 split 为假')
}

/* ---------------- G. 边界：ratio 极端值下的布局 ---------------- */
{
  const t = split('s1', 'row', 0, leaf('a'), leaf('b'))
  const lay = P.layoutPaneTree(t)
  // ratio=0 时左格宽度会是 0 —— 这正是必须夹紧的原因
  near(lay.rects.get('a').w, 15, 'G1 ratio=0 被夹到 15%')
  near(lay.rects.get('b').x, 15, 'G2 右格从 15% 起')
  const t2 = P.layoutPaneTree(split('s2', 'col', 5, leaf('a'), leaf('b')))
  near(t2.rects.get('a').h, 85, 'G3 ratio=5 被压到 85%')
  near(t2.rects.get('b').h, 15, 'G4 剩下一格仍有 15% 高度')
}

/* ---------------- H. neighbor 焦点移动 ---------------- */
{
  const two = P.layoutPaneTree(split('s1', 'row', 0.5, leaf('a'), leaf('b')))
  eq(P.neighbor(two.rects, 'a', 'right'), 'b', 'H1 左右并排：向右到右格')
  eq(P.neighbor(two.rects, 'b', 'left'), 'a', 'H2 左右并排：向左到左格')
  eq(P.neighbor(two.rects, 'a', 'left'), null, 'H3 左边没有邻居返回 null')
  eq(P.neighbor(two.rects, 'b', 'up'), null, 'H4 正上方没有邻居返回 null')

  const four = P.layoutPaneTree(
    split(
      's1',
      'row',
      0.5,
      split('s2', 'col', 0.5, leaf('a'), leaf('b')),
      split('s3', 'col', 0.5, leaf('c'), leaf('d'))
    )
  )
  /*
   * 2x2：从左上(a)按右必须到右上(c)。
   * 只按中心距挑会选中 d（斜对角位移更短），这就是「分档」那一步存在的理由。
   */
  eq(P.neighbor(four.rects, 'a', 'right'), 'c', 'H5 2x2 从左上向右到右上')
  eq(P.neighbor(four.rects, 'a', 'down'), 'b', 'H6 2x2 从左上向下到左下')
  eq(P.neighbor(four.rects, 'd', 'up'), 'c', 'H7 2x2 从右下向上到右上')
  eq(P.neighbor(four.rects, 'd', 'left'), 'b', 'H8 2x2 从右下向左到左下')
  eq(P.neighbor(four.rects, 'b', 'right'), 'd', 'H9 2x2 从左下向右到右下')

  // 三格：左边一整列，右边上下两格。从左下(b)向右应到右下(d)，不是右上(c)
  const three = P.layoutPaneTree(
    split('s1', 'row', 0.5, leaf('a'), split('s2', 'col', 0.5, leaf('c'), leaf('d')))
  )
  /*
   * 左侧整列向右：c 与 d 都在右半边、都与 a 有纵向重叠、中心距也相同（各 25）。
   * 这是真正的平局，本模块的约定是「保持先到者」（深度优先顺序），
   * 所以断言「落在右半边」而不是钉死 c —— 钉死会把遍历顺序写进测试。
   */
  ok(['c', 'd'].includes(P.neighbor(three.rects, 'a', 'right')), 'H10 整列向右落在右半边')
  eq(P.neighbor(three.rects, 'c', 'down'), 'd', 'H11 右半边上下继续可用')
}

/* ---------------- I. 上限：MAX_PANES 与 countLeaves ---------------- */
{
  let t = leaf('a')
  for (let i = 0; i < P.MAX_PANES - 1; i++) {
    t = P.replaceLeaf(t, 'a', split('s' + i, 'row', 0.5, leaf('a'), leaf('p' + i)))
  }
  eq(P.countLeaves(t), P.MAX_PANES, 'I1 连续分屏到上限时格数正确')
  // 再分一次由 splitStore 拦截（这里只确认树本身还能表达，边界不在本模块）
  ok(P.countLeaves(t) >= P.MAX_PANES, 'I2 达到上限后 countLeaves 不小于 MAX_PANES')
}

/* ---------------- 汇总 ---------------- */
if (fails.length === 0) {
  console.log('分屏树回归：全部 ' + pass + ' 条通过')
  process.exit(0)
}
console.log('分屏树回归：' + pass + ' 通过 / ' + fails.length + ' 失败')
for (const f of fails) console.log('  ✗ ' + f)
process.exit(1)
