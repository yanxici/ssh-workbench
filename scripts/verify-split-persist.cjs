/**
 * 分屏持久化回归（R-C13 两个爆破点）。
 *
 * 被修的 bug：
 *   A) remember() 把嵌套分屏格也当标签记下来 → 重启后 1 个 3 格分屏变 3 个标签、
 *      每个再裂 3 格 → 9 → 27 个 shell，撑爆远端 MaxSessions。
 *   B) persist() 只发异步 IPC、不同步改内存 settings → 关掉一格后 App 的恢复
 *      effect 读到旧的 splitLayout、当场再 restoreFor() 把分屏裂回来（窗格复活）。
 *   C) persist() 的删旧循环判据是「当前没有树」，会把**副窗格所属连接**的
 *      布局记录一起删掉（connB 从没拥有过自己的树）。
 *
 * 用法：node scripts/verify-split-persist.cjs
 * 变异验证：SPLIT_SRC=./.tsc-verify/mut/splitStore.old.ts node scripts/verify-split-persist.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, '.tsc-verify', 'stub-split')
const SRC = process.env.SPLIT_SRC || path.join(ROOT, 'src/renderer/src/stores/splitStore.ts')

let failed = 0
function check(name, ok, extra) {
  if (ok) console.log('  ok   ' + name)
  else {
    failed++
    console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''))
  }
}

function stub(name, code) {
  const f = path.join(OUT, name + '.ts')
  fs.writeFileSync(f, code)
  return f
}

async function build() {
  fs.rmSync(OUT, { recursive: true, force: true })
  fs.mkdirSync(OUT, { recursive: true })

  // 会话列表由测试驱动，其余 action 用空实现（persist 只看 sessions 的 id/connectionId）
  const sessionStub = stub(
    'sessionStore',
    [
      'const g: any = globalThis',
      'g.__splitSessions = g.__splitSessions || []',
      'export const useSessionStore: any = {',
      '  getState: () => ({',
      '    sessions: g.__splitSessions,',
      '    close: () => {},',
      '    setActive: () => {},',
      '    openTerminal: () => g.__splitOpenTerminal || null,',
      '    activeId: null',
      '  })',
      '}'
    ].join('\n')
  )

  // update() 永不 resolve：用来证明「内存已经是新布局」不是靠 IPC 回包
  const settingsStub = stub(
    'settingsStore',
    [
      'const g: any = globalThis',
      'g.__splitSettings = g.__splitSettings || { settings: { splitLayout: {} } }',
      'g.__splitUpdates = g.__splitUpdates || []',
      'export const useSettingsStore: any = {',
      '  getState: () => ({',
      '    settings: g.__splitSettings.settings,',
      '    update: (patch: any) => { g.__splitUpdates.push(patch); return new Promise(() => {}) }',
      '  }),',
      '  setState: (arg: any) => {',
      '    const cur = g.__splitSettings.settings',
      '    const next = typeof arg === "function" ? arg({ settings: cur }) : arg',
      '    g.__splitSettings.settings = next.settings',
      '  }',
      '}'
    ].join('\n')
  )

  const toastStub = stub(
    'toastStore',
    'export const useToastStore: any = { getState: () => ({ push: () => {} }) }\n'
  )

  const uidStub = stub(
    'utils',
    'let n = 0\nexport const uid = (): string => "id" + (n += 1)\nexport const cn = (...a: any[]): string => a.filter(Boolean).join(" ")\n'
  )

  /*
   * splitStore 用相对路径 import 兄弟 store（'./sessionStore'），alias 对相对路径无效，
   * 所以这里用 resolve 插件按模块名拦截 —— 只替换这三个，其余（paneTree、
   * paneRegistry、utils 的真实现）照常打进 bundle。
   */
  const stubs = {
    sessionStore: sessionStub,
    settingsStore: settingsStub,
    toastStore: toastStub,
    utils: uidStub
  }
  const stubPlugin = {
    name: 'stub-stores',
    setup(b) {
      b.onResolve({ filter: /(^|\/)(sessionStore|settingsStore|toastStore|utils)$/ }, (args) => {
        const hit = args.path.split('/').pop()
        if (stubs[hit]) return { path: stubs[hit] }
        return null
      })
    }
  }

  /*
   * 探针必须和 splitStore 在**同一张模块图**里打出来。
   * paneRegistry 是一个模块级 Map，splitStore 的 reindex() 往里写、TabBar/App 往外读；
   * 分两份 bundle 就会有两个 Map 实例，探针永远读到空表（断言假红）。
   */
  const bundle = path.join(OUT, 'splitStore.cjs')
  await esbuild.build({
    stdin: {
      contents: [
        'export { useSplitStore } from ' + JSON.stringify(SRC),
        "export { isNestedPane } from '@/lib/paneRegistry'"
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    logLevel: 'error',
    plugins: [stubPlugin],
    alias: { '@': path.join(ROOT, 'src/renderer/src') }
  })
  return require(bundle)
}

async function main() {
  const { useSplitStore, isNestedPane } = await build()
  const g = globalThis
  const layoutOf = () => g.__splitSettings.settings.splitLayout || {}

  /* ---------------- C13-A：remember() 不能记嵌套格 ---------------- */
  /*
   * remember() 在 App.tsx 里，但它过滤的依据是 paneRegistry.isNestedPane。
   * 这里直接验证「分屏格会被判为嵌套」——那是过滤生效的前提。
   */
  /*
   * s2 属于 connB 且是 connA 分屏里的副窗格 —— 这正是「副窗格没有自己的树」的场景。
   * 旧实现的删旧循环只认「这个连接当前有没有树」，于是把 connB 保存的布局一起删了。
   */
  g.__splitSessions = [
    { id: 's1', connectionId: 'connA', status: 'connected' },
    { id: 's2', connectionId: 'connB', status: 'connected' },
    { id: 's3', connectionId: 'connC', status: 'connected' }
  ]
  /*
   * 走真实入口 splitPane 而不是 setState：paneRegistry 的索引只在 store 的
   * reindex() 里刷新，直接塞 trees 会绕过它，探针读到的永远是空表。
   */
  g.__splitOpenTerminal = 's2'
  const newPane = useSplitStore.getState().splitPane('s1', 'row')
  check('A0 splitPane 开出了第二格', newPane === 's2', newPane)
  check('A1 分屏里的非主人格被判为嵌套格（remember 据此过滤）', isNestedPane('s2') === true)
  check('A2 标签主人格不是嵌套格', isNestedPane('s1') === false)

  /* ---------------- C13-C：persist 不能删副窗格所属连接的布局 ---------------- */
  g.__splitSettings.settings.splitLayout = { connB: { t: 'l', c: 'connB' } }
  g.__splitUpdates.length = 0
  useSplitStore.getState().setDragging(true)
  useSplitStore.getState().setDragging(false)
  const afterSplit = layoutOf()
  check('C1 connA 的分屏布局被写入', afterSplit.connA !== undefined, Object.keys(afterSplit))
  check(
    'C2 副窗格所属 connB 的旧布局没被误删',
    afterSplit.connB !== undefined,
    Object.keys(afterSplit)
  )
  check(
    'C3 内存 settings 已同步更新（不依赖 IPC 回包，update 永不 resolve）',
    g.__splitSettings.settings.splitLayout.connA !== undefined
  )
  check('C4 仍然发出了落盘 IPC', g.__splitUpdates.length === 1, g.__splitUpdates.length)

  /* ---------------- C13-B：合回单格后必须删记录 ---------------- */
  useSplitStore.setState({ trees: {} })
  g.__splitSessions = [{ id: 's1', connectionId: 'connA', status: 'connected' }]
  useSplitStore.getState().setDragging(true)
  useSplitStore.getState().setDragging(false)
  const afterFlatten = layoutOf()
  check(
    'B1 合回单格后该连接的布局记录被删（否则重启又裂开）',
    afterFlatten.connA === undefined,
    Object.keys(afterFlatten)
  )

  /* ---------------- C13-B2：关掉一格那一刻，读到的就是新布局 ---------------- */
  /*
   * 这是「窗格瞬间复活」的直接判据：closePane 之后立刻读 settings.splitLayout，
   * 必须已经是「没有该连接」的状态。旧实现这里是旧值。
   */
  g.__splitSessions = [
    { id: 's5', connectionId: 'connD', status: 'connected' },
    { id: 's6', connectionId: 'connD', status: 'connected' }
  ]
  useSplitStore.setState({
    trees: {
      s5: {
        type: 'split',
        id: 'sp2',
        dir: 'col',
        ratio: 0.5,
        children: [
          { type: 'leaf', sessionId: 's5' },
          { type: 'leaf', sessionId: 's6' }
        ]
      }
    },
    syncByTab: {}
  })
  useSplitStore.getState().setDragging(true)
  useSplitStore.getState().setDragging(false)
  check('B2 关格前布局存在', layoutOf().connD !== undefined)

  useSplitStore.getState().closePane('s6')
  g.__splitSessions = [{ id: 's5', connectionId: 'connD', status: 'connected' }]
  const immediate = layoutOf()
  check(
    'B3 closePane 后**同步**读到的布局里已无 connD（不会立刻复活分屏）',
    immediate.connD === undefined,
    Object.keys(immediate)
  )

  fs.rmSync(OUT, { recursive: true, force: true })
  console.log('\n' + (failed === 0 ? '分屏持久化回归全部通过' : failed + ' 项失败'))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('校验异常:', e)
  process.exit(2)
})
