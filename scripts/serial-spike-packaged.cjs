#!/usr/bin/env node
/**
 * 打包产物验证 —— 在真实 win-unpacked 目录里加载 serialport。
 *
 * 为什么不能用开发目录的结果下结论：
 *   开发时 require('serialport') 解析到 node_modules/ 的原始文件树。
 *   打包后整个 app 变成 app.asar + app.asar.unpacked/ 两半，
 *   模块解析走的是 asar 虚拟文件系统，.node 被 asarUnpack 挪到了 unpacked 下。
 *   这条路径只有在真实产物里才成立，开发目录永远测不出来。
 *
 * 运行方式（用打包出来的 exe，以 Node 模式跑，同一个二进制同一个 ABI）：
 *   ELECTRON_RUN_AS_NODE=1 "dist-spike/win-unpacked/SSH Workbench.exe" scripts/serial-spike-packaged.cjs
 *
 * 也可以传路径参数指定其他产物目录：
 *   ELECTRON_RUN_AS_NODE=1 "<exe>" scripts/serial-spike-packaged.cjs dist-v19/win-unpacked
 *
 * 退出码：0 通过；1 失败。
 */

'use strict'

const { existsSync, readdirSync } = require('node:fs')
const { join, resolve } = require('node:path')

// 默认产物目录；可被 argv[2] 覆盖。
// 必须 resolve 成绝对路径：require('dist-v19/...') 这种以盘符以外的相对路径
// 会被 Node 当成「模块名」去 node_modules 里找，报 Cannot find module，
// 而不是按文件路径加载 —— 我第一次就踩了这个，误判成产物缺文件。
const APP_DIR = resolve(process.argv[2] || join(__dirname, '..', 'dist-spike', 'win-unpacked'))
const RES = join(APP_DIR, 'resources')
const ASAR = join(RES, 'app.asar')
const UNPACKED = join(RES, 'app.asar.unpacked')

const results = []
function record(name, ok, detail) {
  results.push({ name, ok, detail: detail || '' })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`)
  return ok
}

function main() {
  console.log('=== 运行时 ===')
  console.log(`  exe       ${process.execPath}`)
  console.log(`  node      ${process.versions.node}`)
  console.log(`  electron  ${process.versions.electron || '(无，ELECTRON_RUN_AS_NODE 模式)'}`)
  console.log(`  modules   ${process.versions.modules} (ABI)`)
  console.log(`  appDir    ${APP_DIR}`)

  // 第 1 层：产物结构是否齐全。缺 app.asar 说明路径给错了，后面的结论都没意义。
  if (!record('app.asar 存在', existsSync(ASAR), ASAR)) return finish()
  record('app.asar.unpacked 存在', existsSync(UNPACKED), UNPACKED)

  // 第 2 层：.node 是否真的被解包出来（asarUnpack 生效的直接证据）
  const nodeDir = join(UNPACKED, 'node_modules', '@serialport', 'bindings-cpp', 'prebuilds', `${process.platform}-${process.arch}`)
  let nodeFiles = []
  try {
    nodeFiles = readdirSync(nodeDir).filter((f) => f.endsWith('.node'))
  } catch {
    /* 目录不存在，下面统一报 */
  }
  const nodeOk = nodeFiles.length > 0
  record(
    `当前平台的 .node 已解包（${process.platform}-${process.arch}）`,
    nodeOk,
    nodeOk ? nodeFiles.join(', ') : `${nodeDir} 下没有 .node`
  )

  // 第 3 层：从 asar 里 require('serialport')。
  // 这是最接近真实应用的一步 —— 走的是 asar 内的 JS + unpacked 里的 .node 组合。
  // 注意：require 的路径要落在 asar 内，Node 的解析器才知道去 unpacked 找二进制。
  const pkgEntry = join(ASAR, 'node_modules', 'serialport', 'dist', 'index.js')
  let SerialPort = null
  try {
    ;({ SerialPort } = require(pkgEntry))
    record('从 app.asar 内 require("serialport")', true, pkgEntry)
  } catch (err) {
    record('从 app.asar 内 require("serialport")', false, String(err.message).split('\n')[0].slice(0, 160))
    return finish()
  }

  // 第 4 层：真正调一次 list()。到这里如果还过，说明整条链是通的。
  // list() 是同步返回 Promise，但本脚本是同步风格 —— 用 then 收尾。
  return SerialPort.list().then(
    (ports) => {
      const ok = Array.isArray(ports)
      const summary = ok && ports.length
        ? ports.map((p) => `${p.path}${p.friendlyName ? ` (${p.friendlyName})` : ''}`).join(', ')
        : '无串口（正常）'
      record('SerialPort.list() 在打包产物内可调用', ok, `${ports.length} 个端口：${summary}`)
      finish()
    },
    (err) => {
      record('SerialPort.list() 在打包产物内可调用', false, String(err.message).split('\n')[0].slice(0, 160))
      finish()
    }
  )
}

function finish() {
  const failed = results.filter((r) => !r.ok).length
  console.log('')
  console.log(`=== ${results.length - failed} 通过 / ${failed} 失败 ===`)
  process.exitCode = failed === 0 ? 0 : 1
  return failed === 0
}

try {
  main()
} catch (err) {
  console.error('[FAIL] 脚本异常 —', err && err.stack ? err.stack : err)
  process.exitCode = 1
}
