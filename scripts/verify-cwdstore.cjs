/**
 * cwdStore 行为单测：seq 语义（这是「侧栏跟随」的核心契约）。
 *
 * 用 esbuild 把真实的 src/renderer/src/stores/cwdStore.ts 打成 CJS，只 stub 掉
 * 两个副作用（IPC 与 home 缓存），store 本身的逻辑是线上那份。
 *
 * 用法：node scripts/verify-cwdstore.cjs
 */
const path = require('path')
const esbuild = require('esbuild')

/** 依赖替身：store 只在「缺 home 时补一次」才会用到它们 */
const STUBS = {
  'lib-ipc': `
    export const call = (p) => (p && p.then ? p : Promise.resolve(null))
    export function ipcStub() {}
  `,
  'lib-remote-home': `
    const homes = new Map()
    export function cachedHome(id) { return homes.get(id) || '' }
    export function rememberHome(id, h) { homes.set(id, h) }
    export function forgetHome(id) { homes.delete(id) }
  `,
  'lib-upload-dir': `
    export function normalizeRemoteDir(p) {
      if (typeof p !== 'string' || !p) return ''
      const out = []
      for (const seg of p.split('/')) {
        if (!seg || seg === '.') continue
        if (seg === '..') { out.pop(); continue }
        out.push(seg)
      }
      return '/' + out.join('/')
    }
  `
}

const plugin = {
  name: 'stubs',
  setup(build) {
    build.onResolve({ filter: /^@\/lib\/ipc$/ }, () => ({ path: 'lib-ipc', namespace: 'stub' }))
    build.onResolve({ filter: /^@\/lib\/remoteHome$/ }, () => ({
      path: 'lib-remote-home',
      namespace: 'stub'
    }))
    build.onResolve({ filter: /^@\/lib\/uploadDir$/ }, () => ({
      path: 'lib-upload-dir',
      namespace: 'stub'
    }))
    build.onLoad({ filter: /.*/, namespace: 'stub' }, (a) => ({
      contents: STUBS[a.path],
      loader: 'js'
    }))
  }
}

const SRC = path.join(__dirname, '../src/renderer/src/stores/cwdStore.ts')

async function main() {
  const out = await esbuild.build({
    entryPoints: [SRC],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node18',
    write: false,
    logLevel: 'silent',
    tsconfig: path.join(__dirname, '../tsconfig.web.json'),
    plugins: [plugin]
  })

  // zustand 在 node 里能直接跑；window 只在 call() 内部被摸到，用桩兜住
  globalThis.window = globalThis.window || {}
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', 'window', out.outputFiles[0].text)(
    mod,
    mod.exports,
    require,
    globalThis.window
  )
  const { useCwdStore, seedCwdFromHome, applyOsc7 } = mod.exports

  run(useCwdStore, seedCwdFromHome, applyOsc7)
}

function run(useCwdStore, seedCwdFromHome, applyOsc7) {
let pass = 0
const fails = []
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else fails.push(`${label}\n    期望 ${e}\n    实际 ${a}`)
}
const st = () => useCwdStore.getState()
const seqOf = (id) => st().seq[id] ?? 0
const pathOf = (id) => st().path[id] ?? ''

/* 1. seed 只落基准，不产生事件 */
seedCwdFromHome('s1', '/home/dev')
eq(pathOf('s1'), '/home/dev', 'S1 seed 落基准')
eq(seqOf('s1'), 0, 'S2 seed 不递增 seq（不该触发跟随）')
seedCwdFromHome('s1', '/srv') // 已有值不覆盖
eq(pathOf('s1'), '/home/dev', 'S3 seed 不覆盖已有值')

/* 2. setPath 每次都产生事件，哪怕路径没变 —— 这就是「再 cd 一次要跳回去」 */
st().setPath('s1', '/opt')
eq(pathOf('s1'), '/opt', 'S4 setPath 更新路径')
eq(seqOf('s1'), 1, 'S5 setPath 递增 seq')
st().setPath('s1', '/opt')
eq(seqOf('s1'), 2, 'S6 同一路径再 cd 也递增 seq')

/* 3. 路径归一化后再存（尾斜杠 / 重复斜杠 / ..） */
st().setPath('s1', '/var//log/../log/')
eq(pathOf('s1'), '/var/log', 'S7 路径归一化')

/* 4. 空/非法输入不产生事件 */
st().setPath('s1', '')
eq(seqOf('s1'), 3, 'S8 空路径不递增 seq')
st().setPath('s1', null)
eq(seqOf('s1'), 3, 'S9 null 路径不递增 seq')

/* 5. 会话之间互不干扰 */
st().setPath('s2', '/tmp')
eq(pathOf('s1'), '/var/log', 'S10 其它会话不影响本会话路径')
eq(seqOf('s2'), 1, 'S11 其它会话独立计数')

/* 6. OSC 7 覆盖 */
applyOsc7('s1', 'file://host/home/dev/work')
eq(pathOf('s1'), '/home/dev/work', 'S12 OSC7 覆盖本地解析')
eq(seqOf('s1'), 4, 'S13 OSC7 也算一次事件')
applyOsc7('s1', 'not-a-url')
eq(seqOf('s1'), 4, 'S14 非法 OSC7 不产生事件')

/* 7. forget 清干净 */
st().forget('s1')
eq(pathOf('s1'), '', 'S15 forget 清路径')
eq(seqOf('s1'), 0, 'S16 forget 清 seq')
eq(pathOf('s2'), '/tmp', 'S17 forget 不影响其它会话')

/* 8. 订阅方按 seq 判断：模拟 FileExplorer 的跟随循环 */
let followed = 0
const jumps = []
const unsub = useCwdStore.subscribe((s) => {
  const seq = s.seq.s3 ?? 0
  if (seq <= followed) return
  followed = seq
  jumps.push(s.path.s3)
})
st().setPath('s3', '/a')
st().setPath('s3', '/a') // 用户手动逛走后再 cd 回同一路径 —— 必须再跳一次
st().setPath('s3', '/b')
unsub()
st().setPath('s3', '/c')
eq(jumps, ['/a', '/a', '/b'], 'S18 每次 cd 都触发一次跟随（含重复路径）')
eq(followed, 3, 'S19 退订后不再跟随')

if (fails.length) {
  console.error(`\n✗ ${fails.length} 项失败，${pass} 项通过\n`)
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
console.log(`✓ cwdStore 全部 ${pass} 项通过`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
