/**
 * 主机指纹自检：格式、旧格式兼容与迁移判定。
 *
 * 覆盖三个容易出错的点：
 * - 新指纹必须是 OpenSSH 风格的 SHA256:base64（无 padding），而不是十六进制；
 * - 旧版本写下的 SHA256:<64 位 hex> 必须被识别为「历史格式」并允许校验通过；
 * - 判定函数不能把新格式误判成旧格式（否则每台设备都会被强制迁移逻辑接走）。
 *
 * 用法：node scripts/verify-hostkey.cjs
 */
const path = require('path')
const fs = require('fs')
const { createHash } = require('crypto')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, '.tsc-verify')
fs.mkdirSync(OUT, { recursive: true })

let failed = 0
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`)
  else {
    failed++
    console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`)
  }
}

async function build() {
  // connectConfig 只用到纯函数，但依赖链里含 electron（存储路径）与 ssh2，
  // 打成一个 bundle 并把 electron 换成本地 stub，避免拉起整个 Electron 运行时
  const stub = path.join(OUT, 'electron-stub-hostkey.cjs')
  fs.writeFileSync(stub, "exports.app = { getPath: () => require('node:os').tmpdir() }\n")
  const bundle = path.join(OUT, 'connect-config-bundle.cjs')
  await esbuild.build({
    stdin: {
      contents:
        "export { hostKeyFingerprint, legacyHostKeyFingerprint, isLegacyFingerprint } from './src/main/ssh/connectConfig'",
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['ssh2'],
    logLevel: 'error',
    alias: { '@shared': path.join(ROOT, 'src/shared') },
    plugins: [
      {
        name: 'stub-electron',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: stub }))
        }
      }
    ]
  })
  return bundle
}

async function main() {
  const bundle = await build()
  const mod = require(bundle)

  /* 造一段「主机公钥」字节：真实格式不参与计算，只需要稳定的二进制 */
  const raw = createHash('sha256').update('ssh-workbench-host-key').digest()

  console.log('\nfingerprint format: 新格式必须是 OpenSSH 风格')
  const fp = mod.hostKeyFingerprint(raw)
  check('带 SHA256: 前缀', fp.startsWith('SHA256:'), fp)
  const body = fp.slice('SHA256:'.length)
  check('主体是 base64 字符集', /^[A-Za-z0-9+/]+$/.test(body), body)
  check('不带 base64 padding', !body.includes('='), body)
  check('主体长度 = 43（32 字节 sha256）', body.length === 43, body.length)
  check(
    '与 openssl 手算一致',
    fp === 'SHA256:' + createHash('sha256').update(raw).digest('base64').replace(/=+$/, ''),
    fp
  )

  console.log('\nlegacy format: 旧版本存的十六进制必须能识别出来')
  const legacy = mod.legacyHostKeyFingerprint(raw)
  check('旧格式是 SHA256:<64 hex>', /^SHA256:[0-9a-f]{64}$/.test(legacy), legacy)
  check(
    '旧格式与 openssl 手算一致',
    legacy === 'SHA256:' + createHash('sha256').update(raw).digest('hex'),
    legacy
  )
  check('旧格式被识别为 legacy', mod.isLegacyFingerprint(legacy) === true)
  check('新格式不被识别为 legacy', mod.isLegacyFingerprint(fp) === false, fp)
  check(
    '无前缀十六进制不算 legacy',
    mod.isLegacyFingerprint(createHash('sha256').update(raw).digest('hex')) === false
  )
  check('空串不算 legacy', mod.isLegacyFingerprint('') === false)
  check('大写十六进制不算 legacy（旧实现只写小写）', mod.isLegacyFingerprint('SHA256:' + 'A'.repeat(64)) === false)

  console.log('\nkey independence: 不同密钥必须得到不同指纹')
  const raw2 = createHash('sha256').update('another-host-key').digest()
  check('两个密钥指纹不同', mod.hostKeyFingerprint(raw) !== mod.hostKeyFingerprint(raw2))
  check('同一密钥指纹稳定', mod.hostKeyFingerprint(raw) === mod.hostKeyFingerprint(Buffer.from(raw)))

  console.log('')
  if (failed > 0) {
    console.log(`主机指纹自检失败：${failed} 项\n`)
    process.exit(1)
  }
  console.log('主机指纹自检全部通过\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
