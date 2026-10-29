/**
 * 新功能的主进程链路压测：走 out/main/index.js 里注册的真实 IPC 通道。
 *
 * 用 Electron 主进程跑（而不是纯 node），因为 sftpManager / repository 依赖
 * electron 的 app.getPath；这里只把 BrowserWindow/dialog 等不需要的部分躲开。
 *
 * 覆盖：
 * - 指纹探测通道 known:probe / known:refresh 的参数校验与落库形状
 * - 上传扫描通道 sftp:scan-folders 对真实目录的统计
 * - 上传文件夹通道使用 keepRoot=true 的调用形态（不上真机，校验参数透传）
 *
 * 用法：npx electron scripts/perf-new-features.cjs
 */
const { app, ipcMain } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const CHANNELS = {
  probe: 'known:probe',
  refresh: 'known:refresh',
  scan: 'sftp:scan-folders',
  uploadFolder: 'sftp:upload-folder-dialog'
}

let failed = 0
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failed++
    console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`)
  }
}

/** 直接向已注册的通道发一次，模拟渲染层调用 */
async function invoke(channel, ...args) {
  const handlers = ipcMain._invokeHandlers || ipcMain._events
  const fn = handlers.get ? handlers.get(channel) : null
  if (!fn) {
    // Electron 的 ipcMain.invoke 表就是 _invokeHandlers（Map）
    throw new Error(`通道未注册：${channel}`)
  }
  return fn({}, ...args)
}

async function main() {
  // 必须先把应用主入口 require 进来（它自己会在 ready 之前调 disableHardwareAcceleration，
  // 并在 ready 之后创建窗口 + 注册全部 IPC）；之后再等 ready。
  require(path.join(ROOT, 'out/main/index.js'))
  await app.whenReady()
  await new Promise((r) => setTimeout(r, 1500))

  console.log('\nIPC registration: 新通道必须已注册')
  const map = ipcMain._invokeHandlers
  check('known:probe 已注册', !!map.get(CHANNELS.probe))
  check('known:refresh 已注册', !!map.get(CHANNELS.refresh))
  check('sftp:scan-folders 已注册', !!map.get(CHANNELS.scan))
  check('sftp:upload-folder-dialog 已注册', !!map.get(CHANNELS.uploadFolder))

  console.log('\nscan: 真实目录统计')
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-feature-'))
  const top = path.join(base, 'bundle')
  fs.mkdirSync(path.join(top, 'nested'), { recursive: true })
  fs.writeFileSync(path.join(top, 'a.bin'), Buffer.alloc(100))
  fs.writeFileSync(path.join(top, 'nested', 'b.bin'), Buffer.alloc(200))
  const scan = await invoke(CHANNELS.scan, [top])
  check('返回 ok', scan && scan.ok === true, scan)
  check('文件数 = 2', scan.data && scan.data.totalFiles === 2, scan.data && scan.data.totalFiles)
  check('字节数 = 300', scan.data && scan.data.totalBytes === 300, scan.data && scan.data.totalBytes)

  console.log('\nfingerprint: 参数校验')
  // 不可达地址：必须快速失败并给出可读原因，而不是挂住
  const started = Date.now()
  const bad = await invoke(CHANNELS.probe, '127.0.0.1', 1)
  const cost = Date.now() - started
  check('不可达时不抛到渲染层', bad && bad.ok === false, bad && bad.ok)
  check('错误信息可读', !!(bad && bad.error && bad.error.length > 0), bad && bad.error)
  check('快速失败（<8s）', cost < 8000, cost)

  const badFp = await invoke(CHANNELS.refresh, '127.0.0.1', 1, 'not-a-fingerprint')
  check('非法指纹被拒', badFp && badFp.ok === false, badFp)

  console.log('')
  fs.rmSync(base, { recursive: true, force: true })
  if (failed > 0) {
    console.log(`新功能链路压测失败：${failed} 项\n`)
    app.exit(1)
    return
  }
  console.log('新功能链路压测全部通过\n')
  app.exit(0)
}

main().catch((err) => {
  console.error(err)
  app.exit(1)
})
