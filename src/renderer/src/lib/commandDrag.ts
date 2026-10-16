/**
 * 常用命令 → 终端 的拖拽协议。
 *
 * 拖拽数据在 dragstart 时必须以同步方式写入 dataTransfer；而 xterm 会把终端里
 * 的文本选区写成 text/plain，若我们只在该键里塞命令 id，粘进终端就会变成一串
 * 无意义的 id 文本（或被主进程当成输入回显）。
 *
 * 因此这里做两件事：
 * 1. 命令 id 只在 dragstart 阶段以 text/plain 承载 —— 放在「默认拖拽」
 *    时即可被终端区的 onDrop 读到；
 * 2. 终端区的 onDragOver 判定为命令拖拽后立即清空所有条目，后续 dragenter /
 *    dragover / drop 都会看到 types 为空 —— Electron 下 xterm 的文本拖放路径
 *    会被这条判定整体跳过，避免同一次拖拽既插入了 id 文本又执行了命令。
 */

/** 命令条目 → 终端去执行的拖拽标识 */
export function isCommandDrag(types: readonly string[]): boolean {
  return types.length > 0
}

/** dragOver 阶段摘除拖拽载荷（返回是否确实摘除了，即这次拖拽来自常用命令） */
export function stripDragPayload(dataTransfer: DataTransfer): boolean {
  const fromCommands = dataTransfer.types.includes('text/plain')
  dataTransfer.clearData()
  return fromCommands
}

/**
 * 读取被拖动的命令 id。
 * 兼容新协议（text/plain）与历史协议（application/x-ssh-command，便于灰度期共存）。
 */
export function readDraggedCommandId(
  dataTransfer: DataTransfer,
  startedId: string | null
): string | null {
  const legacy = dataTransfer.getData('application/x-ssh-command')
  if (legacy) return legacy
  const plain = dataTransfer.getData('text/plain')
  return plain || startedId
}
