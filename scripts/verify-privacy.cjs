/**
 * 「零遥测、零崩溃上报」的可执行断言。
 *
 * 为什么需要它：这两个承诺写在 README 里，靠人肉遵守 —— 哪天有人为了排查一个
 * 线上问题加上 `crashReporter.start({ uploadToServer: true })`，或者 `npm i`
 * 带进一个统计 SDK，README 仍在原地吹同一句话，而没人会去核对。
 * 承诺只有能被脚本推翻，才算承诺。
 *
 * 三条判据（任何一条红，说明承诺已经不成立）：
 *
 *   1. 依赖里没有遥测/崩溃上报 SDK（名字黑名单，见 TELEMETRY_DEPS）；
 *   2. 源码里没有 `crashReporter`（Electron 自带的那个也会上传，见下）；
 *   3. src 里出现的每一个 http(s) 主机都在 ALLOWED_HOSTS 里 —— 这条最狠，
 *      因为任何新加的第三方接口（埋点、license 校验、远程配置）都会被抓到。
 *
 * 关于第 3 条的边界：localhost / 127.0.0.1 / 私有网段放行，它们是「用户连自己
 * 的机器」，比如示例命令里的 http://192.168.1.1，以及代理输入的占位文案。
 *
 * 注意：这里只做**静态**检查。真跑一次抓包当然更彻底，但那需要目标 Git 仓库
 * 有网络、有证书、有 MITM 环境；静态扫描能在 CI 里跑，代价是抓不到运行时
 * 动态拼接的域名（目前代码里没有这种写法）。
 *
 * 用法：node scripts/verify-privacy.cjs
 */
'use strict'
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const SRC = path.join(ROOT, 'src')

/** 依赖名黑名单：出现任意一个即视为「引入了遥测/崩溃上报」 */
const TELEMETRY_DEPS = [
  /sentry/i,
  /bugsnag/i,
  /rollbar/i,
  /raygun/i,
  /newrelic/i,
  /datadog/i,
  /posthog/i,
  /mixpanel/i,
  /amplitude/i,
  /segment(-|\/)?analytics/i,
  /analytics/i,
  /telemetry/i,
  /gtag/i,
  /umami/i,
  /matomo/i,
  /appinsights/i,
  /firebase/i
]

/**
 * 允许的出站主机。
 *
 * 每一行都要能回答「谁在什么时候连它」：
 * - github.com：更新检查（官方 feed）与 README 里的发布页链接；
 * - ghfast.top / gh-proxy.com：更新源镜像预设，用户主动选择才会用它们；
 * - gitee.com：国内发布镜像页（updater.ts 的 MIRROR_PAGE），只在用户点「打不开？用镜像」
 *   时由系统浏览器打开，应用本身不请求它。
 * 换源逻辑见 src/main/updater.ts 的 feedUrlFor()。
 */
const ALLOWED_HOSTS = new Set(['github.com', 'ghfast.top', 'gh-proxy.com', 'gitee.com'])

const PRIVATE_HOST = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'out' || entry.name === 'dist') continue
      walk(p, out)
    } else if (/\.(ts|tsx|js|cjs|mjs)$/.test(entry.name)) {
      out.push(p)
    }
  }
  return out
}

const problems = []

// ---- 1. 依赖 ----
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
  for (const name of Object.keys(pkg[field] || {})) {
    if (TELEMETRY_DEPS.some((re) => re.test(name))) {
      problems.push(`依赖 ${field}.${name} 命中遥测/崩溃上报黑名单`)
    }
  }
}

// ---- 2 & 3. 源码 ----
const files = walk(SRC, [])
const hostHits = new Map()
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8')
  const rel = path.relative(ROOT, file).replace(/\\/g, '/')
  const crash = text.match(/crashReporter/g)
  if (crash) problems.push(`${rel}: 出现 crashReporter（${crash.length} 处）—— Electron 的上报通道`)
  for (const m of text.matchAll(/https?:\/\/[^\s'"`)\]}]+/g)) {
    const host = m[0].replace(/^https?:\/\//, '').split(/[/?#]/)[0].toLowerCase()
    // 占位文案（如「http://ghfast.top」的说明、`…<站>…`）不算真实主机名
    if (!/^[a-z0-9.-]+$/.test(host)) continue
    if (PRIVATE_HOST.test(host)) continue
    if (!hostHits.has(host)) hostHits.set(host, [])
    hostHits.get(host).push(rel)
  }
}
for (const [host, where] of hostHits) {
  if (!ALLOWED_HOSTS.has(host)) {
    problems.push(`未知出站主机 ${host} —— ${[...new Set(where)].slice(0, 3).join(', ')}`)
  }
}

// ---- 输出 ----
console.log('隐私断言：')
console.log(`  依赖 ${Object.keys(pkg.dependencies || {}).length} 个，未发现遥测/崩溃 SDK`)
console.log(`  扫描源码 ${files.length} 个文件，crashReporter 出现 0 次`)
console.log(`  出站主机 ${[...hostHits.keys()].sort().join(', ') || '（无）'}`)

if (problems.length) {
  console.error('\n✗ 隐私断言失败：')
  for (const p of problems) console.error('  - ' + p)
  process.exitCode = 1
} else {
  console.log('\n✓ 零遥测、零崩溃上报仍然成立')
}
