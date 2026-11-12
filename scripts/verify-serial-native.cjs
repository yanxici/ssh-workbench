#!/usr/bin/env node
/**
 * V2.0.0 串口原生模块 spike —— 只回答一个问题：
 *   serialport 的原生绑定能不能在「本项目实际运行的运行时」里加载成功。
 *
 * 为什么需要这个脚本：
 *   serialport 依赖 @serialport/bindings-cpp，那是 .node 原生二进制。
 *   能不能用取决于三件事，任一件错都表现为「加载失败」，但原因完全不同：
 *     1. 有没有对应平台/架构的二进制（prebuilds 里是否有 win32-x64）；
 *     2. 那个二进制是不是 NAPI 版本（NAPI 跨 Node/Electron 版本，非 NAPI 就锁 ABI）；
 *     3. 跑它的运行时是不是 Electron（Electron 的 ABI 与同版本 Node 不同）。
 *
 * 本脚本默认跑在 Electron 主进程里（见 scripts/serial-spike-main.cjs），
 * 因为裸 node 能过不代表打包后的应用能过 —— 后者才是真正要验的。
 * 直接用 node 跑也可以，此时只验第 1、2 条。
 *
 * 用法：
 *   npx electron scripts/serial-spike-main.cjs     # 完整验证（推荐）
 *   node scripts/verify-serial-native.cjs          # 只验绑定本身
 *
 * 退出码：0 通过；1 失败。失败时打印具体的失败层，不打印无用的堆栈。
 */

'use strict'

/** 打印一行带层名前缀的结果，便于在 CI 日志里一眼定位失败层 */
function step(name, ok, detail) {
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ' — ' + detail : ''}`)
  return ok
}

async function main() {
  const results = []

  // ---- 第 0 层：运行时身份。先把它打出来，后面所有结论都要带这个前提 ----
  console.log('=== 运行时 ===')
  console.log(`  node      ${process.versions.node}`)
  console.log(`  electron  ${process.versions.electron || '(无，裸 node)'}`)
  console.log(`  chrome    ${process.versions.chrome || '-'}`)
  console.log(`  modules   ${process.versions.modules} (ABI)`)
  console.log(`  platform  ${process.platform}-${process.arch}`)

  // ---- 第 1 层：包本身能否 require ----
  let SerialPort
  try {
    ;({ SerialPort } = require('serialport'))
    results.push(step('require("serialport")', true))
  } catch (err) {
    results.push(step('require("serialport")', false, err.message))
    return finish(results)
  }

  // ---- 第 2 层：原生绑定能否加载。这是整件事的关键，也是唯一可能因 ABI 崩的一层 ----
  try {
    const bindings = require('@serialport/bindings-cpp')
    const hasAuto = typeof bindings.autoDetect === 'function'
    results.push(step('加载原生绑定 @serialport/bindings-cpp', hasAuto, hasAuto ? 'autoDetect 可用' : 'autoDetect 缺失'))
  } catch (err) {
    results.push(step('加载原生绑定 @serialport/bindings-cpp', false, err.message))
    return finish(results)
  }

  // ---- 第 3 层：绑定自报的平台实现 ----
  // autoDetect() 返回的是「绑定接口对象」，形状为 { list, open }，不是平台 Binding 实例。
  // 第一版脚本按 constructor.name 判 WindowsBinding，结果是 Object —— 判断条件写错了，
  // 不是绑定有问题。这里改为按接口形状判定，这才是这个包对外承诺的契约。
  try {
    const bindings = require('@serialport/bindings-cpp')
    const impl = bindings.autoDetect()
    const ok = Boolean(impl) && typeof impl.list === 'function' && typeof impl.open === 'function'
    results.push(
      step(
        'autoDetect() 返回可用绑定接口',
        ok,
        ok ? 'list / open 均为函数' : `形状异常：${JSON.stringify(Object.keys(impl || {}))}`
      )
    )
  } catch (err) {
    results.push(step('autoDetect() 返回可用绑定接口', false, err.message))
    return finish(results)
  }

  // ---- 第 4 层：真正调一次 list()。加载成功但 list 崩，说明是驱动层问题 ----
  // 注意：CI 机器上没有串口，返回空数组是正常且期望的结果。
  // 这一层验的是「调用不抛错」，不是「有端口」。
  try {
    const ports = await SerialPort.list()
    const isArray = Array.isArray(ports)
    const sample = isArray && ports.length > 0
      ? ports.map((p) => `${p.path}${p.friendlyName ? ` (${p.friendlyName})` : ''}`).join(', ')
      : '无串口（CI 正常）'
    results.push(step('SerialPort.list() 可调用', isArray, `${ports.length} 个端口：${sample}`))
    // 有端口时顺手验一下字段形状 —— 热插拔识别要靠 serialNumber / pnpId
    if (isArray && ports.length > 0) {
      const withPnp = ports.filter((p) => p.pnpId).length
      const withSn = ports.filter((p) => p.serialNumber).length
      results.push(
        step(
          '端口身份字段',
          withPnp > 0,
          `${withPnp}/${ports.length} 带 pnpId，${withSn}/${ports.length} 带 serialNumber` +
            (withSn === 0 ? '（无 serialNumber 时热插拔只能退化到 COM 号，符合设计预期）' : '')
        )
      )
    }
  } catch (err) {
    results.push(step('SerialPort.list() 可调用', false, err.message))
  }

  return finish(results)
}

function finish(results) {
  const failed = results.filter((r) => !r).length
  console.log('')
  console.log(`=== ${results.length - failed} 通过 / ${failed} 失败 ===`)
  // 用 exitCode 而不是 process.exit()：让 stdout 有机会 flush 干净，
  // 否则 CI 日志里最后一行经常缺失，反而看不出失败原因。
  process.exitCode = failed === 0 ? 0 : 1
  return failed === 0
}

main().catch((err) => {
  console.error('[FAIL] 脚本自身异常 —', err && err.stack ? err.stack : err)
  process.exitCode = 1
})
