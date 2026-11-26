/**
 * 应用内自动更新。
 *
 * 设计目标：打开软件 → 标题栏旁边出现「更新」小按钮 → 点一下下载 → 下完点重启，
 * 全程不跳浏览器、不手动找安装包。
 *
 * 国内直连通道设计（零成本、零域名）：
 *   1. 默认「自动」模式在未配代理时优先走 Gitee 同源仓库（w3554334905/ssh-workbench）：
 *      通过 Gitee 公开 API 解析最新 tag，再把该 tag 的下载目录设为 generic feed，
 *      同时关闭差量下载（Gitee 附件 CDN 对 Range 返回 200 全量，关闭可避免白下一次）；
 *   2. 任意通道失败（超时 / 404 / 限流 / 返回 HTML 验证页）时，按顺序自动回退到
 *      GitHub 官方、gh-proxy.com、ghfast.top，单通道探测 8 秒快速失败，不卡死界面；
 *   3. 下载中途失败也会自动切换下一通道继续；若检查阶段已从一跳官方源（Gitee / GitHub）
 *      拿到可信 sha512，回退到第三方加速站时强制校验 sha512 一致才允许下载；
 *   4. 配了更新专用代理时，「自动」模式优先走 GitHub 官方以享受 .blockmap 差量更新。
 *
 * 几个刻意的取舍：
 *   - autoDownload 默认 false：现场网络（4G/专线）贵且慢，一次检查就偷偷拉 80MB
 *     是不可接受的。查到了先只亮「更新」按钮，用户点了才下。
 *   - autoUpdater.autoDownload 始终保持 false，由本模块自己决定是否触发 downloadUpdate()，
 *     避免 electron-updater 绕过我们的多通道回退逻辑。
 *   - 所有异常都吞进状态机（phase='error'），不抛给调用方 ——
 *     更新失败绝不能让正在用的 SSH 会话受影响。
 */

import { app, shell, session } from 'electron'
import { readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { autoUpdater, CancellationToken, type UpdateInfo } from 'electron-updater'
import type { UpdatePhase, UpdateStatus } from '@shared/types'
import { recordError } from './store/errorLog'
import {
  GITHUB_OWNER,
  GITHUB_REPO,
  GITEE_LATEST_API,
  MIRROR_PAGE,
  OFFICIAL_FEED,
  RELEASE_PAGE,
  buildCandidateSpecs,
  feedUrlFor,
  isFallbackShaAllowed,
  isGiteeUrl,
  parseGiteeLatestRelease,
  parseLatestYmlMeta,
  type LatestYmlMeta,
  type UpdateCandidateSpec
} from './updaterChannel'

/**
 * electron-updater 内部用这个分区名建 net session（见其 electronHttpExecutor.js
 * 的 NET_SESSION_NAME）。这里不能 `import` 那个常量：它是 `out/` 内的实现细节，
 * 版本升级很容易换路径。硬写同名分区即可 —— 分区是全局命名空间，名字对上就行。
 */
const NET_SESSION_NAME = 'electron-updater'

/** 单通道探测超时（毫秒）：国内连不上 GitHub 或镜像挂掉时快速切下一个，不干等 60 秒 */
const PROBE_TIMEOUT_MS = 8000

/** 主进程内的日志出口，由 index.ts 注入（那边已经有 bootLog 的写法） */
let log: (...args: unknown[]) => void = () => {}

/** 状态变化时通知渲染层，由 index.ts 注入（需要 mainWindow） */
let broadcast: (status: UpdateStatus) => void = () => {}

/**
 * 开发态是否允许跑更新检查。
 *
 * electron-updater 在未打包的 app 里会直接抛错（没有 app-update.yml）。
 * 调试这条链路时需要真跑一遍，所以给一个显式开关，而不是让 `is.dev`
 * 一刀切 —— 否则只能靠打包后试，改一版等三分钟，非常低效。
 */
const DEV_ENABLED = process.env['SSHWB_UPDATE_DEV'] === '1'

/**
 * 当前是不是便携版/免安装版。
 *
 * electron-builder 的 portable 目标会注入 PORTABLE_EXECUTABLE_DIR/FILE；
 * .zip 解压版没有安装器，同目录下不存在 NSIS 卸载程序 Uninstall*.exe。
 * 这两类都不该走 NSIS 自动下载/安装流程，改为打开发布页手动覆盖。
 */
function isPortable(): boolean {
  if (process.env['PORTABLE_EXECUTABLE_DIR'] || process.env['PORTABLE_EXECUTABLE_FILE']) return true
  if (!app.isPackaged || process.platform !== 'win32') return false
  try {
    const dir = dirname(process.execPath)
    return !readdirSync(dir).some((name) => /^Uninstall.*\.exe$/i.test(name))
  } catch {
    return false
  }
}

const state: UpdateStatus = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  releaseUrl: RELEASE_PAGE,
  mirrorUrl: MIRROR_PAGE
}

let initialized = false
let checkTimer: NodeJS.Timeout | null = null
/** 用户点过「稍后」的版本，避免同一版本反复强提示 */
let dismissedVersion: string | undefined

/** 当前生效的用户更新偏好（运行期修改设置时会同步刷新） */
let currentMirror = ''
let currentProxyUrl = ''
let autoDownloadPref = false
/** 「启动及运行期自动检查更新」的当前偏好（局部 patch 省略 autoCheck 时沿用它） */
let autoCheckPref = true
/** 环境变量强制指定了 feed 时，设置面板里的镜像不再生效（灰度/内网联调用） */
let envOverrideUrl = ''
/** 等待最近一次 setProxy 完成，避免刚改完代理立刻检查撞上旧代理 */
let proxyReady: Promise<void> = Promise.resolve()
/** 上一次失败的 message 与时刻，用于 3 秒内去重 */
let lastFailMessage = ''
let lastFailAt = 0
/** 下载代数与取消令牌：换源/重下/teardown 时取消旧流并丢弃滞后事件 */
let downloadGen = 0
let downloadToken: CancellationToken | undefined
/** 检查代数与探测取消控制器：换源/teardown 时中止在途探测并丢弃滞后事件 */
let checkGen = 0
let activeCheckGen: number | null = null
let probeAbort: AbortController | null = null

function abortActiveProbe(): void {
  if (!probeAbort) return
  try {
    probeAbort.abort()
  } catch {
    /* 已中止的控制器忽略 */
  }
  probeAbort = null
}

function cancelDownload(): void {
  if (!downloadToken) return
  try {
    downloadToken.cancel()
  } catch {
    /* 已经结束的 token cancel 会抛，忽略 */
  }
  downloadToken = undefined
  downloadGen++
}

/** 多通道探测/回退期间抑制 autoUpdater 提前发出的 error 事件，用计数避免重叠调用互相覆盖 */
let suppressErrorCount = 0
/** 下载失败切源并内部重查 updateInfoAndProvider 时，屏蔽中间状态事件避免进度条闪回「检查中」 */
let silentResync = false
/** 当前正在检查的通道上下文，供 update-available / update-not-available 监听读取 */
let probingContext: { label: string; fallbackNotes?: string } | null = null

interface ActiveUpdateAttempt {
  candidates: UpdateCandidateSpec[]
  activeIndex: number
  version: string
  /** 来自一跳官方源（Gitee / GitHub）的可信 sha512，供回退到第三方代理时交叉校验 */
  trustedSha512?: string
}

let activeAttempt: ActiveUpdateAttempt | null = null

interface ResolvedChannel {
  spec: UpdateCandidateSpec
  feed:
    | { provider: 'github'; owner: string; repo: string; releaseType: 'release' }
    | { provider: 'generic'; url: string }
  disableDifferentialDownload: boolean
  meta: LatestYmlMeta
  fallbackNotes?: string
}

function getUpdaterSession(): Electron.Session {
  return session.fromPartition(NET_SESSION_NAME, { cache: false })
}

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
  const now = Date.now()
  if (message === lastFailMessage && now - lastFailAt < 3000) {
    setPhase('error', { error: message })
    return
  }
  lastFailMessage = message
  lastFailAt = now
  // 更新失败是「预期内的常态」（离线/内网环境），
  // 记 warn 而不是 error，避免污染主错误日志。
  log('[updater] failed:', message)
  setPhase('error', { error: message })
  void recordError({
    level: 'warn',
    source: 'updater',
    title: '检查更新失败',
    detail: message
  }).catch(() => undefined)
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 打日志/报错用的脱敏 URL：去掉 userinfo 避免代理密码明文落盘 */
function redactUrl(raw: string): string {
  const head = raw.replace(/(^|\/\/|[=;\s])[^\s/=;]*@/g, '$1***@')
  if (!/^(https?|socks[45]?):\/\//i.test(head)) return head
  try {
    const u = new URL(head)
    if (u.username || u.password) {
      u.username = ''
      u.password = ''
      return u.toString()
    }
    return head
  } catch {
    return head
  }
}

/** 把代理配置应用到 updater 专用的 net session 上 */
function applyProxy(proxyUrl?: string): void {
  const trimmed = (proxyUrl ?? '').trim()
  currentProxyUrl = trimmed
  try {
    const ses = getUpdaterSession()
    if (!trimmed) {
      // 空值 = 跟随系统代理。显式 setProxy({mode:'system'}) 而不是不调用，
      // 是因为用户可能刚从「用代理」切回「自动」，不重置会一直走旧的。
      proxyReady = ses.setProxy({ mode: 'system' }).catch((err) => {
        log('[updater] setProxy(system) failed:', errorMessage(err))
      })
      log('[updater] proxy: system')
      return
    }
    const safeUrl = redactUrl(trimmed)
    log('[updater] proxy:', safeUrl)
    proxyReady = ses
      .setProxy({ mode: 'fixed_servers', proxyRules: trimmed, proxyBypassRules: '<local>' })
      .catch((err) => {
        log('[updater] setProxy failed:', errorMessage(err))
        setPhase('error', { error: `更新代理地址无效：${safeUrl}` })
      })
  } catch (err) {
    log('[updater] setProxy failed:', errorMessage(err))
  }
}

/**
 * 切换更新源偏好。
 *
 * 换源必须取消在途下载并重置状态：旧源查出来的「有新版本」在新源上可能不同或路径失效，
 * 重置成 idle 后下一次检查会重新走新源。
 */
function applyMirror(mirror?: string): void {
  if (envOverrideUrl) return
  const next = (mirror ?? '').trim()
  if (next === currentMirror) return
  // 换源时立即作废正在进行的检查与探测，避免旧源滞后结果/报错写回新源状态
  checkGen++
  activeCheckGen = null
  probingContext = null
  abortActiveProbe()
  if (state.phase === 'downloading') cancelDownload()
  currentMirror = next
  activeAttempt = null
  log('[updater] mirror pref:', next || 'auto')
  if (state.phase !== 'idle' || state.sourceLabel !== undefined || state.latestVersion !== undefined) {
    setPhase('idle', {
      latestVersion: undefined,
      error: undefined,
      releaseNotes: undefined,
      sourceLabel: undefined,
      percent: undefined,
      transferred: undefined,
      total: undefined,
      bytesPerSecond: undefined
    })
  }
}

function formatNotesText(text: string): string | undefined {
  if (!text) return undefined
  // Release notes 里常带完整 markdown（含图片表格），标题栏下拉框放不下。
  // 这里只取前几行纯文本，够用户判断「这次更了什么」即可。
  const cleaned = text
    .replace(/<[^>]+>/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12)
    .join('\n')
  return cleaned || undefined
}

/** 从 UpdateInfo 里抽出可读的更新说明（GitHub release notes 可能是字符串或数组） */
function readNotes(info: UpdateInfo, fallback?: string): string | undefined {
  const notes = info.releaseNotes
  const text = !notes
    ? ''
    : Array.isArray(notes)
      ? notes.map((n) => (typeof n === 'string' ? n : n.note)).join('\n\n')
      : notes
  return formatNotesText(text) ?? (fallback ? formatNotesText(fallback) : undefined)
}

function extractSha512(info: UpdateInfo): string | undefined {
  const first = Array.isArray(info.files)
    ? info.files.find((f) => typeof f.sha512 === 'string' && f.sha512.trim().length > 0)
    : undefined
  if (first?.sha512) return first.sha512.trim()
  const raw = (info as unknown as { sha512?: unknown }).sha512
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined
}

/** 带 8 秒超时的会话级 fetch（走与 electron-updater 相同的代理分区，换源或卸载时可立即中止） */
async function fetchWithTimeout(url: string, accept: string): Promise<Response> {
  const ac = new AbortController()
  probeAbort = ac
  await proxyReady
  if (ac.signal.aborted) {
    if (probeAbort === ac) probeAbort = null
    throw new Error('aborted')
  }
  const ses = getUpdaterSession()
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS)
  try {
    return await ses.fetch(url, {
      method: 'GET',
      headers: {
        Accept: accept,
        'User-Agent': `ssh-workbench/${app.getVersion()}`
      },
      signal: ac.signal
    })
  } finally {
    clearTimeout(timer)
    if (probeAbort === ac) probeAbort = null
  }
}

/** 探测指定 feed 目录下的 latest.yml，过滤 404/超时的同时挡住返回 HTML 验证页的坏镜像 */
async function probeLatestYml(feedBaseUrl: string): Promise<LatestYmlMeta> {
  const ymlUrl = `${feedBaseUrl.replace(/\/+$/, '')}/latest.yml?noCache=${Date.now().toString(32)}`
  const res = await fetchWithTimeout(ymlUrl, 'text/yaml, text/plain, */*')
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`)
  }
  const text = await res.text()
  const meta = parseLatestYmlMeta(text)
  if (!meta) {
    throw new Error('返回的 latest.yml 格式无效（可能被拦截或重定向到登录/验证页）')
  }
  return meta
}

/**
 * 把一条候选通道解析成可直接交给 electron-updater 的配置，并完成快速可达性探测。
 */
async function resolveChannel(spec: UpdateCandidateSpec): Promise<ResolvedChannel> {
  if (spec.kind === 'gitee') {
    const apiRes = await fetchWithTimeout(GITEE_LATEST_API, 'application/json')
    if (!apiRes.ok) {
      throw new Error(`Gitee API HTTP ${apiRes.status}`)
    }
    const json: unknown = await apiRes.json()
    const resolved = parseGiteeLatestRelease(json)
    if (!resolved) {
      throw new Error('Gitee 最新发行版缺少 latest.yml 或为预发布版')
    }
    const meta = await probeLatestYml(resolved.feedUrl)
    return {
      spec,
      feed: { provider: 'generic', url: resolved.feedUrl },
      // Gitee 附件 CDN 对 Range 返回 200 全量而非 206，关掉差量避免无意义的二次下载
      disableDifferentialDownload: true,
      meta,
      fallbackNotes: resolved.notes
    }
  }

  if (spec.kind === 'github') {
    const meta = await probeLatestYml(OFFICIAL_FEED)
    return {
      spec,
      feed: {
        provider: 'github',
        owner: GITHUB_OWNER,
        repo: GITHUB_REPO,
        releaseType: 'release'
      },
      disableDifferentialDownload: false,
      meta
    }
  }

  const targetUrl =
    spec.kind === 'env' ? (spec.rawUrl ?? '').replace(/\/+$/, '') : feedUrlFor(spec.rawUrl)
  const meta = await probeLatestYml(targetUrl)
  return {
    spec,
    feed: { provider: 'generic', url: targetUrl },
    disableDifferentialDownload: isGiteeUrl(targetUrl),
    meta
  }
}

function applyResolvedChannel(resolved: ResolvedChannel): void {
  autoUpdater.disableDifferentialDownload = resolved.disableDifferentialDownload
  autoUpdater.setFeedURL(resolved.feed)
  log(
    '[updater] feed:',
    resolved.spec.label,
    resolved.feed.provider === 'generic' ? resolved.feed.url : 'github',
    resolved.disableDifferentialDownload ? '(full)' : '(differential)'
  )
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

  await proxyReady
  const recheck = getUpdateStatus()
  if (!initialized || recheck.phase === 'checking' || recheck.phase === 'downloading' || recheck.phase === 'downloaded') {
    return recheck
  }

  const myGen = ++checkGen
  setPhase('checking', {
    error: undefined,
    percent: undefined,
    transferred: undefined,
    total: undefined
  })

  const candidates = buildCandidateSpecs(currentMirror, currentProxyUrl, envOverrideUrl)
  const failures: string[] = []
  activeAttempt = null

  suppressErrorCount++
  try {
    for (let i = 0; i < candidates.length; i++) {
      if (!initialized || myGen !== checkGen) return getUpdateStatus()
      const spec = candidates[i]
      try {
        const resolved = await resolveChannel(spec)
        if (!initialized || myGen !== checkGen) return getUpdateStatus()
        applyResolvedChannel(resolved)
        probingContext = { label: spec.label, fallbackNotes: resolved.fallbackNotes }
        activeCheckGen = myGen

        const result = await autoUpdater.checkForUpdates()
        if (!initialized || myGen !== checkGen) return getUpdateStatus()
        if (!result) {
          // updater 在「已禁用」时返回 null（如未打包且没开 forceDevUpdateConfig）
          setPhase('idle')
          return getUpdateStatus()
        }

        const latest = result.updateInfo.version
        const sha512 = extractSha512(result.updateInfo) ?? resolved.meta.sha512
        const snap = getUpdateStatus()
        if (snap.phase === 'available') {
          activeAttempt = {
            candidates,
            activeIndex: i,
            version: latest,
            trustedSha512: spec.isFirstParty ? sha512 : undefined
          }
          if (autoDownloadPref && !isPortable()) {
            void downloadUpdate()
          }
        } else if (latest === snap.latestVersion && snap.phase === 'checking') {
          // checkForUpdates 会触发 update-available / update-not-available 事件，
          // 正常流程上面两个监听已经把 phase 改掉了。走到这里说明事件没来
          // （某些 provider 的边界情况），兜底成「已是最新」。
          setPhase('idle', { latestVersion: latest, sourceLabel: spec.label })
        }
        return getUpdateStatus()
      } catch (err) {
        if (!initialized || myGen !== checkGen) return getUpdateStatus()
        const reason = errorMessage(err)
        failures.push(`${spec.label}: ${reason}`)
        log(`[updater] channel failed (${spec.label}):`, reason)
      } finally {
        if (activeCheckGen === myGen) {
          activeCheckGen = null
          probingContext = null
        }
      }
    }

    if (initialized && myGen === checkGen) {
      fail(new Error(failures.length === 1 ? failures[0] : `全部通道均不可用（${failures.join('；')}）`))
    }
    return getUpdateStatus()
  } finally {
    suppressErrorCount = Math.max(0, suppressErrorCount - 1)
    if (activeCheckGen === myGen) {
      activeCheckGen = null
      probingContext = null
    }
  }
}

/**
 * 开始下载已发现的更新包。
 *
 * 先走检查命中的主通道；若中途断链、限流或被拦截，自动按候选队列切换下一个通道，
 * 静默重拉元数据并校验版本与官方 sha512（如有）后再继续下载。
 */
export async function downloadUpdate(): Promise<UpdateStatus> {
  if (!initialized) return getUpdateStatus()
  if (state.phase === 'downloading' || state.phase === 'downloaded') {
    return getUpdateStatus()
  }
  if (state.phase !== 'available' || !state.latestVersion) {
    log('[updater] no available update to download, skip')
    return getUpdateStatus()
  }
  if (isPortable()) {
    log('[updater] portable build, skip download and open download page')
    await openPortableDownloadPage()
    return getUpdateStatus()
  }

  cancelDownload()
  const gen = downloadGen
  downloadToken = new CancellationToken()
  const token = downloadToken
  setPhase('downloading', { percent: 0, transferred: 0, total: undefined, error: undefined })

  await proxyReady
  if (!initialized || gen !== downloadGen || token.cancelled) {
    if (downloadToken === token) downloadToken = undefined
    return getUpdateStatus()
  }

  const attempt = activeAttempt
  const fallbackOrder = attempt
    ? attempt.candidates
        .map((spec, idx) => ({ spec, idx }))
        .filter((item) => item.idx !== attempt.activeIndex)
    : []

  const failures: string[] = []
  suppressErrorCount++
  try {
    // 第 1 轮：直接使用检查阶段已经就绪的 updateInfoAndProvider，不重复查 latest.yml
    try {
      await autoUpdater.downloadUpdate(token)
      return getUpdateStatus()
    } catch (err) {
      if (!initialized || gen !== downloadGen || token.cancelled) {
        return getUpdateStatus()
      }
      const activeLabel = attempt?.candidates[attempt.activeIndex]?.label ?? state.sourceLabel ?? '当前源'
      const reason = errorMessage(err)
      failures.push(`${activeLabel}: ${reason}`)
      log(`[updater] download failed on ${activeLabel}:`, reason)
    }

    // 后续轮：切到剩余候选通道，重新绑定 updateInfoAndProvider 后重试下载
    if (attempt && fallbackOrder.length > 0) {
      for (const { spec, idx } of fallbackOrder) {
        if (!initialized || gen !== downloadGen || token.cancelled) {
          return getUpdateStatus()
        }
        try {
          log(`[updater] switching download channel → ${spec.label}`)
          const resolved = await resolveChannel(spec)
          if (!initialized || gen !== downloadGen || token.cancelled) {
            return getUpdateStatus()
          }
          if (resolved.meta.version !== attempt.version) {
            throw new Error(`版本不一致（期望 ${attempt.version}，该通道为 ${resolved.meta.version}）`)
          }
          if (!isFallbackShaAllowed(attempt.trustedSha512, resolved.meta.sha512, spec.isThirdPartyProxy)) {
            throw new Error('sha512 与官方源不一致，拒绝使用第三方代理')
          }

          applyResolvedChannel(resolved)
          silentResync = true
          let resyncInfo: UpdateInfo | undefined
          try {
            const checkRes = await autoUpdater.checkForUpdates()
            resyncInfo = checkRes?.updateInfo
          } finally {
            silentResync = false
          }
          if (!initialized || gen !== downloadGen || token.cancelled) {
            return getUpdateStatus()
          }
          if (!resyncInfo || resyncInfo.version !== attempt.version) {
            throw new Error(`切换通道后版本不匹配（${resyncInfo?.version ?? 'none'}）`)
          }
          const resyncSha = extractSha512(resyncInfo) ?? resolved.meta.sha512
          if (!isFallbackShaAllowed(attempt.trustedSha512, resyncSha, spec.isThirdPartyProxy)) {
            throw new Error('切换通道后 sha512 与官方源不一致，拒绝下载')
          }

          setPhase('downloading', {
            sourceLabel: spec.label,
            percent: 0,
            transferred: 0,
            total: undefined,
            bytesPerSecond: undefined,
            error: undefined
          })

          await autoUpdater.downloadUpdate(token)
          attempt.activeIndex = idx
          return getUpdateStatus()
        } catch (err) {
          if (!initialized || gen !== downloadGen || token.cancelled) {
            return getUpdateStatus()
          }
          const reason = errorMessage(err)
          failures.push(`${spec.label}: ${reason}`)
          log(`[updater] fallback download failed (${spec.label}):`, reason)
        }
      }
    }

    if (gen === downloadGen && !token.cancelled) {
      fail(new Error(failures.length === 1 ? failures[0] : `下载失败（${failures.join('；')}）`))
    }
    return getUpdateStatus()
  } finally {
    if (downloadToken === token) downloadToken = undefined
    silentResync = false
    suppressErrorCount = Math.max(0, suppressErrorCount - 1)
  }
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
  if (isPortable()) {
    log('[updater] portable build, open download page instead of installer')
    void openPortableDownloadPage()
    return
  }
  // 有正在跑的 SSH 会话时也照常退出：用户点的就是这个按钮，
  // 预期明确。会话日志已落盘，重连由应用重新打开时处理。
  try {
    autoUpdater.quitAndInstall(false, true)
  } catch (err) {
    fail(err)
  }
}

/** 便携版/免安装版按当前网络与通道偏好打开最可达的发布页（国内无代理优先 Gitee 镜像页） */
async function openPortableDownloadPage(): Promise<void> {
  const pref = currentMirror.toLowerCase()
  const preferMirror =
    Boolean(state.sourceLabel?.includes('Gitee')) ||
    pref === 'gitee' ||
    ((!pref || pref === 'auto') && !currentProxyUrl && state.sourceLabel !== 'GitHub 官方')
  if (preferMirror) {
    await openMirrorPage()
  } else {
    await openReleasePage()
  }
}

/** 打开 Release 页面（App 内更新走不通时的兜底） */
export async function openReleasePage(): Promise<void> {
  await shell.openExternal(state.releaseUrl ?? RELEASE_PAGE)
}

/** 打开国内镜像页（GitHub 打不开时的兜底下载入口） */
export async function openMirrorPage(): Promise<void> {
  await shell.openExternal(MIRROR_PAGE)
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
  /** 更新通道 / 镜像源（见 UpdatePrefs.mirror）；留空走自动多通道 */
  mirror?: string
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
  type UpdateEvent = Parameters<typeof autoUpdater.on>[0]
  const bound: Array<[UpdateEvent, (...args: never[]) => void]> = []

  if (DEV_ENABLED && !app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true
  }

  // 始终由本模块自己触发 downloadUpdate()，确保走多通道回退逻辑
  autoDownloadPref = options.autoDownload === true
  autoCheckPref = options.autoCheck !== false
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = !isPortable()
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.disableWebInstaller = true

  // logger 默认往文件写，这里接到主进程日志里，排障时一个日志面板能看到全部
  autoUpdater.logger = {
    info: (...args: unknown[]) => log('[updater]', ...args),
    warn: (...args: unknown[]) => log('[updater][warn]', ...args),
    error: (...args: unknown[]) => log('[updater][error]', ...args),
    debug: () => undefined
  }

  const bind = <A extends unknown[]>(event: UpdateEvent, fn: (...args: A) => void): void => {
    autoUpdater.on(event, fn)
    bound.push([event, fn as never])
  }

  bind('checking-for-update', () => {
    if (silentResync || activeCheckGen !== checkGen) return
    setPhase('checking', { error: undefined })
  })

  bind('update-available', (info: UpdateInfo) => {
    if (silentResync || activeCheckGen !== checkGen) return
    const ctx = probingContext
    log('[updater] available:', info.version, ctx ? `(${ctx.label})` : '')
    setPhase('available', {
      latestVersion: info.version,
      releaseNotes: readNotes(info, ctx?.fallbackNotes),
      sourceLabel: ctx?.label ?? state.sourceLabel,
      error: undefined,
      percent: undefined,
      transferred: undefined,
      total: undefined
    })
  })

  bind('update-not-available', (info: UpdateInfo) => {
    if (silentResync || activeCheckGen !== checkGen) return
    const ctx = probingContext
    log('[updater] up to date:', info.version, ctx ? `(${ctx.label})` : '')
    setPhase('idle', {
      latestVersion: info.version,
      sourceLabel: ctx?.label ?? state.sourceLabel,
      error: undefined,
      percent: undefined,
      transferred: undefined,
      total: undefined
    })
  })

  bind(
    'download-progress',
    (p: { percent: number; transferred: number; total: number; bytesPerSecond: number }) => {
      if (silentResync || !downloadToken) return
      setPhase('downloading', {
        percent: Math.max(0, Math.min(100, p.percent)),
        transferred: p.transferred,
        total: p.total,
        bytesPerSecond: p.bytesPerSecond
      })
    }
  )

  bind('update-downloaded', (info: UpdateInfo) => {
    if (silentResync || !downloadToken) return
    log('[updater] downloaded:', info.version)
    setPhase('downloaded', {
      latestVersion: info.version,
      percent: 100,
      releaseNotes: readNotes(info) ?? state.releaseNotes,
      error: undefined
    })
  })

  bind('error', (err: Error) => {
    if (suppressErrorCount > 0 || silentResync) return
    if (activeCheckGen !== checkGen && !downloadToken) return
    fail(err)
  })

  // 允许命令行/环境变量覆盖发布源，便于在内网镜像上做灰度验证
  envOverrideUrl = (process.env['SSHWB_UPDATE_URL'] ?? '').trim()
  if (envOverrideUrl) {
    log('[updater] feed overridden:', envOverrideUrl)
  } else {
    currentMirror = (options.mirror ?? '').trim()
    log('[updater] mirror pref:', currentMirror || 'auto')
  }

  applyProxy(options.proxyUrl)

  // 首次检查延后：启动瞬间窗口还在建、渲染层还没订阅事件，
  // 立刻检查的话状态推送会全部丢掉，用户看不到「有新版」。
  if (autoCheckPref) {
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
    for (const [event, fn] of bound) autoUpdater.removeListener(event, fn)
    bound.length = 0
    currentMirror = ''
    currentProxyUrl = ''
    envOverrideUrl = ''
    autoCheckPref = true
    autoDownloadPref = false
    proxyReady = Promise.resolve()
    activeAttempt = null
    checkGen++
    activeCheckGen = null
    probingContext = null
    suppressErrorCount = 0
    abortActiveProbe()
    cancelDownload()
    downloadToken = undefined
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
 * 用户在设置里把「启动时自动检查」从关改成开，或切换了更新通道，
 * 如果只写进配置文件、等下次启动才生效，当下这一会话就永远停在旧结果 ——
 * 这里立刻补一次检查（延后 2 秒，避开设置面板刚关的动画）。
 */
export function applyUpdatePrefs(prefs: {
  autoCheck?: boolean
  autoDownload?: boolean
  proxyUrl?: string
  mirror?: string
}): void {
  if (prefs.proxyUrl !== undefined) applyProxy(prefs.proxyUrl)
  if (!initialized) return

  // 换源要在「是否已有结果」的判断之前：换源会把状态重置成 idle，
  // 顺序反了就会出现「换了镜像但这一会话再也不检查」。
  if (prefs.mirror !== undefined) applyMirror(prefs.mirror)

  if (prefs.autoDownload !== undefined) {
    autoDownloadPref = prefs.autoDownload === true
  }
  if (prefs.autoCheck !== undefined) {
    autoCheckPref = prefs.autoCheck !== false
  }

  if (checkTimer) {
    clearTimeout(checkTimer)
    checkTimer = null
  }
  if (!autoCheckPref) {
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
