/**
 * 一键诊断包内容契约回归（跑主进程真实代码：store/supportBundle.ts）。
 *
 * 锁住的契约：
 *  1. 包内固定四项：README.txt / app-info.txt / error-log.txt / settings.json；
 *  2. boot.log 存在才多一项，且超长时只留尾部（反复启动会一直追加，不能把包撑爆）；
 *  3. 设置里的口令 / 密钥 / 令牌类字段被替换，普通字段原样保留；
 *  4. 产出的 zip 是合法结构（PK\x03\x04 头 + EOCD），普通解压工具能开；
 *  5. 设置 JSON 坏掉时不抛错 —— 导出诊断包不能因为设置文件损坏就整个失败。
 *
 * 用法：node scripts/verify-support-bundle.cjs
 */
const fs = require('fs')
const path = require('path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, '.tsc-verify')
fs.mkdirSync(OUT, { recursive: true })
const entry = path.join(OUT, 'support-bundle.cjs')

esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'src/main/store/supportBundle.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: entry,
  logLevel: 'silent'
})

const { buildSupportEntries, buildSupportZip, redactSettings } = require(entry)

let failed = 0
function check(name, cond, extra) {
  if (cond) console.log('  ok   ' + name)
  else {
    failed++
    console.log('  FAIL ' + name + (extra ? '  -> ' + extra : ''))
  }
}

const base = {
  version: '2.2.1',
  appInfo: { 应用版本: '2.2.1', 系统: 'win32 x64' },
  settingsJson: JSON.stringify({
    theme: 'dark',
    proxy: { host: '10.0.0.1', password: 'hunter2' },
    apiToken: 'abc',
    secretKey: 'zzz'
  }),
  errorText: '错误日志正文',
  now: 1732000000000
}

/* ---------- 1. 固定条目 ---------- */
const entries = buildSupportEntries(base)
const names = entries.map((e) => e.name)
check('包含 README.txt', names.includes('README.txt'), names.join(','))
check('包含 app-info.txt', names.includes('app-info.txt'))
check('包含 error-log.txt', names.includes('error-log.txt'))
check('包含 settings.json', names.includes('settings.json'))
check('无 boot.log 时不打这一项', !names.includes('boot.log'))

const info = entries.find((e) => e.name === 'app-info.txt').data.toString('utf8')
check('app-info 里有版本号', info.includes('2.2.1'))
check('app-info 里有导出时间', info.includes('导出时间'))

/* ---------- 2. boot.log：存在才打，超长只留尾部 ---------- */
const withBoot = buildSupportEntries({ ...base, bootLog: 'x'.repeat(300 * 1024) })
const boot = withBoot.find((e) => e.name === 'boot.log')
check('有 boot.log 时打包进去', !!boot)
check('boot.log 被裁到 200KB 以内', boot && boot.data.length <= 200 * 1024, boot && boot.data.length)
check('空白 boot.log 不打包', !buildSupportEntries({ ...base, bootLog: '   ' }).some((e) => e.name === 'boot.log'))

/* ---------- 3. 设置脱敏 ---------- */
const settings = entries.find((e) => e.name === 'settings.json').data.toString('utf8')
check('口令字段被剔除', !settings.includes('hunter2'))
check('令牌字段被剔除', !settings.includes('abc') && !settings.includes('zzz'))
check('普通字段保留', settings.includes('dark'))
check('坏 JSON 不抛错', redactSettings('{ 坏掉的 json') === '{}')

/* ---------- 3b. URL 内嵌凭据与 boot.log 脱敏 ---------- */
const urlSettings = redactSettings(
  JSON.stringify({
    update: {
      proxyUrl: 'http://alice:SuperSecret@127.0.0.1:7897',
      mirror: 'https://ops:MirrorPass@mirror.corp.local/releases/'
    },
    proxyRule: 'http=bob:RulePass@10.0.0.2:8080;https=carol:HttpsPass@10.0.0.3:8080',
    safeLink: 'https://example.com/help?email=support@example.com'
  })
)
check('proxyUrl 内嵌账号密码被脱敏', !urlSettings.includes('SuperSecret') && !urlSettings.includes('alice'))
check('proxyUrl 主机与端口保留', urlSettings.includes('http://***@127.0.0.1:7897'))
check('mirror 内嵌口令被脱敏', !urlSettings.includes('MirrorPass') && urlSettings.includes('https://***@mirror.corp.local/releases/'))
check('多规则代理串内嵌口令被脱敏', !urlSettings.includes('RulePass') && !urlSettings.includes('HttpsPass'))
check('查询参数里的普通邮箱不被误伤', urlSettings.includes('https://example.com/help?email=support@example.com'))

const bootWithSecret = buildSupportEntries({
  ...base,
  bootLog: '[updater] proxy: http://u:bootSecret@127.0.0.1:7897\npassword=inlinePass\n'
})
  .find((e) => e.name === 'boot.log')
  .data.toString('utf8')
check('boot.log 里的代理 URL 密码被脱敏', !bootWithSecret.includes('bootSecret') && bootWithSecret.includes('http://***@127.0.0.1:7897'))
check('boot.log 里的 KV 密码被脱敏', !bootWithSecret.includes('inlinePass'))

/* ---------- 4. zip 结构合法 ---------- */
const zip = buildSupportZip(base)
check('zip 以 PK\\x03\\x04 开头', zip[0] === 0x50 && zip[1] === 0x4b && zip[2] === 3 && zip[3] === 4)
const eocd = Buffer.from([0x50, 0x4b, 0x05, 0x06])
check('zip 以 EOCD 收尾', zip.lastIndexOf(eocd) > 0)
check('zip 体积足够装下正文', zip.length > 500, zip.length)

console.log(failed === 0 ? '\n全部通过' : '\n失败 ' + failed + ' 项')
process.exit(failed === 0 ? 0 : 1)
