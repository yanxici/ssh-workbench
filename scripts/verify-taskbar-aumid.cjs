#!/usr/bin/env node
/**
 * 任务栏 AUMID 防回归自检（解压版 / 便携版白图标根因）。
 *
 * 背景：
 *   Windows 10/11 上，一旦进程调用 app.setAppUserModelId('com.sshworkbench.app')，
 *   任务栏按钮不再使用 WM_GETICON 或 exe 内嵌图标，而是按「AUMID -> 开始菜单 .lnk」
 *   解析图标。解压版 zip 与便携版没有跑过安装器，开始菜单里没有对应的 .lnk（或旧
 *   .lnk 指向已删除的 dist-v*），导致任务栏退化成白色折角空白文档图标。
 *
 * 覆盖三组断言：
 *   1. 主进程入口接线：index.ts 不再无条件调 electronApp.setAppUserModelId(...)；
 *   2. 纯逻辑矩阵：非 Windows / 开发模式 / 无快捷方式 / 失效目标 / 指向别处 exe /
 *      失效自定义图标 / 有效安装快捷方式（根目录与子目录、大小写差异、坏 lnk 容错）；
 *   3. 真实 Electron shell.writeShortcutLink + shell.readShortcutLink 往返验证
 *      （在临时目录执行，绝不碰用户真实开始菜单）。
 *
 * 用法：node scripts/verify-taskbar-aumid.cjs
 */
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawnSync } = require('node:child_process')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const SRC_MOD = path.join(ROOT, 'src', 'main', 'window', 'appUserModelId.ts')
const SRC_INDEX = path.join(ROOT, 'src', 'main', 'index.ts')

let pass = 0
let fail = 0

function check(name, cond, detail) {
  if (cond) {
    pass++
    console.log('  PASS  ' + name)
  } else {
    fail++
    console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''))
  }
}

function group(title) {
  console.log('\n' + title)
}

/* ------------------------------------------------------------------ */
/* 1. 主进程入口接线断言                                                */
/* ------------------------------------------------------------------ */
group('[1/3] 主进程入口接线')

const indexSrc = fs.readFileSync(SRC_INDEX, 'utf8')
check(
  'src/main/index.ts 不再无条件调用 electronApp.setAppUserModelId',
  !/electronApp\.setAppUserModelId\s*\(/.test(indexSrc),
  '发现无条件 electronApp.setAppUserModelId 调用'
)
check(
  'src/main/index.ts 调用 configureWindowsAppUserModelId',
  /\bconfigureWindowsAppUserModelId\s*\(/.test(indexSrc),
  '未找到 configureWindowsAppUserModelId 调用'
)
check('src/main/window/appUserModelId.ts 存在', fs.existsSync(SRC_MOD), SRC_MOD)

if (!fs.existsSync(SRC_MOD)) {
  console.log(`\n通过 ${pass}  失败 ${fail}`)
  process.exit(1)
}

/* ------------------------------------------------------------------ */
/* 2. 编译模块并跑纯逻辑矩阵                                            */
/* ------------------------------------------------------------------ */
group('[2/3] resolveWindowsAppUserModelId 决策矩阵')

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sshw-aumid-verify-'))
const compiledFile = path.join(tmpDir, 'appUserModelId.cjs')

try {
  esbuild.buildSync({
    entryPoints: [SRC_MOD],
    outfile: compiledFile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
    sourcemap: false
  })

  // 在纯 Node 环境下提供最小 electron stub，只测试纯函数 resolveWindowsAppUserModelId
  const Module = require('node:module')
  const origLoad = Module._load
  Module._load = function patchedLoad(request, _parent, _isMain) {
    if (request === 'electron') {
      return { app: { isPackaged: false, setAppUserModelId() {} }, shell: { readShortcutLink() { return {} } } }
    }
    return origLoad.apply(this, arguments)
  }
  let mod
  try {
    mod = require(compiledFile)
  } finally {
    Module._load = origLoad
  }

  const { APP_USER_MODEL_ID, resolveWindowsAppUserModelId } = mod
  check('导出 APP_USER_MODEL_ID = com.sshworkbench.app', APP_USER_MODEL_ID === 'com.sshworkbench.app', APP_USER_MODEL_ID)
  check('导出 resolveWindowsAppUserModelId 函数', typeof resolveWindowsAppUserModelId === 'function')

  const execA = 'D:\\ssh-workbench-upgrade\\dist-v35\\win-unpacked\\SSH Workbench.exe'
  const execB = 'C:\\Users\\Alice\\AppData\\Local\\Programs\\ssh-workbench\\SSH Workbench.exe'
  const smRoot = path.join(tmpDir, 'start-menu')
  const smSub = path.join(smRoot, 'SSH Workbench')
  fs.mkdirSync(smSub, { recursive: true })

  // 2.1 非 Windows
  check(
    'macOS 跳过 AUMID',
    resolveWindowsAppUserModelId({ platform: 'darwin', isPackaged: true, execPath: execA }) === null
  )
  check(
    'Linux 跳过 AUMID',
    resolveWindowsAppUserModelId({ platform: 'linux', isPackaged: true, execPath: execA }) === null
  )

  // 2.2 开发模式
  const devExe = 'D:\\ssh-workbench-upgrade\\node_modules\\electron\\dist\\electron.exe'
  check(
    'Windows 开发模式保留 execPath 作为 AUMID',
    resolveWindowsAppUserModelId({ platform: 'win32', isPackaged: false, execPath: devExe }) === devExe
  )

  // 2.3 空开始菜单（全新解压版 / 便携版）
  const emptySm = path.join(tmpDir, 'empty-sm')
  fs.mkdirSync(emptySm, { recursive: true })
  check(
    '解压版：开始菜单无快捷方式 -> 不绑定自定义 AUMID (null)',
    resolveWindowsAppUserModelId({
      platform: 'win32',
      isPackaged: true,
      execPath: execA,
      startMenuDirs: [emptySm],
      readShortcutLink: () => ({}),
      exists: () => true
    }) === null
  )

  // 2.4 失效旧快捷方式（指向已删除的 dist-v30）
  const lnkTop = path.join(smRoot, 'SSH Workbench.lnk')
  fs.writeFileSync(lnkTop, 'stub')
  check(
    '解压版：开始菜单旧 lnk 指向已删目录 -> null',
    resolveWindowsAppUserModelId({
      platform: 'win32',
      isPackaged: true,
      execPath: execA,
      startMenuDirs: [smRoot],
      readShortcutLink: () => ({
        appUserModelId: APP_USER_MODEL_ID,
        target: 'D:\\ssh-workbench-upgrade\\dist-v30\\win-unpacked\\SSH Workbench.exe',
        icon: ''
      }),
      exists: (p) => p === execA
    }) === null
  )

  // 2.5 开始菜单 lnk 指向另一份已安装的 exe，但当前跑的是解压版
  check(
    '解压版与安装版共存：开始菜单 lnk 指向安装版 exe，当前跑解压版 -> null',
    resolveWindowsAppUserModelId({
      platform: 'win32',
      isPackaged: true,
      execPath: execA,
      startMenuDirs: [smRoot],
      readShortcutLink: () => ({
        appUserModelId: APP_USER_MODEL_ID,
        target: execB,
        icon: ''
      }),
      exists: (p) => p === execA || p === execB,
      canonicalize: (p) => p.toLowerCase()
    }) === null
  )

  // 2.6 自定义 icon 路径失效 -> null
  check(
    '开始菜单 lnk 显式 icon 文件不存在 -> null',
    resolveWindowsAppUserModelId({
      platform: 'win32',
      isPackaged: true,
      execPath: execB,
      startMenuDirs: [smRoot],
      readShortcutLink: () => ({
        appUserModelId: APP_USER_MODEL_ID,
        target: execB,
        icon: 'C:\\missing\\icon.ico'
      }),
      exists: (p) => p === execB,
      canonicalize: (p) => p.toLowerCase()
    }) === null
  )

  // 2.7 快捷方式 AUMID 不匹配 -> null
  check(
    '开始菜单 lnk 的 AUMID 不一致 -> null',
    resolveWindowsAppUserModelId({
      platform: 'win32',
      isPackaged: true,
      execPath: execB,
      startMenuDirs: [smRoot],
      readShortcutLink: () => ({
        appUserModelId: 'com.other.app',
        target: execB,
        icon: ''
      }),
      exists: (p) => p === execB,
      canonicalize: (p) => p.toLowerCase()
    }) === null
  )

  // 2.8 安装版命中（含盘符大小写差异，icon 为空沿用目标 exe 图标）
  check(
    '安装版：开始菜单根 lnk 匹配当前 exe（大小写不敏感）-> 返回 com.sshworkbench.app',
    resolveWindowsAppUserModelId({
      platform: 'win32',
      isPackaged: true,
      execPath: execB,
      startMenuDirs: [smRoot],
      readShortcutLink: () => ({
        appUserModelId: APP_USER_MODEL_ID,
        target: execB.toLowerCase(),
        icon: ''
      }),
      exists: (p) => p.toLowerCase() === execB.toLowerCase(),
      canonicalize: (p) => p.toLowerCase()
    }) === APP_USER_MODEL_ID
  )

  // 2.9 损坏 lnk + 子目录有效 lnk 并存（容错且命中子目录）
  const lnkSub = path.join(smSub, 'SSH Workbench.lnk')
  fs.writeFileSync(lnkSub, 'stub')
  const fakeIcon = path.join(tmpDir, 'icon.ico')
  fs.writeFileSync(fakeIcon, 'ico')
  check(
    '坏 lnk 不抛异常，且能命中子目录中的有效 lnk（带有效自定义 icon）',
    resolveWindowsAppUserModelId({
      platform: 'win32',
      isPackaged: true,
      execPath: execB,
      startMenuDirs: [smRoot],
      readShortcutLink: (p) => {
        if (p === lnkTop) throw new Error('corrupt shortcut')
        return {
          appUserModelId: APP_USER_MODEL_ID,
          target: execB,
          icon: fakeIcon
        }
      },
      exists: (p) => p === execB || p === fakeIcon,
      canonicalize: (p) => p.toLowerCase()
    }) === APP_USER_MODEL_ID
  )

  // 2.10 不相干名称的 lnk 不会被扫描（避免拖慢启动）
  const unrelatedSm = path.join(tmpDir, 'unrelated-sm')
  fs.mkdirSync(unrelatedSm, { recursive: true })
  fs.writeFileSync(path.join(unrelatedSm, 'WeChat.lnk'), 'stub')
  let readCount = 0
  resolveWindowsAppUserModelId({
    platform: 'win32',
    isPackaged: true,
    execPath: execA,
    startMenuDirs: [unrelatedSm],
    readShortcutLink: () => {
      readCount++
      return {}
    },
    exists: () => true
  })
  check('不扫描无关程序的 lnk（readCount === 0）', readCount === 0, { readCount })

  /* ---------------------------------------------------------------- */
  /* 3. 真实 Electron shell.writeShortcutLink / readShortcutLink 集成  */
  /* ---------------------------------------------------------------- */
  group('[3/3] 真实 Electron Shortcut API 集成验证')

  const electronExe = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (process.platform === 'win32' && fs.existsSync(electronExe)) {
    const probeScript = path.join(tmpDir, 'electron-lnk-probe.cjs')
    const probeOut = path.join(tmpDir, 'electron-lnk-probe.json')
    fs.writeFileSync(
      probeScript,
      `
const { app, shell } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { APP_USER_MODEL_ID, resolveWindowsAppUserModelId } = require(${JSON.stringify(compiledFile)})
app.whenReady().then(() => {
  const base = ${JSON.stringify(path.join(tmpDir, 'real-sm'))}
  fs.mkdirSync(base, { recursive: true })
  const out = {}

  // A: 空目录
  out.empty = resolveWindowsAppUserModelId({
    platform: 'win32',
    isPackaged: true,
    execPath: process.execPath,
    startMenuDirs: [base]
  })

  // B: 指向不存在目标的真实 .lnk
  const lnk = path.join(base, 'SSH Workbench.lnk')
  out.writeB = shell.writeShortcutLink(lnk, 'create', {
    target: 'D:\\\\non-existent-sshw-dir\\\\SSH Workbench.exe',
    appUserModelId: APP_USER_MODEL_ID
  })
  out.staleTarget = resolveWindowsAppUserModelId({
    platform: 'win32',
    isPackaged: true,
    execPath: process.execPath,
    startMenuDirs: [base]
  })

  // C: 指向另一存在 exe（cmd.exe）的真实 .lnk
  const cmdExe = path.join(process.env.SystemRoot || 'C:\\\\Windows', 'System32', 'cmd.exe')
  out.writeC = shell.writeShortcutLink(lnk, 'create', {
    target: cmdExe,
    appUserModelId: APP_USER_MODEL_ID
  })
  out.otherExe = resolveWindowsAppUserModelId({
    platform: 'win32',
    isPackaged: true,
    execPath: process.execPath,
    startMenuDirs: [base]
  })

  // D: 指向当前 process.execPath 的真实 .lnk
  out.writeD = shell.writeShortcutLink(lnk, 'create', {
    target: process.execPath,
    cwd: path.dirname(process.execPath),
    icon: process.execPath,
    iconIndex: 0,
    appUserModelId: APP_USER_MODEL_ID
  })
  out.matchingInstalled = resolveWindowsAppUserModelId({
    platform: 'win32',
    isPackaged: true,
    execPath: process.execPath,
    startMenuDirs: [base]
  })

  fs.writeFileSync(${JSON.stringify(probeOut)}, JSON.stringify(out))
  app.quit()
})
`,
      'utf8'
    )

    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    const run = spawnSync(
      electronExe,
      [probeScript, `--user-data-dir=${path.join(tmpDir, 'el-ud')}`, '--disable-gpu', '--no-sandbox'],
      { cwd: ROOT, env, stdio: 'pipe', encoding: 'utf8', timeout: 25000 }
    )
    const okOut = run.status === 0 && fs.existsSync(probeOut)
    check('Electron 真实 Shortcut API 探针正常退出', okOut, { status: run.status, stderr: (run.stderr || '').slice(0, 300) })
    if (okOut) {
      const r = JSON.parse(fs.readFileSync(probeOut, 'utf8'))
      check('真实环境 .lnk 写入全部成功', r.writeB === true && r.writeC === true && r.writeD === true, {
        writeB: r.writeB,
        writeC: r.writeC,
        writeD: r.writeD
      })
      check('真实环境 A：无快捷方式 -> null', r.empty === null, r.empty)
      check('真实环境 B：快捷方式指向已删目录 -> null', r.staleTarget === null, r.staleTarget)
      check('真实环境 C：快捷方式指向别的 exe -> null', r.otherExe === null, r.otherExe)
      check('真实环境 D：快捷方式指向当前 exe -> com.sshworkbench.app', r.matchingInstalled === APP_USER_MODEL_ID, r.matchingInstalled)
    }
  } else {
    console.log('  SKIP  非 Windows 或未找到 Electron 二进制，跳过第 3 组')
  }
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true })
}

console.log(`\n通过 ${pass}  失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)
