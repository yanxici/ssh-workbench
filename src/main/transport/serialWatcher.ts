/**
 * 串口热插拔监听。
 *
 * 为什么是轮询而不是系统事件：Windows 有 WM_DEVICECHANGE、Linux 有 udev，
 * 但 serialport 不暴露任何插拔事件，要接就得自己写平台代码（Windows 还要
 * 一个隐藏窗口收消息）。轮询 `SerialPort.list()` 一次是几毫秒的枚举，
 * 2 秒一次的开销可以忽略，换来的是三平台同一份实现。
 *
 * 为什么不做防抖合并：拔插本身是低频动作（人手插拔），合并只会让
 * 「插上了但界面还没反应」的窗口变长。真正需要防的是「枚举本身抖动」，
 * 所以判据用指纹而不是长度 —— 端口顺序变化不算变化。
 */
import type { SerialPortInfo } from '@shared/types'
import { listSerialPorts, portsFingerprint } from './serialPorts'

/** 轮询间隔。2 秒：人手插拔的感知阈值约 1 秒，再快只是白烧 CPU */
const POLL_MS = 2000

export interface SerialWatchEvents {
  /** 端口列表发生变化（增/删/身份变化） */
  onPorts: (ports: SerialPortInfo[], previous: SerialPortInfo[]) => void
}

export class SerialWatcher {
  private timer: NodeJS.Timeout | null = null
  private ports: SerialPortInfo[] = []
  private fingerprint = ''
  private polling = false
  private readonly events: SerialWatchEvents

  constructor(events: SerialWatchEvents) {
    this.events = events
  }

  /** 启动监听并立刻取一次初值（初值不触发 onPorts，避免启动瞬间误报） */
  async start(): Promise<SerialPortInfo[]> {
    if (this.timer) return this.ports
    this.ports = await listSerialPorts()
    this.fingerprint = portsFingerprint(this.ports)
    this.timer = setInterval(() => void this.poll(), POLL_MS)
    // unref：监听不该拖住进程退出（Electron 关窗时主进程要能干净结束）
    this.timer.unref?.()
    return this.ports
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  /** 当前缓存的一份端口列表（打开连接编辑器时先给这个，再等下一次轮询刷新） */
  current(): SerialPortInfo[] {
    return this.ports
  }

  /**
   * 立即刷新一次并返回。
   * 用户点「刷新端口」按钮时走这里，不必等下一个 2 秒节拍。
   */
  async refresh(): Promise<SerialPortInfo[]> {
    await this.poll()
    return this.ports
  }

  private async poll(): Promise<void> {
    // 上一轮还没跑完就跳过：枚举偶发卡住时不能让轮询堆叠
    if (this.polling) return
    this.polling = true
    try {
      const next = await listSerialPorts()
      const nextFp = portsFingerprint(next)
      if (nextFp === this.fingerprint) return
      const previous = this.ports
      this.ports = next
      this.fingerprint = nextFp
      this.events.onPorts(next, previous)
    } finally {
      this.polling = false
    }
  }
}
