/**
 * 应用内自动更新。
 *
 * 设计目标：打开软件 → 标题栏旁边出现「更新」小按钮 → 点一下下载 → 下完点重启，
 * 全程不跳浏览器、不手动找安装包。
 *
 * 为什么用 electron-updater 而不是自己写：
 *   1. 差量更新（.blockmap）是刚需 —— 78MB 的安装包在国内网络下直连 GitHub
 *      动辄十几分钟，差量通常只有几 MB；
 *   2. sha512 校验、断点续传、下载完成后的原子替换都由它处理，
 *      自己实现出错就是「更新完打不开」这种最坏结果；
 *   3. electron-builder 在打包时会自动生成 app-update.yml 与 latest.yml，
 *      两边元数据天然一致，不存在手写配置写错 owner/repo 的低级故障。
 *
 * 几个刻意的取舍：
 *   - autoDownload 默认 false：现场网络（4G/专线）贵且慢，一次检查就偷偷拉 78MB
 *     是不可接受的。查到了先只亮「更新」按钮，用户点了才下。
 *   - autoInstallOnAppQuit 保持 true：用户已经点了重启却临时取消，下次正常退出
 *     时顺手装上，不用再点一次。装完不会自己弹窗，行为可预期。
 *   - 所有异常都吞进状态机（phase='error'），不抛给调用方 ——
 *     更新失败绝不能让正在用的 SSH 会话受影响。
 */

import { app, shell, session } from 'electron'
import { autoUpdater, type UpdateInfo } from 'electron-updater'
import type { UpdatePhase, UpdateStatus } from '@shared/types'
import { recordError } from './store/errorLog'

/**
 * electron-updater 内部用这个分区名建 net session（见其 electronHttpExecutor.js
 * 的 NET_SESSION_NAME）。这里不能 `import` 那个常量：它是 `out/` 内的实现细节，
 * 版本升级很容易换路径。硬写同名分区即可 —— 分区是全局命名空间，名字对上就行。
 */
const NET_SESSION_NAME = 'electron-updater'

/** 主进程内的日志出口，由 index.ts 注入（那边已经有 bootLog 的写法） */
let log: (...args: unknown[]) => void = () => {}

/** 状态变化时通知渲染层，由 index.ts 注入（需要 mainWindow） */
let broadcast: (status: UpdateStatus) => void = () => {}

/**
 * 发布页地址。
 *
 * 与 electron-builder.yml 的 publish 段是同一份信息，但这里必须硬写一遍：
 * 更新失败时用户仍然需要一条能自己下载的活路，而那时 app-update.yml
 * 未必读得出来（例如打包产物被裁剪/被企业策略改写）。
 */
const RELEASE_PAGE = 'https://github.com/yanxici/ssh-workbench/releases/latest'

/**
 * 开发态是否允许跑更新检查。
 *
 * electron-updater 在未打包的 app 里会直接抛错（没有 app-update.yml）。
 * 调试这条链路时需要真跑一遍，所以给一个显式开关，而不是让 `is.dev`
 * 一刀切 —— 否则只能靠打包后试，改一版等三分钟，非常低效。
 */
const DEV_ENABLED = process.env['SSHWB_UPDATE_DEV'] === '1'

const state: UpdateStatus = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  releaseUrl: RELEASE_PAGE
}

let initialized = false
let checkTimer: NodeJS.Timeout | null = null
/** 用户点过「稍后」的版本，避免同一版本反复强提示 */
let dismissedVersion: string | undefined

function setPhase(phase: UpdatePhase, patch: Partial<UpdateStatus> = {}): void {
  state.phase = phase
  Object.assign(state, patch)
  // 每次进入 available 都要重新判断 dismissed：换了新版本就该再提示
  if (phase === 'available' && state.latestVersion && state.latestVersion !== dismissedVersion) {
    state.dismissed = false
  }
  broadcast({ ...state })
}

function fail(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  // 更新失败是「预期内的常态」（GitHub 在国内经常连不上），
  // 记 error 日志会污染日志面板，这里只留在状态里给用户看。
  log('[updater] failed:', message)
  setPhase('error', { error: message })
  void recordError({
    level: 'warn',
    source: 'updater',
    title: '检查更新失败',
    detail: message
  }).catch(() => undefined)
}

/** 把代理配置应用到 updater 专用的 net session 上 */
function applyProxy(proxyUrl?: string): void {
  try {
    const ses = session.fromPartition(NET_SESSION_NAME, { cache: false })
    if (!proxyUrl || proxyUrl.trim() === '') {
      // 空值 = 跟随系统代理。显式 setProxy({mode:'system'}) 而不是不调用，
      // 是因为用户可能刚从「用代理」切回「自动」，不重置会一直走旧的。
      void ses.setProxy({ mode: 'system' })
      log('[updater] proxy: system')
      return
    }
    const trimmed = proxyUrl.trim()
    void ses.setProxy({ mode: 'fixed_servers', proxyRules: trimmed, proxyBypassRules: '<local>' })
    log('[updater] proxy:', trimmed)
  } catch (err) {
    log('[updater] setProxy failed:', err instanceof Error ? err.message : String(err))
  }
}

/** 从 UpdateInfo 里抽出可读的更新说明（GitHub release notes 可能是字符串或数组） */
function readNotes(info: UpdateInfo): string | undefined {
  const notes = info.releaseNotes
  if (!notes) return undefined
  const text = Array.isArray(notes)
    ? notes.map((n) => (typeof n === 'string' ? n : n.note)).join('\n\n')
    : notes
  if (!text) return undefined
  // Release notes 里常带完整 markdown（含图片表格），标题栏下拉框放不下。
  // 这里只取前几行纯文本，够用户判断「这次更了什么」即可。
  return text
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12)
    .join('\n')
}

/** 当前是否有可用更新（渲染层据此决定要不要亮按钮） */
export function isUpdateAvailable(): boolean {
  return state.phase === 'available' || state.phase === 'downloading' || state.phase === 'downloaded'
}

export function getUpdateStatus(): UpdateStatus {
  return { ...state }
}

/** 主动检查（force=true 时即便之前已判定「最新」也重查一次） */
export async function checkForUpdates(force = false): Promise<UpdateStatus> {
  if (!initialized) {
    log('[updater] not initialized, skip check')
    return getUpdateStatus()
  }
  if (state.phase === 'checking' || state.phase === 'downloading') {
    // 已有检查/下载在跑，直接返回当前状态，不叠加请求
    return getUpdateStatus()
  }
  if (state.phase === 'downloaded') {
    return getUpdateStatus()
  }
  if (!force && state.phase === 'available') {
    return getUpdateStatus()
  }
  setPhase('checking', { error: undefined, percent: undefined, transferred: undefined, total: undefined })
  try {
    const result = await autoUpdater.checkForUpdates()
    if (!result) {
      // updater 在「已禁用」时返回 null（如未打包且没开 forceDevUpdateConfig）
      setPhase('idle')
      return getUpdateStatus()
    }
    const latest = result.updateInfo.version
    /*
     * 现读一次状态，不能用上面几个 if 里窄化过的 state.phase。
     *
     * 前面 `if (state.phase === 'checking' ...) return` 之后，TS 把 state.phase
     * 窄化成 "error" | "idle" | "available"，但 await 期间监听器完全可以把
     * phase 改回 'checking'（checkForUpdates 会自己发事件）。拿快照读真实值，
     * 既避开误报的 TS2367，逻辑上也才是对的。
     */
    const snap = getUpdateStatus()
    if (latest === snap.latestVersion && snap.phase === 'checking') {
      // checkForUpdates 会触发 update-available / update-not-available 事件，
      // 正常流程上面两个监听已经把 phase 改掉了。走到这里说明事件没来
      // （某些 provider 的边界情况），兜底成「已是最新」。
      setPhase('idle', { latestVersion: latest })
    }
    return getUpdateStatus()
  } catch (err) {
    fail(err)
    return getUpdateStatus()
  }
}

/** 开始下载已发现的更新包 */
export async function downloadUpdate(): Promise<UpdateStatus> {
  if (!initialized) return getUpdateStatus()
  if (state.phase === 'downloading' || state.phase === 'downloaded') {
    return getUpdateStatus()
  }
  setPhase('downloading', { percent: 0, transferred: 0, total: undefined, error: undefined })
  try {
    await autoUpdater.downloadUpdate()
  } catch (err) {
    fail(err)
  }
  return getUpdateStatus()
}

/**
 * 退出并安装。
 *
 * isSilent=false：NSIS 安装器会显示进度条。静默安装时 Electron 进程已退出、
 * 安装器在后台跑，用户会觉得「点了没反应」，反而更慌。
 * isForceRunAfter=true：装完自动把新版拉起来，符合「一键更新」的预期。
 */
export function quitAndInstall(): void {
  if (!initialized) return
  // 有正在跑的 SSH 会话时也照常退出：用户点的就是这个按钮，
  // 预期明确。会话日志已落盘，重连由应用重新打开时处理。
  try {
    autoUpdater.quitAndInstall(false, true)
  } catch (err) {
    fail(err)
  }
}

/** 打开 Release 页面（App 内更新走不通时的兜底） */
export async function openReleasePage(): Promise<void> {
  await shell.openExternal(state.releaseUrl ?? RELEASE_PAGE)
}

/** 用户点「稍后」：本会话内收起提示 */
export function dismiss(): UpdateStatus {
  dismissedVersion = state.latestVersion
  state.dismissed = true
  broadcast({ ...state })
  return getUpdateStatus()
}

export interface InitUpdaterOptions {
  log: (...args: unknown[]) => void
  broadcast: (status: UpdateStatus) => void
  /** 启动后延迟多久做第一次检查（毫秒），默认 8 秒 */
  initialDelayMs?: number
  /** 自动检查的偏好 */
  autoCheck?: boolean
  /** 检查到更新是否自动下载 */
  autoDownload?: boolean
  /** 更新专用代理 */
  proxyUrl?: string
}

/**
 * 初始化更新器。必须在 app ready 之后调用。
 *
 * 返回的 teardown 用于测试/重载时解绑，正常生命周期里不需要调用。
 */
export function initUpdater(options: InitUpdaterOptions): () => void {
  log = options.log
  broadcast = options.broadcast
  state.currentVersion = app.getVersion()

  const enabled = app.isPackaged || DEV_ENABLED
  if (!enabled) {
    // 源码态直接跑 `electron .`：没有 app-update.yml，也没有可升级的目标。
    // 保留 idle 状态，渲染层就不显示任何更新相关 UI。
    log('[updater] disabled (not packaged). set SSHWB_UPDATE_DEV=1 to force')
    return () => undefined
  }

  if (initialized) return () => undefined
  initialized = true

  applyProxy(options.proxyUrl)

  autoUpdater.autoDownload = options.autoDownload === true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  // 允许命令行/环境变量覆盖发布源，便于在内网镜像上做灰度验证
  if (process.env['SSHWB_UPDATE_URL']) {
    autoUpdater.setFeedURL({ provider: 'generic', url: process.env['SSHWB_UPDATE_URL'] })
    log('[updater] feed overridden:', process.env['SSHWB_UPDATE_URL'])
  }

  // logger 默认往文件写，这里接到主进程日志里，排障时一个日志面板能看到全部
  autoUpdater.logger = {
    info: (...args: unknown[]) => log('[updater]', ...args),
    warn: (...args: unknown[]) => log('[updater][warn]', ...args),
    error: (...args: unknown[]) => log('[updater][error]', ...args),
    debug: () => undefined
  }
  autoUpdater.on('checking-for-update', () => {
    setPhase('checking', { error: undefined })
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    log('[updater] available:', info.version)
    setPhase('available', {
      latestVersion: info.version,
      releaseNotes: readNotes(info),
      error: undefined,
      percent: undefined,
      transferred: undefined,
      total: undefined
    })
    if (options.autoDownload === true) void downloadUpdate()
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    log('[updater] up to date:', info.version)
    setPhase('idle', {
      latestVersion: info.version,
      error: undefined,
      percent: undefined,
      transferred: undefined,
      total: undefined
    })
  })

  autoUpdater.on('download-progress', (p) => {
    setPhase('downloading', {
      percent: Math.max(0, Math.min(100, p.percent)),
      transferred: p.transferred,
      total: p.total,
      bytesPerSecond: p.bytesPerSecond
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    log('[updater] downloaded:', info.version)
    setPhase('downloaded', {
      latestVersion: info.version,
      percent: 100,
      releaseNotes: readNotes(info) ?? state.releaseNotes,
      error: undefined
    })
  })

  autoUpdater.on('error', (err: Error) => {
    fail(err)
  })

  // 首次检查延后：启动瞬间窗口还在建、渲染层还没订阅事件，
  // 立刻检查的话状态推送会全部丢掉，用户看不到「有新版」。
  if (options.autoCheck !== false) {
    const delay = options.initialDelayMs ?? 8000
    checkTimer = setTimeout(() => {
      checkTimer = null
      void checkForUpdates()
    }, delay)
    // 定时器不该阻止进程退出
    checkTimer.unref?.()
  }

  return () => {
    if (checkTimer) {
      clearTimeout(checkTimer)
      checkTimer = null
    }
    initialized = false
  }
}

/** 运行期修改代理（设置面板改完立刻生效，不用重启） */
export function setUpdateProxy(proxyUrl?: string): void {
  applyProxy(proxyUrl)
}

/**
 * 运行期应用偏好改动。
 *
 * 用户在设置里把「启动时自动检查」从关改成开，如果只写进配置文件、
 * 等下次启动才生效，当下这一会话就永远是「没检查过」—— 用户会以为
 * 开关坏了。这里立刻补一次检查（延后 2 秒，避开设置面板刚关的动画）。
 */
export function applyUpdatePrefs(prefs: {
  autoCheck?: boolean
  autoDownload?: boolean
  proxyUrl?: string
}): void {
  if (prefs.proxyUrl !== undefined) applyProxy(prefs.proxyUrl)
  if (!initialized) return

  autoUpdater.autoDownload = prefs.autoDownload === true

  if (checkTimer) {
    clearTimeout(checkTimer)
    checkTimer = null
  }
  if (prefs.autoCheck === false) {
    log('[updater] auto check disabled')
    return
  }
  // 已经查过（有结果）就不重复查：用户改开关的时刻不该再打一次网络请求
  if (state.phase !== 'idle') {
    log('[updater] auto check enabled, already has result:', state.phase)
    return
  }
  checkTimer = setTimeout(() => {
    checkTimer = null
    void checkForUpdates()
  }, 2000)
  checkTimer.unref?.()
}
