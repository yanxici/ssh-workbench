/**
 * 串口原生模块的懒加载入口。
 *
 * 为什么不当普通 import：
 *
 * 1. **启动路径**。serialport 会加载原生 .node，走一遍 node-gyp-build 的
 *    平台探测。只用 SSH 的用户完全不需要付这笔开销，而主进程启动时间直接
 *    体现在「双击图标到窗口出现」上。
 *
 * 2. **故障隔离**。原生模块在个别机器上会加载失败（缺 VC 运行库、杀软拦截、
 *    32/64 位不匹配）。如果顶层 import，一次失败会让整个主进程起不来 ——
 *    连 SSH 都用不了。改成懒加载后，失败只影响串口功能本身。
 *
 * 3. **打包与测试**。esbuild 会静态跟随字面量 require 把原生模块打进 bundle，
 *    在没有对应二进制的环境（CI、裸 node 跑验证脚本）里直接抛
 *    「No native build was found」。用非字面量 require 让它留在运行时解析。
 */
import { createRequire } from 'node:module'

type SerialPortModule = typeof import('serialport')

const requireFromHere = createRequire(__filename)

let cached: SerialPortModule | null = null
let loadError: Error | null = null

/** 取 serialport 模块。首次调用才真正加载，失败后缓存错误避免反复重试 */
export function loadSerialport(): SerialPortModule {
  if (cached) return cached
  if (loadError) throw loadError
  try {
    // 变量形式：让打包器无法静态解析，保持运行时时序加载
    const name = 'serialport'
    cached = requireFromHere(name) as SerialPortModule
    return cached
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    loadError = new Error(
      `串口驱动加载失败：${message}\n` +
        '串口功能不可用，SSH 连接不受影响。若系统为精简版 Windows，可能需要安装 VC++ 运行库。'
    )
    throw loadError
  }
}
