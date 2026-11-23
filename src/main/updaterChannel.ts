/**
 * 自动更新通道解析与校验（纯逻辑模块，无 Electron 依赖）。
 *
 * 拆出来单独成文件有两个目的：
 *   1. 让 scripts/verify-updater-channel.cjs 能在裸 Node 下直接做单元测试，
 *      不必每次改通道排序或 URL 拼接都要起完整的 Electron 进程；
 *   2. 把所有发布源常量与 URL 拼接集中在一处，隐私审计（verify-privacy.cjs）
 *      和后续维护一眼就能核对清楚。
 */

export const GITHUB_OWNER = 'yanxici'
export const GITHUB_REPO = 'ssh-workbench'

/** GitHub 官方发布页（兜底打开浏览器用） */
export const RELEASE_PAGE = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`

/** GitHub 官方 generic feed 基址（拼接镜像前缀时用） */
export const OFFICIAL_FEED = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest/download`

/** Gitee 官方国内同源仓库 */
export const GITEE_OWNER = 'w3554334905'
export const GITEE_REPO = 'ssh-workbench'

/** Gitee 发布页（兜底打开浏览器用） */
export const MIRROR_PAGE = `https://gitee.com/${GITEE_OWNER}/${GITEE_REPO}/releases`

/** Gitee 最新 Release 元数据 API（匿名可读，用于解析最新 tag 与更新说明） */
export const GITEE_LATEST_API = `https://gitee.com/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/latest`

/** Gitee Release 附件基址（后接 `/<tag>` 即构成 generic feed 目录） */
export const GITEE_DOWNLOAD_BASE = `https://gitee.com/${GITEE_OWNER}/${GITEE_REPO}/releases/download`

/**
 * 内置的公共 GitHub 加速站（仅在一跳官方源都不可达，或用户主动选择时使用）。
 * 主机名须与 scripts/verify-privacy.cjs 的 ALLOWED_HOSTS 保持一致。
 */
export const BUILTIN_PROXY_MIRRORS: readonly string[] = [
  'https://gh-proxy.com',
  'https://ghfast.top'
]

export type UpdateCandidateKind = 'gitee' | 'github' | 'mirror' | 'env'

export interface UpdateCandidateSpec {
  kind: UpdateCandidateKind
  /** 唯一标识（用于去重与日志） */
  id: string
  /** 面向用户的通道显示名（如「Gitee 国内源」「GitHub 官方」「gh-proxy.com」） */
  label: string
  /** 仅 kind='mirror' | 'env' 时存在 */
  rawUrl?: string
  /** 是否为一跳官方源（Gitee 同源仓库 / GitHub 官方仓库） */
  isFirstParty: boolean
  /** 是否为内置第三方公共代理（用于下载回退时强制校验官方 sha512） */
  isThirdPartyProxy: boolean
}

export interface LatestYmlMeta {
  version: string
  sha512: string
}

export interface GiteeReleaseResolved {
  tagName: string
  feedUrl: string
  notes?: string
}

const PRIVATE_OR_LOCAL_HOST =
  /^(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i

/** 提取主机名做展示标签，解析失败时退回原串 */
export function hostLabel(url: string): string {
  try {
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`
    return new URL(normalized).host || url
  } catch {
    return url
  }
}

/** 判断地址是否指向 Gitee（Gitee 附件 CDN 忽略 Range 返回 200 全量，需关闭差量下载） */
export function isGiteeUrl(url: string): boolean {
  try {
    const normalized = /^https?:\/\//i.test(url) ? url : `https://${url}`
    const host = new URL(normalized).hostname.toLowerCase()
    return host === 'gitee.com' || host.endsWith('.gitee.com')
  } catch {
    return false
  }
}

/**
 * 把用户填写的镜像配置规整成真正的 generic feed URL。
 *
 * 支持三种常见写法：
 *   1. 代理前缀（如 `https://gh-proxy.com` 或省略协议的 `gh-proxy.com`）→ 拼接官方 release 目录；
 *   2. 完整 release 目录（路径含 `/releases/`，如企业内网镜像）→ 原样使用；
 *   3. 局域网 / 本机地址（如 `http://192.168.1.10:8080/updates`）→ 原样使用，不拼 GitHub 路径。
 */
export function feedUrlFor(mirror?: string): string {
  const raw = (mirror ?? '').trim().replace(/\/+$/, '')
  if (!raw) return OFFICIAL_FEED
  const normalized = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  if (normalized.includes('/releases/')) return normalized
  try {
    const u = new URL(normalized)
    if (PRIVATE_OR_LOCAL_HOST.test(u.hostname)) return normalized
  } catch {
    // 交由下方按前缀拼接，后续 fetch 校验会给出明确错误
  }
  return `${normalized}/${OFFICIAL_FEED}`
}

/**
 * 按当前设置构造待尝试的更新通道队列（按优先级排序）。
 *
 * - 环境变量 `SSHWB_UPDATE_URL` 优先级最高（内网灰度 / E2E 联调专用），只尝试这一个源；
 * - 留空或 `'auto'`：自动多通道回退。未填专用代理时国内优先走 Gitee 同源镜像，
 *   不通再退 GitHub 官方与内置加速站；填了专用代理说明用户具备直连 GitHub 的链路，
 *   优先走 GitHub 官方（支持 .blockmap 差量更新），不通再退 Gitee 与加速站；
 * - 显式选 `'gitee'` / `'github'` / 自定义镜像时，严格只走用户指定的那个源。
 */
export function buildCandidateSpecs(
  mirror?: string,
  proxyUrl?: string,
  envOverrideUrl?: string
): UpdateCandidateSpec[] {
  const envUrl = (envOverrideUrl ?? '').trim().replace(/\/+$/, '')
  if (envUrl) {
    return [
      {
        kind: 'env',
        id: `env:${envUrl}`,
        label: hostLabel(envUrl),
        rawUrl: envUrl,
        isFirstParty: false,
        isThirdPartyProxy: false
      }
    ]
  }

  const giteeSpec: UpdateCandidateSpec = {
    kind: 'gitee',
    id: 'gitee',
    label: 'Gitee 国内源',
    isFirstParty: true,
    isThirdPartyProxy: false
  }

  const githubSpec: UpdateCandidateSpec = {
    kind: 'github',
    id: 'github',
    label: 'GitHub 官方',
    isFirstParty: true,
    isThirdPartyProxy: false
  }

  const builtinMirrors: UpdateCandidateSpec[] = BUILTIN_PROXY_MIRRORS.map((m) => ({
    kind: 'mirror',
    id: `mirror:${m}`,
    label: hostLabel(m),
    rawUrl: m,
    isFirstParty: false,
    isThirdPartyProxy: true
  }))

  const raw = (mirror ?? '').trim()
  const lower = raw.toLowerCase()

  if (!raw || lower === 'auto') {
    const hasExplicitProxy = (proxyUrl ?? '').trim().length > 0
    return hasExplicitProxy
      ? [githubSpec, giteeSpec, ...builtinMirrors]
      : [giteeSpec, githubSpec, ...builtinMirrors]
  }

  if (lower === 'gitee') return [giteeSpec]
  if (lower === 'github') return [githubSpec]

  const isBuiltin = BUILTIN_PROXY_MIRRORS.some(
    (m) => m.toLowerCase() === lower.replace(/\/+$/, '')
  )
  return [
    {
      kind: 'mirror',
      id: `custom:${raw}`,
      label: hostLabel(raw),
      rawUrl: raw,
      isFirstParty: false,
      isThirdPartyProxy: isBuiltin
    }
  ]
}

/**
 * 校验探测到的 `latest.yml` 文本是否为合法更新清单并抽出 version / sha512。
 *
 * 公共加速站挂掉或触发人机验证时，经常返回 HTTP 200 的 HTML 页面；
 * 如果直接喂给 electron-updater，报错信息晦涩且可能白等超时。
 * 这里先验结构，非 YAML 一律当成通道不可用立刻切下一个。
 */
export function parseLatestYmlMeta(text: string): LatestYmlMeta | null {
  if (!text || text.length > 64 * 1024) return null
  const trimmed = text.trimStart()
  if (!trimmed || trimmed.startsWith('<')) return null
  const verMatch = /^version:\s*['"]?([0-9]+\.[0-9]+\.[0-9]+[^\s'"]*)['"]?\s*$/m.exec(trimmed)
  const shaMatch = /^\s*sha512:\s*['"]?([A-Za-z0-9+/=]{32,})['"]?\s*$/m.exec(trimmed)
  if (!verMatch || !shaMatch) return null
  return {
    version: verMatch[1],
    sha512: shaMatch[1]
  }
}

/**
 * 解析 Gitee `/releases/latest` JSON，拼出可用于 generic provider 的固定目录。
 *
 * 必须确认附件里已经上传了 `latest.yml` 且非预发布版：
 * 发版刚建完 Release、附件还没传齐的窗口期里直接判无效，让自动模式无缝回退 GitHub。
 */
export function parseGiteeLatestRelease(data: unknown): GiteeReleaseResolved | null {
  if (!data || typeof data !== 'object') return null
  const rec = data as Record<string, unknown>
  if (rec['prerelease'] === true) return null
  const tagName = typeof rec['tag_name'] === 'string' ? rec['tag_name'].trim() : ''
  if (!tagName) return null
  const assets = Array.isArray(rec['assets']) ? rec['assets'] : []
  const hasLatestYml = assets.some(
    (a) => a && typeof a === 'object' && (a as Record<string, unknown>)['name'] === 'latest.yml'
  )
  if (!hasLatestYml) return null
  const notes = typeof rec['body'] === 'string' && rec['body'].trim() ? rec['body'] : undefined
  return {
    tagName,
    feedUrl: `${GITEE_DOWNLOAD_BASE}/${encodeURIComponent(tagName)}`,
    notes
  }
}

/**
 * 验证下载回退通道的 sha512 是否与官方一跳源一致。
 *
 * 防篡改边界：如果检查阶段已经从一跳源（Gitee / GitHub）拿到可信 sha512，
 * 下载失败回退到第三方公共加速站时，对方给的 latest.yml 必须携带完全一致的 sha512，
 * 否则拒绝使用该加速站，防止第三方代理同时替换 latest.yml 和安装包。
 */
export function isFallbackShaAllowed(
  trustedSha512: string | undefined,
  candidateSha512: string | undefined,
  isThirdPartyProxy: boolean
): boolean {
  if (!isThirdPartyProxy || !trustedSha512) return true
  if (!candidateSha512) return false
  return trustedSha512.trim() === candidateSha512.trim()
}
