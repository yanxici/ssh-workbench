import type { Client, OpenMode, SFTPWrapper, Stats } from 'ssh2'
import { existsSync, promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import iconv from 'iconv-lite'
import type {
  RemoteFile,
  RemoteText,
  SftpBackendMode,
  SftpModeEvent,
  TextEncoding,
  TransferProgressEvent,
  TransferTask,
  UploadScanItem
} from '@shared/types'
import { sessionManager } from './sessionManager'
import { execCollect } from './exec'
import {
  shellChmod,
  shellDownloadFile,
  shellHome,
  shellList,
  shellListMany,
  shellMkdir,
  shellReadText,
  shellRemove,
  shellRename,
  safeRelativeSegments,
  shellUploadFile,
  shellWalkRemote,
  shellWriteText,
  shQuote
} from './shellFs'
import type { ShellTransferHooks } from './shellFs'
import { recordFromEvent } from '../store/transferRecord'
import { recordError } from '../store/errorLog'

/**
 * SFTP 文件管理 —— 在已建立的 SSH 会话上挂载 SFTP 子系统。
 *
 * 设计：
 * - 每个会话懒创建并缓存一个 SFTPWrapper，会话断开后自动失效重建；
 * - 传输任务串行排队（避免多任务争抢带宽/连接），进度以节流事件推送到渲染层；
 * - 上传下载基于 ssh2 的 fastPut/fastGet（分块并发，嵌入式设备兼容性好），
 *   通过 step 回调驱动进度（约 150ms 节流一次）；
 * - 远程文本编辑：保存前自动把原文件改名为 <name>.bak（覆盖旧备份）。
 */

type ProgressHandler = (event: TransferProgressEvent) => void

/**
 * 每个「批次占位 Set」对应一份小写归一后的副本。
 *
 * 调用方传进来的 allocated 是原样的路径，不能就地改成小写（返回值还要用）；
 * 又不想让调用方多传一个参数，就用 WeakMap 挂在那个 Set 上 —— 批次结束
 * 调用方丢掉 Set，这里跟着回收。
 *
 * 这是**唯一的**占位来源。曾经还有一个模块级 allocatedLower 给「没传 allocated」
 * 的调用兜底，那是个纯粹的坑：它永不清空，文件删了也照样占着名字，
 * 同一个文件在整个进程生命周期里每次下载都被迫多加一个 (1)(2)(3)。
 */
/**
 * 同名文件自动加序号，绝不覆盖已有文件。
 *
 * 与 ipc/zmodem.ts 的 uniquePath 保持同一套规则（`名字 (1).ext`）——
 * 两条下载路径行为必须一致：ZMODEM 接收早就做了重名保护，
 * 而 SFTP 下载此前是 `fs.open(localPath, 'w')` 直接截断，
 * 用户把远端 config.bak 拖到本地同名目录，本地原文件当场没了。
 */
export function uniqueLocalPath(
  dir: string,
  name: string,
  /**
   * 本批次或全局在途已分配的路径（可选）。
   * 只靠 existsSync 判断是不够的：批量下载时文件还没落盘，同一批或跨批次的
   * 同名远端文件会算出同一个候选路径，并发 `fs.open` 互相截断。
   * 这里每次按当前 allocated 实时生成折叠视图，避免长生命周期 Set 删除条目后
   * 与旁路 WeakMap 缓存永久失步。
   */
  allocated?: Set<string>
): string {
  /*
   * Windows 文件系统大小写不敏感：A.txt 与 a.txt 是同一个文件，而 existsSync
   * 与 Set 都按字面比较。批量下载里两个只差大小写的远端文件会算出同一个候选
   * 路径，双双往同一个 .part 里写。归一成小写再比对（POSIX 上保持原样）。
   */
  const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
  const takenLower = allocated ? new Set([...allocated].map(fold)) : null
  /*
   * 没传 allocated 时只看磁盘。另外必须连 .part 一起看：并发下载写的是
   * <目标>.part，两个任务算出同一目标就等于两个句柄写同一个半成品。
   */
  const taken = (p: string): boolean =>
    existsSync(p) || existsSync(partPathOf(p)) || (takenLower?.has(fold(p)) ?? false)
  const candidate = join(dir, name)
  if (!taken(candidate)) {
    allocated?.add(candidate)
    return candidate
  }
  const ext = extname(name)
  const stem = name.slice(0, name.length - ext.length) || 'download'
  let i = 1
  for (;;) {
    const next = join(dir, `${stem} (${i})${ext}`)
    if (!taken(next)) {
      allocated?.add(next)
      return next
    }
    i += 1
  }
}

const PROGRESS_THROTTLE_MS = 150
const EDIT_SIZE_LIMIT = 2 * 1024 * 1024
/** 文本保存的超时：2 MB 走慢链路也可能要几十秒，比元数据操作宽松得多 */
const EDIT_WRITE_TIMEOUT_MS = 60_000

/** 分块传输：单块大小与在途并发数（兼顾吞吐与可中断粒度） */
const CHUNK_SIZE = 256 * 1024
const CHUNK_INFLIGHT = 6
/** 同时进行的传输任务数（暂停中的任务不会挡住队列里的其他任务） */
const MAX_CONCURRENT_TRANSFERS = 3

/**
 * 批量列目录的并发度。
 * SFTP 协议允许一个通道上有多个 outstanding request，但嵌入式设备的 sftp-server
 * 往往只有很小的请求队列；8 是「明显快于串行、又不会把老设备打挂」的经验值。
 */
const LIST_MANY_CONCURRENCY = 8

/** 上传前扫描预览的文件数上限：超过就只报「至少这么多」，避免选中巨大目录时卡住 */
const SCAN_FILE_LIMIT = 20000
/** 目录上传的文件数上限（与扫描预览同源，但必须显式提示已截断） */
const UPLOAD_FILE_LIMIT = 20000
/**
 * 目录下载沿用同一上限。
 *
 * 旧实现 walkRemote 既没有上限也没有环检测：远端存在目录环（bind mount、
 * NFS 自引用）时，遍历永不结束 —— 内存里 files 数组一直涨，直到进程被 OOM
 * 杀掉，而界面上只显示「正在扫描」。上传侧早就有这个上限，下载侧漏了。
 */
const DOWNLOAD_FILE_LIMIT = UPLOAD_FILE_LIMIT
/** 远程递归遍历的深度上限（配合 DOWNLOAD_FILE_LIMIT 兜住目录环） */
const MAX_WALK_DEPTH = 64
/** 递归删除的深度上限（同上，防止删到一半停不下来） */
const MAX_REMOVE_DEPTH = 64

/* ---------------------- 断线续传（弱网 / 设备抖动） ---------------------- */

/**
 * 单文件断线重试的上限与恢复等待窗口。
 *
 * 现场场景：设备挂在 4G 或劣质网口上，SSH 会毫无征兆地断开几秒再回来。
 * sessionManager 的自动重连是 1/2/4/8/16 秒退避（默认最多 5 次，合计约 31 秒），
 * 所以 90 秒窗口足够覆盖一整轮重连；超过这个量级就不是抖动，而是真离线了。
 */
const FILE_RETRY_MAX = 8
const RECOVER_DEADLINE_MS = 90000
const RECOVER_POLL_MS = 500
/** 一批分块多久无响应就判定链路已死（正常 1.5MB 远小于 1 秒） */
const CHUNK_TIMEOUT_MS = 30000
/** open / stat 这类控制请求的超时 */
const META_TIMEOUT_MS = 15000
/**
 * 挂载 SFTP 子系统的等待上限。
 *
 * 比控制请求宽：握手刚完成时服务器可能还在初始化子系统，正常几百毫秒就回来了。
 * 但绝不能再短到正常慢机（跳板机三跳）会误报。10 秒足够。
 */
const SFTP_MOUNT_TIMEOUT_MS = 10000
/**
 * 关闭句柄的等待上限。比 META_TIMEOUT_MS 短得多：通道断掉时这个 close 无论如何
 * 都不会回包，多等一秒就是把「断线后 3 秒恢复」拖成「断线后 18 秒恢复」。
 */
const CLOSE_TIMEOUT_MS = 3000
/** 续传时的身份校验：远端/本地文件尾部各读这么多字节做指纹 */
const FINGERPRINT_BYTES = 64 * 1024

/** 主进程侧的字节数文案（渲染层的那份在 lib/utils.ts，主进程用不到） */
function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

/**
 * 给 SFTP 请求套一个超时。
 *
 * 必须要有：链路悄悄断掉时 ssh2 的请求回调**永远不触发**，
 * 传输会静默卡死（进度条定格在某个百分比），比直接报错难排查得多。
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}：${ms / 1000}s 内无响应，判定链路中断`)),
      ms
    )
    timer.unref?.()
    p.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        // 透传原错误（保持 isRetryable 匹配的消息原文），只把非 Error 包一层
        reject(e instanceof Error ? e : new Error(String(e)))
      }
    )
  })
}

/**
 * 这个错误能否靠「重连 + 断点续传」自愈。
 *
 * 只认链路层面的症状。权限被拒、磁盘满、路径非法这类问题重试一万次也是同样结果，
 * 把它们当可重试只会把真实错误拖 90 秒才报给用户。
 */
function isRetryable(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  const code = (err as NodeJS.ErrnoException | undefined)?.code ?? ''
  if (/链路中断|ECONNRESET|EPIPE|ETIMEDOUT|ECONNABORTED|EHOSTUNREACH/i.test(`${msg} ${code}`)) {
    return true
  }
  return /channel not open|not connected|no response from server|connection lost|connection closed|socket hang up|sftp session|会话不存在或已断开|会话已断开|等待会话就绪超时|无法启动 SFTP|Timed out while waiting/i.test(
    msg
  )
}

/**
 * 这个错误是不是「路径确实不存在」。
 *
 * 与 isRetryable 互补：SSH 服务器的 NOT_FOUND 在各实现里文案不一致（code 有的是
 * 数字 2，有的是字符串 'ENOENT'，有的干脆只有一句 No such file），所以文案和 code 都要看；
 * 超时那种「拿不到答案」绝不能算不存在。
 */
function isMissingEntry(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: unknown } | undefined)?.code
  if (code === 2 || code === 'ENOENT' || code === 'NO_SUCH_FILE') return true
  return /no such file|not exist|不存在|NoSuchFile/i.test(msg)
}

/**
 * 这条路径是不是远端根（'/'、'//'、'/.、/./' 都算）。
 *
 * 递归删除的唯一黑名单：ShellFS 侧的 assertSafeRemovePath 早就拒了根，
 * SFTP 侧没有，于是 `rm -rf /` 在 sftp 通道上是能真跑起来的。
 */
function isRemoteRoot(path: string): boolean {
  return path.split('/').every((seg) => seg === '' || seg === '.')
}

/** 这个错误是不是「目录已经在了」（并发建目录时的正常结果） */
function isExistsEntry(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  const code = (err as { code?: unknown } | undefined)?.code
  if (code === 4 || code === 'EEXIST' || code === 'FILE_ALREADY_EXISTS') return true
  return /already exists|已存在|EEXIST/i.test(msg)
}

/** 断线重试的协作面：由 SftpManager 提供，分块引擎只管「失败 → 续传」 */
interface ResumeHooks {
  /** 断线后重新拿一个可用通道（内部会等 SSH 自动重连完成） */
  recover: () => Promise<SFTPWrapper>
  /** 推送一条状态文案（空串表示已恢复正常） */
  notify: (note: string) => void
}

/**
 * 传输控制块：暂停/继续/取消都作用在这里。
 *
 * ssh2 的 fastGet/fastPut 是一次性调用、无法中断，所以文件传输改成
 * 「open → 分块 read/write → close」引擎，块与块之间检查这里的标志：
 * - paused  → 停在循环里等唤醒（句柄保留，继续时原地续传）
 * - cancelled → 抛出 TransferCancelledError，清理半截文件
 * - halt    → 出错时让其余并发块尽快退出
 */
interface TransferControl {
  sessionId: string
  direction: 'upload' | 'download'
  localPath: string
  remotePath: string
  transferred: number
  total: number
  unit: 'bytes' | 'files'
  paused: boolean
  cancelled: boolean
  halt: boolean
  /**
   * 目录上传时是否保留本地目录本身（true → 目标目录/本地目录名/...）。
   * 拖拽上传沿用旧语义（把目录内容铺进目标目录），「上传文件夹」显式开启保留，
   * 用户可以预期「选了 foo 就在远端得到 foo/」。
   */
  keepRoot: boolean
  /** 是否仍占着一个并发位（暂停会让出，继续时重新排队拿回） */
  holding: boolean
  /** 取/放并发位（由 SftpManager.acquire/release 注入，checkpoint 里用） */
  acquire?: () => Promise<void>
  release?: () => void
  /** 忽略「远端已是最新」的跳过判据，强制全量重传 */
  force: boolean
  /**
   * 目录传输的「非失败说明」：跳过链接、空目录、命中上限、兼容模式全量重传……
   *
   * 以前只在 running 事件里带 note，收尾事件不带，于是 transfer-records.json
   * 里那些记录全都没有 note —— 面板上看不出「这次少传了 3 个链接」。
   * 存在控制块上，收尾时再补进去。
   */
  note?: string
  /**
   * shell 后端传输通道的中断句柄（由 registerStream 挂上）。
   *
   * 取消不能只置 ctl.cancelled 就完事：shell 后端跑的是远端 cat / cat > 一条命令，
   * 它不会自己看标志位。不主动 close 通道，远端命令会一直被背压卡着，
   * 大文件看起来「取消了还在传」。
   */
  abortStream?: () => void
  waiters: Array<() => void>
}

class TransferCancelledError extends Error {
  constructor() {
    super('传输已取消')
    this.name = 'TransferCancelledError'
  }
}

class TransferAbortedError extends Error {
  constructor() {
    super('传输已中断')
    this.name = 'TransferAbortedError'
  }
}

/**
 * 目录任务里「部分文件失败」的结构化错误。
 *
 * 旧实现把失败拼成一句「N 个文件失败（例如 a、b、c）」，只留前 3 条，
 * 剩下的永久丢弃 —— 用户传 2 万个文件挂了 300 个时，界面只告诉他 3 个是谁。
 * 这里把全量带上，交给主进程按错误原因聚合成记录（见 transferRecordStore），
 * 界面才能回答「是不是全都是 Permission denied」。
 */
class TransferPartialError extends Error {
  readonly failures: Array<{ path: string; message: string }>
  constructor(failures: Array<{ path: string; message: string }>, summary: string) {
    super(summary)
    this.name = 'TransferPartialError'
    this.failures = failures
  }
}

/**
 * 猜一段字节的文本编码。
 *
 * 顺序是有讲究的：BOM 最确定 → 严格 UTF-8 校验（合法的 UTF-8 几乎不可能是
 * GB18030 的巧合，反过来则经常成立）→ GB18030。旧实现无条件 buf.toString('utf-8')，
 * 一个 GBK 编码的 nginx.conf 打开就是满屏方块，保存回写把原注释彻底毁掉。
 *
 * 都猜不中时退回 UTF-8（带替换字符）并标记为 utf-8：至少用户还能看见拉丁字符，
 * 而不是被一句「不支持的文件」挡在门外。
 */
function detectTextEncoding(buf: Buffer): { content: string; encoding: TextEncoding } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { content: buf.subarray(3).toString('utf-8'), encoding: 'utf-8' }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { content: buf.subarray(2).toString('utf-16le'), encoding: 'utf-16le' }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    /*
     * Node 没有 utf-16be，用字节交换绕过去。
     * 截断的文件（奇数个字节）会让 swap16() 抛 RangeError，直接崩在打开文件上；
     * 丢掉最后那个孤立字节，把剩下的照常显示出来。
     */
    const pairs = buf.length >= 3 ? buf.subarray(2, 2 + ((buf.length - 2) & ~1)) : Buffer.alloc(0)
    const swapped = Buffer.from(pairs)
    swapped.swap16()
    return { content: swapped.toString('utf-16le'), encoding: 'utf-16be' }
  }
  try {
    // fatal 模式：遇到非法序列直接抛，不会静默替换成 U+FFFD
    const content = new TextDecoder('utf-8', { fatal: true }).decode(buf)
    return { content, encoding: 'utf-8' }
  } catch {
    /* 不是合法 UTF-8，继续往下猜 */
  }
  // GB18030 是 GBK/GB2312 的超集，中文 Windows 上的配置文件基本都是它
  try {
    const content = iconv.decode(buf, 'gb18030')
    // 解出来还带替换字符说明也不是 GB18030，别硬认
    if (!content.includes('�')) return { content, encoding: 'gb18030' }
  } catch {
    /* 走兜底 */
  }
  return { content: buf.toString('utf-8'), encoding: 'utf-8' }
}

/**
 * 按编码把文本编回字节（写回远程文件时用，必须与读入时一致）。
 *
 * UTF-16 必须把 detectTextEncoding 剥掉的 BOM 补回去：
 * 第一，没有 BOM 时 detect 会把它当成含 NUL 的二进制而拒绝打开，用户保存一次就再也打不开原文件；
 * 第二，Windows 记事本/PowerShell 5 缺 BOM 会按 ANSI 解释，中文全变乱码。
 * 能走到 utf-16 两个分支的一定是原本带 BOM 的文件，所以补 BOM 是无损还原。
 * utf-8 / gb18030 没有这个约定，保持原样不加。
 */
function encodeText(content: string, encoding: TextEncoding): Buffer {
  if (encoding === 'utf-8') return Buffer.from(content, 'utf-8')
  if (encoding === 'utf-16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')])
  if (encoding === 'utf-16be') {
    const buf = Buffer.from(content, 'utf16le')
    buf.swap16()
    return Buffer.concat([Buffer.from([0xfe, 0xff]), buf])
  }
  return iconv.encode(content, 'gb18030')
}

/** 唤醒所有挂在暂停点上的等待者 */
function wake(ctl: TransferControl): void {
  const waiters = ctl.waiters.splice(0)
  for (const w of waiters) w()
}

/**
 * 暂停点：可在每个分块之间调用。
 *
 * 一条铁律：**挂起等待期间绝不能占着并发位**。旧实现只在 pauseTransfer 里
 * 尝试让位，而排队中的任务那时 holding 还是 false，release 是空操作；等它终于
 * 轮到并拿到位再进 checkpoint，就变成攥着位子等唤醒 —— 暂停 3 个排队任务
 * （MAX_CONCURRENT_TRANSFERS=3）即永久死锁整条队列。所以让位放在暂停循环里做。
 */
async function checkpoint(ctl: TransferControl): Promise<void> {
  for (;;) {
    if (ctl.cancelled) throw new TransferCancelledError()
    if (ctl.halt) throw new TransferAbortedError()
    if (!ctl.paused) {
      if (ctl.holding || !ctl.acquire) return
      await ctl.acquire()
      // 排队拿位可能等很久，拿到后必须重检：期间完全可能被取消或再次暂停
      continue
    }
    ctl.release?.()
    await new Promise<void>((resolve) => ctl.waiters.push(resolve))
  }
}

/* ------------------------------ 工具 ------------------------------ */

/** 远端 POSIX 路径拼接 */
function joinRemote(dir: string, name: string): string {
  if (dir === '/') return `/${name}`
  return `${dir.replace(/\/+$/, '')}/${name}`
}

function formatMode(mode: number): string {
  const perm = (m: number): string =>
    `${m & 4 ? 'r' : '-'}${m & 2 ? 'w' : '-'}${m & 1 ? 'x' : '-'}`
  /*
   * 文件类型必须先把高位掩出来再**整体比较**：
   * 原来写成 mode & 0o120000 取的是「这几个掩码位有没有置上」，
   * 普通文件 0o100644 与 0o120000 有共同位，于是所有普通文件都显示成 lrwxrwxrwx。
   */
  const fmt = mode & 0o170000
  const type =
    fmt === 0o040000 ? 'd'
    : fmt === 0o120000 ? 'l'
    : fmt === 0o140000 ? 's'
    : fmt === 0o060000 ? 'b'
    : fmt === 0o020000 ? 'c'
    : fmt === 0o010000 ? 'p'
    : '-'
  return type + perm((mode >> 6) & 7) + perm((mode >> 3) & 7) + perm(mode & 7)
}

/** readdir 原始结果 → 渲染层用的 RemoteFile[]（目录在前，再按名称排序） */
function toRemoteFiles(
  dir: string,
  entries: Array<{ filename: string; attrs: Stats }>
): RemoteFile[] {
  const files: RemoteFile[] = entries.map((e) => {
    const attrs = e.attrs
    const isDir = attrs.isDirectory()
    const isLink = attrs.isSymbolicLink()
    return {
      name: e.filename,
      path: joinRemote(dir, e.filename),
      type: isDir ? 'directory' : isLink ? 'symlink' : 'file',
      size: attrs.size ?? 0,
      mode: attrs.mode ?? 0,
      modeStr: formatMode(attrs.mode ?? 0),
      uid: attrs.uid ?? 0,
      gid: attrs.gid ?? 0,
      mtime: (attrs.mtime ?? 0) * 1000,
      isLink
    }
  })
  files.sort((a, b) => {
    const aDir = a.type === 'directory'
    const bDir = b.type === 'directory'
    if (aDir !== bDir) return aDir ? -1 : 1
    return a.name.localeCompare(b.name, 'zh-CN')
  })
  return files
}

/*
 * 元数据原语全部必须带超时。
 *
 * 理由和 pReaddir 完全相同：链路悄悄断掉时 ssh2 的回调永远不会触发，
 * 而这些原语是 removeRecursive / 目录传输 / 文本编辑的唯一入口 ——
 * 少一个超时，就有一条路径会「不报错也不结束」，用户只能重开面板。
 * 文案里刻意带「链路中断」：isRetryable 认这个词，超时才能走重连续传。
 */
function pStat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return withTimeout(
    new Promise<Stats>((resolve, reject) => {
      sftp.stat(path, (err, stats) => (err ? reject(err) : resolve(stats)))
    }),
    META_TIMEOUT_MS,
    '读取文件属性'
  )
}

/*
 * readdir 必须带超时。
 *
 * 链路悄悄断掉时 ssh2 的回调永远不会触发 —— 渲染层就一直在 loading，
 * 刷新按钮被 disabled 锁死，用户看到的就是「很慢、按钮按不下去」，
 * 除了重开面板没有任何恢复路径。这里是所有列目录的唯一入口，
 * 套一层超时后失败会走正常报错路径，界面能自己爬起来。
 */
/*
 * lstat 与 stat 的分工，是「删除」这条路径唯一的安全边界。
 *
 * stat 跟随符号链接：用户删一个指向 /var/www 的链接，拿到的是目标的 properties，
 * isDirectory() 为真 → 递归进去把目标目录整个清空。删链接变成了删目标站。
 * lstat 看的是链接本身（isSymbolicLink() 为真），此时只 unlink 链接本身。
 */
function pLstat(sftp: SFTPWrapper, path: string): Promise<Stats> {
  return withTimeout(
    new Promise<Stats>((resolve, reject) => {
      sftp.lstat(path, (err, stats) => (err ? reject(err) : resolve(stats)))
    }),
    META_TIMEOUT_MS,
    '读取文件属性（不跟随链接）'
  )
}

function pReaddir(sftp: SFTPWrapper, path: string): Promise<Array<{ filename: string; attrs: Stats }>> {
  return withTimeout(
    new Promise<Array<{ filename: string; attrs: Stats }>>((resolve, reject) => {
      sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list)))
    }),
    META_TIMEOUT_MS,
    '读取目录'
  )
}

function pUnlink(sftp: SFTPWrapper, path: string, isDir: boolean): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      const cb = (err: Error | undefined | null): void => (err ? reject(err) : resolve())
      if (isDir) sftp.rmdir(path, cb)
      else sftp.unlink(path, cb)
    }),
    META_TIMEOUT_MS,
    '删除远端条目'
  )
}

function pRename(sftp: SFTPWrapper, from: string, to: string): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      sftp.rename(from, to, (err) => (err ? reject(err) : resolve()))
    }),
    META_TIMEOUT_MS,
    '重命名远端文件'
  )
}

/* --------------------------- 分块读写原语 --------------------------- */

function pOpen(sftp: SFTPWrapper, path: string, mode: OpenMode): Promise<Buffer> {
  return withTimeout(
    new Promise<Buffer>((resolve, reject) => {
      sftp.open(path, mode, (err, handle) => (err ? reject(err) : resolve(handle)))
    }),
    META_TIMEOUT_MS,
    '打开远端文件'
  )
}

/*
 * mkdir / chmod / realpath / readFile / writeFile 也必须带超时。
 *
 * 旧实现里这几处是裸回调，链路静默断开时回调永不触发：IPC 永不返回、
 * 传输并发位永不归还，最后整个文件面板和队列一起僵住。文案统一带
 * 「链路中断」——isRetryable 认这个词，超时才能走重连而不是直接报错。
 */
function pMkdir(sftp: SFTPWrapper, path: string): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      sftp.mkdir(path, (err) => (err ? reject(err) : resolve()))
    }),
    META_TIMEOUT_MS,
    '创建远端目录'
  )
}

function pChmod(sftp: SFTPWrapper, path: string, mode: number): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      sftp.chmod(path, mode, (err) => (err ? reject(err) : resolve()))
    }),
    META_TIMEOUT_MS,
    '修改远端权限'
  )
}

function pRealpath(sftp: SFTPWrapper, path: string): Promise<string> {
  return withTimeout(
    new Promise<string>((resolve, reject) => {
      sftp.realpath(path, (err, abs) => (err ? reject(err) : resolve(abs)))
    }),
    META_TIMEOUT_MS,
    '解析远端真实路径'
  )
}

function pReadFile(sftp: SFTPWrapper, path: string): Promise<Buffer> {
  return withTimeout(
    new Promise<Buffer>((resolve, reject) => {
      sftp.readFile(path, (err, data) => (err ? reject(err) : resolve(data)))
    }),
    EDIT_WRITE_TIMEOUT_MS,
    '读取远端文件'
  )
}

function pWriteFile(sftp: SFTPWrapper, path: string, data: Buffer): Promise<void> {
  return withTimeout(
    new Promise<void>((resolve, reject) => {
      sftp.writeFile(path, data, (err) => (err ? reject(err) : resolve()))
    }),
    EDIT_WRITE_TIMEOUT_MS,
    '写入远端文件'
  )
}

/**
 * 关闭远端句柄。
 *
 * 必须带超时兜底：链路断掉之后 ssh2 的请求回调永远不会触发（实测 8s+ 无回调），
 * 而这条路径遍布 catch / finally。挂在这里的后果是「断线后传输彻底停住，不报错
 * 也不续传」—— 用户看到的是进度条定格，比直接失败更难理解。
 * 关句柄失败本身无所谓（通道都死了），所以照旧永不 reject。
 */
function pClose(sftp: SFTPWrapper, handle: Buffer): Promise<void> {
  return Promise.race([
    new Promise<void>((resolve) => {
      sftp.close(handle, () => resolve())
    }),
    sleep(CLOSE_TIMEOUT_MS)
  ])
}

function pFstat(sftp: SFTPWrapper, handle: Buffer): Promise<Stats> {
  return withTimeout(
    new Promise<Stats>((resolve, reject) => {
      sftp.fstat(handle, (err, stats) => (err ? reject(err) : resolve(stats)))
    }),
    META_TIMEOUT_MS,
    '读取远端文件属性'
  )
}

function pRead(
  sftp: SFTPWrapper,
  handle: Buffer,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number
): Promise<number> {
  return new Promise((resolve, reject) => {
    sftp.read(handle, buffer, offset, length, position, (err, bytesRead) => {
      if (err) reject(err)
      else resolve(bytesRead)
    })
  })
}

/**
 * 读完远端一段数据，直到读满 len 或确实到 EOF。
 *
 * 为什么不能只调一次 read：CHUNK_SIZE 是 256 KB，而 OpenSSH sftp-server 的
 * 单包上限通常只有 64 KB（Dropbear / Go pkg/sftp / 老设备为 32 KB 或 16 KB）。
 * 服务端返回短读（bytesRead < len）是常态，不是 EOF。旧实现把短读当整块写完，
 * 再把下一块的偏移直接推到 pos + 256 KB —— 中间那段从没写过的字节在 .part
 * 里就是一片零洞，而文件大小照样正确：用户拿到的是「大小对、内容坏」。
 *
 * @returns 实际读到的字节（长度 < len 才表示真的到 EOF）
 */
async function readRemoteRange(
  sftp: SFTPWrapper,
  handle: Buffer,
  length: number,
  position: number
): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(length)
  let filled = 0
  while (filled < length) {
    const got = await withTimeout(
      pRead(sftp, handle, buf, filled, length - filled, position + filled),
      CHUNK_TIMEOUT_MS,
      '下载分块'
    )
    if (got <= 0) break
    filled += got
  }
  return buf.subarray(0, filled)
}

function pWrite(
  sftp: SFTPWrapper,
  handle: Buffer,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    sftp.write(handle, buffer, offset, length, position, (err) =>
      err ? reject(err) : resolve()
    )
  })
}

/** 删除远端半截文件；通道已死时借一次重连再删（否则 file 会一直留在远端） */
async function discardRemoteOnFresh(
  conn: SFTPWrapper,
  hooks: ResumeHooks | undefined,
  path: string
): Promise<void> {
  await discardRemote(conn, path)
  if (!hooks) return
  /*
   * conn 十有八九已经死了 —— 死通道上的 unlink 只会立刻拿到 ECONNRESET，
   * 远端文件原封不动地留着。用户下次看到同名文件还在，会以为上次传成功了。
   * 所以放弃重试时借最后一次恢复机会把半截文件删掉，5 秒拿不到就作罢。
   */
  const fresh = await Promise.race([
    hooks.recover().catch(() => null),
    sleep(5000).then(() => null)
  ])
  if (fresh && fresh !== conn) await discardRemote(fresh, path)
}

/** 删除传输失败/取消后残留的半截文件（失败无所谓） */
async function silentUnlinkLocal(path: string): Promise<void> {
  await fs.unlink(path).catch(() => undefined)
}

/**
 * 关闭本地写句柄并吞掉错误。
 *
 * 单独抽函数只是为了让「可能为 null 的句柄」走到形参上 —— 直接内联写
 * `if (local) await local.close()` 时，TS 的控制流分析会把 local 收窄成
 * never（try 和 catch 都把 local 置空了），finally 里就成了对 never 调方法。
 * 不能为这个加类型断言，句柄是真的可能还在。
 */
async function closeLocalQuietly(fh: FileHandle | null): Promise<void> {
  if (fh) await fh.close().catch(() => undefined)
}

/** 半成品临时文件路径：<文件名>.part（同目录，保证 rename 是原子同卷移动） */
function partPathOf(target: string): string {
  return `${target}.part`
}

/**
 * 把写完的 .part 提交成正式文件。
 *
 * 目标名理论上在入队时就已经用 uniqueLocalPath 避开了重名，但排队到真正开写
 * 之间隔着一段时间，用户完全可能在这期间自己放了个同名文件进来。这时候
 * 直接 rename 会失败（Windows 上 EEXIST/EPERM），所以按最小代价退一步：
 * 删掉占位目标再 rename 一次。两次都失败就上抛 —— 此时 .part 还在，数据没丢。
 */
async function commitPartFile(partPath: string, target: string): Promise<void> {
  try {
    await fs.rename(partPath, target)
    return
  } catch {
    // 目标已存在时改名会失败，删掉再试一次（与上传侧 rename 到已存在路径同策）
  }
  await fs.unlink(target).catch(() => undefined)
  await fs.rename(partPath, target)
}

/**
 * 把写完的远端 .part 提交成正式文件，覆盖前先留一份 .bak。
 *
 * 与本地 commitPartFile 同形，但远端多一步备份：SFTP 的 rename 在目标已存在时
 * 行为因服务器而异（OpenSSH 默认覆盖，部分嵌入式 sftp-server 直接失败），
 * 所以先把目标改名成 .bak，再改名 .part → 目标，两步都不成功就回滚并上抛。
 * 覆盖式上传把原文件悄悄吃掉，和「上传」这个动作的直觉正好相反。
 */
async function commitRemotePart(
  sftp: SFTPWrapper,
  partPath: string,
  target: string
): Promise<void> {
  const bak = `${target}.bak`
  const existed = await pStat(sftp, target).then(
    () => true,
    () => false
  )
  let backedUp = false
  if (existed) {
    await pUnlink(sftp, bak, false).catch(() => undefined)
    try {
      await pRename(sftp, target, bak)
      backedUp = true
    } catch {
      /* 备份失败也继续：下面 rename 失败时会再退一步删掉目标重试 */
    }
  }
  try {
    await pRename(sftp, partPath, target)
    return
  } catch (err) {
    if (!backedUp) {
      // 目标还占着名字（服务器不接受覆盖式 rename）：删掉再试一次
      await pUnlink(sftp, target, false).catch(() => undefined)
      try {
        await pRename(sftp, partPath, target)
        return
      } catch {
        /* 落到下面的回滚 */
      }
    }
    if (backedUp) await pRename(sftp, bak, target).catch(() => undefined)
    throw err
  }
}

/**
 * 把远端文件的 mtime 对齐到本地文件。
 *
 * 目录重传的「这个文件没变就跳过」判据是 size + mtime；SFTP 写入不会保留
 * 源文件的时间戳，不显式对齐的话远端 mtime 永远是「刚才」，跳过判据形同虚设。
 * 不支持 utimes 的服务器（极少）或权限不足时静默放弃 —— 退化成每次全传。
 */
async function setRemoteMtime(
  sftp: SFTPWrapper,
  path: string,
  atime: number,
  mtime: number
): Promise<void> {
  if (typeof sftp.utimes !== 'function') return
  // 超时/失败都当放弃：mtime 对不齐最多是下次全量重传，不该让上传失败
  await withTimeout(
    new Promise<void>((resolve) => {
      try {
        sftp.utimes(path, atime, mtime, () => resolve())
      } catch {
        resolve()
      }
    }),
    META_TIMEOUT_MS,
    '对齐远端修改时间'
  ).catch(() => undefined)
}

/**
 * 远端那个同名文件是否已经是这个本地文件的最新版本。
 *
 * 判据只有 size + mtime（秒级）。不算校验和：算一遍 sha256 要把两个文件都
 * 完整读一遍，比直接重传还慢，而「大小相同、秒级时间也相同、内容还不同」
 * 需要人为构造。
 */
async function isUpToDate(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string
): Promise<boolean> {
  const [localSt, remoteSt] = await Promise.all([
    fs.stat(localPath).catch(() => null),
    pStat(sftp, remotePath).catch(() => null)
  ])
  if (!localSt || !remoteSt || !remoteSt.isFile()) return false
  if (localSt.size !== remoteSt.size) return false
  return Math.floor(localSt.mtimeMs / 1000) === Math.floor(remoteSt.mtime)
}

async function silentUnlinkRemote(sftp: SFTPWrapper, path: string): Promise<void> {
  await pUnlink(sftp, path, false).catch(() => undefined)
}

/**
 * 读远端文件的一段（用于续传前的尾部指纹比对）。
 *
 * 必须是循环补读，不能是单次 pRead。指纹长度是 64 KB，而 OpenSSH sftp-server
 * 单包上限 64 KB、Dropbear / Go pkg/sftp / 老嵌入式设备只有 32 KB 或 16 KB。
 * 单次读在这些设备上只回来 32 KB，于是：
 *   - 下载侧 `remoteTail.length === len` 恒 false → 断点续传永远从头开始；
 *   - 上传侧 `!remoteTail.equals(localTail)` 恒 true → 直接把已传的远端数据 'w' 截断。
 * 也就是说这两类设备上「续传」从来没用过，每次都是全量重传。
 * 直接复用 readRemoteRange，短读在那里已经被当成常态补读。
 */
async function readRemoteTail(
  sftp: SFTPWrapper,
  handle: Buffer,
  position: number,
  length: number
): Promise<Buffer> {
  return readRemoteRange(sftp, handle, length, position)
}

/**
 * 读本地文件的一段（与 readRemoteTail 配对）。
 *
 * 单独开一个只读句柄而不是复用写入句柄：写入句柄可能是 'w'（刚截断），
 * 在还没写任何数据时读它会得到空内容，指纹比对会假失败。
 */
async function readLocalChunk(path: string, position: number, length: number): Promise<Buffer> {
  const fh = await fs.open(path, 'r')
  try {
    const buf = Buffer.allocUnsafe(length)
    const { bytesRead } = await fh.read(buf, 0, length, position)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close().catch(() => undefined)
  }
}

/**
 * 有界删除远端半截文件。
 *
 * 通道已死时 sftp.unlink 的回调永远不会触发，直接 await 会把整个任务
 * 挂死在 finally 里 —— 用户看到的是「取消后进度条不动」，比报错更糟。
 */
async function discardRemote(sftp: SFTPWrapper, path: string): Promise<void> {
  await Promise.race([silentUnlinkRemote(sftp, path), sleep(1500)])
}

/**
 * 进度上报器：节流 + 平均速度。所有传输路径共用，保证渲染层看到的事件形状一致。
 */
function makeReporter(
  ctl: TransferControl,
  taskId: string,
  emit: (e: TransferProgressEvent) => void
): { report: (force?: boolean) => void; elapsed: () => number } {
  const startedAt = Date.now()
  let lastEmit = 0
  let lastBytes = 0
  const base = (): Omit<TransferProgressEvent, 'status' | 'speedBps'> => ({
    taskId,
    sessionId: ctl.sessionId,
    direction: ctl.direction,
    localPath: ctl.localPath,
    remotePath: ctl.remotePath,
    transferred: ctl.transferred,
    total: ctl.total,
    unit: ctl.unit
  })

  return {
    report: (force?: boolean): void => {
      const now = Date.now()
      if (!force && now - lastEmit < PROGRESS_THROTTLE_MS) return
      const span = Math.max(now - (lastEmit || startedAt), 1)
      const speed = ((ctl.transferred - lastBytes) * 1000) / span
      lastEmit = now
      lastBytes = ctl.transferred
      emit({ ...base(), status: 'running', speedBps: Math.max(0, Math.round(speed)) })
    },
    elapsed: (): number => Date.now() - startedAt
  }
}

/* --------------------------- 后端降级判定 --------------------------- */

/**
 * 这些错误说明「链路 / 会话本身」出了问题，而不是「服务器上没有 sftp 子系统」。
 *
 * 必须先判它们：`ECONNRESET`、`Channel is not open` 都是链路断掉的通用文案，
 * 而链路错误的描述里经常顺带出现 not found / timed out 这类词。先跑降级正则的话，
 * 一次地铁里断网就会被判成「这台设备没有 sftp-server」，之后整个会话都被钉在
 * shell 通道上 —— 明明是网断了，用户看到的却是文件面板永久降级。
 */
const CONNECTION_LEVEL_SFTP_ERROR =
  /channel open failure|channel is not open|not connected|connection lost|connection closed|socket hang up|econnreset|etimedout|epipe|timed out/i

/**
 * 只认「服务器明确表示 sftp 子系统起不来」这一种。
 *
 * 单目录的 Permission denied / No such file 不在其列：那是路径的问题，换一条通道
 * （shell）同样读不到，把它们算成降级只会让用户以为自己打开了什么「兼容模式」，
 * 而真正的错误原因被埋掉。
 */
const SFTP_SUBSYSTEM_MISSING_ERROR =
  /unable to start subsystem|unable to start sftp|while establishing sftp session|unexpected sftp session termination|expected version packet|sftp-server|exit code 127|not found/i

/**
 * 判断异常是否等价于「对端没有 sftp 子系统」（老式嵌入式设备 / BusyBox / 老 dropbear）。
 *
 * 顺序不能反：先排除链路类错误，再看子系统缺失。反过来的话
 * `Connection lost while waiting for ... not found` 这种句子会同时命中两条正则，
 * 结果取决于正则书写顺序而不是真实原因 —— 那是不可维护的判据。
 *
 * 传入非 Error 时按字面消息处理（IPC 回来的错误常是字符串），其余一律 false：
 * 拿不到消息就没有依据，宁可不降级也不要猜。
 */
export function isSftpSubsystemUnavailableError(err: unknown): boolean {
  const message =
    err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  if (message === '') return false
  if (CONNECTION_LEVEL_SFTP_ERROR.test(message)) return false
  return SFTP_SUBSYSTEM_MISSING_ERROR.test(message)
}

/* ------------------------------ 管理器 ------------------------------ */

/** 导出类供回归脚本驱动（生产只使用下方的单例） */
export class SftpManager {
  private wrappers = new Map<string, SFTPWrapper>()
  /** 正在挂载中的 SFTP 通道（并发请求共享同一次挂载，避免重复 sftp 子系统） */
  private pendingMounts = new Map<string, Promise<SFTPWrapper>>()

  /**
   * 已被占位、但还没落盘的下载目标路径（原样大小写）。
   *
   * 每个批次各自一个 allocated Set 只挡得住**同一批**内的重名：用户先后两次
   * 下载同名文件时，第一批还在传、磁盘上没有目标文件，第二批的 existsSync
   * 全是 false，于是两边算出同一个路径，双双往同一个 .part 里写。
   * 所以占位必须跨批次，入队时占、任务收尾时放（enqueue 的 finally）。
   */
  private activeDownloadTargets = new Set<string>()
  /**
   * 每个会话的远端 home 绝对路径缓存。
   * home() 走一次 realpath，打开文件面板时至少多点一次往返；
   * home 在一个会话生命周期内不会变，缓存到断开为止即可。
   */
  private homes = new Map<string, string>()
  private onProgress: ProgressHandler | null = null
  /** 在途/排队中的传输控制块：暂停、继续、取消都从这里找 */
  private controls = new Map<string, TransferControl>()
  /**
   * 传输并发度（同时正在传输的任务数）。
   * 暂停中的任务不占位：让出后队列继续往下走，否则三个任务一暂停，
   * 后面所有任务就永久排队（旧实现就是这么卡死的）。
   */
  private running = 0
  private waiters: Array<() => void> = []
  /**
   * 每个会话「已确认」的文件通道后端。
   *
   * 只缓存确定的结果：shell 一旦确认就长期有效（这台设备上确实没有 sftp-server，
   * 重试一百次也不会有），sftp 也缓存，省掉每次都要重新挂载子系统。
   * 判定过程本身不写这里 —— 见 pendingMode。
   */
  private sessionModes = new Map<string, SftpBackendMode>()
  /**
   * 正在判定中的后端（并发请求共享同一次探测）。
   *
   * 打开文件面板时 bootstrap / listMany / prewarm 会一起打到主进程，
   * 没有这道合并就是三次 sftp 子系统握手失败 + 三次 shell 探针。
   */
  private pendingMode = new Map<string, Promise<SftpBackendMode>>()
  /** 首次确认降级时的通知钩子（主进程转成 IPC 事件推给渲染层） */
  private onMode: ((e: SftpModeEvent) => void) | null = null
  setProgressHandler(handler: ProgressHandler): void {
    this.onProgress = handler
  }

  /**
   * 注册「后端降级」通知。
   *
   * 只在**首次**确认降级时触发一次：渲染层据此在文件面板上打「Shell 兼容」角标，
   * 每帧都推一遍既没必要，也会让渲染层误以为状态还在变。
   */
  setModeHandler(handler: (e: SftpModeEvent) => void): void {
    this.onMode = handler
  }

  /** 该会话当前确认过的后端；尚未判定时返回 null（渲染层据此显示「未知」而不是猜一个） */
  getMode(sessionId: string): SftpBackendMode | null {
    return this.sessionModes.get(sessionId) ?? null
  }

  /* ------------------------------ 传输控制 ------------------------------ */

  /** 暂停某个传输任务（排队中的任务也可以先暂停，轮到它时直接停住） */
  pauseTransfer(taskId: string): boolean {
    const ctl = this.controls.get(taskId)
    if (!ctl || ctl.cancelled) return false
    if (ctl.paused) return true
    ctl.paused = true
    // 立刻让出并发位，让排队中的任务动起来；继续时在 checkpoint 里重新排队拿回
    ctl.release?.()
    this.emit({
      taskId,
      sessionId: ctl.sessionId,
      direction: ctl.direction,
      localPath: ctl.localPath,
      remotePath: ctl.remotePath,
      transferred: ctl.transferred,
      total: ctl.total,
      status: 'paused',
      unit: ctl.unit
    })
    return true
  }

  /** 继续被暂停的传输（并发位在 checkpoint 里重新排队拿，这里只管唤醒） */
  resumeTransfer(taskId: string): boolean {
    const ctl = this.controls.get(taskId)
    if (!ctl || ctl.cancelled || !ctl.paused) return false
    ctl.paused = false
    wake(ctl)
    this.emit({
      taskId,
      sessionId: ctl.sessionId,
      direction: ctl.direction,
      localPath: ctl.localPath,
      remotePath: ctl.remotePath,
      transferred: ctl.transferred,
      total: ctl.total,
      status: 'running',
      unit: ctl.unit
    })
    return true
  }

  /** 终止传输（排队中的会直接跳过；传输中的在下一个分块边界退出并清理半截文件） */
  cancelTransfer(taskId: string): boolean {
    const ctl = this.controls.get(taskId)
    if (!ctl || ctl.cancelled) return false
    ctl.cancelled = true
    ctl.paused = false
    wake(ctl)
    // shell 后端：立刻掐掉远端 cat / cat >，否则它只会被背压拖着慢慢跑完
    try {
      ctl.abortStream?.()
    } catch {
      /* 通道可能已关 */
    }
    // 立刻回一帧 canceled：排队中的任务可能要等并发位空出来才真正退出，
    // 界面不该在这段时间里继续显示"传输中"。
    this.emit({
      taskId,
      sessionId: ctl.sessionId,
      direction: ctl.direction,
      localPath: ctl.localPath,
      remotePath: ctl.remotePath,
      transferred: ctl.transferred,
      total: ctl.total,
      status: 'canceled',
      unit: ctl.unit
    })
    return true
  }

  /** 是否还有任务在跑（供测试/诊断使用） */
  hasActiveTransfers(): boolean {
    return this.controls.size > 0
  }

  /**
   * 会话真的关闭了：清通道 + 结束该会话名下的所有传输（含暂停中的）。
   *
   * 与 clearSession 分开是必须的：clearSession 也会被 recoverChannel 用来
   * 「丢掉坏通道再重挂」，那是**续传路径**。把它当成关会话处理，
   * 每次断线自愈都会当场取消正在恢复的任务 —— 任务永远落 canceled。
   * 只有这里（sessionManager.setOnClosed 那条线）才代表「这活不干了」。
   *
   * 不取消的话，暂停中的任务永远停在 checkpoint 里等一个不会到来的 wake：
   * 没有人再发终态事件，任务栏进度条会一直卡在中间值直到应用退出。
   */
  closeSession(sessionId: string): void {
    for (const [taskId, ctl] of [...this.controls]) {
      if (ctl.sessionId === sessionId) this.cancelTransfer(taskId)
    }
    this.clearSession(sessionId)
  }

  /** 会话的 SFTP 通道不可用（断线/协议错误）：只丢缓存，不动传输任务 */
  clearSession(sessionId: string): void {
    this.pendingMounts.delete(sessionId)
    this.homes.delete(sessionId)
    /*
     * 后端判定必须跟着会话一起清掉。
     *
     * 用户给设备装上 sftp-server 后重连，缓存的 'shell' 会让他永远走兼容通道；
     * 反过来把 'sftp' 留在缓存里，重连到另一台 BusyBox 设备时会一直重试挂载
     * 子系统，把唯一一次降级机会白白烧掉。重连即重置是唯一安全的语义。
     */
    this.sessionModes.delete(sessionId)
    this.pendingMode.delete(sessionId)
    const wrapper = this.wrappers.get(sessionId)
    if (!wrapper) return
    this.wrappers.delete(sessionId)
    try {
      wrapper.end()
    } catch {
      /* ignore */
    }
  }

  private async getSftp(sessionId: string): Promise<SFTPWrapper> {
    const cached = this.wrappers.get(sessionId)
    if (cached) return cached

    const inflight = this.pendingMounts.get(sessionId)
    if (inflight) return inflight

    // 先声明再赋值：IIFE 内部要用 mounting 做「还是不是当前这次挂载」的判断
    let mounting!: Promise<SFTPWrapper>
    // eslint-disable-next-line prefer-const -- 唯一赋值必须晚于声明，IIFE 内要比对自身引用
    mounting = (async (): Promise<SFTPWrapper> => {
      // 会话可能仍在握手（连接瞬间就打开了文件树）—— 等到 connected 再挂载，
      // 否则会在未连接的占位客户端上直接失败
      await sessionManager.waitUntilReady(sessionId)
      const client = sessionManager.getClient(sessionId)
      if (!client) throw new Error('会话不存在或已断开，请先打开 SSH 连接')

      /*
       * 挂载必须带超时。
       *
       * client.sftp 的 promise 只由回调兑现，而 ssh2 在某些服务器/两种并发挂载
       * 撞车时会**既不回调也不报错**（请求包发出去就没了）。没有超时的话这个
       * promise 永远挂着，调用方 await 住 —— 界面上文件面板一直转圈，
       * 连重试按钮都点不动（因为封面上写着 loading）。
       */
      /*
       * 超时之后的迟到结果是**孤儿**：调用方已经放弃，没人会去 end 它。
       * 不主动 end 的话这条 SFTP 通道连同底下的 shell 会一直挂在连接上，
       * 每次点重试就多漏一条，直到用户关标签为止。
       */
      let timedOut = false
      const sftp = await withTimeout(
        new Promise<SFTPWrapper>((resolve, reject) => {
          client.sftp((err, wrapper) => {
            if (timedOut) {
              try {
                wrapper?.on('error', () => undefined)
                wrapper?.end()
              } catch {
                /* ignore */
              }
              reject(new Error('启动 SFTP 子系统超时'))
              return
            }
            if (err) reject(new Error(`无法启动 SFTP 子系统：${err.message}`))
            else resolve(wrapper)
          })
        }),
        SFTP_MOUNT_TIMEOUT_MS,
        '启动 SFTP 子系统'
      ).catch((e: unknown) => {
        timedOut = true
        throw e
      })

      /*
       * 迟到的挂载结果不能写进缓存。
       *
       * 握手期间用户关了标签（或会话断到重连上限），clearSession 已经把缓存清干净，
       * 而这条 promise 稍后才 resolve。无条件 set 等于给一个已经死掉的会话塞回一条
       * 还能用的通道：下次同名 sessionId 出现在别的连接上时，文件面板拿到的就是它。
       */
      if (
        sessionManager.statusOf(sessionId) !== 'connected' ||
        sessionManager.getClient(sessionId) !== client ||
        this.pendingMounts.get(sessionId) !== mounting
      ) {
        try {
          sftp.end()
        } catch {
          /* ignore */
        }
        throw new Error('会话已关闭，无法继续传输')
      }
      this.wrappers.set(sessionId, sftp)
      sftp.on('close', () => {
        if (this.wrappers.get(sessionId) === sftp) this.wrappers.delete(sessionId)
      })
      /*
       * 必须监听 error。
       *
       * ssh2 在协议层出错时是 `emit('error')` 紧接着 `destroy()`
       * （SFTP.js 里 sftp.emit('error', err); sftp.destroy()）。
       * 没有 error 监听会冒到进程级 uncaughtException 兜底 —— 那边只写 boot.log，
       * 既不会清 wrappers 缓存也不会清 homes 缓存。结果是这个会话后续所有
       * SFTP 调用都拿到已销毁的 wrapper，报 Channel not open，
       * 一直错到用户手动关标签为止。这里主动清缓存，下次调用自动重新挂载。
       */
      sftp.on('error', (err: Error) => {
        if (this.wrappers.get(sessionId) === sftp) this.clearSession(sessionId)
        void recordError({
          level: 'warn',
          source: 'sftp',
          title: 'SFTP 通道异常，已重置',
          detail: err.message
        })
      })
      return sftp
    })()

    this.pendingMounts.set(sessionId, mounting)
    try {
      return await mounting
    } finally {
      if (this.pendingMounts.get(sessionId) === mounting) this.pendingMounts.delete(sessionId)
    }
  }

  /**
   * 判定该会话该走哪种文件通道，并缓存结论。
   *
   * 判定顺序是有讲究的：**先试 SFTP**。绝大多数设备都有 sftp-server，
   * 先试就等于「零额外开销」；只有握手明确失败、且错误说明子系统不存在、
   * 且会话此刻确实是 connected 时，才用一条 echo 探针确认 shell 通道可用。
   *
   * 为什么要那条探针：BusyBox 设备的 exec 通道也可能被关掉（只留交互式 shell），
   * 不做验证就切过去，用户会在文件面板里看到一个空目录而不是一句「设备不支持」。
   * 探针失败时把原始 SFTP 错误原样抛出 —— 那才是用户该看到的真话。
   */
  async resolveBackend(sessionId: string): Promise<SftpBackendMode> {
    const cached = this.sessionModes.get(sessionId)
    if (cached) return cached

    const inflight = this.pendingMode.get(sessionId)
    if (inflight) return inflight

    // 同上：IIFE 内部要比对 resolving 自身
    let resolving!: Promise<SftpBackendMode>
    // eslint-disable-next-line prefer-const -- 唯一赋值必须晚于声明，IIFE 内要比对自身引用
    resolving = (async (): Promise<SftpBackendMode> => {
      try {
        await this.getSftp(sessionId)
        // 同上：挂载期间会话可能已换掉或断开，别把旧结论写给新会话
        if (
          this.pendingMode.get(sessionId) !== resolving ||
          sessionManager.statusOf(sessionId) !== 'connected'
        ) {
          throw new Error('会话已关闭，无法继续传输')
        }
        this.sessionModes.set(sessionId, 'sftp')
        return 'sftp'
      } catch (err) {
        if (!isSftpSubsystemUnavailableError(err)) throw err
        // 会话已经掉了：那不是「设备没有 sftp-server」，是网断了，原样抛
        if (sessionManager.statusOf(sessionId) !== 'connected') throw err
        const client = sessionManager.getClient(sessionId)
        if (!client) throw err
        const probe = await execCollect(client, 'echo __SWB_SH_OK__', 5000)
        const usable =
          probe.status === 'done' &&
          probe.exitCode === 0 &&
          probe.stdout.includes('__SWB_SH_OK__')
        if (!usable) throw err
        /*
         * 结论落缓存前复核：探针要跑几百毫秒，这期间会话可能已经断开并
         * 重连到同一个 sessionId 上。把「旧连接只支持 shell」写进新会话的缓存，
         * 新会话就会被永久降级 —— 直到用户手动关标签。
         */
        if (
          this.pendingMode.get(sessionId) !== resolving ||
          sessionManager.statusOf(sessionId) !== 'connected' ||
          sessionManager.getClient(sessionId) !== client
        ) {
          throw err
        }
        this.sessionModes.set(sessionId, 'shell')
        this.onMode?.({ sessionId, mode: 'shell' })
        return 'shell'
      }
    })()

    this.pendingMode.set(sessionId, resolving)
    try {
      return await resolving
    } finally {
      if (this.pendingMode.get(sessionId) === resolving) this.pendingMode.delete(sessionId)
    }
  }

  /**
   * 取 shell 通道要用的 Client。
   *
   * 与 getSftp 一样先等会话 ready，但不能复用它的缓存：Client 在重连后会换成
   * 新对象，抓住旧的只会在断线后一路报「Channel is not open」。
   */
  private async shellClient(sessionId: string): Promise<Client> {
    await sessionManager.waitUntilReady(sessionId)
    const client = sessionManager.getClient(sessionId)
    if (!client) throw new Error('会话不存在或已断开，请先打开 SSH 连接')
    return client
  }

  /** 出错后使缓存的通道失效（例如会话已断开） */
  private invalidate(sessionId: string): void {
    this.clearSession(sessionId)
  }

  /**
   * 断线后把 SFTP 通道重新拿回来（续传的「恢复」钩子）。
   *
   * 这里的时序是这个功能能work的关键：链路断掉时 sessionManager 会走自己的
   * 自动重连（退避 1s/2s/4s…，最多 autoReconnectMax 次）。如果 SFTP 侧等都不等
   * 就反复 getSftp，拿到的永远是「会话已断开」，重试次数会被白烧掉。
   * 所以：先丢掉坏通道 → 轮询会话状态，等它回到 connected → 再挂载。
   *
   * 会话状态彻底掉了（用户关了标签、断线超过重连上限）时立刻抛，
   * 让上层把文件任务落到 error，而不是在这里空转到 90 秒。
   */
  private async recoverChannel(sessionId: string): Promise<SFTPWrapper> {
    this.invalidate(sessionId)
    const deadline = Date.now() + RECOVER_DEADLINE_MS
    for (;;) {
      const status = sessionManager.statusOf(sessionId)
      if (status === 'connected') break
      /*
       * 顺序很关键：先判「还能等」，只有真的没人会恢复它时才抛。
       *
       * teardown 在调度重连前就把 record 从 sessions 删了，所以整个退避期间
       * statusOf() 都是 undefined。原实现把 `status === undefined` 当成
       * 「会话已关闭」挡在最前面，于是断线第一轮轮询就抛错退出 ——
       * 后面这句 isReconnecting 判断成了永远走不到的死代码，
       * 断点续传在一次网络闪断后就必然失败。
       */
      if (sessionManager.isReconnecting(sessionId) || status === 'connecting') {
        if (Date.now() > deadline) {
          throw new Error('等待重连超时，请检查网络后重试')
        }
        await sleep(RECOVER_POLL_MS)
        continue
      }
      /*
       * 既不在重连、也不是 connecting：说明自动重连已放弃、用户关了标签，
       * 或压根没开自动重连。再等下去就是干耗，把原因直接抛给用户。
       */
      throw new Error(
        status === undefined
          ? '会话已关闭，无法继续传输'
          : '连接已断开且未能自动重连，请检查网络后重试'
      )
    }
    return this.getSftp(sessionId)
  }

  /* ------------------------------ 目录与文件 ------------------------------ */

  async home(sessionId: string): Promise<string> {
    const cached = this.homes.get(sessionId)
    if (cached) return cached
    const mode = await this.resolveBackend(sessionId)
    let abs: string
    if (mode === 'shell') {
      // shell 通道没有 realpath：pwd 就是登录后的 home，语义等价
      abs = await shellHome(await this.shellClient(sessionId))
    } else {
      const sftp = await this.getSftp(sessionId)
      abs = await pRealpath(sftp, '.').catch((err: unknown) => {
        throw new Error(`无法获取远端主目录：${err instanceof Error ? err.message : String(err)}`)
      })
    }
    this.homes.set(sessionId, abs)
    return abs
  }

  /**
   * 预挂载 SFTP 子系统（方案 B）。
   *
   * 首次点开文件面板时，getSftp() 要单独做一次 client.sftp() 握手，
   * 真实服务器上常见 200~800ms，而且这次握手与随后的 readdir 是串行的 ——
   * 用户看到的就是「点了要等一会」。
   *
   * SSH 连接建立后立刻在后台预热，把这段时间提前吃掉；同时把 home 也解析好，
   * 打开面板时直接命中缓存。失败静默：预热只是优化，不该影响连接主流程。
   */
  async prewarm(sessionId: string): Promise<void> {
    try {
      // 后端判定放在预热里做：真机上一次 sftp 握手失败要 300~800ms，
      // 提前吃掉，用户点开文件面板时不会再卡一下才降级。
      await this.resolveBackend(sessionId)
      // 顺手解析 home，打开面板时不用再等一次 realpath
      await this.home(sessionId)
    } catch {
      /* 预热失败不影响主流程，后续按需挂载即可 */
    }
  }

  async list(sessionId: string, dir: string): Promise<RemoteFile[]> {
    const mode = await this.resolveBackend(sessionId)
    if (mode === 'shell') {
      return shellList(await this.shellClient(sessionId), dir)
    }
    const sftp = await this.getSftp(sessionId)
    try {
      return toRemoteFiles(dir, await pReaddir(sftp, dir))
    } catch (err) {
      /*
       * 只有「通道本身坏了」才作废重挂。
       * ssh2 的 SFTP 状态错误带数字 code（2=不存在、3=没权限），那是目录的问题；
       * 以前一律 invalidate，结果一个没权限的目录让整条通道作废，
       * 下一个请求要重新握手（几百毫秒）—— 用户感知就是「刷新很慢」。
       * listMany 的判定本来就是对的，这里对齐。
       */
      if (typeof (err as { code?: unknown }).code !== 'number') this.invalidate(sessionId)
      throw new Error(`读取目录失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /**
   * 批量列多个目录（一次 IPC）。
   *
   * 为什么要这个：目录树展开时渲染层原本是「一个目录一条 IPC」，主进程这边
   * 每个请求都要 getSftp → 排队到 Electron IPC 的微任务队列里，再单发一条
   * readdir。N 个目录就是 N 次串行的「渲染→主进程→远端→渲染」调度往返，
   * 而 SFTP 通道本身是可以并行多个 outstanding request 的 —— 卡在调度，不是卡在带宽。
   *
   * 这里在同一个 wrapper 上把 N 条 readdir 一起发出去（并发上限
   * LIST_MANY_CONCURRENCY，避免打爆老设备的 sftp 请求队列），单条失败不拖垮整批，
   * 用 errors 把失败的目录单独带回去让渲染层显示「读取失败」而不是整棵树空白。
   */
  async listMany(
    sessionId: string,
    dirs: string[]
  ): Promise<{ dirs: Record<string, RemoteFile[]>; errors: Record<string, string> }> {
    const mode = await this.resolveBackend(sessionId)
    if (mode === 'shell') {
      // shell 侧自带并发池（SHELL_LIST_CONCURRENCY），语义与这里一致
      return shellListMany(await this.shellClient(sessionId), dirs)
    }
    const sftp = await this.getSftp(sessionId)
    const dirsOut: Record<string, RemoteFile[]> = {}
    const errors: Record<string, string> = {}
    const queue = [...new Set(dirs)]
    /*
     * 只有「通道本身坏了」才作废重挂：ssh2 的 SFTP 状态错误带数字 code（2=不存在、
     * 3=没权限），那是单个目录的问题。以前按「一个都没读成」来判断，展开一个全是
     * 无权限目录的父目录时整条通道被拆掉重连，用户感知就是面板卡几百毫秒。
     */
    let channelBroken = false

    const worker = async (): Promise<void> => {
      for (;;) {
        const dir = queue.shift()
        if (dir === undefined) return
        try {
          dirsOut[dir] = toRemoteFiles(dir, await pReaddir(sftp, dir))
        } catch (err) {
          if (typeof (err as { code?: unknown }).code !== 'number') channelBroken = true
          errors[dir] = err instanceof Error ? err.message : String(err)
        }
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(LIST_MANY_CONCURRENCY, queue.length) }, () => worker())
    )
    if (channelBroken) this.invalidate(sessionId)
    return { dirs: dirsOut, errors }
  }

  /**
   * 首次打开文件面板的「一次往返」引导。
   *
   * 旧链路是三步串行：sftp.home() 等 realpath → 渲染层 setState → 下一轮 effect
   * 再发 sftp.list()。等于用户点开的瞬间要等两个 RTT，而第二个 RTT 完全是
   * 因为渲染层必须先知道 home 才能发请求 —— 是纯粹的调度等待。
   *
   * 这里在主进程里把 realpath 和 readdir 连着做完，一次 IPC 返回，
   * 渲染层拿到就能直接上屏。
   */
  async bootstrap(sessionId: string): Promise<{ home: string; files: RemoteFile[] }> {
    const mode = await this.resolveBackend(sessionId)
    if (mode === 'shell') {
      const client = await this.shellClient(sessionId)
      const home = await this.home(sessionId)
      return { home, files: await shellList(client, home) }
    }
    const sftp = await this.getSftp(sessionId)
    const home = await this.home(sessionId)
    try {
      return { home, files: toRemoteFiles(home, await pReaddir(sftp, home)) }
    } catch (err) {
      throw new Error(`读取目录失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  async mkdir(sessionId: string, path: string): Promise<void> {
    const mode = await this.resolveBackend(sessionId)
    if (mode === 'shell') {
      // recursive=false 与 sftp.mkdir 的语义对齐：目标已存在时报错，而不是静默成功
      await shellMkdir(await this.shellClient(sessionId), path, false)
      return
    }
    const sftp = await this.getSftp(sessionId)
    await pMkdir(sftp, path).catch((err: unknown) => {
      throw new Error(`创建目录失败：${err instanceof Error ? err.message : String(err)}`)
    })
  }

  /** 递归删除（文件或目录） */
  async remove(sessionId: string, path: string): Promise<void> {
    // 两个通道都从这里进：根目录一律拒，和 shell 侧的 assertSafeRemovePath 对齐
    if (isRemoteRoot(path)) throw new Error('不能删除远端根目录')
    const mode = await this.resolveBackend(sessionId)
    if (mode === 'shell') {
      // shellRemove 内部先过 assertSafeRemovePath：rm -rf 的路径必须自己校验
      await shellRemove(await this.shellClient(sessionId), path)
      return
    }
    const sftp = await this.getSftp(sessionId)
    await this.removeRecursive(sftp, path)
  }

  /**
   * 递归删除（文件、目录或符号链接）。
   *
   * 两条硬规则：
   * 1. 判型必须用 lstat。用 stat 会跟随链接，删一个指向 /var/www 的软链等于
   *    递归清空目标目录 —— 用户以为删的是「一个快捷方式」。
   * 2. 链接一律只 unlink 链接本身，绝不进入。进不去，就没有「删到链接外面」的可能。
   *
   * depth 上限防的是目录环（bind mount / NFS 自引用 / 恶意服务端构造的循环）。
   * 环在路径上表现为无限加深，深度封顶就能自己停下来，不用维护已访问集合。
   */
  private async removeRecursive(sftp: SFTPWrapper, path: string, depth = 0): Promise<void> {
    if (depth > MAX_REMOVE_DEPTH) {
      throw new Error(`目录层级超过 ${MAX_REMOVE_DEPTH} 层，疑似存在目录环，已中止删除`)
    }
    const st = await pLstat(sftp, path)
    if (st.isSymbolicLink()) {
      await pUnlink(sftp, path, false)
      return
    }
    if (st.isDirectory()) {
      const entries = await pReaddir(sftp, path)
      for (const e of entries) {
        await this.removeRecursive(sftp, joinRemote(path, e.filename), depth + 1)
      }
      await pUnlink(sftp, path, true)
    } else {
      await pUnlink(sftp, path, false)
    }
  }

  async rename(sessionId: string, from: string, to: string): Promise<void> {
    const mode = await this.resolveBackend(sessionId)
    if (mode === 'shell') {
      await shellRename(await this.shellClient(sessionId), from, to)
      return
    }
    const sftp = await this.getSftp(sessionId)
    await pRename(sftp, from, to)
  }

  async chmod(sessionId: string, path: string, mode: number): Promise<void> {
    const backend = await this.resolveBackend(sessionId)
    if (backend === 'shell') {
      await shellChmod(await this.shellClient(sessionId), path, mode)
      return
    }
    const sftp = await this.getSftp(sessionId)
    await pChmod(sftp, path, mode).catch((err: unknown) => {
      throw new Error(`修改权限失败：${err instanceof Error ? err.message : String(err)}`)
    })
  }

  /* ------------------------------ 远程编辑 ------------------------------ */

  /**
   * 读取远程文本文件。
   *
   * 返回值带编码：写回时必须用同一种编码，否则一个 GBK 的 nginx.conf
   * 存一次就变成满屏问号，中文注释永久丢失（旧实现就是这个行为）。
   */
  async readText(sessionId: string, path: string): Promise<RemoteText> {
    /*
     * shell 模式下没有 readFile：用 wc -c 先探大小（超限就不 cat，避免把
     * 一个 500 MB 的日志整体拉进内存），再用 cat 收原始字节，编码探测仍走
     * 与 SFTP 分支同一个 detectTextEncoding —— 两条通道的判定必须完全一致，
     * 否则同一个 GBK 文件在降级前后会被判成不同编码。
     */
    if ((await this.resolveBackend(sessionId)) === 'shell') {
      return shellReadText(
        await this.shellClient(sessionId),
        path,
        detectTextEncoding,
        EDIT_SIZE_LIMIT
      )
    }
    const sftp = await this.getSftp(sessionId)
    const st = await pLstat(sftp, path)
    if (st.isSymbolicLink()) {
      // 链接是「指路牌」，编辑器把它当成普通文件保存会把链接换成普通文件
      const target = await pStat(sftp, path)
      if (target.size > EDIT_SIZE_LIMIT) {
        throw new Error(
          `文件过大（${(target.size / 1048576).toFixed(1)} MB），请下载到本地后再编辑（上限 2 MB）`
        )
      }
    } else if (st.size > EDIT_SIZE_LIMIT) {
      throw new Error(
        `文件过大（${(st.size / 1048576).toFixed(1)} MB），请下载到本地后再编辑（上限 2 MB）`
      )
    }
    const buf = await pReadFile(sftp, path).catch((err: unknown) => {
      throw new Error(`读取失败：${err instanceof Error ? err.message : String(err)}`)
    })
    if (buf.includes(0) && !(buf[0] === 0xff && buf[1] === 0xfe) && !(buf[0] === 0xfe && buf[1] === 0xff)) {
      throw new Error('该文件看起来是二进制文件，无法以文本方式编辑')
    }
    return detectTextEncoding(buf)
  }

  /**
   * 保存远程文本：原文件先备份为 <path>.bak，再原地截断写入。
   *
   * 这里刻意不用「先 rename 成 .bak 再写新文件」的老做法：那等于把原文件
   * 变成一个新建文件 —— 符号链接被替换成普通文件、权限从 0600 掉到默认 0644、
   * owner 和 SELinux 标签全丢。原地 open('w') 写只改内容，元数据一个不动。
   * 代价是写入过程不是原子的（中途失败会留下半截），所以失败时从 .bak 回滚。
   */
  async writeText(
    sessionId: string,
    path: string,
    content: string,
    encoding: TextEncoding = 'utf-8'
  ): Promise<void> {
    /*
     * shell 模式：shellWriteText 内部按同一套承诺行事（先 cp 一份 <path>.swb-bak，
     * 用 cat > 截断写入，失败时从备份回滚）。差别只在备份文件名 —— SFTP 侧用
     * .bak，shell 侧用 .swb-bak，避免两套实现互相踩到对方留下的备份。
     */
    if ((await this.resolveBackend(sessionId)) === 'shell') {
      await shellWriteText(await this.shellClient(sessionId), path, encodeText(content, encoding))
      return
    }
    const sftp = await this.getSftp(sessionId)

    /*
     * 备份原文件（若存在）。
     *
     * 这里必须把「目标不存在」和「备份失败」分开：
     * 原实现用一个 try 把 pStat / pUnlink / pRename 全包住，服务器拒绝 rename
     * （权限不足、只读挂载、文件被占）会被当成「目标不存在」默默跳过，
     * 然后直接覆盖写入 —— 原内容再无备份，与「先备份」的承诺相反。
     * 现在 pStat 失败才算「不存在」，pRename 失败直接中止，
     * 并把 rename 成成的 .bak 在写入失败时回滚，避免 path 位置留下半截新内容。
     */
    let backedUp = false
    const bak = `${path}.bak`
    const existed = await pStat(sftp, path).then(
      () => true,
      () => false
    )
    /*
     * 备份用「复制一份」而不是「改名」：改名会把符号链接换成普通文件、
     * 把原文件从 path 位置上挪走，写入一旦失败就只剩回滚这一条路。
     * 复制的话原文件始终在原地，备份只是一份副本，写失败也不会毁掉原文件。
     */
    let original: Buffer | null = null
    if (existed) {
      original = await pReadFile(sftp, path).catch((err: unknown) => {
        throw new Error(`读取原文件失败：${err instanceof Error ? err.message : String(err)}`)
      })
      try {
        await pUnlink(sftp, bak, false)
      } catch {
        /* 旧备份不存在，正常 */
      }
      try {
        await pWriteFile(sftp, bak, original)
        backedUp = true
      } catch (err) {
        // 备份失败就直接中止：没有备份的覆盖写入是不可挽回的
        throw new Error(
          `无法备份原文件（${err instanceof Error ? err.message : String(err)}），已中止写入以免丢失内容`
        )
      }
    }

    const buf = encodeText(content, encoding)
    try {
      await pWriteFile(sftp, path, buf)
    } catch (err) {
      // 写入失败：从备份恢复原内容，别让 path 位置留下半截文件
      if (backedUp && original) {
        const restore = original
        await pWriteFile(sftp, path, restore).catch(() => undefined)
      }
      throw err
    }
  }

  /* ------------------------------ 传输 ------------------------------ */

  /**
   * 上传一批本地路径（文件或目录）。
   *
   * @param options.keepRoot 目录项是否保留本地目录名本身：
   *   - true  → 目标目录/本地目录名/...（「上传文件夹」的直觉语义）
   *   - false → 把本地目录的内容铺进目标目录（历史拖拽语义，保持不变）
   */
  upload(
    sessionId: string,
    localPaths: string[],
    remoteDir: string,
    options: { keepRoot?: boolean; force?: boolean } = {}
  ): string[] {
    const keepRoot = options.keepRoot === true
    // 强制全量：忽略「远端已是最新」的跳过判据（用户明确要求重传时用）
    const force = options.force === true
    const taskIds: string[] = []
    for (const localPath of localPaths) {
      const taskId = randomUUID()
      taskIds.push(taskId)
      const remotePath = joinRemote(remoteDir, basename(localPath))
      this.enqueue(
        async (ctl, hooks) => {
          /*
           * 上传前先定后端：sftp 子系统缺失的设备在 shell 通道上用
           * cat > <part> && mv -f 流式写，语义与 SFTP 侧一致（先落中转再原子替换），
           * 只是没有「远端已是最新就跳过」的判据 —— BusyBox 的 ls 时间精度
           * 不足以做秒级比较，宁可重传也不能漏传。
           */
          if ((await this.resolveBackend(sessionId)) === 'shell') {
            const client = await this.shellClient(sessionId)
            const st = await fs.stat(localPath).catch(() => null)
            if (st?.isDirectory()) {
              await transferUploadShellDir(client, ctl, taskId, (e) => this.emit(e))
            } else {
              await transferUploadShell(client, ctl, taskId, (e) => this.emit(e))
            }
            return
          }
          const sftp = await this.getSftp(sessionId)
          const st = await fs.stat(localPath).catch(() => null)
          if (st?.isDirectory()) {
            await transferUploadDir(sftp, ctl, taskId, (e) => this.emit(e), hooks)
          } else {
            await transferUpload(sftp, ctl, taskId, (e) => this.emit(e), hooks)
          }
        },
        sessionId,
        taskId,
        'upload',
        localPath,
        remotePath,
        keepRoot,
        force
      )
    }
    return taskIds
  }

  /**
   * 扫描待上传的本地目录：文件数 / 总字节数 / 一级条目。
   *
   * 选完文件夹后立刻给出「N 个文件、共 X MB、会新建哪些目录」，
   * 比直接扔进队列让用户盯着一个没有总量的进度条要好得多；
   * 也顺手把「空目录」这种情况提前暴露出来（否则上传会建一堆空目录）。
   */
  async scanFolders(
    localPaths: string[]
  ): Promise<{ totalFiles: number; totalBytes: number; items: UploadScanItem[] }> {
    const items: UploadScanItem[] = []
    let totalFiles = 0
    let totalBytes = 0
    for (const p of localPaths) {
      const st = await fs.stat(p).catch(() => null)
      if (!st) continue
      if (!st.isDirectory()) {
        items.push({ localPath: p, name: basename(p), isDir: false, files: 1, bytes: st.size })
        totalFiles += 1
        totalBytes += st.size
        continue
      }
      const files = await walkLocal(p, SCAN_FILE_LIMIT)
      /*
       * 并发 stat：2 万文件串行 await 是 2 万次「等一次磁盘/网络往返」，
       * 用户选完文件夹后要干等十几秒才看到「N 个文件、共 X MB」。
       * 这里的量级是本地 stat，用 LIST_MANY_CONCURRENCY 复用同一个常量，
       * 不必为一个纯 IO 累加再发明一个新数字。
       */
      let bytes = 0
      let cursor = 0
      const workers = Array.from({ length: Math.min(LIST_MANY_CONCURRENCY, files.length) }, async () => {
        for (;;) {
          const idx = cursor
          cursor += 1
          const f = files[idx]
          if (!f) return
          const s = await fs.stat(f.full).catch(() => null)
          if (s) bytes += s.size
        }
      })
      await Promise.all(workers)
      items.push({
        localPath: p,
        name: basename(p),
        isDir: true,
        files: files.length,
        bytes,
        // 命中上限：数字是下限，UI 提示「至少」
        truncated: files.length >= SCAN_FILE_LIMIT
      })
      totalFiles += files.length
      totalBytes += bytes
    }
    return { totalFiles, totalBytes, items }
  }

  download(sessionId: string, remotePaths: string[], localDir: string): string[] {
    const taskIds: string[] = []
    /*
     * 目标路径占位用实例级的集合，而不是每批一个新的 Set：
     * 跨批次的重名（先后两次下载同名文件，前者还在传）同样要挡住，
     * 见 activeDownloadTargets 的注释。占位在 enqueue 的 finally 里释放。
     */
    const allocated = this.activeDownloadTargets
    for (const remotePath of remotePaths) {
      const taskId = randomUUID()
      taskIds.push(taskId)
      /*
       * 重名保护：target 在排队时就定下来，不能等真正下载时再算。
       * 并发下若等到执行时才算，两个同名文件会算出同一个候选路径。
       * 目录下载（isDir）保留用户指定的目录名，重名时同样加序号，
       * 避免把两个同名目录的内容合并到一处。
       */
      /*
       * 远端文件名是攻击者可控输入，必须净化后再落到本地。
       * assertRemotePath 只按 / 分段查 ..，放行 "/tmp/..\.."、"access.log:1"
       * （NTFS 数据流）、"CON"、"foo." —— Windows 上 basename("/tmp/..\..")
       * 就是 ".."，join 之后直接逃出 localDir。与目录下载共用同一套净化。
       */
      const safeName = safeRelativeSegments(basename(remotePath)).pop() || 'download'
      const localPath = uniqueLocalPath(localDir, safeName, allocated)
      this.enqueue(
        async (ctl, hooks) => {
          // 下载侧同理：shell 后端先探一次远端类型，再决定单文件还是整个目录
          if ((await this.resolveBackend(sessionId)) === 'shell') {
            const client = await this.shellClient(sessionId)
            const kind = await shellKindOf(client, remotePath)
            if (kind === 'directory') {
              await transferDownloadShellDir(client, ctl, taskId, (e) => this.emit(e))
            } else {
              await transferDownloadShell(client, ctl, taskId, (e) => this.emit(e))
            }
            return
          }
          const sftp = await this.getSftp(sessionId)
          const st = await pStat(sftp, remotePath).catch(() => null)
          if (st?.isDirectory()) {
            await transferDownloadDir(sftp, ctl, taskId, (e) => this.emit(e), hooks)
          } else {
            await transferDownload(sftp, ctl, taskId, (e) => this.emit(e), hooks)
          }
        },
        sessionId,
        taskId,
        'download',
        localPath,
        remotePath
      )
    }
    return taskIds
  }

  /** 注册任务并按并发度调度（暂停/继续/取消都靠 controls 里的控制块） */
  private enqueue(
    build: (ctl: TransferControl, hooks: ResumeHooks) => Promise<void>,
    sessionId: string,
    taskId: string,
    direction: 'upload' | 'download',
    localPath: string,
    remotePath: string,
    keepRoot = false,
    force = false
  ): void {
    const ctl: TransferControl = {
      sessionId,
      direction,
      localPath,
      remotePath,
      transferred: 0,
      total: 0,
      unit: 'bytes',
      paused: false,
      cancelled: false,
      halt: false,
      keepRoot,
      holding: false,
      force,
      waiters: []
    }
    /*
     * 把闸门的取/放注入控制块，供 checkpoint 在「暂停后继续」时重新排队。
     * 用闭包而不是让 checkpoint 直接碰 SftpManager：checkpoint 是模块级
     * 纯函数，分块引擎（上传/下载）都在它外面，不该为了一个并发位反向依赖实例。
     */
    ctl.acquire = async () => {
      await this.acquire()
      ctl.holding = true
    }
    ctl.release = () => {
      if (!ctl.holding) return
      ctl.holding = false
      this.release()
    }
    this.controls.set(taskId, ctl)
    /*
     * 身份快照在**入队**这一刻取。
     *
     * 不能在收尾时再查 sessionManager：会话关掉之后 list() 里已经没有它，
     * 记录会变成「未知连接」；而 sessionId 每次启动都重新生成，重启后也 join 不回来。
     * 这里只取一次，后续所有落盘都用这份快照。
     */
    const session = sessionManager.list().find((s) => s.id === sessionId)
    const identity = {
      connectionId: session?.connectionId,
      connectionName: session?.connectionName,
      target: session?.target,
      /*
       * sessionId 也带上，但只给面板回查实时进度用 —— 它不是身份，
       * 上面三个快照字段才是。两者混用会在重启后 join 出「未知连接」。
       */
      sessionId
    }
    /** 只在状态跃迁时落盘（进度事件一律不写，见 transferRecord 的注释） */
    const finish = (event: TransferProgressEvent): void => {
      if (event.status !== 'done' && event.status !== 'error' && event.status !== 'canceled') {
        this.emit(event)
        return
      }
      /*
       * 收尾事件本身不带 note（它是目录遍历结束时才有的话），
       * 必须从控制块补上。UI 与落盘用同一份：旧实现只给 recordFromEvent 补，
       * 渲染层拿到的 done 事件没有 note —— 用户看不到「跳过 N 个链接」，
       * 刷新历史记录后又突然出现，像是两条不同结果。
       */
      const finalEvent = event.note ? event : { ...event, note: ctl.note }
      this.emit(finalEvent)
      void recordFromEvent(finalEvent, identity)
    }
    this.emit({ ...this.baseEvent(ctl, taskId), status: 'pending' })
    void recordFromEvent(
      { ...this.baseEvent(ctl, taskId), status: 'pending' },
      identity
    )

    const run = async (): Promise<void> => {
      // 排队期间就被取消：不占并发位，直接落终态并释放下载占位
      if (ctl.cancelled) {
        this.controls.delete(taskId)
        ctl.abortStream = undefined
        if (ctl.direction === 'download') this.activeDownloadTargets.delete(ctl.localPath)
        finish({ ...this.baseEvent(ctl, taskId), status: 'canceled' })
        return
      }
      await this.acquire()
      ctl.holding = true
      /*
       * 传给分块引擎的两个钩子：
       * - recover：断线后重新挂通道（内部会等会话自己重连回来）；
       * - notify：把「正在重连续传」写进任务的 note，UI 直接显示，
       *   不需要新增 status 枚举（那会波及 6 处状态判定点）。
       */
      const hooks: ResumeHooks = {
        recover: () => this.recoverChannel(sessionId),
        notify: (note) => this.emit(eventOf(ctl, taskId, 'running', { note }))
      }
      try {
        /*
         * 拿到并发位之后再走一次暂停点：排队期间可能已经被取消或暂停，
         * 旧实现直接开干，于是「已取消」的目录任务照样把远端目录建完再报 done。
         */
        await checkpoint(ctl)
        await build(ctl, hooks)
        finish({ ...this.baseEvent(ctl, taskId), status: 'done' })
      } catch (err) {
        if (err instanceof TransferCancelledError) {
          finish({ ...this.baseEvent(ctl, taskId), status: 'canceled' })
        } else if (err instanceof TransferAbortedError) {
          finish({
            ...this.baseEvent(ctl, taskId),
            status: 'error',
            error: '传输已中断'
          })
        } else if (err instanceof TransferPartialError) {
          // 结构化的逐文件失败：error 留人读的摘要，failures 交给记录层聚合
          finish({
            ...this.baseEvent(ctl, taskId),
            status: 'error',
            error: err.message,
            failures: err.failures
          })
        } else {
          finish({
            ...this.baseEvent(ctl, taskId),
            status: 'error',
            error: err instanceof Error ? err.message : String(err)
          })
        }
      } finally {
        this.controls.delete(taskId)
        ctl.abortStream = undefined
        // 走 ctl.release：暂停期间已经让出过位，这里不能再减一次
        ctl.release?.()
        // 仅释放下载占位，避免上传任务误删同名在途下载的占位
        if (ctl.direction === 'download') this.activeDownloadTargets.delete(ctl.localPath)
      }
    }
    void run()
  }

  /** 并发闸门：同时最多 MAX_CONCURRENT_TRANSFERS 个任务 */
  private acquire(): Promise<void> {
    if (this.running < MAX_CONCURRENT_TRANSFERS) {
      this.running += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.running += 1
        resolve()
      })
    })
  }

  private release(): void {
    this.running = Math.max(0, this.running - 1)
    const next = this.waiters.shift()
    if (next) next()
  }

  private baseEvent(
    ctl: TransferControl,
    taskId: string
  ): Omit<TransferProgressEvent, 'status'> {
    return {
      taskId,
      sessionId: ctl.sessionId,
      direction: ctl.direction,
      localPath: ctl.localPath,
      remotePath: ctl.remotePath,
      transferred: ctl.transferred,
      total: ctl.total,
      unit: ctl.unit
    }
  }

  private emit(event: TransferProgressEvent): void {
    this.onProgress?.(event)
  }
}

/* ------------------------------ 分块传输引擎 ------------------------------ */

/**
 * 单文件以「open → 批量 read/write → close」方式传输。
 *
 * 为什么不用 fastGet/fastPut：那是一次性调用，只有 step 回调，没有任何中断句柄，
 * 暂停/终止无从下手。这里在每批分块之间调用 checkpoint(ctl)，暂停时原地等待，
 * 取消时抛 TransferCancelledError，随后清理半截文件。
 *
 * 一批 = CHUNK_INFLIGHT 个 CHUNK_SIZE 块（≈1.5MB），吞吐接近 fastGet，中断粒度可接受。
 */

function eventOf(
  ctl: TransferControl,
  taskId: string,
  status: TransferTask['status'],
  extra: Partial<TransferProgressEvent> = {}
): TransferProgressEvent {
  return {
    taskId,
    sessionId: ctl.sessionId,
    direction: ctl.direction,
    localPath: ctl.localPath,
    remotePath: ctl.remotePath,
    transferred: ctl.transferred,
    total: ctl.total,
    unit: ctl.unit,
    status,
    ...extra
  }
}

/**
 * 上传单个文件（本地 → 远端），返回实际写入字节数。
 *
 * 断线续传（这是本函数的全部复杂度来源）：
 * - 远端已落盘的字节数由「远端文件实际大小」决定，不由内存里的计数决定；
 * - 每次续接前用尾部 64KB 指纹比对，防止远端那个文件已经被别人换掉；
 * - 断线时**绝不删远端文件**（旧实现 failure → unlink，导致已传的几十 MB 白费）；
 * - 只有放弃重试 / 用户取消时才清理半截文件。
 */
async function uploadFileChunked(
  sftp: SFTPWrapper,
  ctl: TransferControl,
  localPath: string,
  remotePath: string,
  onBytes: (transferred: number, total: number) => void,
  hooks?: ResumeHooks
): Promise<number> {
  const local = await fs.open(localPath, 'r')
  let conn = sftp
  let handle: Buffer | null = null
  let total = 0
  /*
   * pos   = 逻辑游标：已经发出去（或正在发）的字节数。
   * acked = 连续确认前缀：服务器确实回报成功、一定落了盘的字节数。
   *
   * 为什么必须分开：一个批次是 CHUNK_INFLIGHT 个并发 WRITE，完成顺序不确定。
   * 断链那一刻可能只有批次里靠后的几块落了盘，前面的块永远丢了。此时远端文件
   * 长度已经被写到批次末尾（SFTP 按偏移写，没写到的区域是零洞），fstat 得到的
   * remoteSize 与尾部指纹**都会给出"已经传到 pos"的假象** —— 于是续传从 pos 往
   * 后写，零洞永久留在文件中间：大小完全正确、sha256 全错（实测 24MB 断在 3.2MB
   * 处，中间 3.2–4.25MB 全是 0x00）。断线后只能信 acked。
   */
  let pos = 0
  let acked = 0
  let attempts = 0
  const deadline = Date.now() + RECOVER_DEADLINE_MS
  /*
   * 和下载侧对称：全程只写 <目标名>.part，全部写完才原子改名成目标名。
   *
   * 旧实现直接往最终名写。传到 90% 断网，远端留下一个大小正常的半截固件包，
   * 「文件存在」骗过了所有人和所有烧录工具。有了 .part，「目标名存在」才重新
   * 等于「内容完整」，续传起点也改成读 .part 的长度，不再去猜目标名的来历。
   */
  const partPath = partPathOf(remotePath)
  try {
    const st = await local.stat()
    total = st.size
    onBytes(pos, total)
    for (;;) {
      try {
        await checkpoint(ctl)
        /*
         * 续传：pos > 0 说明之前已经写过一段，必须用 'r+' 打开（不截断）。
         * 'w' 带 O_TRUNC，会让我们自己把已上传的部分清空 —— 这正是旧实现
         * 「断线后重试等于从头再来」的根因。
         */
        handle = await withTimeout(
          pOpen(conn, partPath, pos > 0 ? 'r+' : 'w').catch((err: unknown) => {
            /*
             * pos > 0 但 .part 已经不在了（设备重启清了 /tmp、被人清理过）：
             * 'r+' 会直接 ENOENT，一路抛成「打开远端文件失败」。从 0 重来即可。
             */
            if (pos === 0 || !isMissingEntry(err)) throw err
            pos = 0
            return pOpen(conn, partPath, 'w')
          }),
          META_TIMEOUT_MS,
          '打开远端文件'
        )
        if (pos > 0) {
          // 远端实际落了多长，才是唯一可信的续传起点
          const fst = await withTimeout(
            pFstat(conn, handle).catch(() => null),
            META_TIMEOUT_MS,
            '读取远端文件状态'
          )
          const remoteSize = fst && fst.isFile() ? fst.size : 0
          if (remoteSize < pos) {
            // 远端比我们以为的短：中间有洞，只能从头来
            pos = remoteSize
          }
          if (pos > 0) {
            const len = Math.min(FINGERPRINT_BYTES, pos)
            const [remoteTail, localTail] = await Promise.all([
              readRemoteTail(conn, handle, pos - len, len),
              readLocalChunk(localPath, pos - len, len)
            ])
            if (!remoteTail.equals(localTail)) {
              /*
               * 尾部对不上 → 远端那个同名文件不是我们写的（用户手动覆盖过、
               * 或者上一次传输写坏了）。继续按偏移写会把两份内容缝在一起，
               * 得到大小正确、内容错误的文件 —— 比报错危险得多，所以清零重来。
               */
              await pClose(conn, handle)
              handle = null
              handle = await withTimeout(
                pOpen(conn, partPath, 'w'),
                META_TIMEOUT_MS,
                '重新打开远端文件'
              )
              pos = 0
            }
          }
        }
        // 续传起点被 fstat / 指纹校正过，acked 必须跟着对齐，否则下一轮会退到旧值
        acked = pos
        onBytes(pos, total)
        while (pos < total) {
          await checkpoint(ctl)
          const batch: Array<{ pos: number; bytes: number; buf: Buffer }> = []
          for (let i = 0; i < CHUNK_INFLIGHT && pos < total; i += 1) {
            const len = Math.min(CHUNK_SIZE, total - pos)
            const buf = Buffer.allocUnsafe(len)
            const { bytesRead } = await local.read(buf, 0, len, pos)
            if (bytesRead <= 0) break
            batch.push({ pos, bytes: bytesRead, buf })
            pos += bytesRead
            if (bytesRead < len) break
          }
          if (batch.length === 0) break
          // 一批整写：任何一块超时都视为链路已死，交给外层重试续传。
          // 逐块回报 acked 时只能推进到「批内连续」的位置，见上面 acked 的注释。
          const doneFlags = new Array<boolean>(batch.length).fill(false)
          // 只把「从 acked 开始连续完成」的那些块算进去；中间缺一块就停在那里等它，
          // 因为缺的那块下面可能是零洞。
          const advance = () => {
            for (;;) {
              const i = batch.findIndex((c, k) => doneFlags[k] && c.pos === acked)
              if (i < 0) return
              acked += batch[i].bytes
              doneFlags[i] = false
            }
          }
          await withTimeout(
            Promise.all(
              batch.map((c, i) =>
                pWrite(conn, handle as Buffer, c.buf, 0, c.bytes, c.pos).then((res) => {
                  doneFlags[i] = true
                  advance()
                  return res
                })
              )
            ),
            CHUNK_TIMEOUT_MS,
            '上传分块'
          )
          onBytes(pos, total)
        }
        // 句柄必须先关：Windows / 部分 sftp-server 上未释放的句柄会让 rename 失败
        if (handle) {
          await pClose(conn, handle)
          handle = null
        }
        await commitRemotePart(conn, partPath, remotePath)
        // 对齐 mtime，让「目录重传跳过未变化文件」有判据可用
        await setRemoteMtime(conn, remotePath, st.atimeMs / 1000, st.mtimeMs / 1000)
        return pos
      } catch (err) {
        /*
         * 取消判据不能只看 err 的类型：取消通常落在某一批 pWrite 还在飞的时候，
         * 那一批会因为句柄被关掉而抛出「bad handle」之类的东西，而不是
         * TransferCancelledError。若照错误类型走重试分支，就会在用户按了取消之后
         * 又去重连、又用 'w' 重新打开文件 —— 远端于是凭空长出一个空文件。
         * 所以先看 ctl.cancelled 这个意图标志。
         */
        if (ctl.cancelled || err instanceof TransferCancelledError) {
          if (handle) await pClose(conn, handle)
          handle = null
          // 用户主动取消：远端半截文件留着只会让人误以为传过了，必须清掉。
          // 断线不属于这一类 —— 那是要继续的，清理只在真正放弃时发生。
          await discardRemote(conn, partPath)
          throw new TransferCancelledError()
        }
        if (err instanceof TransferAbortedError) {
          if (handle) await pClose(conn, handle)
          handle = null
          await discardRemote(conn, partPath)
          throw err
        }
        if (handle) {
          await pClose(conn, handle)
          handle = null
        }
        attempts += 1
        // 不可自愈的错误（权限、磁盘满…）立刻抛；可自愈的等重连后从 pos 续传
        if (!hooks || !isRetryable(err) || attempts > FILE_RETRY_MAX || Date.now() > deadline) {
          await discardRemoteOnFresh(conn, hooks, partPath)
          throw err
        }
        /*
         * 回退到连续确认前缀再续传。pos 里那些「发出去了但没被确认」的字节不能算：
         * 它们下面可能就是一个零洞。重发一遍只浪费带宽，写错内容才是真事故。
         */
        pos = Math.min(pos, acked)
        hooks.notify(
          `连接中断，正在重连后续传（第 ${attempts} 次，已完成 ${formatBytes(pos)} / ${formatBytes(total)}）`
        )
        try {
          conn = await hooks.recover()
        } catch (recoverErr) {
          /*
           * 恢复钩子的三条快速失败（会话已关闭 / 未自动重连 / 等待超时）是终态：
           * 以前 .catch(() => conn) 把它们吞掉，拿着死通道一路空转到重试上限，
           * 用户等满 8 轮才看到一句「通道未打开」。这里直接放弃并清掉半截文件。
           */
          await discardRemoteOnFresh(conn, hooks, partPath)
          throw recoverErr
        }
        /*
         * 重连成功后必须重新确认远端长度：恢复的那一次可能只写成了一半，
         * 而本地 pos 是「已提交给 socket」的字节，不等于「已落盘」的字节。
         * 交给下一轮 fstat 校正，这里只把句柄释放掉。
         */
        await sleep(RECOVER_POLL_MS)
      }
    }
  } finally {
    if (handle) await pClose(conn, handle)
    await local.close().catch(() => undefined)
  }
}

/**
 * 下载单个文件（远端 → 本地），返回实际写入字节数。
 *
 * 先写 <文件名>.part，全部写完再 rename 成最终名 —— 这一条是整个下载路径的
 * 正确性根基，不是优化：
 *
 * - 旧实现直接往最终文件名写。传到 90% 断网，用户打开文件管理器看到的是一个
 *   大小正常的 mp4，双击播放到 90% 就黑屏；固件包更糟 —— 烧录工具只校验长度，
 *   刷进去直接变砖，而「文件存在」这件事骗过了所有人。
 * - 有 .part 之后，「最终文件名存在」重新等于「内容完整」。检查完整性不再需要
 *   任何额外状态。
 * - 续传起点改为读 .part 的长度，不再读最终文件名 —— 最终名下的文件可能是
 *   用户自己的同名文件，绝不能拿它当「已下载进度」。
 *
 * 断线/失败一律保留 .part（下次同任务重试直接续上）；只有用户取消才删。
 */
async function downloadFileChunked(
  sftp: SFTPWrapper,
  ctl: TransferControl,
  remotePath: string,
  localPath: string,
  onBytes: (transferred: number, total: number) => void,
  hooks?: ResumeHooks
): Promise<number> {
  await fs.mkdir(dirname(localPath), { recursive: true })
  /*
   * 半成品一律落在 .part 上。续传起点只能读这个文件 ——
   * 读最终文件名等于把「用户自己的同名文件」当成「上次下了一半」，
   * 于是长度一样就当已下完直接跳过，长度不同就缝在一起。
   */
  const partPath = partPathOf(localPath)
  let conn = sftp
  let handle: Buffer | null = null
  let local: FileHandle | null = null
  let total = 0
  let pos = 0
  let attempts = 0
  const deadline = Date.now() + RECOVER_DEADLINE_MS
  try {
    for (;;) {
      try {
        await checkpoint(ctl)
        handle = await withTimeout(
          pOpen(conn, remotePath, 'r'),
          META_TIMEOUT_MS,
          '打开远端文件'
        )
        // stat 可能因权限失败，fstat 拿句柄更可靠；都拿不到就靠读到 EOF 定位总量
        const st = await withTimeout(
          pFstat(conn, handle).catch(() => null),
          META_TIMEOUT_MS,
          '读取远端文件状态'
        )
        total = st && st.isFile() ? st.size : 0
        /*
         * 续传起点 = .part 现有长度。首次进来没有 .part，existsSync 为假 → 0。
         * pos 只在「.part 确实装着远端这段内容」时才取正数，其余一律从头下。
         */
        let localSize = 0
        if (existsSync(partPath)) {
          const lst = await fs.stat(partPath).catch(() => null)
          localSize = lst && lst.isFile() ? lst.size : 0
        }
        if (localSize > 0 && (total === 0 || localSize <= total)) {
          const len = Math.min(FINGERPRINT_BYTES, localSize)
          const remoteAt = Math.max(0, localSize - len)
          const [remoteTail, localTail] = await Promise.all([
            readRemoteTail(conn, handle, remoteAt, len),
            readLocalChunk(partPath, localSize - len, len)
          ])
          pos = remoteTail.length === len && remoteTail.equals(localTail) ? localSize : 0
        } else {
          pos = 0
        }
        // pos > 0 才是真续传；否则截断重建，避免旧内容留在尾部
        // .part 在 stat 与 open 之间被清掉的情况：'r+' 报 ENOENT，退回从头下载
        local = await fs.open(partPath, pos > 0 ? 'r+' : 'w').catch((err: unknown) => {
          if (pos === 0 || !isMissingEntry(err)) throw err
          pos = 0
          return fs.open(partPath, 'w')
        })
        if (pos > 0) await local.truncate(pos).catch(() => undefined)
        onBytes(pos, total)
        while (total === 0 || pos < total) {
          await checkpoint(ctl)
          const pending: Array<
            Promise<{ pos: number; expected: number; bytes: number; buf: Buffer }>
          > = []
          for (let i = 0; i < CHUNK_INFLIGHT; i += 1) {
            const chunkPos = pos + i * CHUNK_SIZE
            if (total > 0 && chunkPos >= total) break
            const len = total > 0 ? Math.min(CHUNK_SIZE, total - chunkPos) : CHUNK_SIZE
            pending.push(
              readRemoteRange(conn, handle, len, chunkPos).then((buf) => ({
                pos: chunkPos,
                expected: len,
                bytes: buf.length,
                buf
              }))
            )
          }
          if (pending.length === 0) break
          /*
           * 不再在外面套一层 withTimeout：一批是 CHUNK_INFLIGHT 个块（≈1.5MB），
           * 16KB 包的服务端要走近百次串行 RTT，50 KB/s 的慢链路本来就超过 30s。
           * 单次 read 的超时由 readRemoteRange 内部逐个 pRead 兜着，够用且不会误杀。
           */
          const chunks = await Promise.all(pending)
          let eof = false
          for (const c of chunks) {
            if (c.bytes <= 0) {
              eof = true
              break
            }
            await local.write(c.buf, 0, c.bytes, c.pos)
            pos = c.pos + c.bytes
            onBytes(pos, total)
            // 短读 = 已到 EOF：再往下读只会写出零洞，必须立刻收尾
            if (c.bytes < c.expected) {
              eof = true
              break
            }
          }
          if (eof) break
        }
        /*
         * 写入句柄必须先关掉再 rename：Windows 上句柄未释放时 rename 会 EBUSY，
         * 而这一步失败意味着整个文件白下（.part 还在，但用户看不到成品）。
         */
        await closeLocalQuietly(local)
        local = null
        await commitPartFile(partPath, localPath)
        return pos
      } catch (err) {
        if (local) {
          await local.close().catch(() => undefined)
          local = null
        }
        if (handle) {
          await pClose(conn, handle)
          handle = null
        }
        // 与上传侧同理：取消往往表现为「句柄已关」，不能只看错误类型
        if (ctl.cancelled || err instanceof TransferCancelledError) {
          await silentUnlinkLocal(partPath)
          throw new TransferCancelledError()
        }
        if (err instanceof TransferAbortedError) {
          await silentUnlinkLocal(partPath)
          throw err
        }
        attempts += 1
        if (!hooks || !isRetryable(err) || attempts > FILE_RETRY_MAX || Date.now() > deadline) {
          // 放弃重试：保留 .part（下次同任务重试能续上），但绝不留下最终名的假文件
          throw err
        }
        hooks.notify(
          `连接中断，正在重连后续传（第 ${attempts} 次，已完成 ${formatBytes(pos)} / ${formatBytes(total)}）`
        )
        // 恢复失败就是终态（会话已关/不再重连/超时），原样抛出，别再拿死通道空转
        conn = await hooks.recover()
        await sleep(RECOVER_POLL_MS)
      }
    }
  } finally {
    await closeLocalQuietly(local)
    if (handle) await pClose(conn, handle)
  }
}

/* ------------------------------ 单文件任务 ------------------------------ */

async function transferUpload(
  sftp: SFTPWrapper,
  ctl: TransferControl,
  taskId: string,
  emit: (e: TransferProgressEvent) => void,
  hooks?: ResumeHooks
): Promise<void> {
  ctl.unit = 'bytes'
  ctl.transferred = 0
  ctl.total = 0
  const reporter = makeReporter(ctl, taskId, emit)
  // 首帧必须带上真实总量：本地 stat 一拿到就强制发一帧，否则进度条会先空槽再跳。
  let announced = false
  const onBytes = (transferred: number, total: number): void => {
    ctl.transferred = transferred
    if (total > 0) ctl.total = total
    const force = !announced && ctl.total > 0
    if (force) announced = true
    reporter.report(force)
  }
  const written = await uploadFileChunked(sftp, ctl, ctl.localPath, ctl.remotePath, onBytes, hooks)
  if (!announced) reporter.report(true)
  ctl.transferred = Math.max(written, ctl.total)
  ctl.total = ctl.transferred
}

async function transferDownload(
  sftp: SFTPWrapper,
  ctl: TransferControl,
  taskId: string,
  emit: (e: TransferProgressEvent) => void,
  hooks?: ResumeHooks
): Promise<void> {
  ctl.unit = 'bytes'
  ctl.transferred = 0
  ctl.total = 0
  const reporter = makeReporter(ctl, taskId, emit)
  let announced = false
  const onBytes = (transferred: number, total: number): void => {
    ctl.transferred = transferred
    if (total > 0) ctl.total = total
    const force = !announced && ctl.total > 0
    if (force) announced = true
    reporter.report(force)
  }
  const written = await downloadFileChunked(sftp, ctl, ctl.remotePath, ctl.localPath, onBytes, hooks)
  if (!announced) reporter.report(true)
  ctl.transferred = Math.max(written, ctl.total)
  ctl.total = ctl.transferred
}

/* ------------------------------ 目录递归传输 ------------------------------ */

/**
 * 本地目录递归遍历，返回相对路径与绝对路径。
 * @param limit 可选上限：扫描预览用，命中即停（正式上传不传，必须走全量）
 */
interface LocalTree {
  files: Array<{ rel: string; full: string }>
  /** 相对路径的目录清单（含空目录，顺序为父目录在前） */
  dirs: string[]
  /** 被跳过的符号链接 / junction（相对路径） */
  links: string[]
  /** 是否因命中 limit 提前结束（调用方必须据此提示用户，不能静默漏传） */
  truncated: boolean
}

/**
 * 遍历本地目录，同时收齐「文件、目录（含空目录）、被跳过的链接」。
 *
 * 两个历史 bug 就出在这里：
 * 1. 只收集文件 → 空目录在远端根本不会被建出来，用户传一个「只有子目录」的
 *    文件夹时看起来什么都没发生；
 * 2. 符号链接 / Windows junction 的 `dirent.isDirectory()` 是 false，会被当成
 *    文件去 open，轻则传出一个 0 字节的假文件，重则 EISDIR 直接让整个目录
 *    上传失败（node_modules、pnpm store、OneDrive 目录里遍地都是）。
 *    这里统一跳过并记下来，后面在失败汇总里报给用户。
 */
async function walkLocalTree(root: string, limit?: number): Promise<LocalTree> {
  const files: LocalTree['files'] = []
  const dirs: string[] = []
  const links: string[] = []
  const stack: Array<{ dir: string; rel: string }> = [{ dir: root, rel: '' }]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) break
    const entries = await fs.readdir(current.dir, { withFileTypes: true })
    for (const e of entries) {
      const full = join(current.dir, e.name)
      const rel = current.rel ? `${current.rel}/${e.name}` : e.name
      if (e.isSymbolicLink()) {
        links.push(rel)
        continue
      }
      if (e.isDirectory()) {
        dirs.push(rel)
        stack.push({ dir: full, rel })
      } else {
        files.push({ rel, full })
        if (limit !== undefined && files.length >= limit) {
          return { files, dirs, links, truncated: true }
        }
      }
    }
  }
  return { files, dirs, links, truncated: false }
}

/** 只要文件清单（扫描预览用） */
async function walkLocal(
  root: string,
  limit?: number
): Promise<Array<{ rel: string; full: string }>> {
  return (await walkLocalTree(root, limit)).files
}

/** 远端目录递归遍历 */
/**
 * 远端目录递归遍历：同时返回文件与目录清单。
 *
 * 目录清单不能省 —— 只按文件还原本地结构时，远端那些**空目录**会在下载后
 * 彻底消失（和上传侧「空目录不落地」是同一类 bug）。
 */
interface RemoteTree {
  files: Array<{ rel: string; full: string }>
  dirs: Array<{ rel: string; full: string }>
  /** 被跳过的符号链接（相对路径），用于在收尾时如实告知用户 */
  links: string[]
  /** 是否命中文件数上限（数字是下限，UI 应说「至少 N 个」） */
  truncated: boolean
}

async function walkRemote(sftp: SFTPWrapper, root: string, limit?: number): Promise<RemoteTree> {
  const files: RemoteTree['files'] = []
  const dirs: RemoteTree['dirs'] = []
  const links: string[] = []
  /*
   * visited 记录「已经展开过的绝对路径」。
   *
   * 目录环在远端很常见：bind mount 自引用、NFS 挂着上一级、运维手滑 ln -s 造出的
   * 循环。只有深度上限也能停住，但会在环上白白多走 64 层、重复列目录、重复报
   * 同名文件；用绝对路径去重能当场切断环。
   *
   * 用 full 而不是 realpath：realpath 每个目录多一次往返，对 2 万文件是 2 万次
   * 额外请求。同一条路径出现两次就足够判定为环 —— 真实目录树里同一绝对路径
   * 不可能以两个不同位置出现。
   */
  const visited = new Set<string>()
  const stack: Array<{ dir: string; rel: string; depth: number }> = [
    { dir: root, rel: '', depth: 0 }
  ]
  for (;;) {
    const current = stack.pop()
    if (!current) break
    if (current.depth > MAX_WALK_DEPTH) {
      throw new Error(
        `目录层级超过 ${MAX_WALK_DEPTH} 层，疑似存在目录环，已中止下载（已扫描 ${
          files.length
        } 个文件）`
      )
    }
    if (visited.has(current.dir)) continue
    visited.add(current.dir)
    const entries = await pReaddir(sftp, current.dir)
    for (const e of entries) {
      const full = joinRemote(current.dir, e.filename)
      const rel = current.rel ? `${current.rel}/${e.filename}` : e.filename
      /*
       * 符号链接默认跳过，和上传侧 walkLocalTree 对称。
       *
       * 链接可能是目录（指向别处）也可能是文件（指向本机路径）。当成文件下载，
       * 链接指向目录时会拿到 EISDIR；当成目录递归，就是顺着链接跑到目录树外面去。
       * 两条都不该是「下载文件夹」的默认行为，所以统一跳过并在收尾报数。
       */
      if (e.attrs.isSymbolicLink()) {
        links.push(rel)
        continue
      }
      if (e.attrs.isDirectory()) {
        dirs.push({ rel, full })
        stack.push({ dir: full, rel, depth: current.depth + 1 })
      } else {
        files.push({ rel, full })
        if (limit !== undefined && files.length >= limit) {
          return { files, dirs, links, truncated: true }
        }
      }
    }
  }
  return { files, dirs, links, truncated: false }
}

/** 远端逐级创建目录（已存在的层级忽略） */
async function ensureRemoteDir(sftp: SFTPWrapper, dirPath: string): Promise<void> {
  const parts = dirPath.split('/').filter(Boolean)
  let current = dirPath.startsWith('/') ? '' : '.'
  for (const part of parts) {
    current = `${current}/${part}`
    try {
      await pStat(sftp, current)
      continue
    } catch (err) {
      /*
       * 只有「确实不存在」才往下建目录。
       * 旧实现把任何 pStat 失败都当不存在 —— 链路超时、权限不足也一样，
       * 于是会对着一个存在但读不了的目录反复 mkdir，且超时判定的错被吞掉。
       */
      if (!isMissingEntry(err)) throw err
    }
    await pMkdir(sftp, current).catch((err: unknown) => {
      // 并发下别人刚建好（或目标其实存在）：按已存在处理，其余照抛
      if (!isExistsEntry(err)) throw err
    })
  }
}

/**
 * 上传目录：进度按"已完成文件数 / 总文件数"，每个文件内部同样可分块暂停/取消。
 *
 * 目录落点有两种语义，由 ctl.keepRoot 决定：
 * - false（历史行为，拖拽上传）：把本地目录的**内容**铺进目标目录；
 * - true（「上传文件夹」）：目标目录/<本地目录名>/...
 *   —— 用户明确选了一个文件夹，远端就该出现同名目录，否则两个不同名的文件夹
 *   会被铺平到同一个目标里，互相覆盖都看不出来。
 */
async function transferUploadDir(
  sftp: SFTPWrapper,
  ctl: TransferControl,
  taskId: string,
  emit: (e: TransferProgressEvent) => void,
  hooks?: ResumeHooks
): Promise<void> {
  const localDir = ctl.localPath
  /*
   * 目录任务里 sftp 句柄会被反复用到（建目录、逐文件上传）。通道断掉重连后
   * 手里这个 wrapper 已经死了，继续用它建目录会一路失败 —— 所以这里包一层
   * 可替换的通道引用，recover 时同步换成新通道。
   */
  let chan = sftp
  const dirHooks: ResumeHooks | undefined = hooks
    ? {
        notify: hooks.notify,
        recover: async () => {
          chan = await hooks.recover()
          return chan
        }
      }
    : undefined
  // 旧实现按「内容铺进目标目录」定义，这里取 remotePath 的父目录即可；
  // 保留目录本身时直接用 remotePath（= 目标目录/本地目录名）。
  const remoteDir = ctl.keepRoot
    ? ctl.remotePath
    : ctl.remotePath.slice(0, ctl.remotePath.lastIndexOf('/')) || '/'
  /*
   * 走上限：10 万文件的目录若先把整棵树建成数组再开始传，用户会在
   * 完全无反馈的情况下干等，且树本身要吃掉几 MB 内存。
   * 与 scanFolders 的 SCAN_FILE_LIMIT 同源，但这里必须给「已截断」的明确提示，
   * 不能静默漏传 —— 用户以为整个目录都传上去了才是真事故。
   */
  const { files, dirs, links, truncated } = await walkLocalTree(localDir, UPLOAD_FILE_LIMIT)
  // 大目录的遍历本身可能几十秒，中途取消必须能立刻停下，别等文件列表拿全
  await checkpoint(ctl)

  // 目录里一个文件都没有时也要把目录本身建出来，否则「上传文件夹」看起来毫无反应
  if (ctl.keepRoot) await ensureRemoteDir(chan, remoteDir)

  // 先把目录全部建好（父在前），空目录才不会丢
  for (const d of dirs) {
    // 几万个空目录的 mkdir 也是一串往返，取消要在这条循环里生效
    await checkpoint(ctl)
    await ensureRemoteDir(chan, joinRemote(remoteDir, d))
  }

  ctl.unit = 'files'
  ctl.total = files.length
  ctl.transferred = 0
  emit(eventOf(ctl, taskId, 'running'))

  let done = 0
  let skipped = 0
  const failed: Array<{ path: string; message: string }> = []
  for (const f of files) {
    await checkpoint(ctl)
    const target = joinRemote(remoteDir, f.rel)
    const targetDir = target.slice(0, target.lastIndexOf('/')) || '/'
    await ensureRemoteDir(chan, targetDir)
    /*
     * 目录重传时跳过没变化的文件。
     *
     * 判据 size + 秒级 mtime（见 isUpToDate）。上传侧之前完全没有跳过逻辑，
     * 一个 800MB 的项目目录改一行就要全量重传，这才是「上传很薄」的实感来源。
     * 判据错了的代价是「该传的没传」，所以只在两边都能 stat 到、且都像文件时
     * 才跳过；拿不准一律重传。
     */
    if (!ctl.force && (await isUpToDate(chan, f.full, target))) {
      skipped += 1
      done += 1
      ctl.transferred = done
      emit(eventOf(ctl, taskId, 'running'))
      continue
    }
    try {
      await uploadFileChunked(chan, ctl, f.full, target, () => undefined, dirHooks)
    } catch (err) {
      if (err instanceof TransferCancelledError || err instanceof TransferAbortedError) throw err
      /*
       * 链路类错误（重试预算已烧完 or 会话彻底掉了）必须向上抛：
       * 若当成「单文件失败」吞进 failed，剩下的几十个文件会全部以同样的
       * 原因失败，最后用户只看到一句「N 个文件失败」—— 而真相是网断了。
       */
      if (isRetryable(err)) throw err
      // 单个文件失败（权限、占用、路径过长…）不该让整批目录上传前功尽弃
      failed.push({
        path: f.rel,
        message: err instanceof Error ? err.message : String(err)
      })
    }
    done += 1
    ctl.transferred = done
    emit(eventOf(ctl, taskId, 'running'))
  }
  ctl.transferred = ctl.total

  const notes: string[] = []
  if (failed.length > 0) {
    const sample = failed
      .slice(0, 3)
      .map((x) => `${x.path}（${x.message}）`)
      .join('；')
    notes.push(`${failed.length} 个文件失败（例如 ${sample}）`)
  } else if (ctl.total === 0) {
    notes.push('该文件夹里没有文件，已创建目录结构')
  }
  if (links.length > 0) {
    notes.push(`跳过 ${links.length} 个符号链接/目录联接（例如 ${links.slice(0, 2).join('、')}）`)
  }
  if (skipped > 0) {
    // 跳过是默认行为，但用户必须知道「这次没传满」，否则会怀疑上传没生效
    notes.push(`跳过 ${skipped} 个未变化的文件（大小与修改时间都一致）`)
  }
  if (truncated) {
    // 命中上限属于「用户必须知道」的情况：静默只传一半才是真事故
    notes.push(`文件数超过 ${UPLOAD_FILE_LIMIT} 上限，已只上传前 ${UPLOAD_FILE_LIMIT} 个`)
  }
  if (failed.length > 0) throw new TransferPartialError(failed, notes.join('；'))
  // 遍历已结束、马上要报 done：这里补一个暂停点，否则用户刚按下的暂停会被 done 吞掉
  await checkpoint(ctl)
  if (notes.length > 0) {
    // 只跳过链接/命中上限、文件全成功：不算失败，但也不能悄悄咽下去。
    // 判据用 notes 而不是各计数器的或：空目录也要提示「没有文件」，
    // 原来那条 notes 拼好了却没机会发出去。
    ctl.note = notes.join('；')
    emit(eventOf(ctl, taskId, 'running', { note: ctl.note }))
  }
}

/** 下载目录：进度按"已完成文件数 / 总文件数" */
async function transferDownloadDir(
  sftp: SFTPWrapper,
  ctl: TransferControl,
  taskId: string,
  emit: (e: TransferProgressEvent) => void,
  hooks?: ResumeHooks
): Promise<void> {
  const remoteDir = ctl.remotePath
  let chan = sftp
  const dirHooks: ResumeHooks | undefined = hooks
    ? {
        notify: hooks.notify,
        recover: async () => {
          chan = await hooks.recover()
          return chan
        }
      }
    : undefined
  // ctl.localPath 已经是"目标目录/远端目录名"，目录内文件直接铺在它下面
  const localDir = ctl.localPath
  const { files, dirs, links, truncated } = await walkRemote(
    chan,
    remoteDir,
    DOWNLOAD_FILE_LIMIT
  )
  ctl.unit = 'files'
  ctl.total = files.length
  ctl.transferred = 0
  emit(eventOf(ctl, taskId, 'running'))

  // 先把远端目录结构（含空目录）在本地建出来，否则下载完的空目录会凭空消失
  for (const d of dirs) {
    // 目录多的站点，mkdir 循环也能跑很久，取消要在这里生效
    await checkpoint(ctl)
    await fs.mkdir(join(localDir, ...safeRelativeSegments(d.rel)), { recursive: true })
  }

  let done = 0
  const failed: Array<{ path: string; message: string }> = []
  for (const f of files) {
    await checkpoint(ctl)
    const target = join(localDir, ...safeRelativeSegments(f.rel))
    try {
      await downloadFileChunked(chan, ctl, f.full, target, () => undefined, dirHooks)
    } catch (err) {
      if (err instanceof TransferCancelledError || err instanceof TransferAbortedError) throw err
      // 链路类错误向上抛（同上传侧理由）
      if (isRetryable(err)) throw err
      // 单个文件失败（权限、占用、磁盘满…）不该让整批下载前功尽弃
      failed.push({
        path: f.rel,
        message: err instanceof Error ? err.message : String(err)
      })
    }
    done += 1
    ctl.transferred = done
    emit(eventOf(ctl, taskId, 'running'))
  }
  ctl.transferred = ctl.total

  const notes: string[] = []
  if (failed.length > 0) {
    const sample = failed
      .slice(0, 3)
      .map((x) => `${x.path}（${x.message}）`)
      .join('；')
    notes.push(`${failed.length} 个文件失败（例如 ${sample}）`)
  } else if (ctl.total === 0) {
    notes.push('该文件夹里没有文件，已创建目录结构')
  }
  if (links.length > 0) {
    notes.push(`跳过 ${links.length} 个符号链接（例如 ${links.slice(0, 2).join('、')}）`)
  }
  if (truncated) {
    notes.push(`文件数超过 ${DOWNLOAD_FILE_LIMIT} 上限，已只下载前 ${DOWNLOAD_FILE_LIMIT} 个`)
  }
  if (failed.length > 0) throw new TransferPartialError(failed, notes.join('；'))
  // 遍历已结束、马上要报 done：这里补一个暂停点，否则用户刚按下的暂停会被 done 吞掉
  await checkpoint(ctl)
  if (notes.length > 0) {
    // 判据用 notes：空目录的提示同样要发出，不能只在有链接/截断时才发
    ctl.note = notes.join('；')
    emit(eventOf(ctl, taskId, 'running', { note: ctl.note }))
  }
}

/* --------------------------- Shell 通道传输 --------------------------- */

/**
 * 探远端路径类型：shell 通道没有 lstat，只能用 test 内建问一句。
 *
 * 失败一律返回 'missing'：调用方会退回按单文件下载处理，
 * 真正的错误（权限、路径不存在）由随后的 cat 暴露，不必在这里猜。
 */
async function shellKindOf(client: Client, remotePath: string): Promise<'file' | 'directory' | 'missing'> {
  const quoted = shQuote(remotePath)
  const command =
    '[ -d ' + quoted + ' ] && echo __SWB_DIR__ || { [ -e ' + quoted + ' ] && echo __SWB_FILE__ || echo __SWB_NONE__; }'
  const probe = await execCollect(client, command, 15000)
  if (probe.status !== 'done' || probe.exitCode !== 0) return 'missing'
  const text = probe.stdout.trim()
  if (text.includes('__SWB_DIR__')) return 'directory'
  if (text.includes('__SWB_FILE__')) return 'file'
  return 'missing'
}

/**
 * 把 TransferControl 桥接成 shellFs 的传输钩子。
 *
 * shellFs 只认回调、不认识 ctl，暂停 / 取消 / 进度全靠这里转接；
 * 暂停时同样要让出并发位，否则三个暂停的 shell 传输会把整条队列永久卡死
 * （与 checkpoint 里那套 release/acquire 保持同一套语义）。
 *
 * @param reportBytes 单文件传输为 true（进度按字节推进）；
 *   目录内逐文件传时传 false —— 那时 ctl.unit 是 'files'，进度由文件数驱动，
 *   让字节数覆盖 ctl.transferred 会把「3/100 个文件」显示成几 MB 的乱码进度。
 */
function bridgeShellHooks(
  ctl: TransferControl,
  taskId: string,
  emit: (e: TransferProgressEvent) => void,
  reportBytes: boolean
): ShellTransferHooks {
  const reporter = makeReporter(ctl, taskId, emit)
  let announced = false
  return {
    isPaused: () => ctl.paused,
    isCancelled: () => ctl.cancelled,
    waitIfPaused: async () => {
      // 与 checkpoint 同一套语义：挂起等待期间先让出并发位，醒来再重新排队拿
      for (;;) {
        if (ctl.cancelled) return
        if (!ctl.paused) {
          if (ctl.holding || !ctl.acquire) return
          await ctl.acquire()
          continue
        }
        ctl.release?.()
        await new Promise<void>((resolve) => ctl.waiters.push(resolve))
      }
    },
    onProgress: (transferred, total) => {
      if (!reportBytes) return
      ctl.transferred = transferred
      if (total > 0) ctl.total = total
      const force = !announced && ctl.total > 0
      if (force) announced = true
      reporter.report(force)
    },
    /*
     * 把通道控制块挂到 ctl 上：cancelTransfer 只有这一条路能真正掐断 shell 后端的
     * 传输。registerStream 由 shellFs 在通道建好时同步调用（onChannel），
     * onStdin 那个 setImmediate 之后才到，来不及。
     */
    registerStream: (ctrl) => {
      ctl.abortStream = ctrl.abort
    }
  }
}

/** 单文件上传（shell 后端）：进度按字节，取消/中断转成引擎认识的错误类型 */
async function transferUploadShell(
  client: Client,
  ctl: TransferControl,
  taskId: string,
  emit: (e: TransferProgressEvent) => void
): Promise<void> {
  await checkpoint(ctl)
  ctl.unit = 'bytes'
  ctl.transferred = 0
  ctl.total = 0
  try {
    await shellUploadFile(client, ctl.localPath, ctl.remotePath, bridgeShellHooks(ctl, taskId, emit, true))
  } catch (err) {
    // shellFs 抛的是「传输已取消：路径」这种文案，引擎只认错误类型，
    // 这里必须翻译成 TransferCancelledError，否则取消会被记成一次失败。
    if (ctl.cancelled) throw new TransferCancelledError()
    throw err
  }
  if (ctl.total <= 0) ctl.total = ctl.transferred
  ctl.transferred = Math.max(ctl.transferred, ctl.total)
}

/** 单文件下载（shell 后端） */
async function transferDownloadShell(
  client: Client,
  ctl: TransferControl,
  taskId: string,
  emit: (e: TransferProgressEvent) => void
): Promise<void> {
  await checkpoint(ctl)
  ctl.unit = 'bytes'
  ctl.transferred = 0
  ctl.total = 0
  try {
    await shellDownloadFile(client, ctl.remotePath, ctl.localPath, bridgeShellHooks(ctl, taskId, emit, true))
  } catch (err) {
    if (ctl.cancelled) throw new TransferCancelledError()
    throw err
  }
  if (ctl.total <= 0) ctl.total = ctl.transferred
  ctl.transferred = Math.max(ctl.transferred, ctl.total)
}

/**
 * 上传目录（shell 后端）：进度按「已完成文件数 / 总文件数」。
 *
 * 与 SFTP 侧的差别只有一处：不做 mtime 跳过判断（BusyBox ls 精度不够，
 * 判错就是「该传的没传」）。其余语义（保留目录名、空目录、上限提示、
 * 单文件失败不拖垮整批）完全对齐。
 */
async function transferUploadShellDir(
  client: Client,
  ctl: TransferControl,
  taskId: string,
  emit: (e: TransferProgressEvent) => void
): Promise<void> {
  const localDir = ctl.localPath
  const remoteDir = ctl.keepRoot
    ? ctl.remotePath
    : ctl.remotePath.slice(0, ctl.remotePath.lastIndexOf('/')) || '/'
  const { files, dirs, links, truncated } = await walkLocalTree(localDir, UPLOAD_FILE_LIMIT)

  if (ctl.keepRoot) await shellMkdir(client, remoteDir, true)
  for (const d of dirs) {
    // 兼容模式每个目录一次往返，更要能在中途取消
    await checkpoint(ctl)
    await shellMkdir(client, joinRemote(remoteDir, d), true)
  }

  ctl.unit = 'files'
  ctl.total = files.length
  ctl.transferred = 0
  emit(eventOf(ctl, taskId, 'running'))

  let done = 0
  // 同一目录下的文件只 mkdir 一次：每文件一次 mkdir -p 是纯粹的往返浪费
  let lastDir = ''
  const failed: Array<{ path: string; message: string }> = []
  for (const f of files) {
    await checkpoint(ctl)
    const target = joinRemote(remoteDir, f.rel)
    const targetDir = target.slice(0, target.lastIndexOf('/')) || '/'
    if (targetDir !== lastDir) {
      await shellMkdir(client, targetDir, true)
      lastDir = targetDir
    }
    try {
      await shellUploadFile(client, f.full, target, bridgeShellHooks(ctl, taskId, emit, false))
    } catch (err) {
      if (ctl.cancelled) throw new TransferCancelledError()
      if (err instanceof TransferCancelledError || err instanceof TransferAbortedError) throw err
      // 链路类错误向上抛：否则剩下几十个文件会以同样理由失败，真相被埋成「N 个文件失败」
      if (isRetryable(err)) throw err
      failed.push({ path: f.rel, message: err instanceof Error ? err.message : String(err) })
    }
    done += 1
    ctl.transferred = done
    emit(eventOf(ctl, taskId, 'running'))
  }
  ctl.transferred = ctl.total

  const notes: string[] = []
  if (failed.length > 0) {
    const sample = failed
      .slice(0, 3)
      .map((x) => `${x.path}（${x.message}）`)
      .join('；')
    notes.push(`${failed.length} 个文件失败（例如 ${sample}）`)
  } else if (ctl.total === 0) {
    notes.push('该文件夹里没有文件，已创建目录结构')
  }
  if (links.length > 0) {
    notes.push(`跳过 ${links.length} 个符号链接/目录联接（例如 ${links.slice(0, 2).join('、')}）`)
  }
  notes.push('兼容模式下不判断远端是否已是最新，已全部重传')
  if (truncated) {
    notes.push(`文件数超过 ${UPLOAD_FILE_LIMIT} 上限，已只上传前 ${UPLOAD_FILE_LIMIT} 个`)
  }
  if (failed.length > 0) throw new TransferPartialError(failed, notes.join('；'))
  // 同 SFTP 侧：遍历结束后、报 done 之前仍要能被暂停/取消打断
  await checkpoint(ctl)
  ctl.note = notes.join('；')
  emit(eventOf(ctl, taskId, 'running', { note: ctl.note }))
}

/** 下载目录（shell 后端）：进度按「已完成文件数 / 总文件数」 */
async function transferDownloadShellDir(
  client: Client,
  ctl: TransferControl,
  taskId: string,
  emit: (e: TransferProgressEvent) => void
): Promise<void> {
  const remoteDir = ctl.remotePath
  const localDir = ctl.localPath
  const entries = await shellWalkRemote(client, remoteDir, DOWNLOAD_FILE_LIMIT, MAX_WALK_DEPTH)
  const dirs = entries.filter((e) => e.isDir)
  const files = entries.filter((e) => !e.isDir)
  // 条目数撞到上限：数字是下限，必须提示用户「没下全」
  const truncated = entries.length >= DOWNLOAD_FILE_LIMIT

  ctl.unit = 'files'
  ctl.total = files.length
  ctl.transferred = 0
  emit(eventOf(ctl, taskId, 'running'))

  // 远端空目录也要在本地建出来，否则下载完目录结构会凭空少几层
  await fs.mkdir(localDir, { recursive: true })
  for (const d of dirs) {
    // 同上传侧：目录多的站点，mkdir 循环必须能被取消打断
    await checkpoint(ctl)
    await fs.mkdir(join(localDir, ...safeRelativeSegments(d.relPath)), { recursive: true })
  }

  let done = 0
  const failed: Array<{ path: string; message: string }> = []
  for (const f of files) {
    await checkpoint(ctl)
    const target = join(localDir, ...safeRelativeSegments(f.relPath))
    await fs.mkdir(dirname(target), { recursive: true })
    try {
      await shellDownloadFile(client, f.remotePath, target, bridgeShellHooks(ctl, taskId, emit, false))
    } catch (err) {
      if (ctl.cancelled) throw new TransferCancelledError()
      if (err instanceof TransferCancelledError || err instanceof TransferAbortedError) throw err
      if (isRetryable(err)) throw err
      failed.push({ path: f.relPath, message: err instanceof Error ? err.message : String(err) })
    }
    done += 1
    ctl.transferred = done
    emit(eventOf(ctl, taskId, 'running'))
  }
  ctl.transferred = ctl.total

  const notes: string[] = []
  if (failed.length > 0) {
    const sample = failed
      .slice(0, 3)
      .map((x) => `${x.path}（${x.message}）`)
      .join('；')
    notes.push(`${failed.length} 个文件失败（例如 ${sample}）`)
  } else if (ctl.total === 0) {
    notes.push('该文件夹里没有文件，已创建目录结构')
  }
  if (truncated) {
    notes.push(`文件数超过 ${DOWNLOAD_FILE_LIMIT} 上限，已只下载前 ${DOWNLOAD_FILE_LIMIT} 个`)
  }
  if (failed.length > 0) throw new TransferPartialError(failed, notes.join('；'))
  // 遍历已结束、马上要报 done：这里补一个暂停点，否则用户刚按下的暂停会被 done 吞掉
  await checkpoint(ctl)
  if (notes.length > 0) {
    ctl.note = notes.join('；')
    emit(eventOf(ctl, taskId, 'running', { note: ctl.note }))
  }
}

export const sftpManager = new SftpManager()
