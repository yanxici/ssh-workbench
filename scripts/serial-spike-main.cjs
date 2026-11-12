#!/usr/bin/env node
/**
 * 串口原生模块 spike —— Electron 主进程侧启动器。
 *
 * 为什么必须单独跑一遍 Electron：
 *   `node scripts/verify-serial-native.cjs` 过了，只证明「裸 Node 能加载」。
 *   但应用真正运行在 Electron 主进程里，Electron 的 V8/ABI 与同版本 Node 不同
 *   （Electron 33 是 ABI 130，裸 Node 24 是 137）。如果 serialport 的绑定不是
 *   NAPI 而是锁死 Node 版本，裸 node 全绿、打包后照样 ERR_DLOPEN_FAILED ——
 *   而这种错只在用户机器上炸，是发布事故而不是测试失败。
 *
 * 这个脚本做的事：在 Electron 里跑同一个校验，然后把结论落盘。
 * 落盘是因为 Windows 上 Electron 的 stdout 有时被 GUI 子系统吞掉，
 * 只靠控制台会拿不到结果；写文件是唯一可靠的取证方式。
 *
 * 用法：
 *   npx electron scripts/serial-spike-main.cjs
 *   结果写到 serial-spike-result.json（仓库根，.gitignore 忽略）
 *
 * 退出码：0 通过；1 失败。
 */

'use strict'

const { app } = require('electron')
const { writeFileSync } = require('node:fs')
const { join } = require('node:path')

const OUT = join(__dirname, '..', 'serial-spike-result.json')

// 不需要窗口：这个脚本只验主进程能不能加载原生模块。
// 不关掉硬件加速的话，某些无 GPU 的 CI 机器会在创建 GL 上下文时卡住。
app.disableHardwareAcceleration()

async function probe() {
  const report = {
    ts: new Date().toISOString(),
    runtime: {
      node: process.versions.node,
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      abi: process.versions.modules,
      platform: `${process.platform}-${process.arch}`
    },
    steps: []
  }

  const record = (name, ok, detail) => {
    report.steps.push({ name, ok, detail: detail || '' })
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
    return ok
  }

  console.log('=== 运行时（Electron）===')
  console.log(`  node      ${process.versions.node}`)
  console.log(`  electron  ${process.versions.electron}`)
  console.log(`  chrome    ${process.versions.chrome}`)
  console.log(`  modules   ${process.versions.modules} (ABI)`)
  console.log(`  platform  ${process.platform}-${process.arch}`)

  // 第 1 层：require 包。Electron 下这一步可能因 app 未就绪而失败，
  // 所以整段包在 try 里，失败也要把 report 写出去。
  let SerialPort
  try {
    ;({ SerialPort } = require('serialport'))
    record('require("serialport") in Electron', true)
  } catch (err) {
    record('require("serialport") in Electron', false, err.message)
    return report
  }

  // 第 2 层：原生绑定加载。这是 ABI 兼容性的判定点。
  // 若这里抛 ERR_DLOPEN_FAILED / NODE_MODULE_VERSION 不匹配，说明必须重建。
  try {
    const bindings = require('@serialport/bindings-cpp')
    const impl = bindings.autoDetect()
    const ok = typeof impl.list === 'function' && typeof impl.open === 'function'
    record('原生绑定在 Electron ABI 下加载', ok, ok ? `list/open 可用（ABI ${process.versions.modules}）` : '接口形状异常')
  } catch (err) {
    record('原生绑定在 Electron ABI 下加载', false, err.message)
    return report
  }

  // 第 3 层：真实调用 list()。加载成功 ≠ 能工作，驱动层错误在这一层暴露。
  try {
    const ports = await SerialPort.list()
    const ok = Array.isArray(ports)
    const summary = ok && ports.length
      ? ports.map((p) => `${p.path}${p.friendlyName ? ` (${p.friendlyName})` : ''}`).join(', ')
      : '无串口（CI 正常）'
    record('SerialPort.list() in Electron', ok, `${ports.length} 个端口：${summary}`)
  } catch (err) {
    record('SerialPort.list() in Electron', false, err.message)
  }

  return report
}

app.whenReady().then(async () => {
  let report
  try {
    report = await probe()
  } catch (err) {
    report = { ts: new Date().toISOString(), error: String(err && err.stack ? err.stack : err), steps: [] }
  }
  const failed = (report.steps || []).filter((s) => !s.ok).length
  report.passed = (report.steps || []).length - failed
  report.failed = failed
  try {
    writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n', 'utf8')
    console.log(`\n结果已写入 ${OUT}`)
  } catch (err) {
    console.error('写结果文件失败：', err.message)
  }
  console.log(`=== ${report.passed} 通过 / ${report.failed} 失败 ===`)
  app.exit(failed === 0 ? 0 : 1)
})
