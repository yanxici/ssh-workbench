/**
 * 热插拔监听器的单例持有者。
 *
 * 为什么单独一个文件而不是让 serialWatcher.ts 自己导出单例：
 * ipc/serial.ts 与 main/index.ts 都要拿到同一个实例，而 serialWatcher.ts
 * 本身不该知道「谁在用它」。把持有权放在这里，两边都只依赖这一层，
 * 谁先初始化都不会拿到 undefined。
 */
import type { SerialWatcher } from './serialWatcher'

let instance: SerialWatcher | null = null

export function setSerialWatcher(watcher: SerialWatcher | null): void {
  instance = watcher
}

export function getSerialWatcher(): SerialWatcher | null {
  return instance
}
