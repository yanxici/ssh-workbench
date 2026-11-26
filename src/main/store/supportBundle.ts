import { createZip, type ZipEntry } from '../util/zip'

/**
 * 一键诊断包的内容组装（纯函数，不碰 electron，可独立测试）。
 *
 * 与「诊断巡检包」（store/bundle.ts）的分工：
 * - 巡检包绑定某台设备的巡检报告，进得去会话才导得出来；
 * - 诊断包不依赖会话：连不上、闪退、更新失败、界面卡住，用户点一下就能产出，
 *   内容是「程序自己产出的诊断信息」，不含连接凭据 / 私钥 / 主机列表。
 */

export interface SupportBundleInput {
  version: string
  /** 逐行键值对（应用版本、Electron、系统、架构、语言、数据目录、导出时间） */
  appInfo: Record<string, string>
  /** 设置对象序列化后的 JSON 文本（敏感字段会被剔除） */
  settingsJson: string
  /** 错误日志纯文本 */
  errorText: string
  /** 启动期诊断日志，可能不存在 */
  bootLog?: string
  now?: number
}

/** boot.log 可能很长（反复启动会一直追加），只保留尾部，避免压出几十 MB 的包 */
const MAX_BOOT_LOG_BYTES = 200 * 1024

const README = `Portix 诊断包
====================
由「设置 → 错误日志 → 导出诊断包」生成，把问题现场原样交给技术支持或研发。

包含内容
--------
README.txt     本说明
app-info.txt   应用与运行环境（版本 / Electron / 系统 / 架构 / 语言 / 数据目录）
error-log.txt  应用内错误日志（时间、来源、标题、详情，口令类字段已脱敏）
settings.json  应用设置（口令 / 密钥 / 令牌类字段已剔除）
boot.log       启动期诊断日志（仅当本机存在该文件时打包，只保留最近 200KB）

不包含内容
----------
连接列表、主机名、账号、密码、私钥、会话内容、命令历史、传输记录。
排障确实需要这些时，请在「连接管理」里用「导出连接」（会带凭据，注意保管）。
`

/** 脱敏 URL / 代理规则中内嵌的账号密码（如 http://user:pass@host 或 http=user:pass@host） */
export function redactUrlCredentials(text: string): string {
  return text
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, '$1***@')
    .replace(/(^|[=;\s])[^\s/=;@]+:[^\s/=;@]*@/g, '$1***@')
}

/** 脱敏 boot.log 中的口令、URL 凭据与私钥块（兜底旧版未脱敏落盘的历史日志） */
function redactBootLog(text: string): string {
  return redactUrlCredentials(text)
    .replace(
      /((?:password|passwd|pwd|passphrase|proxyPassword|proxy_password|secret|token|apikey|api_key)\s*[=:]\s*)([^\s,;'"`\]}]+)/gi,
      '$1***'
    )
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '[PRIVATE KEY REDACTED]'
    )
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g, '[PRIVATE KEY REDACTED]')
}

/**
 * 剔除设置里的敏感字段。
 *
 * 设置本身不含连接凭据（那些在 vault 里），但代理定义（如 update.proxyUrl）、
 * 镜像地址或外部集成配置里可能带内嵌口令；按键名剔除的同时对所有字符串值
 * 执行 URL 凭据脱敏，避免 http://user:pass@host 原样落进诊断包。
 */
export function redactSettings(json: string): string {
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return '{}'
  }
  const SENSITIVE = /pass|secret|token|key|credential/i
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return redactUrlCredentials(v)
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = SENSITIVE.test(k) ? '（已剔除）' : walk(val)
      }
      return out
    }
    return v
  }
  return JSON.stringify(walk(value), null, 2)
}

export function buildSupportEntries(input: SupportBundleInput): ZipEntry[] {
  const now = input.now ?? Date.now()
  const header = [
    `导出时间：${new Date(now).toLocaleString()}`,
    `应用版本：${input.version}`,
    ''
  ].join('\n')

  const appInfo = Object.entries(input.appInfo)
    .map(([k, v]) => `${k}：${v}`)
    .join('\n')

  const entries: ZipEntry[] = [
    { name: 'README.txt', data: Buffer.from(README, 'utf-8') },
    { name: 'app-info.txt', data: Buffer.from(`${header}${appInfo}\n`, 'utf-8') },
    { name: 'error-log.txt', data: Buffer.from(input.errorText, 'utf-8') },
    { name: 'settings.json', data: Buffer.from(redactSettings(input.settingsJson), 'utf-8') }
  ]

  if (input.bootLog && input.bootLog.trim()) {
    const rawBuf = Buffer.from(input.bootLog, 'utf-8')
    const sliced =
      rawBuf.length > MAX_BOOT_LOG_BYTES
        ? rawBuf.subarray(rawBuf.length - MAX_BOOT_LOG_BYTES).toString('utf-8')
        : input.bootLog
    const redacted = Buffer.from(redactBootLog(sliced), 'utf-8')
    const tail =
      redacted.length > MAX_BOOT_LOG_BYTES
        ? redacted.subarray(redacted.length - MAX_BOOT_LOG_BYTES)
        : redacted
    entries.push({ name: 'boot.log', data: tail })
  }

  return entries
}

export function buildSupportZip(input: SupportBundleInput): Buffer {
  return createZip(buildSupportEntries(input), new Date(input.now ?? Date.now()))
}
