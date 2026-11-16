/**
 * 剪贴板通道自检（IPC 契约：CLIP_READ 必须交回 string，不能把 Promise 漏给调用方）。
 *
 * 背景：上游 Electron 45 按 RFC 0019 把 clipboard 的 readText / writeText 改成返回 Promise；
 * 本仓仍是 Electron 33，两个 API 同步返回 string —— 所以这条断言在当前是「契约不许退化」的
 * 护栏，将来升 Electron 时会变成「不许漏 await」的护栏。
 * 这是**最容易静默坏掉**的那类变更：
 *   `parseSshCommand(clipboard.readText())` 在 45 下编译不过（TS 会报），但若某处
 *   用了 `as unknown as string` 或 any，运行时拿到的是 Promise 对象，正则永远不匹配，
 *   表现为「剪贴板识别按钮没反应」—— 没有异常、没有日志。
 *
 * 三层断言：
 *   1. 静态：src/main 里不得出现「不为 clipboard.readText 加 await 就往下传」的写法；
 *   2. 行为：CLIP_WRITE 写进去之后 CLIP_READ 能读回同一个字符串；
 *   3. 契约：CLIP_READ 的返回值必须是 string 而不是 Promise（拿 Promise 就说明漏了 await）。
 *
 * 说明：第 2/3 条必须真跑 Electron（clipboard 模块只在 Electron 里存在）。
 *
 * 用法：node scripts/verify-clipboard.cjs（内部会自动用 Electron 重跑）
 */

/* ELECTRON_RUN_AS_NODE 会让 electron 退化成纯 Node（无 clipboard 模块），先重开一次 */
if (process.env.ELECTRON_RUN_AS_NODE || !process.versions.electron) {
  const { spawnSync } = require('node:child_process')
  const path = require('node:path')
  const os = require('node:os')
  const fs = require('node:fs')
  const exe =
    process.platform === 'win32'
      ? path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe')
      : path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron')
  if (!fs.existsSync(exe)) {
    console.error('找不到 Electron 二进制：' + exe)
    process.exit(1)
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  void os
  const r = spawnSync(exe, [__filename], { stdio: 'inherit', env })
  process.exit(r.status === null ? 1 : r.status)
}

const { app, clipboard, ipcMain } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : '')) }
}

async function main() {
  const ROOT = path.join(__dirname, '..')

  console.log('\n[剪贴板通道 · Electron ' + process.versions.electron + ']')

  /* 1. 静态：readText 的结果必须被 await 或直接 return 给 handle */
  const files = []
  function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.ts')) files.push(p)
    }
  }
  walk(path.join(ROOT, 'src/main'))
  const offenders = []
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf-8')
    if (!/clipboard\.readText\(\)/.test(src)) continue
    const lines = src.split(/\r?\n/)
    lines.forEach((line, i) => {
      if (!/clipboard\.readText\(\)/.test(line)) return
      /*
       * 两种合法写法：
       *   1. await clipboard.readText() —— 需要字符串时
       *   2. () => clipboard.readText() —— handle() 接受 Promise 返回值，IPC 层自己 await；
       *      这是「直接透传」，不是漏 await
       * 非法写法：把结果当字符串继续传（如 parseSshCommand(clipboard.readText())）。
       */
      const trimmed = line.replace(/[ \t]+$/, '')
      const isThunk = /=>\s*clipboard\.readText\(\)\s*\)?$/.test(trimmed)
      const isAwait = /await\s+clipboard\.readText\(\)/.test(line)
      if (!isThunk && !isAwait) {
        offenders.push(path.relative(ROOT, f) + ':' + (i + 1) + ' ' + line.trim())
      }
    })
  }
  check('readText() 的结果都被 await（否则拿到 Promise）', offenders.length === 0, offenders)

  /* 2/3. 行为：写入后读回，且返回值类型是 string */
  await app.whenReady()
  const marker = 'clip-probe-' + Date.now()
  await clipboard.writeText(marker)
  const read = await clipboard.readText()
  check('writeText/readText 往返一致', read === marker, String(read))
  check('readText 返回 string 而非 Promise', typeof read === 'string', typeof read)

  /* 4. 通过 IPC handler 的实际返回形状（模拟 handle() 包装） */
  ipcMain.handle('probe:clip-read', () => clipboard.readText())
  const viaIpc = await ipcMain._invokeHandlers.get('probe:clip-read')({})
  check('handle() 直接返回 readText() 时最终拿到 string', typeof viaIpc === 'string' && viaIpc === marker, typeof viaIpc)

  console.log('\n通过 ' + pass + '  失败 ' + fail)
  app.exit(fail === 0 ? 0 : 1)
}

app.disableHardwareAcceleration()
main().catch((e) => { console.error('FATAL ' + e.message); app.exit(2) })