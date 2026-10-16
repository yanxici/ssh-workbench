/**
 * 私钥导入校验 + 真实认证测试：
 *  1. inspectPrivateKey 对各种文件的判断（PEM RSA / OpenSSH ed25519 / 加密私钥 / 公钥 / 垃圾 / 空文件）
 *  2. 用指定私钥文件对本地 ssh2 测试服务器做公钥认证，确认能真正登录
 * 用法：node scripts/verify-privatekey.cjs [私钥文件路径，可选]
 * 注意：脚本不会打印私钥内容
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')
const { Client, Server, utils } = require('ssh2')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.tsc-verify')
fs.mkdirSync(OUT_DIR, { recursive: true })
const bundle = path.join(OUT_DIR, 'privatekey-bundle.cjs')
esbuild.buildSync({
  entryPoints: [path.join(ROOT, 'src/main/util/privateKey.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle,
  external: ['ssh2'],
  logLevel: 'error'
})
const { inspectPrivateKey } = require(bundle)

let pass = 0
let fail = 0
const fails = []
function check(name, ok, detail = '') {
  if (ok) pass++
  else {
    fail++
    fails.push(`${name} ${detail}`)
  }
}
function expectOk(name, buf, wantEncrypted) {
  try {
    const r = inspectPrivateKey(buf)
    check(name, r.encrypted === wantEncrypted, `encrypted=${r.encrypted}`)
    return r
  } catch (e) {
    check(name, false, `抛错：${e.message}`)
    return null
  }
}
function expectReject(name, buf, pattern) {
  try {
    inspectPrivateKey(buf)
    check(name, false, '未被拒绝')
  } catch (e) {
    check(name, pattern.test(e.message), `错误信息：${e.message}`)
  }
}

/* ---------- 1. 格式判断 ---------- */
const rsa = utils.generateKeyPairSync('rsa', { bits: 2048 })
const ed = utils.generateKeyPairSync('ed25519')
const encRsa = utils.generateKeyPairSync('rsa', { bits: 2048, passphrase: 'secret', cipher: 'aes256-cbc' })

expectOk('OpenSSH RSA 私钥', Buffer.from(rsa.private), false)
expectOk('OpenSSH ed25519 私钥', Buffer.from(ed.private), false)
expectOk('加密私钥识别为需要口令', Buffer.from(encRsa.private), true)
expectOk('CRLF 换行的私钥', Buffer.from(ed.private.replace(/\n/g, '\r\n')), false)
expectReject('公钥被拒绝', Buffer.from(rsa.public), /公钥/)
expectReject('空文件被拒绝', Buffer.alloc(0), /为空/)
expectReject('普通文本被拒绝', Buffer.from('hello world\n'), /无法识别|不是私钥/)
expectReject('二进制垃圾被拒绝', Buffer.from(Array.from({ length: 2048 }, () => Math.floor(Math.random() * 256))), /无法识别|不是私钥/)
expectReject('超大文件被拒绝', Buffer.alloc(70 * 1024, 65), /过大/)

const userKeyPath = process.argv[2]
let userKey = null
if (userKeyPath) {
  userKey = fs.readFileSync(userKeyPath)
  const r = expectOk(`用户私钥 ${path.basename(userKeyPath)}`, userKey, false)
  if (r) console.log(`用户私钥类型：${r.type}，加密：${r.encrypted}`)
}

/* ---------- 2. 真实公钥认证 ---------- */
async function tryAuth(name, privateKey, passphrase, allowedPub) {
  const hostKey = utils.generateKeyPairSync('ed25519').private
  const allowed = utils.parseKey(allowedPub)
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('error', () => {})
    client.on('authentication', (ctx) => {
      if (ctx.method !== 'publickey') return ctx.reject(['publickey'])
      const same = ctx.key.algo && Buffer.compare(ctx.key.data, allowed.getPublicSSH()) === 0
      if (!same) return ctx.reject(['publickey'])
      if (!ctx.signature) return ctx.accept() // 预检
      ctx.accept()
    })
    client.on('ready', () => client.end())
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const ok = await new Promise((resolve) => {
    const c = new Client()
    c.on('ready', () => {
      c.end()
      resolve(true)
    })
    c.on('error', (e) => resolve(e.message))
    c.connect({ host: '127.0.0.1', port, username: 'root', privateKey, passphrase, readyTimeout: 8000 })
  })
  server.close()
  check(name, ok === true, ok === true ? '' : `登录失败：${ok}`)
}

async function main() {
  await tryAuth('生成的 RSA 私钥能登录', rsa.private, undefined, rsa.public)
  await tryAuth('加密私钥 + 口令能登录', encRsa.private, 'secret', encRsa.public)
  if (userKey) {
    // 用私钥自己推出公钥，让测试服务器只放行这把钥匙
    const parsed = utils.parseKey(userKey)
    const key = Array.isArray(parsed) ? parsed[0] : parsed
    const pub = `${key.type} ${key.getPublicSSH().toString('base64')}`
    await tryAuth(`用户私钥 ${path.basename(userKeyPath)} 能登录`, userKey, undefined, pub)
  }

  fs.rmSync(bundle, { force: true })
  console.log(`通过 ${pass}  失败 ${fail}`)
  fails.forEach((f) => console.log('  ✗ ' + f))
  process.exit(fail ? 1 : 0)
}
main().catch((e) => {
  console.log('测试中断：' + e.message)
  process.exit(2)
})
