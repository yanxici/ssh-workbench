/**
 * IPC 通道完整性自检：拆分 main/index.ts 之后，134 个通道一个都不能少。
 *
 * 拆分是纯搬家，风险全在「漏搬了一个 handle()」—— 那不会编译失败，
 * 只会在用户点到那个按钮时报 "No handler registered"。
 * 所以这里做三层对账：
 * 1. 静态：shared/ipc.ts 里的每个通道常量，必须在 src/main 里有对应的 IPC.XXX 注册；
 * 2. 运行时：真跑一遍 registerAllIpc()，数 ipcMain 上实际注册的通道；
 * 3. 行为：抽查通道可调用，且失败被包装成 { ok:false } 而不是抛异常。
 *
 * 用法：npx electron scripts/verify-ipc-registration.cjs
 */

/*
 * 有些终端/CI 会全局设置 ELECTRON_RUN_AS_NODE=1，此时 electron 走 Node 模式，
 * require('electron') 拿到的是路径字符串而不是内置模块 —— 静态断言照样全绿，
 * 但运行时那段其实没跑（假测试）。发现该变量就静默重开一次，去掉它再跑。
 */
if (process.env.ELECTRON_RUN_AS_NODE) {
  const { spawnSync } = require('child_process')
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const r = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], { stdio: 'inherit', env })
  process.exit(r.status === null ? 1 : r.status)
}

const { app, ipcMain } = require('electron')
const fs = require('fs')
const path = require('path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, '.tsc-verify')
fs.mkdirSync(OUT, { recursive: true })

let failed = 0
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failed++
    console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`)
  }
}

/** 从 shared/ipc.ts 抽出 [常量名, 通道值] */
function readChannels() {
  const src = fs.readFileSync(path.join(ROOT, 'src/shared/ipc.ts'), 'utf-8')
  const out = []
  for (const m of src.matchAll(/^\s+([A-Z_]+):\s*'([^']+)'/gm)) {
    out.push({ name: m[1], value: m[2] })
  }
  return out
}

function walk(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (e.name.endsWith('.ts')) acc.push(p)
  }
  return acc
}

async function main() {
  const channels = readChannels()
  const eventChannels = channels.filter((c) => c.value.startsWith('evt:'))
  const invokeChannels = channels.filter((c) => !c.value.startsWith('evt:'))

  console.log('\nstatic: 每个通道常量都要有 IPC.XXX 注册点')
  check('通道总数 > 100', channels.length > 100, channels.length)

  const mainFiles = walk(path.join(ROOT, 'src/main'))
  const sources = mainFiles
    .filter((f) => !f.endsWith(path.join('ipc', 'handle.ts')))
    .map((f) => fs.readFileSync(f, 'utf-8'))
    .join('\n')

  const missing = invokeChannels.filter((c) => !sources.includes(`IPC.${c.name}`))
  check(
    `所有 invoke 通道有注册点（缺 ${missing.length}）`,
    missing.length === 0,
    missing.slice(0, 8).map((c) => c.name)
  )
  check('事件通道无需注册（主进程 -> 渲染层）', eventChannels.length > 0, eventChannels.length)

  console.log('\nruntime: 真跑一遍 registerAllIpc()')
  const stub = path.join(OUT, 'electron-stub-ipc.cjs')
  fs.writeFileSync(stub, 'module.exports = require("electron")\n')
  const bundle = path.join(OUT, 'ipc-bundle.cjs')
  const stubWin = path.join(OUT, 'windowref-stub-ipc.cjs')
  fs.writeFileSync(
    stubWin,
    [
      'let win = null',
      'exports.getMainWindow = () => win',
      'exports.setMainWindow = (w) => { win = w }',
      'exports.dialogParent = () => undefined'
    ].join('\n') + '\n'
  )
  await esbuild.build({
    stdin: {
      contents: "export { registerAllIpc } from './src/main/ipc'",
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['electron', 'ssh2', 'electron-updater'],
    logLevel: 'error',
    alias: { '@shared': path.join(ROOT, 'src/shared') },
    plugins: [
      {
        name: 'stub-windowref',
        setup(b) {
          b.onResolve({ filter: /windowRef$/ }, () => ({ path: stubWin }))
        }
      }
    ]
  })

  await app.whenReady()
  const { registerAllIpc } = require(bundle)
  registerAllIpc()
  const registered = [...ipcMain._invokeHandlers.keys()]
  const expected = invokeChannels.map((c) => c.value)
  const notRegistered = expected.filter((c) => !registered.includes(c))
  const extra = registered.filter((c) => !expected.includes(c))

  check(
    `注册数量覆盖全部通道（${registered.length}/${expected.length}）`,
    notRegistered.length === 0,
    notRegistered.slice(0, 8)
  )
  check('没有多余注册（改名字忘了改常量）', extra.length === 0, extra.slice(0, 8))

  console.log('\nbehavior: 抽查通道可调用、失败被包装')
  const invoke = (ch, ...args) => ipcMain._invokeHandlers.get(ch)({}, ...args)

  const paths = await invoke('store:paths')
  check('store:paths 返回 ok', paths && paths.ok === true, paths)
  const settings = await invoke('settings:get')
  check('settings:get 返回 ok', settings && settings.ok === true)

  // 失败必须被 handle() 包装成 { ok:false }，绝不能抛到渲染层
  const bad = await invoke('known:refresh', 'x', 1, 'nope')
  check('失败被包装成 { ok:false }', bad && bad.ok === false, bad && bad.error)

  // 越权路径：渲染层不能指定任意文件来导入
  const swallow = await invoke('conn:import-preview', 'C:/windows/win.ini')
  check('导入通道拒绝未授权路径', swallow && swallow.ok === false, swallow && swallow.error)

  console.log('')
  if (failed > 0) {
    console.log(`IPC 完整性自检失败：${failed} 项\n`)
    app.exit(1)
    return
  }
  console.log(`IPC 完整性自检全部通过（${registered.length} 个通道）\n`)
  app.exit(0)
}

main().catch((e) => {
  console.error(e)
  app.exit(1)
})
