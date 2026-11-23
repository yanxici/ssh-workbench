/**
 * 自动更新多通道解析与防篡改边界的纯逻辑回归。
 *
 * 直接用 esbuild 在内存中编译 src/main/updaterChannel.ts 运行，确保测的是线上代码：
 *   - 自动模式无代理时优先 Gitee 国内源，有专用代理时优先 GitHub 官方；
 *   - 显式选定单一通道 / 环境变量覆盖时不擅自追加其他通道；
 *   - 镜像前缀、内网完整 releases 目录、私有 IP 目录拼接口径一致；
 *   - 损坏或返回 HTML 验证页的坏镜像会被 parseLatestYmlMeta 立刻拦下；
 *   - Gitee 发行版缺少 latest.yml 或为预发布版时判无效，避免拉到半成品；
 *   - 从官方一跳源回退到第三方加速站时，sha512 不一致必被拒绝。
 *
 * 用法：node scripts/verify-updater-channel.cjs
 */
'use strict'
const path = require('node:path')
const esbuild = require('esbuild')

const SRC = path.join(__dirname, '../src/main/updaterChannel.ts')
const out = esbuild.buildSync({
  entryPoints: [SRC],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  write: false,
  logLevel: 'silent'
})
const mod = { exports: {} }
new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require)
const U = mod.exports

let pass = 0
const fails = []

function ok(cond, label, extra) {
  if (cond) pass++
  else fails.push(label + (extra === undefined ? '' : '\n    ' + JSON.stringify(extra)))
}

function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else fails.push(label + '\n    期望 ' + e + '\n    实际 ' + a)
}

// ---- A. 通道优先级 ----
{
  const list = U.buildCandidateSpecs('', '')
  eq(
    list.map((c) => c.id),
    ['gitee', 'github', 'mirror:https://gh-proxy.com', 'mirror:https://ghfast.top'],
    'A1: 自动模式无代理应优先 Gitee → GitHub → 内置加速站'
  )
  ok(list[0].isFirstParty && !list[0].isThirdPartyProxy, 'A2: Gitee 为一跳官方同源')
  ok(list[1].isFirstParty && !list[1].isThirdPartyProxy, 'A3: GitHub 为一跳官方源')
  ok(!list[2].isFirstParty && list[2].isThirdPartyProxy, 'A4: gh-proxy.com 标记为第三方代理')
}

{
  const list = U.buildCandidateSpecs('auto', 'http://127.0.0.1:7897')
  eq(
    list.map((c) => c.id),
    ['github', 'gitee', 'mirror:https://gh-proxy.com', 'mirror:https://ghfast.top'],
    'A5: 自动模式填了代理应优先 GitHub → Gitee → 内置加速站'
  )
}

{
  const giteeOnly = U.buildCandidateSpecs('gitee', 'http://127.0.0.1:7897')
  eq(giteeOnly.map((c) => c.id), ['gitee'], 'A6: 显式选 gitee 只保留单通道')

  const githubOnly = U.buildCandidateSpecs('github', '')
  eq(githubOnly.map((c) => c.id), ['github'], 'A7: 显式选 github 只保留单通道')

  const custom = U.buildCandidateSpecs('https://gh-proxy.com/', '')
  eq(custom.length, 1, 'A8: 显式选镜像只保留单通道')
  ok(custom[0].isThirdPartyProxy, 'A9: 内置镜像后缀斜杠也能正确识别为第三方代理')
  eq(custom[0].label, 'gh-proxy.com', 'A10: 标签提取主机名')

  const env = U.buildCandidateSpecs('gitee', '', 'http://127.0.0.1:9000/feed/')
  eq(env.length, 1, 'A11: SSHWB_UPDATE_URL 覆盖一切用户配置')
  eq(env[0].kind, 'env', 'A12: 环境变量候选标记为 env')
  eq(env[0].rawUrl, 'http://127.0.0.1:9000/feed', 'A13: 环境变量去掉末尾斜杠')
}

// ---- B. feedUrlFor 与 Gitee 识别 ----
{
  eq(
    U.feedUrlFor('https://gh-proxy.com/'),
    'https://gh-proxy.com/https://github.com/yanxici/ssh-workbench/releases/latest/download',
    'B1: 代理前缀自动拼官方 release 目录'
  )
  eq(
    U.feedUrlFor('gh-proxy.com'),
    'https://gh-proxy.com/https://github.com/yanxici/ssh-workbench/releases/latest/download',
    'B2: 省略协议的代理域名补全 https://'
  )
  eq(
    U.feedUrlFor('https://10.0.0.5/ssh-workbench/releases/latest/download/'),
    'https://10.0.0.5/ssh-workbench/releases/latest/download',
    'B3: 带 /releases/ 的完整内网地址原样保留'
  )
  eq(
    U.feedUrlFor('http://192.168.1.10:8080/updates/'),
    'http://192.168.1.10:8080/updates',
    'B4: 局域网地址原样保留，不误拼 GitHub 路径'
  )
  ok(U.isGiteeUrl('https://gitee.com/w3554334905/ssh-workbench/releases/download/v2.3.1'), 'B5: 识别 gitee.com')
  ok(U.isGiteeUrl('https://foruda.gitee.com/attach_file/123'), 'B6: 识别 gitee.com 子域')
  ok(!U.isGiteeUrl('https://gh-proxy.com/https://github.com/yanxici/ssh-workbench'), 'B7: 非 Gitee 地址返回 false')
}

// ---- C. latest.yml 校验 ----
{
  const validYml = [
    'version: 2.3.1',
    'files:',
    '  - url: ssh-workbench-Setup-2.3.1.exe',
    '    sha512: AooSRN2HQDxh2MoEP+YElVDYdvaSL6Gy1U7KD2won5n1cxhM8jHlagloHzsmrVn3TkqvyTs18x9tl17DkGVH7A==',
    '    size: 84213303',
    'path: ssh-workbench-Setup-2.3.1.exe',
    'sha512: AooSRN2HQDxh2MoEP+YElVDYdvaSL6Gy1U7KD2won5n1cxhM8jHlagloHzsmrVn3TkqvyTs18x9tl17DkGVH7A=='
  ].join('\n')
  const meta = U.parseLatestYmlMeta(validYml)
  eq(
    meta,
    {
      version: '2.3.1',
      sha512: 'AooSRN2HQDxh2MoEP+YElVDYdvaSL6Gy1U7KD2won5n1cxhM8jHlagloHzsmrVn3TkqvyTs18x9tl17DkGVH7A=='
    },
    'C1: 合法 latest.yml 正确解析 version 与 sha512'
  )

  eq(U.parseLatestYmlMeta('<!DOCTYPE html><html>Just a moment...</html>'), null, 'C2: 拦截 HTML 验证页')
  eq(U.parseLatestYmlMeta('version: 2.3.1\npath: foo.exe\n'), null, 'C3: 缺少 sha512 拒绝')
  eq(U.parseLatestYmlMeta(''), null, 'C4: 空文本拒绝')
  eq(U.parseLatestYmlMeta('version: 2.3.1\n' + 'x'.repeat(70000)), null, 'C5: 异常大响应拒绝')
}

// ---- D. Gitee Release API 解析 ----
{
  const okRel = U.parseGiteeLatestRelease({
    tag_name: 'v2.3.1',
    prerelease: false,
    body: '### 更新内容\n- 终端手感补齐',
    assets: [
      { name: 'ssh-workbench-Setup-2.3.1.exe' },
      { name: 'latest.yml' }
    ]
  })
  eq(
    okRel,
    {
      tagName: 'v2.3.1',
      feedUrl: 'https://gitee.com/w3554334905/ssh-workbench/releases/download/v2.3.1',
      notes: '### 更新内容\n- 终端手感补齐'
    },
    'D1: 正常 Gitee Release 拼出固定 tag feed 目录与更新说明'
  )

  eq(
    U.parseGiteeLatestRelease({
      tag_name: 'v2.4.0-beta.1',
      prerelease: true,
      assets: [{ name: 'latest.yml' }]
    }),
    null,
    'D2: 预发布版被过滤'
  )

  eq(
    U.parseGiteeLatestRelease({
      tag_name: 'v2.3.2',
      prerelease: false,
      assets: [{ name: 'ssh-workbench-Setup-2.3.2.exe' }]
    }),
    null,
    'D3: 尚未上传 latest.yml 的半成品 Release 被判无效'
  )

  eq(U.parseGiteeLatestRelease(null), null, 'D4: 空响应安全返回 null')
}

// ---- E. 第三方回退 sha512 交叉校验 ----
{
  const realSha = 'AooSRN2HQDxh2MoEP+YElVDYdvaSL6Gy1U7KD2won5n1cxhM8jHlagloHzsmrVn3TkqvyTs18x9tl17DkGVH7A=='
  const evilSha = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=='
  ok(U.isFallbackShaAllowed(realSha, realSha, true), 'E1: 第三方代理 sha512 与官方一致放行')
  ok(!U.isFallbackShaAllowed(realSha, evilSha, true), 'E2: 第三方代理 sha512 不一致拦截')
  ok(!U.isFallbackShaAllowed(realSha, undefined, true), 'E3: 第三方代理缺失 sha512 拦截')
  ok(U.isFallbackShaAllowed(realSha, evilSha, false), 'E4: 一跳官方源不受第三方代理校验阻塞')
  ok(U.isFallbackShaAllowed(undefined, evilSha, true), 'E5: 未拿到一跳 sha512 时允许第三方代理自验')
}

console.log(`updater-channel 回归：通过 ${pass}，失败 ${fails.length}`)
if (fails.length) {
  for (const f of fails) console.error('  ✗ ' + f)
  process.exitCode = 1
} else {
  console.log('✓ 全部断言通过')
}
