/**
 * 「侧栏文件面板跟随终端 cwd」的决策单测。
 *
 * 这段逻辑的 bug 形态都是「功能在，但用户看不到」：
 *   - 面板默认停在「工作区」Tab，那是一列快捷位置，不是目录树；
 *   - 面板首次挂载时把游标对齐到当前序号，挂载前发生的 cd 全被吃掉；
 *   - 用户手动关掉再打开跟随，期待「立刻对齐」而不是等下一次 cd。
 * 这些都不是解析问题，所以用纯函数覆盖。
 *
 * 被测文件：src/renderer/src/lib/cwdFollow.ts（零依赖，直接 require 编译产物）
 * 用法：node scripts/verify-cwdfollow.cjs
 */
const path = require('path')
const esbuild = require('esbuild')

async function load() {
  const out = await esbuild.build({
    entryPoints: [path.join(__dirname, '../src/renderer/src/lib/cwdFollow.ts')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    write: false,
    logLevel: 'silent'
  })
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require)
  return mod.exports
}

function main({ decideFollow, decideInitial }) {
  let pass = 0
  const fails = []
  function eq(actual, expected, label) {
    const a = JSON.stringify(actual)
    const e = JSON.stringify(expected)
    if (a === e) pass++
    else fails.push(`${label}\n    期望 ${e}\n    实际 ${a}`)
  }

  /* ---------------- decideInitial：首次挂载落在哪 ---------------- */

  eq(
    decideInitial({ knownCwd: '/var/log', follow: true, tab: 'workspace' }),
    { dir: '/var/log', tab: 'fs' },
    'I1 有已知 cwd + 开着跟随 → 直接进目录树（这是「cd 完看不到文件」的根因）'
  )
  eq(
    decideInitial({ knownCwd: '/var/log', follow: false, tab: 'workspace' }),
    { dir: '/var/log', tab: 'workspace' },
    'I2 关掉跟随时不替用户切 Tab'
  )
  eq(
    decideInitial({ knownCwd: '', follow: true, tab: 'workspace' }),
    { dir: '', tab: 'workspace' },
    'I3 没有已知 cwd → 留在工作区，等 home 解析'
  )
  eq(
    decideInitial({ knownCwd: '  /srv/app//', follow: true, tab: 'workspace' }),
    { dir: '/srv/app', tab: 'fs' },
    'I4 已知 cwd 归一化（折叠斜杠、去尾斜杠）'
  )
  eq(
    decideInitial({ knownCwd: '/', follow: true, tab: 'workspace' }),
    { dir: '/', tab: 'fs' },
    'I5 根目录也算有效 cwd'
  )

  /* ---------------- decideFollow：一次次 cd ---------------- */

  const base = { connected: true, follow: true, currentDir: '/home/dev' }

  eq(
    decideFollow({ ...base, seq: 1, followedSeq: 0, path: '/var/log' }),
    { jump: '/var/log', followedSeq: 1 },
    'F1 新事件 → 跳过去'
  )
  eq(
    decideFollow({ ...base, seq: 1, followedSeq: 1, path: '/var/log' }),
    { jump: null, followedSeq: 1 },
    'F2 同一事件不重复消费'
  )
  eq(
    decideFollow({ ...base, currentDir: '/var/log', seq: 2, followedSeq: 1, path: '/var/log' }),
    { jump: null, followedSeq: 2 },
    'F3 已经在目标目录 → 游标前进但不做无意义的 UI 清空'
  )
  eq(
    decideFollow({ ...base, currentDir: '/etc', seq: 3, followedSeq: 2, path: '/var/log' }),
    { jump: '/var/log', followedSeq: 3 },
    'F4 用户手动逛到 /etc 后再 cd 回 /var/log → 必须跳回去（seq 而非路径比较的意义）'
  )
  eq(
    decideFollow({ ...base, seq: 4, followedSeq: 3, path: '' }),
    { jump: null, followedSeq: 3 },
    'F5 序号前进但路径还没解析出来 → 游标不前进，等下一次事件'
  )
  eq(
    decideFollow({ ...base, follow: false, seq: 5, followedSeq: 4, path: '/opt' }),
    { jump: null, followedSeq: 5 },
    'F6 关掉跟随 → 不跳，但游标跟上（重新打开时不该补跳历史目录）'
  )
  eq(
    decideFollow({ ...base, connected: false, seq: 6, followedSeq: 5, path: '/opt' }),
    { jump: null, followedSeq: 6 },
    'F7 断线时同样只推进游标'
  )
  eq(
    decideFollow({ ...base, seq: 3, followedSeq: 5, path: '/opt' }),
    { jump: null, followedSeq: 5 },
    'F8 序号回退（切会话残留）→ 不跳也不回退游标'
  )
  eq(
    decideFollow({ ...base, currentDir: '/var//log/', seq: 7, followedSeq: 6, path: '/var/log' }),
    { jump: null, followedSeq: 7 },
    'F9 路径比较前先归一化（/var//log/ 与 /var/log 是同一处）'
  )
  eq(
    decideFollow({ ...base, seq: 8, followedSeq: 7, path: '/opt/my dir' }),
    { jump: '/opt/my dir', followedSeq: 8 },
    'F10 带空格的目录名原样返回（不 trim 掉中间的空格）'
  )
  eq(
    decideFollow({ ...base, seq: 9, followedSeq: 8, path: '   ' }),
    { jump: null, followedSeq: 8 },
    'F11 纯空白路径视为无路径'
  )

  /* ---------------- 真实序列：cd → 打开面板 → 手动逛 → 再 cd ---------------- */

  {
    // 面板还没挂载时用户就 cd 了两次
    let followed = 0
    let currentDir = ''
    const events = [
      { seq: 1, path: '/var/log' },
      { seq: 2, path: '/etc/nginx' }
    ]
    for (const e of events) {
      const d = decideFollow({ connected: true, follow: true, currentDir, followedSeq: followed, ...e })
      followed = d.followedSeq
      if (d.jump) currentDir = d.jump
    }
    eq(
      { currentDir, followed },
      { currentDir: '/etc/nginx', followed: 2 },
      'S1 连续 cd 后最终停在最后那个目录'
    )

    // 面板此刻才第一次挂载：应当直接落在终端所在目录，且进入目录树
    const init = decideInitial({ knownCwd: currentDir, follow: true, tab: 'workspace' })
    eq(init, { dir: '/etc/nginx', tab: 'fs' }, 'S2 首次打开面板直接落在终端当前目录并显示目录树')

    // 用户手动逛走，然后再 cd 同一目录 —— 必须再跳一次
    currentDir = '/tmp'
    const d2 = decideFollow({
      connected: true,
      follow: true,
      currentDir,
      followedSeq: followed,
      seq: 3,
      path: '/etc/nginx'
    })
    eq(d2, { jump: '/etc/nginx', followedSeq: 3 }, 'S3 手动逛走后 cd 回同一路径仍会跳')
  }

  if (fails.length) {
    console.error(`\n✗ ${fails.length} 项失败，${pass} 项通过\n`)
    for (const f of fails) console.error('  - ' + f)
    process.exit(1)
  }
  console.log(`✓ cwdFollow 全部 ${pass} 项通过`)
}

load().then(main).catch((e) => {
  console.error(e)
  process.exit(1)
})
