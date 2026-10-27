/**
 * 「侧栏文件面板跟随终端 cwd」的决策核心。
 *
 * 为什么把这段抽出来：这段逻辑真正的难点不在解析 `cd`（那在 `@/lib/shellCwd`），
 * 而在**什么时候该跳、跳哪儿、要不要替用户切 Tab**。它由三件事共同决定：
 * 终端 cwd 的事件序号、面板已经消费到哪个序号、面板此刻是不是用户眼前那一栏。
 * 三者任意一个判断错了，用户看到的就是「我开了跟随，但 cd 之后没反应」——
 * 而这种交互 bug 用 DOM 测试很难覆盖（面板常驻挂载、靠 display 切换，
 * 事件都在隐藏时到达），所以把它收敛成纯函数，直接单测。
 *
 * 契约：
 * - `seq` 是**事件**序号（同一路径再 cd 一次也算新事件），不是路径比较；
 * - 面板只消费**新事件**，切会话时先把游标对齐，避免被上一个会话的 cwd 拽走；
 * - 序号前进但面板不可见时，目标仍然要落下去（用户切回来就该在那儿）。
 */

/** 一次跟随判定的输入 */
export interface FollowInput {
  /** 终端 cwd 的当前事件序号 */
  seq: number
  /** 面板已经消费到的序号 */
  followedSeq: number
  /** 终端 cwd 的当前路径（可能是空串） */
  path: string
  /** 面板此刻的当前目录 */
  currentDir: string
  /** 会话是否处于 connected */
  connected: boolean
  /** 用户是否开着「跟随终端目录」 */
  follow: boolean
}

/** 一次跟随判定的结果 */
export interface FollowDecision {
  /** 需要跳转的目标目录；null = 不跳 */
  jump: string | null
  /** 判定后应该写回的游标（无论跳不跳都要写，否则同一事件会被反复消费） */
  followedSeq: number
}

/**
 * 归一化：与 `@/lib/uploadDir` 的 normalizeRemoteDir 保持同一语义，
 * 但这里不 import 它 —— 本文件要能在 node 里裸跑（单测），零依赖。
 */
function norm(dir: string | null | undefined): string {
  const raw = (dir ?? '').trim()
  if (!raw) return ''
  const collapsed = raw.replace(/\/{2,}/g, '/')
  if (collapsed === '/') return '/'
  return collapsed.replace(/\/+$/, '') || '/'
}

/**
 * 决定这一次要不要把面板切到 `path`。
 *
 * 单向前进：`seq <= followedSeq` 时直接返回，不跳也不回退游标 ——
 * 回退会让「切走再切回」时重复消费旧事件。
 */
export function decideFollow(input: FollowInput): FollowDecision {
  const { seq, followedSeq, path, currentDir, connected, follow } = input

  // 断线 / 关掉开关：游标照样跟上，否则重新打开时会补跳一次「历史」目录
  if (!connected || !follow) return { jump: null, followedSeq: Math.max(followedSeq, seq) }
  if (seq <= followedSeq) return { jump: null, followedSeq }

  const target = norm(path)
  // 序号前进但路径还没解析出来（例如 `cd` 之后 home 还在补）：游标不前进，
  // 等下一次带路径的事件；否则这次事件会被永久跳过。
  if (!target) return { jump: null, followedSeq }

  // 已经在这个目录了：游标前进，不动 UI（省一次无意义的展开状态清空）
  if (norm(currentDir) === target) return { jump: null, followedSeq: seq }

  return { jump: target, followedSeq: seq }
}

/** 挂载 / 切会话时的初始状态判定 */
export interface InitialInput {
  /** 已知的终端 cwd（可能为空） */
  knownCwd: string
  /** 用户是否开着跟随 */
  follow: boolean
  /** 当前所在 Tab */
  tab: 'workspace' | 'fs'
}

/**
 * 面板刚挂载（或切到新会话）时该怎么办。
 *
 * 这里踩过的坑：面板首次挂载时，游标会被对齐到「当前序号」，于是**挂载前**
 * 已经发生的 `cd` 事件全部被静默吞掉；而 Tab 默认停在「工作区」（常用位置
 * 快捷入口），用户点开文件面板看到的是一列快捷入口而不是目录树 ——
 * 体感就是「我 cd 了，文件没跟过来」。所以：有已知 cwd 且开着跟随时，
 * 直接把 Tab 定到「文件系统」，让目录树第一眼就是终端所在目录。
 */
export function decideInitial(input: InitialInput): {
  dir: string
  tab: 'workspace' | 'fs'
} {
  const dir = norm(input.knownCwd)
  if (!dir) return { dir: '', tab: input.tab }
  if (!input.follow) return { dir, tab: input.tab }
  return { dir, tab: 'fs' }
}
