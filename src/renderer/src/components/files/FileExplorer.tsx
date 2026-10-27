import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ChevronRight,
  Download,
  Folder,
  File as FileIcon,
  FileText,
  FolderOpen,
  FolderPlus,
  FolderTree,
  HardDrive,
  Home,
  LayoutGrid,
  Loader2,
  Link2,
  Link2Off,
  Pencil,
  Plus,
  RefreshCw,
  Terminal,
  Upload
} from 'lucide-react'
import type { RemoteFile } from '@shared/types'
import type { SessionUi } from '@/stores/sessionStore'
import { useSftpStore } from '@/stores/sftpStore'
import { useToastStore } from '@/stores/toastStore'
import { call } from '@/lib/ipc'
import { cn, formatBytes, remoteDirname, remoteJoin } from '@/lib/utils'
import { normalizeRemoteDir, rememberUploadDir, resolveUploadDir } from '@/lib/uploadDir'
import { invalidateDir, loadDir as loadDirCached, loadDirs, peekDir, writeDir } from '@/lib/dirCache'
import { requestDirs } from '@/lib/dirLoader'
import { cachedHome, rememberHome } from '@/lib/remoteHome'
import { useCwdStore, seedCwdFromHome } from '@/stores/cwdStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { UploadTargetDialog } from './UploadTargetDialog'
import {
  ConfirmDialog,
  ContextMenu,
  PromptDialog,
  useContextMenu,
  type MenuEntry
} from '@/components/ui'

/**
 * 侧栏文件面板：工作区 / 文件系统 两个 Tab。
 *
 * - 「工作区」= 常用位置快捷入口（home、/、/tmp、/var/log、/etc），点一下跳到该目录；
 * - 「文件系统」= 真正的远端目录树，点目录逐级下钻，顶部面包屑可回跳；
 * - 两者共用同一个 currentDir，所以从快捷入口点进去之后，面包屑继续可用。
 *
 * 为什么不用 <SessionFileTree>：那个是给「贴着终端的一栏」设计的，带有自己的
 * 工具栏与关闭按钮，塞进侧栏会跟活动栏形成两套导航。这里按新外观重做一层，
 * 数据仍走同一套 sftp IPC，功能不缩减（双击目录=进入、双击文件=打开编辑器）。
 */

/**
 * 空闲预取的目录上限。
 *
 * 取 6 是因为典型目录里用户下一步最可能点的是前几个子目录（列表已按
 * 目录优先+名称排序，用户视线也落在上半屏）。再多就是拿链路带宽赌命中率：
 * 每条预取在慢链路上都要占一个 SFTP 通道槽位，反而拖慢用户真正点开的那一个。
 */
const PREFETCH_DIRS = 6

const WORKSPACE_SPOTS: Array<{ label: string; get: (home: string) => string; icon: JSX.Element }> =
  [
    { label: '主目录', get: (h) => h || '/', icon: <Home size={13} /> },
    { label: '根目录', get: () => '/', icon: <HardDrive size={13} /> },
    { label: '临时目录', get: () => '/tmp', icon: <Folder size={13} /> },
    { label: '系统日志', get: () => '/var/log', icon: <FileText size={13} /> },
    { label: '配置目录', get: () => '/etc', icon: <Folder size={13} /> }
  ]

interface TreeNode {
  file: RemoteFile
  depth: number
  /** 展开失败时在该目录下显示的一行提示（file 是占位，不可点） */
  error?: string
}

export function FileExplorer({
  session,
  onBrowseSessions
}: {
  /** 当前活动会话；未连接时展示引导 */
  session: SessionUi | null
  onOpenTransfer: () => void
  onBrowseSessions: () => void
}): JSX.Element {
  const [tab, setTab] = useState<'workspace' | 'fs'>('workspace')
  const [home, setHome] = useState<string>('')
  const [currentDir, setCurrentDir] = useState<string>('')
  const [openDirs, setOpenDirs] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /* 上传前先确认目标目录：以前这里直接把 currentDir 塞进系统文件对话框，
     currentDir 为空时就是 '' → joinRemote('' , name) → '/name'，落根目录。 */
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadDefault, setUploadDefault] = useState('')
  const [uploadBusy, setUploadBusy] = useState(false)

  const version = useSftpStore((s) => s.treeVersion)
  const bumpTree = useSftpStore((s) => s.bumpTree)
  const openEditor = useSftpStore((s) => s.openEditor)
  /* 展开状态在 effect 里也要读（不想因为它变化就整条 effect 重跑） */
  const openDirsRef = useRef(openDirs)
  openDirsRef.current = openDirs
  /* 当前目录同理：跟随终端的 effect 不该因为「用户自己换了目录」而重跑一遍 */
  const currentDirRef = useRef(currentDir)
  currentDirRef.current = currentDir
  /* 右键目标：命中某一行 → 该行；点在空白处 → 当前目录（菜单里下载/新建/上传都落在它上面） */
  const { menu, openMenu, closeMenu } = useContextMenu<RemoteFile | null>()
  const [dialog, setDialog] = useState<null | 'mkdir' | 'rename'>(null)
  const [menuTarget, setMenuTarget] = useState<RemoteFile | null>(null)
  const [pendingDelete, setPendingDelete] = useState<RemoteFile | null>(null)

  const sessionId = session?.id ?? null
  const connected = session?.status === 'connected'

  /*
   * 「跟随终端 cd」开关。缺省按开处理（`!== false`）：老配置里没有这个键，
   * 而绝大多数人第一次用就期待它生效；不想被跟随的人可以一键关掉。
   */
  const followPref = useSettingsStore((s) => s.settings.filesFollowTerminalCwd)
  const updateSettings = useSettingsStore((s) => s.update)
  const follow = followPref !== false

  /* 终端 cwd 的「事件序号」与路径：序号变一次 = 用户又 cd 了一次（哪怕路径没变） */
  const cwdSeq = useCwdStore((s) => (sessionId ? (s.seq[sessionId] ?? 0) : 0))
  const cwdPath = useCwdStore((s) => (sessionId ? (s.path[sessionId] ?? '') : ''))
  /** 已经跟随过的序号：避免同一事件被重渲染重复消费 */
  const followedSeqRef = useRef(0)

  /* ---------- 取 home（决定「主目录」快捷入口与初始路径） ---------- */
  /**
   * 换会话先把面板状态清干净。
   *
   * 之前这段缺失：currentDir 会带着上个会话的路径留在新会话里，而下面的
   * home effect 用的是 `normalizeRemoteDir(cur) || h` —— cur 非空就保留，
   * 于是新会话打开就停在**上一个机器**的目录上（对端根本没有这个路径）。
   *
   * 清空后立刻用本会话已知的终端 cwd 兜底：用户先 `cd` 再第一次打开文件面板时，
   * 面板应该直接落在他刚去的地方，而不是弹回 home 让他再点一遍。
   */
  useEffect(() => {
    const knownCwd = sessionId ? normalizeRemoteDir(useCwdStore.getState().path[sessionId] ?? '') : ''
    setCurrentDir(knownCwd)
    setHome('')
    setOpenDirs(new Set())
    setSelected(null)
  }, [sessionId])

  useEffect(() => {
    if (!sessionId || !connected) {
      setHome('')
      setCurrentDir('')
      return
    }
    // 渲染层缓存命中时同步拿到 home：本轮就发 readdir，少一个 IPC 往返的等待
    const known = cachedHome(sessionId)
    if (known) {
      setHome(known)
      setCurrentDir((cur) => normalizeRemoteDir(cur) || known)
      seedCwdFromHome(sessionId, known)
      return
    }
    let cancelled = false
    // bootstrap：主进程里把 realpath(home) 和 home 的 readdir 连着做完，
    // 一次 IPC 返回。旧链路是先 home() 再等渲染层 setState 后发 list()，
    // 用户点开的瞬间要白等两个 RTT（第二个纯粹是调度）。
    void call(window.api.sftp.bootstrap(sessionId), { silent: true }).then((res) => {
      if (cancelled) return
      if (!res) {
        // bootstrap 失败（老服务器不支持、或目录不可读）：退回原来的两步走
        void call(window.api.sftp.home(sessionId), { silent: true }).then((dir) => {
          if (cancelled) return
          const h = normalizeRemoteDir(dir)
          rememberHome(sessionId, h)
          setHome(h)
          setCurrentDir((cur) => normalizeRemoteDir(cur) || h)
          seedCwdFromHome(sessionId, h)
        })
        return
      }
      const h = normalizeRemoteDir(res.home)
      rememberHome(sessionId, h)
      writeDir(sessionId, h, res.files)
      setHome(h)
      setCurrentDir((cur) => normalizeRemoteDir(cur) || h)
      seedCwdFromHome(sessionId, h)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, connected])

  /** 会话切走时把序号对齐，避免「切回来被上一次的 cwd 拽走」 */
  useEffect(() => {
    followedSeqRef.current = useCwdStore.getState().seq[sessionId ?? ''] ?? 0
  }, [sessionId])

  /**
   * 跟随终端的 `cd`：cwd 的**事件序号**一变，就把面板切过去。
   *
   * 为什么看序号而不是比较路径串：`cd /opt` → 手动在侧栏逛到 /etc → 再
   * `cd /opt`，路径完全没变，但用户的意图是「回到 /opt 去」。只比字符串会把
   * 这次命令当成无变化而漏掉，序号就一定不会漏。
   *
   * 三条约束：
   * - 只消费**本次会话新发生的事件**：切会话时先把序号对齐（见上一个 effect），
   *   否则切回来会被上个会话残留的 cwd 强行拽走；
   * - 用户关掉开关就不跟（见 follow）；
   * - 目标不在这里做存在性校验：readdir 失败会照常显示「读取失败」，
   *   比悄悄不动更容易让人明白发生了什么。
   */
  useEffect(() => {
    if (!sessionId || !connected) return
    if (!follow) return
    if (cwdSeq <= followedSeqRef.current) return
    followedSeqRef.current = cwdSeq
    if (!cwdPath) return
    const target = normalizeRemoteDir(cwdPath)
    if (!target) return
    if (currentDirRef.current === target) return
    // 换目录 = 上一棵树的展开状态作废（与 goto() 一致）
    setOpenDirs(new Set())
    setSelected(null)
    setCurrentDir(target)
    setTab('fs')
  }, [sessionId, connected, follow, cwdSeq, cwdPath])

  /* ---------- 拉取某个目录的直接子项（带缓存 + 在途去重） ---------- */
  const fetchDir = useCallback(
    async (dir: string, force = false): Promise<RemoteFile[] | null> => {
      if (!sessionId) return null
      return loadDirCached(
        sessionId,
        dir,
        () => call(window.api.sftp.list(sessionId, dir), { silent: true }),
        force
      )
    },
    [sessionId]
  )

  /* ---------- 目录树数据：根目录一份 + 每个展开目录一份，按需加载 ---------- */
  /**
   * 旧逻辑的病根（就是「打开特别慢」的来源）：
   *
   *   useEffect(..., [currentDir, openDirs, version]) 里做 `walk()`，而 walk 是
   *   `await walk(child)` 的串行 DFS。于是每展开一层目录，整个 effect 重跑，
   *   从 currentDir 起把**所有已加载过的父目录再 readdir 一遍**。展开到第 N 层
   *   就是 N 次串行往返；每次展开都重新付一遍。RTT 100ms 的机器上，展开三层
   *   就已经是一秒多的卡顿，而且越展开越慢。
   *
   * 现在拆成两件事：
   *   1) 数据：根目录一个 effect，已展开目录一个 effect（并发补齐、命中缓存就
   *      不请求），互不牵连 —— 展开第 N 层只发第 N 层那一条 readdir；
   *   2) 渲染：`rows` 由 useMemo 在内存里拼出来，纯计算，不发请求。
   *
   * 另外所有读取都走 `@/lib/dirCache`：切目录、折叠再展开、切走再切回都是
   * 内存命中；根目录用 stale-while-revalidate，过期也先上屏不空等。
   */
  const [roots, setRoots] = useState<{ dir: string; files: RemoteFile[] } | null>(null)
  const [rootError, setRootError] = useState<string | null>(null)
  const [subDirs, setSubDirs] = useState<Map<string, RemoteFile[]>>(new Map())
  /** 子目录读取失败的原因：失败目录在树里显示一行错误，而不是永远转圈 */
  const [dirErrors, setDirErrors] = useState<Map<string, string>>(new Map())
  /** 在途的目录集合：避免同一目录被两轮 effect 同时请求 */
  const pendingRef = useRef<Set<string>>(new Set())
  /** 上一次的「目录\0版本」签名：用来区分「换了目录」和「用户按了刷新」 */
  const lastSigRef = useRef<string>('')
  /** 会话引用：迟到的响应不能写进新会话的树 */
  const sessionRef = useRef<string | null>(sessionId)
  sessionRef.current = sessionId

  useEffect(() => {
    if (!sessionId || !connected || !currentDir) return
    let cancelled = false

    const sig = `${currentDir}\u0000${version}`
    const prevSig = lastSigRef.current
    lastSigRef.current = sig
    /* 同目录但版本号变了 = 上传/删除/改名/点刷新 → 强制重拉（绕过 5s 新鲜期） */
    const forced = prevSig.startsWith(`${currentDir}\u0000`) && prevSig !== sig
    /* 换目录 / 换会话 → 上一层留下的展开数据全部作废 */
    if (!prevSig.startsWith(`${currentDir}\u0000`)) {
      pendingRef.current.clear()
      setSubDirs((prev) => (prev.size === 0 ? prev : new Map()))
      setDirErrors((prev) => (prev.size === 0 ? prev : new Map()))
    }
    if (forced) {
      for (const d of openDirsRef.current) invalidateDir(sessionId, d)
      pendingRef.current.clear()
      setSubDirs((prev) => (prev.size === 0 ? prev : new Map()))
      setDirErrors((prev) => (prev.size === 0 ? prev : new Map()))
    }

    const hit = peekDir(sessionId, currentDir)
    if (hit.cached) {
      // 有缓存就立刻上屏（过期也先给，界面不空着等往返）
      setRoots({ dir: currentDir, files: hit.cached.files })
      setRootError(null)
      if (!forced && hit.fresh) return
    }

    setLoading(!hit.cached)
    void fetchDir(currentDir, forced)
      .then((files) => {
        if (cancelled || sessionRef.current !== sessionId) return
        setRoots({ dir: currentDir, files: files ?? [] })
      })
      .catch(() => {
        if (cancelled || sessionRef.current !== sessionId) return
        setRoots({ dir: currentDir, files: [] })
        setRootError('读取目录失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
    // openDirs 不进依赖：展开/折叠不该触发根目录重拉
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, connected, currentDir, version, fetchDir])

  /**
   * 已展开但还没数据的目录：**一轮批量补齐**。
   *
   * 旧版是串行 DFS（每展开一层，整个 effect 重跑、把所有父目录再 readdir 一遍）；
   * 上一版改成了 Promise.all 并发，但仍是「一个目录一条 IPC」——N 个目录就是
   * N 次渲染↔主进程的调度往返，慢链路上这部分比远端 readdir 本身还贵。
   *
   * 现在把这一轮要补的目录一次性交给 `requestDirs`，它在同一帧内合并、压成
   * 一条 IPC 发出去（主进程内部再并发 8 路 readdir），一次 RTT 拿回整批。
   * 依赖里带 subDirs：补齐后写回 → 再跑一轮 → 没有待办就立刻 return，自然收敛。
   */
  useEffect(() => {
    if (!sessionId || !connected || !roots) return
    const sid = sessionId

    const known = new Set<string>([roots.dir, ...subDirs.keys()])
    const todo = [...openDirs].filter((d) => !known.has(d) && !pendingRef.current.has(d))
    if (todo.length === 0) return

    for (const d of todo) pendingRef.current.add(d)
    void loadDirs(sid, todo, (missing) => requestDirs(sid, missing)).then((res) => {
      for (const d of todo) pendingRef.current.delete(d)
      if (sessionRef.current !== sid) return
      setSubDirs((prev) => {
        const next = new Map(prev)
        for (const d of todo) {
          // 读失败也写一个空数组：否则这个目录会一直被当成"待补"反复请求，
          // 失败目录改成显示一行错误提示（见 dirErrors）
          next.set(d, res.files[d] ?? [])
        }
        return next
      })
      setDirErrors((prev) => {
        const failed = todo.filter((d) => res.errors[d])
        // 只改本次涉及的目录：别的分支的错误状态不该被这轮顺手清掉
        const next = new Map(prev)
        for (const d of failed) next.set(d, res.errors[d])
        for (const d of todo) if (!res.errors[d]) next.delete(d)
        if (next.size === prev.size && [...next].every(([k, v]) => prev.get(k) === v)) return prev
        return next
      })
    })
  }, [sessionId, connected, roots, openDirs, subDirs])

  /**
   * 空闲预取一层子目录。
   *
   * 用户的真实动作是「看一眼目录 → 点开某个子目录」。首屏出来后到用户点击之间
   * 通常有 300ms~2s 的空档，这段时间链路是闲的 —— 与其等用户点了再付一个 RTT，
   * 不如在空闲时把当前目录下最可能的几个子目录先批量读回来写进缓存。
   *
   * 约束：
   * - 只预取一层、最多 PREFETCH_DIRS 个，且只读目录不放业务状态；
   * - 用 requestIdleCallback（不支持时退回 setTimeout），不抢首屏的带宽与主线程；
   * - 只写 dirCache，不写 subDirs —— 不触发重渲染，展开时由 loadDirs 命中。
   */
  useEffect(() => {
    if (!sessionId || !connected || !roots) return
    const sid = sessionId
    const targets = roots.files
      .filter((f) => f.type === 'directory' || f.type === 'symlink')
      .slice(0, PREFETCH_DIRS)
      .map((f) => f.path)
      .filter((p) => !peekDir(sid, p).cached)
    if (targets.length === 0) return

    let cancelled = false
    const run = (): void => {
      if (cancelled || sessionRef.current !== sid) return
      void loadDirs(sid, targets, (missing) => requestDirs(sid, missing))
    }
    const idle = (
      window as unknown as {
        requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
      }
    ).requestIdleCallback
    if (typeof idle === 'function') {
      const id = idle(run, { timeout: 1500 })
      return () => {
        cancelled = true
        ;(
          window as unknown as { cancelIdleCallback?: (id: number) => void }
        ).cancelIdleCallback?.(id)
      }
    }
    const timer = setTimeout(run, 400)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [sessionId, connected, roots])

  /** 扁平行：从 roots 起，按 openDirs 递归拼装（纯内存，不发请求） */
  const rows = useMemo<TreeNode[] | null>(() => {
    if (!roots) return null
    const out: TreeNode[] = []
    const seen = new Set<string>()
    const walk = (dir: string, depth: number, files: RemoteFile[]): void => {
      if (seen.has(dir)) return
      seen.add(dir)
      // 目录在前、文件在后，各自按名称排序（与 VS Code 一致）
      const sorted = [...files].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name, 'en')
      })
      for (const f of sorted) {
        out.push({ file: f, depth })
        if (f.type === 'directory' && openDirs.has(f.path)) {
          const failed = dirErrors.get(f.path)
          if (failed) out.push({ file: f, depth: depth + 1, error: failed })
          else {
            const kids = subDirs.get(f.path)
            if (kids) walk(f.path, depth + 1, kids)
          }
        }
      }
    }
    walk(roots.dir, 0, roots.files)
    return out
  }, [roots, subDirs, openDirs, dirErrors])

  const error = rootError

  const toggleDir = (path: string): void => {
    setOpenDirs((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const goto = (dir: string): void => {
    setCurrentDir(dir)
    setOpenDirs(new Set())
    setSelected(null)
    setTab('fs')
  }

  /* ---------- 上传：先选目标目录，再选本地文件 ---------- */
  const openUpload = async (): Promise<void> => {
    if (!sessionId) return
    // 当前目录 → 上次用的目录 → 远端 home；都拿不到就留空让用户自己填
    const dir = await resolveUploadDir(sessionId, currentDir)
    setUploadDefault(dir)
    setUploadOpen(true)
  }

  const doUpload = async (dir: string): Promise<void> => {
    if (!sessionId) return
    const target = normalizeRemoteDir(dir)
    if (!target) return
    setUploadBusy(true)
    try {
      rememberUploadDir(sessionId, target)
      const res = await call(window.api.sftp.uploadDialog(sessionId, target), {
        errorTitle: '上传失败'
      })
      if (res && !res.canceled) {
        useToastStore.getState().push({
          kind: 'info',
          title: `已加入 ${res.count} 个上传任务`,
          detail: `目标：${target}`
        })
        bumpTree()
      }
    } finally {
      setUploadBusy(false)
      setUploadOpen(false)
    }
  }

  /* ---------- 右键菜单动作 ---------- */

  /** 上传到指定目录（右键「上传文件到此处」与空白处右键共用） */
  const openUploadTo = async (dir: string): Promise<void> => {
    if (!sessionId) return
    const target = await resolveUploadDir(sessionId, dir)
    setUploadDefault(target)
    setUploadOpen(true)
  }

  /**
   * 下载：文件与目录走同一个 IPC。
   * 目录的递归遍历在主进程（sftpManager.transferDownloadDir），渲染层不需要展开。
   */
  const downloadTo = async (paths: string[], localDir?: string): Promise<void> => {
    if (!sessionId || paths.length === 0) return
    if (localDir) {
      const ids = await call(window.api.sftp.download(sessionId, paths, localDir), {
        errorTitle: '下载失败'
      })
      if (ids) {
        useToastStore.getState().push({
          kind: 'info',
          title: `已加入 ${ids.length} 个下载任务`,
          detail: `目标：${localDir}`
        })
      }
      return
    }
    // 没有默认目录：弹系统对话框让用户挑保存位置（目录下载会整棵建在所选目录下）
    const res = await call(window.api.sftp.downloadDialog(sessionId, paths), {
      errorTitle: '下载失败'
    })
    if (res && !res.canceled) {
      useToastStore.getState().push({
        kind: 'info',
        title: `已加入 ${res.count} 个下载任务`
      })
    }
  }

  /** 一键下载到本机「下载」文件夹，不弹对话框 */
  const downloadToDefault = async (paths: string[]): Promise<void> => {
    if (!sessionId || paths.length === 0) return
    const dir = await call(window.api.sftp.downloadsDir(), { silent: true })
    await downloadTo(paths, dir || undefined)
  }

  const mkdirAt = async (parent: string, name: string): Promise<void> => {
    if (!sessionId) return
    const done = await call(window.api.sftp.mkdir(sessionId, remoteJoin(parent, name)), {
      errorTitle: '新建文件夹失败'
    })
    if (done !== null) bumpTree()
  }

  const renameTo = async (target: RemoteFile, name: string): Promise<void> => {
    if (!sessionId) return
    const done = await call(
      window.api.sftp.rename(sessionId, target.path, remoteJoin(remoteDirname(target.path), name)),
      { errorTitle: '重命名失败' }
    )
    if (done !== null) bumpTree()
  }

  const removeAt = async (target: RemoteFile): Promise<void> => {
    if (!sessionId) return
    const ok = await call(window.api.sftp.remove(sessionId, target.path), {
      errorTitle: '删除失败'
    })
    if (ok !== null) {
      useToastStore.getState().push({ kind: 'success', title: `已删除「${target.name}」` })
      bumpTree()
    }
  }

  /** 当前右键的目标集合：行 → 该行；空白处 → 当前目录 */
  const menuItems = (target: RemoteFile | null): MenuEntry[] => {
    const dir = target ? (target.type === 'directory' ? target.path : currentDir) : currentDir
    return [
      ...(target && target.type !== 'directory'
        ? [
            {
              label: '编辑',
              icon: <Pencil size={12} />,
              onClick: () => void openEditor(target.path)
            }
          ]
        : []),
      {
        label: target ? (target.type === 'directory' ? '下载此目录' : '下载') : '下载当前目录',
        icon: <Download size={12} />,
        disabled: !target && !currentDir,
        onClick: () => void downloadTo([target ? target.path : currentDir])
      },
      {
        label: '下载到「下载」文件夹',
        icon: <Download size={12} />,
        disabled: !target && !currentDir,
        onClick: () => void downloadToDefault([target ? target.path : currentDir])
      },
      {
        label: target?.type === 'directory' ? '上传文件到此处' : '上传文件到此目录',
        icon: <Upload size={12} />,
        separatorBefore: true,
        disabled: !dir,
        onClick: () => void openUploadTo(dir)
      },
      {
        label: '新建文件夹',
        icon: <FolderPlus size={12} />,
        disabled: !dir,
        onClick: () => setDialog('mkdir')
      },
      ...(target
        ? [
            { label: '重命名', separatorBefore: true, onClick: () => setDialog('rename') },
            {
              label: target.type === 'directory' ? '删除目录' : '删除',
              danger: true,
              onClick: () => setPendingDelete(target)
            }
          ]
        : [])
    ]
  }

  /* ---------- 面包屑：把路径拆成可点的段 ---------- */
  const crumbs = (() => {
    const p = currentDir || '/'
    const parts = p.split('/').filter(Boolean)
    const out: Array<{ label: string; path: string }> = [{ label: '/', path: '/' }]
    let acc = ''
    for (const part of parts) {
      acc = `${acc}/${part}`
      out.push({ label: part, path: acc })
    }
    return out
  })()

  /* ---------- 未连接：引导去连接 ---------- */
  if (!session || !connected) {
    return (
      <div className="flex h-full flex-col">
        <div className="panel-head">
          <FolderTree size={13} className="shrink-0 text-ink-3" />
          <span className="panel-title">文件</span>
          <span className="flex-1" />
        </div>
        <ExplorerTabs tab={tab} onChange={setTab} />
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-5 text-center">
          <FolderOpen size={26} className="text-ink-3/60" />
          <div className="text-xs font-medium text-ink-2">还没有连接任何设备</div>
          <div className="text-2xs leading-relaxed text-ink-3">
            文件浏览器需要先建立 SSH 连接；连上之后这里会自动显示远端目录。
          </div>
          <button className="btn btn-primary mt-1 h-7 px-3 text-2xs" onClick={onBrowseSessions}>
            <Terminal size={12} />
            去连接设备
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 头部：与其它 5 个侧栏面板共用 panel-head。
          原来这里是「Tab 行 + 工具栏」两行自造头，比 HistoryPanel /
          CommandPanel 等高出 4px，切面板时内容整体上下跳 —— 现在统一成
          panel-head(32) + panel-toolbar，剩下的横向空间还给了会话名。 */}
      <div className="panel-head">
        <FolderTree size={13} className="shrink-0 text-ink-3" />
        <span className="panel-title">文件</span>
        <span
          className="min-w-0 flex-1 truncate text-right font-mono text-3xs text-ink-3"
          title={session.title}
        >
          {session.title}
        </span>
        <button
          className="btn-icon h-6 w-6"
          title={
            follow
              ? '已跟随终端：在终端里 cd 会自动跳到此目录（点击关闭跟随）'
              : '跟随终端已关闭：点击后在终端里 cd 会自动跳到该目录'
          }
          onClick={() => void updateSettings({ filesFollowTerminalCwd: !follow })}
        >
          {follow ? (
            <Link2 size={13} className="text-accent" />
          ) : (
            <Link2Off size={13} className="text-ink-3" />
          )}
        </button>
        <button className="btn-icon h-6 w-6" title="刷新当前目录" onClick={() => bumpTree()}>
          <RefreshCw size={13} />
        </button>
        <button
          className="btn-icon h-6 w-6"
          title={currentDir ? `上传文件到 ${currentDir}（可改目标目录）` : '上传文件（选择目标目录）'}
          onClick={() => void openUpload()}
        >
          <Upload size={13} />
        </button>
        <button
          className="btn-icon h-6 w-6"
          title={currentDir ? '在当前目录新建文件夹' : '请先进入一个目录'}
          disabled={!currentDir}
          onClick={() => {
            if (!currentDir) return
            void call(window.api.sftp.mkdir(sessionId!, remoteJoin(currentDir, '新建文件夹')), {
              silent: true
            }).then(() => bumpTree())
          }}
        >
          <Plus size={14} />
        </button>
      </div>

      {/* Tab 行：跟命令面板的「全部/收藏/最近」用同一套分段控件外观 */}
      <ExplorerTabs tab={tab} onChange={setTab} />

      {/* 面包屑：只在「文件系统」Tab 出现 —— 工作区是快捷位置列表，
          顶上再放一条路径等于同一信息重复两次 */}
      {tab === 'fs' && (
        <div className="scroll-thin flex h-7 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-edge px-1.5">
          {crumbs.map((c, i) => (
            <span key={c.path} className="flex shrink-0 items-center gap-0.5">
              {i > 0 && <ChevronRight size={10} className="text-ink-3/50" />}
              <button
                className={cn(
                  'rounded px-1 py-0.5 font-mono text-2xs transition-colors duration-150 hover:bg-hover',
                  i === crumbs.length - 1 ? 'text-ink' : 'text-ink-3'
                )}
                onClick={() => goto(c.path)}
              >
                {c.label}
              </button>
            </span>
          ))}
        </div>
      )}

      {/* 工作区快捷入口 */}
      {tab === 'workspace' && (
        <div className="shrink-0 border-b border-edge px-1.5 py-1.5">
          <div className="mb-1 px-1 text-3xs font-semibold uppercase tracking-wider text-ink-3/80">
            常用位置
          </div>
          {WORKSPACE_SPOTS.map((spot) => {
            const path = spot.get(home)
            const active = currentDir === path
            return (
              <button
                key={spot.label}
                className={cn(
                  'flex w-full cursor-default items-center gap-2 rounded px-1.5 py-1 text-left text-xs transition-colors duration-150',
                  active ? 'bg-select text-ink' : 'text-ink-2 hover:bg-hover'
                )}
                onClick={() => goto(path)}
              >
                <span className={active ? 'text-accent' : 'text-ink-3'}>{spot.icon}</span>
                <span className="min-w-0 flex-1 truncate">{spot.label}</span>
                <span className="max-w-[120px] shrink-0 truncate font-mono text-3xs text-ink-3/80">
                  {path}
                </span>
              </button>
            )
          })}
        </div>
      )}

      {/* 目录树：空白处右键也出菜单（目标=当前目录），这样侧栏任何位置都能直接下载整目录 */}
      <div
        className="scroll-thin min-h-0 flex-1 overflow-auto py-1"
        onContextMenu={(e) => {
          // 行自己会 stopPropagation，走到这里的都是空白区域
          setMenuTarget(null)
          openMenu(e, null)
        }}
      >
        {loading && rows === null ? (
          <div className="flex items-center justify-center gap-2 py-6 text-2xs text-ink-3">
            <Loader2 size={12} className="animate-spin" />
            加载中…
          </div>
        ) : error ? (
          <div className="px-3 py-4 text-2xs leading-relaxed text-ink-3">{error}</div>
        ) : rows && rows.length === 0 ? (
          <div className="flex flex-col items-center gap-1 px-4 py-8 text-center">
            <LayoutGrid size={18} className="text-ink-3/50" />
            <div className="text-2xs text-ink-3">这个目录是空的</div>
          </div>
        ) : (
          (rows ?? []).map(({ file, depth, error: rowError }) => {
            /* 展开失败的行：不渲染成可操作的条目，避免用户对着点却没反应 */
            if (rowError) {
              return (
                <div
                  key={`${file.path}\u0000err`}
                  className="flex items-center gap-1 py-[3px] pr-2 text-2xs text-danger"
                  style={{ paddingLeft: 6 + depth * 12 }}
                  title={rowError}
                >
                  <span className="min-w-0 flex-1 truncate">读取失败：{rowError}</span>
                </div>
              )
            }
            const isDir = file.type === 'directory'
            const isOpen = openDirs.has(file.path)
            const isSel = selected === file.path
            /** 展开中：目录已展开但数据还没回来（批量补齐在途） */
            const isPending = isDir && isOpen && !subDirs.has(file.path)
            return (
              <div
                key={file.path}
                data-file-path={file.path}
                className={cn(
                  'group flex cursor-default items-center gap-1 py-[3px] pr-2 text-xs transition-colors duration-150',
                  isSel ? 'bg-select text-ink' : 'text-ink-2 hover:bg-hover'
                )}
                style={{ paddingLeft: 6 + depth * 12 }}
                onClick={() => setSelected(file.path)}
                onContextMenu={(e) => {
                  // 先选中再开菜单：菜单项读的是同一个 target，避免右键后视觉选中不跟手
                  setSelected(file.path)
                  setMenuTarget(file)
                  openMenu(e, file)
                }}
                onDoubleClick={() => {
                  if (isDir) {
                    setCurrentDir(file.path)
                    toggleDir(file.path)
                  } else {
                    void openEditor(file.path)
                  }
                }}
                title={`${file.path}${isDir ? '' : ` · ${formatBytes(file.size)}`}`}
              >
                {isPending ? (
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    <Loader2 size={10} className="animate-spin text-ink-3" />
                  </span>
                ) : isDir ? (
                  <button
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-ink-3 hover:text-ink"
                    onClick={(e) => {
                      e.stopPropagation()
                      toggleDir(file.path)
                    }}
                  >
                    <ChevronRight
                      size={11}
                      className={cn('transition-transform duration-150', isOpen && 'rotate-90')}
                    />
                  </button>
                ) : (
                  <span className="h-4 w-4 shrink-0" />
                )}

                {isDir ? (
                  <Folder size={13} className={cn('shrink-0', isSel ? 'text-accent' : 'text-ink-3')} />
                ) : (
                  <FileIcon size={13} className="shrink-0 text-ink-3" />
                )}

                <span className="min-w-0 flex-1 truncate">{file.name}</span>
              </div>
            )
          })
        )}
      </div>

      {/* 底：当前目录 + 上级 */}
      <div className="flex h-7 shrink-0 items-center gap-1 border-t border-edge px-1.5 text-2xs text-ink-3">
        <span className="min-w-0 flex-1 truncate font-mono" title={currentDir || undefined}>
          {currentDir || '未选择目录'}
        </span>
        {currentDir && currentDir !== '/' && (
          <button
            className="rounded px-1 py-0.5 transition-colors duration-150 hover:bg-hover hover:text-ink-2"
            onClick={() => goto(remoteDirname(currentDir) || '/')}
          >
            上级
          </button>
        )}
      </div>

      {/* 右键菜单：行 → 该文件/目录；空白 → 当前目录 */}
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={closeMenu} />
      )}

      <PromptDialog
        open={dialog !== null}
        title={dialog === 'rename' ? '重命名' : '新建文件夹'}
        label={dialog === 'rename' ? '新名称' : '文件夹名称'}
        defaultValue={dialog === 'rename' ? (menuTarget?.name ?? '') : ''}
        onCancel={() => setDialog(null)}
        onConfirm={(value) => {
          const kind = dialog
          setDialog(null)
          if (kind === 'rename' && menuTarget) {
            void renameTo(menuTarget, value)
          } else if (kind === 'mkdir') {
            const parent = menuTarget?.type === 'directory' ? menuTarget.path : currentDir
            if (parent) void mkdirAt(parent, value)
          }
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="删除远程文件"
        danger
        confirmText="删除"
        message={
          pendingDelete ? (
            <>
              确定删除远端
              {pendingDelete.type === 'directory' ? '目录' : '文件'}
              <span className="font-medium text-ink">「{pendingDelete.name}」</span>吗？
              <div className="mt-2 selectable break-all font-mono text-2xs text-ink-3">
                {pendingDelete.path}
              </div>
              {pendingDelete.type === 'directory' && (
                <div className="mt-1 text-2xs text-danger">目录将被递归删除，不可恢复。</div>
              )}
            </>
          ) : (
            ''
          )
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const target = pendingDelete
          setPendingDelete(null)
          if (target) void removeAt(target)
        }}
      />

      {/* 上传目标目录（选完目录才弹本地文件选择框） */}
      <UploadTargetDialog
        open={uploadOpen}
        sessionId={sessionId ?? ''}
        defaultDir={uploadDefault}
        hint={currentDir ? `当前浏览：${currentDir}` : '未进入目录，请手动指定上传位置'}
        busy={uploadBusy}
        onCancel={() => setUploadOpen(false)}
        onConfirm={(dir) => void doUpload(dir)}
      />
    </div>
  )
}

/** Tab 行：工作区 / 文件系统。
 *
 * 用与命令面板「全部 / 收藏 / 最近」完全一致的分段控件外观（bg-raised 外壳 +
 * 选中项白底微投影），而不是自造的「下划线 Tab」。理由：侧栏 6 个面板里只有
 * 这里用下划线，切面板时视觉语言不统一；分段控件还能让「当前在哪一栏」在
 * 280px 宽度下更清楚。 */
function ExplorerTabs({
  tab,
  onChange
}: {
  tab: 'workspace' | 'fs'
  onChange: (t: 'workspace' | 'fs') => void
}): JSX.Element {
  const items: Array<{ key: 'workspace' | 'fs'; label: string }> = [
    { key: 'workspace', label: '工作区' },
    { key: 'fs', label: '文件系统' }
  ]
  return (
    <div className="flex shrink-0 items-center gap-1 px-2 pb-1.5 pt-1.5">
      <div className="flex items-center gap-0.5 rounded-md bg-raised p-0.5">
        {items.map((it) => {
          const on = tab === it.key
          return (
            <button
              key={it.key}
              className={cn(
                'flex h-[22px] items-center rounded px-2 text-2xs transition-colors duration-150',
                on
                  ? 'bg-app font-medium text-ink shadow-[0_1px_2px_rgb(0_0_0/0.06)]'
                  : 'text-ink-3 hover:text-ink-2'
              )}
              onClick={() => onChange(it.key)}
            >
              {it.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
