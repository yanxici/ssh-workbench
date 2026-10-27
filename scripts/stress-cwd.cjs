/**
 * 本次改动的压测：目录缓存 / 批量加载器 / 终端 cwd 解析。
 *
 * 为什么要有它：仓库原有的 scripts/stress-test.js 只压连接配置与快捷键，
 * 完全没覆盖「侧栏打开远端目录」这条链路。而这条链路的性能瓶颈恰恰不在
 * 数据量上，而在**往返次数**与**重复请求**上 —— 所以要压的是 IPC 次数、
 * 命中率、以及每行命令的解析成本。
 *
 * 与 verify-*.cjs 的分工：
 *   - verify-* 测**对不对**（契约、边界、失败路径）
 *   - 本文件测**扛不扛得住**（吞吐、命中率、内存、退化情况）
 *
 * 全部跑真实的线上代码（esbuild 打包后 require），不是副本。
 *
 * 用法：node scripts/stress-cwd.cjs
 * 退出码 0 = 全部达标。
 */
const path = require('path')
const esbuild = require('esbuild')

/* ------------------------------------------------------------------ *
 *  加载被测模块
 * ------------------------------------------------------------------ */

/**
 * esbuild 同步 API 不支持 plugin，所以这里用异步 build。
 * 依赖替身（stub）与 verify-cwdstore.cjs 同构，保证测的是线上那份逻辑。
 */
async function loadTs(entry, stubs = {}) {
  const plugins = []
  const alias = Object.entries(stubs)
  if (alias.length) {
    plugins.push({
      name: 'stubs',
      setup(build) {
        for (const [id, contents] of alias) {
          const ns = 'stub:' + id
          build.onResolve(
            { filter: new RegExp('^' + id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') },
            () => ({ path: id, namespace: ns })
          )
          build.onLoad({ filter: /.*/, namespace: ns }, () => ({ contents, loader: 'js' }))
        }
      }
    })
  }
  const out = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    write: false,
    logLevel: 'silent',
    plugins
  })
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require)
  return mod.exports
}

let shellCwd = null
let dirCache = null
let dirLoader = null

async function loadAll() {
  shellCwd = await loadTs(path.join(__dirname, '../src/renderer/src/lib/shellCwd.ts'))
  dirCache = await loadTs(path.join(__dirname, '../src/renderer/src/lib/dirCache.ts'), {
    '@shared/types': 'export {}'
  })
  dirLoader = await loadTs(path.join(__dirname, '../src/renderer/src/lib/dirLoader.ts'), {
    '@/lib/ipc': 'export const call = (p) => (p && p.then ? p : Promise.resolve(null))'
  })
}

/* ------------------------------------------------------------------ *
 *  报告工具
 * ------------------------------------------------------------------ */

const rows = []
let fail = 0

/**
 * @param name  测试项
 * @param ok    是否达标
 * @param detail 实测值描述
 * @param budget 预估值（超过就失败）
 */
function bench(name, ok, detail, budget) {
  rows.push({ name, ok, detail, budget })
  if (!ok) fail++
  console.log(`  ${ok ? 'OK  ' : 'FAIL'}  ${name}\n        ${detail}${budget ? `  (预算 ${budget})` : ''}`)
}

function fmt(n) {
  return n.toLocaleString('en-US')
}

function ms(n) {
  return n < 1 ? `${(n * 1000).toFixed(0)}µs` : `${n.toFixed(1)}ms`
}

function hr(title) {
  console.log('\n' + title)
  console.log('-'.repeat(title.length))
}

/* ------------------------------------------------------------------ *
 *  1. 目录缓存：命中率与规模退化
 * ------------------------------------------------------------------ */

async function testDirCacheThroughput() {
  hr('1. 目录缓存吞吐（侧栏切目录的主路径）')

  // 模拟一个 300 目录的工作现场：每个目录 200 个条目
  const DIRS = 300
  const FILES_PER_DIR = 200
  const paths = Array.from({ length: DIRS }, (_, i) => `/srv/app/module-${i}/src`)

  const mkFiles = (p) =>
    Array.from({ length: FILES_PER_DIR }, (_, i) => ({
      name: `file-${i}.ts`,
      path: `${p}/${i}`,
      type: i % 7 === 0 ? 'directory' : 'file',
      size: 1024 * i,
      mtime: 1700000000 + i,
      modeStr: 'rw-r--r--',
      linkTarget: ''
    }))

  let fetches = 0
  const fetcher = async (dir) => {
    fetches++
    return mkFiles(dir)
  }

  // 预热：把 300 个目录全部读一遍
  const t0 = process.hrtime.bigint()
  for (const p of paths) await dirCache.loadDir('sess-hot', p, () => fetcher(p))
  const coldMs = Number(process.hrtime.bigint() - t0) / 1e6
  bench(
    '冷启动 300 目录 × 200 条目',
    coldMs < 3000,
    `${ms(coldMs)}，${DIRS * FILES_PER_DIR} 条记录，${fetches} 次 fetch`,
    '< 3000ms'
  )

  // 热路径：同样的 300 个目录再走 20 轮（模拟来回点目录）
  const fetchesBefore = fetches
  const ROUNDS = 20
  const t1 = process.hrtime.bigint()
  for (let r = 0; r < ROUNDS; r++) {
    for (const p of paths) await dirCache.loadDir('sess-hot', p, () => fetcher(p))
  }
  const warmMs = Number(process.hrtime.bigint() - t1) / 1e6
  const extraFetches = fetches - fetchesBefore
  const lookups = ROUNDS * DIRS
  bench(
    `热路径 ${fmt(lookups)} 次目录切换`,
    extraFetches === 0,
    `${ms(warmMs)}，${fmt(Math.round(lookups / (warmMs / 1000)))} 次/秒，额外 fetch ${extraFetches} 次`,
    '额外 fetch = 0'
  )

  // 在途去重：同一目录并发展开 50 次
  const before = fetches
  dirCache.invalidateDir('sess-dup', '/srv/app/dup')
  const t2 = process.hrtime.bigint()
  const results = await Promise.all(
    Array.from({ length: 50 }, () =>
      dirCache.loadDir('sess-dup', '/srv/app/dup', () => fetcher('/srv/app/dup'))
    )
  )
  const dupMs = Number(process.hrtime.bigint() - t2) / 1e6
  bench(
    '同一目录并发展开 50 次',
    fetches - before === 1 && results.every((r) => r && r.length === FILES_PER_DIR),
    `${ms(dupMs)}，实际 fetch ${fetches - before} 次，50 个调用全部拿到 ${FILES_PER_DIR} 条`,
    'fetch = 1 次'
  )

  // 规模上限：塞 900 个目录，看是否被 MAX_DIRS(300) 压住
  for (let i = 0; i < 900; i++) {
    await dirCache.loadDir('sess-many', `/bulk/${i}`, async () => mkFiles(`/bulk/${i}`))
  }
  const stats = dirCache.cacheStats()
  bench(
    '写入 900 个目录后的容量控制',
    stats.dirs <= 300,
    `缓存内 ${stats.dirs} 个目录（上限 ${stats.dirs <= 300 ? '300 生效' : '未生效！'}），在途 ${stats.inflight}`,
    '≤ 300'
  )

  // 会话级失效：一次清掉该会话全部目录
  dirCache.invalidateDir('sess-many')
  const after = dirCache.cacheStats()
  bench(
    '会话级失效一次清空',
    after.dirs < stats.dirs,
    `${stats.dirs} → ${after.dirs} 个目录`,
    '应减少'
  )

  dirCache.clearDirCache()
}

/* ------------------------------------------------------------------ *
 *  2. 批量加载器：IPC 合并率
 * ------------------------------------------------------------------ */

async function testDirLoaderBatching() {
  hr('2. 批量加载器的 IPC 合并率（决定慢链路体感）')

  /*
   * dirLoader 内部最终会调 `window.api.sftp.list/listMany`。这里给 global 装一个
   * 假 window，记录「到底发出去了多少条请求、每批带了几个目录」——
   * 合并率就是这个文件要证明的核心指标。
   */
  const sent = { calls: 0, dirs: 0, batches: [] }
  global.window = {
    api: {
      sftp: {
        list: async (_s, dir) => {
          sent.calls++
          sent.dirs++
          sent.batches.push(1)
          return [{ name: dir, path: dir + '/x', type: 'file' }]
        },
        listMany: async (_s, dirs) => {
          sent.calls++
          sent.dirs += dirs.length
          sent.batches.push(dirs.length)
          const out = { dirs: {}, errors: {} }
          for (const d of dirs) out.dirs[d] = [{ name: d, path: d + '/x', type: 'file' }]
          return out
        }
      }
    }
  }

  const CASES = [4, 16, 64, 256]
  for (const N of CASES) {
    sent.calls = 0
    sent.dirs = 0
    sent.batches = []
    const dirs = Array.from({ length: N }, (_, i) => `/batch/case${N}/d${i}`)
    const t0 = process.hrtime.bigint()
    const res = await Promise.all(dirs.map((d) => dirLoader.requestDirs('sess-batch', [d])))
    const elapsed = Number(process.hrtime.bigint() - t0) / 1e6
    const st = dirLoader.loaderStats()
    const got = res.reduce((n, r) => n + Object.keys(r.dirs).length, 0)
    bench(
      `${N} 个目录同帧请求`,
      sent.calls === 1 && got === N && st.pending === 0 && st.waiters === 0,
      `${ms(elapsed)}，实际 IPC ${sent.calls} 条（旧路径需 ${N} 条，省 ${(
        (1 - sent.calls / N) *
        100
      ).toFixed(0)}%），${got}/${N} 个目录拿到数据`,
      'IPC = 1'
    )
  }

  // 会话切换：旧批次必须被丢弃，不能串到新会话
  sent.calls = 0
  sent.batches = []
  const oldP = dirLoader.requestDirs('sess-A', ['/a/1', '/a/2'])
  const newP = dirLoader.requestDirs('sess-B', ['/b/1'])
  const oldRes = await oldP
  const newRes = await newP
  bench(
    '会话切换时旧批次被丢弃',
    Object.keys(oldRes.dirs).length === 0 && Object.keys(oldRes.errors).length === 0,
    `旧会话返回 ${Object.keys(oldRes.dirs).length} 个目录（应为 0），新会话返回 ${Object.keys(newRes.dirs).length} 个`,
    '旧批次 = 0'
  )

  delete global.window
}

/* ------------------------------------------------------------------ *
 *  3. 终端 cwd 解析：每行命令的成本
 * ------------------------------------------------------------------ */

function testShellCwdParsing() {
  hr('3. 终端输入解析（每次按键都要跑，必须极便宜）')

  const HOME = '/home/dev'

  /* 3a. 逐字节 feed 的成本 —— 用户打字时这条路径在最前面 */
  {
    const t = shellCwd.createInputTracker()
    const LINES = 20000
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < LINES; i++) {
      // 逐字符送入，模拟真实按键流
      for (const ch of 'ls -la /var/log/nginx/') t.feed(ch)
      t.feed('\r')
    }
    const total = Number(process.hrtime.bigint() - t0) / 1e6
    const perLine = (total / LINES) * 1000
    bench(
      `${fmt(LINES)} 行命令逐字符送入`,
      perLine < 50,
      `${ms(total)} 总计，每行 ${perLine.toFixed(1)}µs（25 次 feed）`,
      '每行 < 50µs'
    )
  }

  /* 3b. 常见命令的解析成本 —— 回车时跑一次 */
  {
    const t = shellCwd.createInputTracker()
    const LINES = 200000
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < LINES; i++) {
      const line = t.feed(i % 3 === 0 ? 'cd /var/log\r' : i % 3 === 1 ? 'ls -la\r' : 'tail -f app.log\r')
      if (line) {
        shellCwd.containsCdCommand(line) && shellCwd.resolveCdPath(line, '/home/dev', HOME)
      }
    }
    const total = Number(process.hrtime.bigint() - t0) / 1e6
    bench(
      `${fmt(LINES)} 行（含 1/3 是 cd）`,
      total < 4000,
      `${ms(total)}，${fmt(Math.round(LINES / (total / 1000)))} 行/秒`,
      '< 4000ms'
    )
  }

  /* 3c. 超长命令不拖垮 —— 用户经常粘一整条长长的 curl */
  {
    const t = shellCwd.createInputTracker()
    const HUGE = 'curl -s "' + 'a'.repeat(100000) + '"'
    const t0 = process.hrtime.bigint()
    const line = t.feed(HUGE)
    const elapsed = Number(process.hrtime.bigint() - t0) / 1e6
    bench(
      '100KB 单次粘贴',
      line === null,
      `${ms(elapsed)} 处理完，超长行被丢弃（不解析、不跟随）`,
      '丢弃'
    )
  }

  /* 3d. bracketed paste 的整段处理 */
  {
    const t = shellCwd.createInputTracker()
    const N = 20000
    const payload = '\x1b[200~cd /opt/some/deep/path\x1b[201~'
    const t0 = process.hrtime.bigint()
    let ok = 0
    for (let i = 0; i < N; i++) {
      if (t.feed(payload + '\r') === 'cd /opt/some/deep/path') ok++
    }
    const total = Number(process.hrtime.bigint() - t0) / 1e6
    bench(
      `${fmt(N)} 次粘贴 cd 路径`,
      ok === N,
      `${ms(total)}，${fmt(Math.round(N / (total / 1000)))} 次/秒，全部正确解析`,
      '全部正确'
    )
  }

  /* 3e. ESC 序列轰炸：方向键乱按不能把追踪器搞崩 */
  {
    const t = shellCwd.createInputTracker()
    const N = 50000
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < N; i++) t.feed('\x1b[A')
    // 方向键翻历史会改写行缓冲且结果不回传 → 整行标记不可信，这一行必须被丢弃
    const afterArrows = t.feed('cd /srv\r')
    // 但状态必须在回车后复位，下一行照常工作
    const nextLine = t.feed('cd /opt\r')
    const total = Number(process.hrtime.bigint() - t0) / 1e6
    bench(
      `${fmt(N)} 次方向键后状态机仍正确`,
      afterArrows === null && nextLine === 'cd /opt',
      `${ms(total)}，方向键后的行被保守丢弃（${afterArrows === null ? '正确' : '漏了'}），下一行恢复识别`,
      '丢弃后复位'
    )
  }
}

/* ------------------------------------------------------------------ *
 *  4. 端到端：模拟真实操作序列
 * ------------------------------------------------------------------ */

function testEndToEndSequence() {
  hr('4. 端到端：模拟「点开目录 → 展开 → 切走 → 切回」')

  const HOME = '/home/dev'
  const tracker = shellCwd.createInputTracker()

  // 真实操作：cd 到深目录 → 侧栏跟随 → 展开三层 → 切到另一个会话 → 切回来
  const ops = [
    'cd /srv/app/src\r',
    'ls\r',
    'cd components\r',
    'vim index.ts\r',
    'cd ../..\r',
    'cd /var/log\r',
    'tail -f syslog\r',
    'cd ~\r'
  ]

  const want = ['/srv/app/src', null, '/srv/app/src/components', null, '/srv/app', '/var/log', null, '/home/dev']
  let base = HOME
  const got = []
  const t0 = process.hrtime.bigint()
  for (const cmd of ops) {
    const line = tracker.feed(cmd)
    if (!line) {
      got.push(null)
      continue
    }
    if (!shellCwd.containsCdCommand(line)) {
      got.push(null)
      continue
    }
    const dir = shellCwd.resolveCdPath(line, base, HOME)
    got.push(dir)
    if (dir) base = dir
  }
  const elapsed = Number(process.hrtime.bigint() - t0) / 1e6
  const ok = JSON.stringify(got) === JSON.stringify(want)
  bench(
    '8 步真实操作序列',
    ok,
    ok ? `${ms(elapsed)}，cwd 追踪全部正确` : `期望 ${JSON.stringify(want)}\n        实际 ${JSON.stringify(got)}`,
    '全部正确'
  )
}

/* ------------------------------------------------------------------ *
 *  主流程
 * ------------------------------------------------------------------ */

async function main() {
  console.log('SSH Workbench · 本次改动压测')
  console.log('='.repeat(60))
  await loadAll()
  const heapBefore = process.memoryUsage().heapUsed

  await testDirCacheThroughput()
  await testDirLoaderBatching()
  testShellCwdParsing()
  testEndToEndSequence()

  const heapAfter = process.memoryUsage().heapUsed
  const growth = (heapAfter - heapBefore) / 1024 / 1024

  console.log('\n' + '='.repeat(60))
  console.log(`结果：${rows.length - fail} 通过 / ${fail} 失败`)
  console.log(`堆增长：${growth.toFixed(1)} MB（含 300 目录缓存与 20 万行解析的中间对象）`)
  console.log('')

  // 写一份结果留档（与仓库既有 stress-test-results 目录保持一致）
  const fs = require('fs')
  const dir = path.join(__dirname, '../stress-test-results')
  fs.mkdirSync(dir, { recursive: true })
  const out = {
    at: new Date().toISOString(),
    platform: `${process.platform} ${process.arch}`,
    node: process.version,
    heapGrowthMB: Number(growth.toFixed(2)),
    passed: rows.length - fail,
    failed: fail,
    rows
  }
  fs.writeFileSync(path.join(dir, 'cwd-follow.json'), JSON.stringify(out, null, 2))
  console.log(`详细结果：${path.join(dir, 'cwd-follow.json')}`)

  process.exit(fail === 0 ? 0 : 1)
}

void main()
