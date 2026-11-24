import type { ConnKind, ConnStatus } from '@shared/types'

/**
 * 拖进终端的本地文件该走哪条通道。
 *
 * P1-1 的核心判据：默认用 SFTP 直接传到终端当前目录（不需要远端装 trzsz），
 * 按住 Alt 临时切回 trzsz（用户明确要「流式传输/断点续传」时才用）。
 *
 * 为什么把判定抽成纯函数而不是塞在 onDrop 里：
 * 拖拽有三个入口（dragover / dragleave / drop）要各自判一次，写在组件里
 * 必然出现「overlay 说能传、drop 却没传」的不一致；纯函数可以被
 * scripts/verify-paste-guard.cjs 直接断言，每条短路都有对应断言。
 */

export type DropUploadMode = 'sftp' | 'trzsz'
export type DropAction = 'ignore' | 'sftp' | 'trzsz'

export interface DropActionInput {
  /** 会话类型；缺省按 'ssh' 处理（V1.x 会话没有这个字段） */
  kind: ConnKind
  status: ConnStatus
  /** dataTransfer.files.length —— 命令卡片拖拽时为 0 */
  fileCount: number
  /** 用户偏好；脏值/缺省一律回落 'sftp' */
  prefMode?: DropUploadMode | null
  /** 拖拽过程中是否按着 Alt（临时翻转通道） */
  altKey: boolean
}

/**
 * 判定拖放动作。
 *
 * 三条短路必须都在通道计算之前：
 * - 串口没有 SFTP，也没有 trzsz 通道；
 * - 没连上就没有远端 cwd 可传；
 * - fileCount 为 0 说明拖的是命令卡片（另一条链路），绝不能当成文件上传。
 */
export function decideDropAction(input: DropActionInput): DropAction {
  if (input.kind === 'serial') return 'ignore'
  if (input.status !== 'connected') return 'ignore'
  if (!(input.fileCount > 0)) return 'ignore'

  // 异或而不是「Alt 就是 trzsz」：偏好本身就是 trzsz 时，Alt 要能翻回 sftp。
  const base: DropUploadMode = input.prefMode === 'trzsz' ? 'trzsz' : 'sftp'
  return (base === 'trzsz') !== input.altKey ? 'trzsz' : 'sftp'
}

/**
 * dragover 阶段能拿到的文件数。
 *
 * Windows 的坑：拖拽**未落下**时 dataTransfer.files 处于「保护模式」，
 * 长度恒为 0 —— 只有 drop 之后才填上真实 File 列表。于是 onDragOver 里
 * 拿 files.length 判定会永远得到 0，decideDropAction 直接短路成 ignore：
 * 提示层不出现、e.preventDefault() 不被调用，浏览器默认行为接管，文件根本落不下来。
 *
 * 三级回退，顺序不能换：
 * 1. files.length —— 有就是准的（drop 阶段、以及非 Windows 平台）；
 * 2. items[kind === 'file'] 的条数 —— dragover 期间唯一可信的线索；
 * 3. types 含 'Files' 时返回 1 —— 拖动刚开始、items 还没填上内容，
 *    只知道「拖的是文件」，给个占位 1 让提示层先亮起来即可（真实数量在 drop 时才算）。
 *
 * 拖常用命令（text/plain）时 items 全是 string 且 types 不含 'Files'，返回 0 ——
 * 与命令拖拽链路的分界线就在这一步。
 */
export function countDraggedFiles(dt: DataTransferLike | null | undefined): number {
  if (!dt) return 0
  const files = dt.files
  if (files && files.length > 0) return files.length
  const items = dt.items
  if (items && items.length > 0) {
    let n = 0
    /* 用下标而不是 for..of：dragover 期间拿到的是 DataTransferItemList，
     * 它在部分环境下没有 Symbol.iterator，而 verify 脚本传的是普通数组。 */
    for (let i = 0; i < items.length; i += 1) {
      if (items[i]?.kind === 'file') n += 1
    }
    if (n > 0) return n
  }
  const types = dt.types
  if (types && Array.from(types).includes('Files')) return 1
  return 0
}

/** countDraggedFiles 只读 dataTransfer 的三个字段，接受结构化子集方便在无 DOM 环境断言 */
export interface DataTransferLike {
  files?: { length: number } | null
  items?: ArrayLike<{ kind?: string }> | null
  types?: ArrayLike<string> | null
}
