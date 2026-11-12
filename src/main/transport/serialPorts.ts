/**
 * 串口端口枚举。
 *
 * 单独成文件而不是塞进 serialTransport：枚举是「不需要打开端口」的只读操作，
 * 连接编辑器、热插拔监听、导入时的端口校验都要用它，不该被迫引入传输层。
 *
 * 走 serialLoader 懒加载：原生模块加载失败时枚举返回空列表，而不是让
 * 整个主进程起不来。
 */
import type { SerialPortInfo } from '@shared/types'
import { loadSerialport } from './serialLoader'

/**
 * serialport 的 `SerialPort.list()` 返回 `@serialport/bindings-interface` 的 `PortInfo[]`，
 * 但那个包的 `exports` 里没有 `types` 条件（只有 `require` / `default`），
 * 在 `moduleResolution: "bundler"` 下 TS 解不出类型，`list()` 的返回值会退化成
 * error type —— tsc 因为 noImplicitAny: false 静默放过，eslint 的类型感知规则
 * （no-unsafe-member-access）则会把每个字段都判成 unsafe。
 *
 * 所以这里自己声明一份形状，只在边界处 cast 一次，后面全部走真实类型。
 * 字段全部可选（除 path）：各平台给不全，Windows 有 serialNumber/pnpId，
 * Linux 常常什么都没有。
 */
interface RawPortInfo {
  path: string
  manufacturer?: string
  serialNumber?: string
  pnpId?: string
  locationId?: string
  productId?: string
  vendorId?: string
}

/** 枚举当前可用串口。失败时返回空数组 —— 枚举不到不等于出错，界面按空列表处理 */
export async function listSerialPorts(): Promise<SerialPortInfo[]> {
  try {
    const { SerialPort } = loadSerialport()
    const ports = (await SerialPort.list()) as RawPortInfo[]
    return ports.map((p) => ({
      path: p.path,
      manufacturer: p.manufacturer || undefined,
      serialNumber: p.serialNumber || undefined,
      pnpId: p.pnpId || undefined,
      locationId: p.locationId || undefined,
      productId: p.productId || undefined,
      vendorId: p.vendorId || undefined
    }))
  } catch {
    return []
  }
}

/**
 * 端口指纹：用于热插拔检测判断「列表是否变了」。
 *
 * 只比 path 不够 —— 拔掉 COM3 再插另一台设备，列表还是只有 COM3，
 * 但那是另一台设备。把身份字段一起算进指纹，才能发现这种替换。
 */
export function portsFingerprint(ports: SerialPortInfo[]): string {
  return ports
    .map((p) => `${p.path}\u0000${p.serialNumber ?? ''}\u0000${p.pnpId ?? ''}`)
    .sort()
    .join('\u0001')
}
