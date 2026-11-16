/**
 * 任务完成通知（v2.1.4）纯逻辑回归：把 src/renderer/src/lib/notifyPlan.ts 用 esbuild
 * 打成 CJS 直接跑线上那份代码，不复制粘贴。
 *
 * 断言判据统一按「旧实现必红」来选 —— 每一条都对应一个真会出错的实现方式：
 *   - 顺序错（先判聚焦再判静音）：静音的设备在失焦时照样弹系统通知 → C4 红；
 *   - 聚焦时弹系统通知：人就在窗口前，同一件事说两遍 → C5 红；
 *   - 启发式关掉仍然判命中：默认配置下每 1.5 秒弹一条"疑似完成" → D2 红；
 *   - notifiedAt 不做门：同一次静默被 2s 巡检重复命中 → D4 红；
 *   - normalize 用 !!v：手写的字符串 "false" 会被当成 true，静音整片失效 → E2 红。
 *
 * 用法：node scripts/verify-notify.cjs
 * 退出码 0 = 全部通过。
 */
const path = require('path')
const esbuild = require('esbuild')

const SRC = path.join(__dirname, '../src/renderer/src/lib/notifyPlan.ts')
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
const N = mod.exports

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

/** 全开偏好：最"吵"的配置，任何一层判定没生效都会漏出通知 */
const ALL_ON = {
  enabled: true,
  system: true,
  sound: true,
  heuristic: true,
  mutedConnectionIds: []
}
const req = (over) => ({ kind: 'batch', title: '批量执行完成', ...over })

/* ---------------- 1. isMuted ---------------- */
{
  eq(N.isMuted(['a', 'b'], 'a'), true, 'A1 列表内含该连接 → 静音')
  eq(N.isMuted(['a', 'b'], 'c'), false, 'A2 列表内不含 → 不静音')
  eq(N.isMuted([], 'a'), false, 'A3 空列表 → 不静音')
  eq(N.isMuted(undefined, 'a'), false, 'A4 undefined → 不静音')
  // connectionId 缺失时必须判 false：串口会话、设备扫描这类没有归属连接的
  // 任务不能被"空 id 恰好命中了空列表" 静音掉
  eq(N.isMuted([''], undefined), false, 'A5 没有连接 id → 永远不静音')
}

/* ---------------- 2. planNotify 顺序 ---------------- */
{
  eq(N.planNotify(req(), { prefs: { ...ALL_ON, enabled: false }, focused: false }), {
    channel: 'none',
    reason: 'disabled'
  }, 'B1 总开关关掉 → 一律不发')

  eq(N.planNotify(req({ title: '   ' }), { prefs: ALL_ON, focused: false }), {
    channel: 'none',
    reason: 'empty-title'
  }, 'B2 空标题 → 不发')

  eq(N.planNotify(req(), { prefs: ALL_ON, focused: true }), {
    channel: 'toast',
    reason: 'focused'
  }, 'B3 窗口聚焦 → 只发应用内 toast')

  eq(N.planNotify(req(), { prefs: ALL_ON, focused: false }), {
    channel: 'system',
    reason: 'unfocused'
  }, 'B4 窗口失焦且开系统通知 → 发系统通知')

  eq(N.planNotify(req(), { prefs: { ...ALL_ON, system: false }, focused: false }), {
    channel: 'toast',
    reason: 'system-off'
  }, 'B5 失焦但关了系统通知 → 退回 toast（不能什么都不发）')
}

/* ---------------- 3. 静音与聚焦的优先级 ---------------- */
{
  const prefs = { ...ALL_ON, mutedConnectionIds: ['conn-1'] }
  // 静音的连接失焦时也不许弹系统通知：用户点静音正是因为"这台设备别烦我"，
  // 而失焦恰恰是最容易被烦到的时刻
  eq(N.planNotify(req({ connectionId: 'conn-1' }), { prefs, focused: false }), {
    channel: 'none',
    reason: 'muted'
  }, 'C1 静音 + 失焦 → 不弹系统通知')

  eq(N.planNotify(req({ connectionId: 'conn-1' }), { prefs, focused: true }), {
    channel: 'none',
    reason: 'muted'
  }, 'C2 静音 + 聚焦 → 也不弹 toast（静音就是彻底不提示）')

  eq(N.planNotify(req({ connectionId: 'conn-2' }), { prefs, focused: false }), {
    channel: 'system',
    reason: 'unfocused'
  }, 'C3 没静音的另一台 → 照常弹')

  // 顺序保护：静音必须排在聚焦之前判定，否则 C1 会变成 toast
  eq(
    N.planNotify(req({ connectionId: 'conn-1' }), {
      prefs: { ...prefs, system: false },
      focused: false
    }),
    { channel: 'none', reason: 'muted' },
    'C4 静音优先于 system-off 回落'
  )
}

/* ---------------- 4. 启发式判定 ---------------- */
{
  const base = ALL_ON
  const t = 100000
  ok(
    N.heuristicHit({ now: t + 1600, lastOutputAt: t, notifiedAt: 0, prefs: base }),
    'D1 静默 1.6s 且窗口在后台 → 命中'
  )
  ok(
    !N.heuristicHit({ now: t + 1600, lastOutputAt: t, notifiedAt: 0, prefs: { ...base, heuristic: false } }),
    'D2 启发式关掉（默认）→ 不命中'
  )
  ok(
    !N.heuristicHit({ now: t + 1000, lastOutputAt: t, notifiedAt: 0, prefs: base }),
    'D3 只静默 1s → 未到阈值不命中'
  )
  ok(
    !N.heuristicHit({ now: t + 3000, lastOutputAt: t, notifiedAt: t + 500, prefs: base }),
    'D4 这一轮已经提醒过 → 不重复命中（否则 2s 巡检会反复弹）'
  )
  ok(
    N.heuristicHit({ now: t + 4000, lastOutputAt: t + 2000, notifiedAt: t + 500, prefs: base }),
    'D5 提醒过之后又有新输出、再静默 → 允许再提醒一次'
  )
  ok(
    !N.heuristicHit({ now: t + 9000, lastOutputAt: 0, notifiedAt: 0, prefs: base }),
    'D6 从没输出过的会话 → 不判定（刚打开还没登录不算"完成"）'
  )
  ok(
    !N.heuristicHit({ now: t + 1600, lastOutputAt: t, notifiedAt: 0, prefs: { ...base, enabled: false } }),
    'D7 总开关关掉 → 启发式也不命中'
  )
  eq(N.HEURISTIC_IDLE_MS, 1500, 'D8 阈值写死 1.5s（改小会误报、改大会迟钝）')
}

/* ---------------- 5. 静音列表增删 ---------------- */
{
  eq(N.addMuted(undefined, 'x'), ['x'], 'E1 空列表加一项')
  eq(N.addMuted(['x'], 'x'), ['x'], 'E2 重复添加不产生重复项')
  eq(N.addMuted(['a', '', null, 'b'], 'c'), ['a', 'b', 'c'], 'E3 脏数据被清洗后再追加')
  eq(N.removeMuted(['a', 'b'], 'a'), ['b'], 'E4 删除命中项')
  eq(N.removeMuted(['a'], 'zzz'), ['a'], 'E5 删除不存在的项 → 原样返回')
  eq(N.removeMuted(undefined, 'a'), [], 'E6 undefined → 空数组')
}

/* ---------------- 6. normalizeNotifyPrefs 老配置兜底 ---------------- */
{
  eq(N.normalizeNotifyPrefs(undefined), {
    enabled: true,
    system: true,
    sound: false,
    heuristic: false,
    mutedConnectionIds: []
  }, 'F1 无配置 → 默认（system 开、sound/heuristic 关）')

  // 手写 "false" 是真值 —— 这正是不能用 !!v 的理由
  eq(N.normalizeNotifyPrefs({ sound: 'false' }).sound, false, 'F2 字符串 "false" 不被当成真值')

  eq(N.normalizeNotifyPrefs({ enabled: 0 }).enabled, true, 'F3 非布尔值回落默认 true')

  eq(N.normalizeNotifyPrefs({ mutedConnectionIds: 'x' }).mutedConnectionIds, [], 'F4 非数组 → 空数组（不能崩）')

  eq(
    N.normalizeNotifyPrefs({ mutedConnectionIds: ['a', 'a', '', '  ', 'b'] }).mutedConnectionIds,
    ['a', 'b'],
    'F5 去重 + 去空白'
  )

  eq(N.normalizeNotifyPrefs(null).enabled, true, 'F6 null → 全部回落默认')
}

/* ---------------- 7. buildNotifyText 截断与折叠 ---------------- */
{
  const long = 'x'.repeat(400)
  const r = N.buildNotifyText({ kind: 'batch', title: long, detail: long })
  eq(r.title.length, 120, 'G1 标题截到 120 字')
  eq(r.body.length, 300, 'G2 正文截到 300 字')
  ok(r.title.endsWith('…'), 'G3 截断补省略号')

  eq(
    N.buildNotifyText({ kind: 'batch', title: '  a \n\n  b  ' }).title,
    'a b',
    'G4 空白折叠成一个空格'
  )
  eq(N.buildNotifyText({ kind: 'batch', title: 'ok' }).body, '', 'G5 无 detail → 空正文')
}

/* ---------------- 8. 类别表 ---------------- */
{
  eq(N.NOTIFY_KINDS.length, 8, 'H1 八类任务事件')
  for (const k of ['batch', 'diag', 'firmware', 'sftp', 'discover', 'tftp', 'heuristic']) {
    ok(N.NOTIFY_KINDS.includes(k), 'H2 类别表含 ' + k)
  }
}

/* ---------------- 汇总 ---------------- */
console.log('通知决策回归：通过 ' + pass + ' 条')
if (fails.length) {
  console.log('失败 ' + fails.length + ' 条：')
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
console.log('通知决策回归：全部 ' + pass + ' 条通过')
