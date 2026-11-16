/**
 * 「另存为新设备」凭据继承回归（主进程真实代码：repository + vault）。
 *
 * 背景：另存会生成一个新的 connection id，而密码存在 vault 里按 id 索引。
 * 旧实现只搬连接定义、不搬凭据，于是「另存为新设备并连接」之后立刻又弹
 * 一次密码框 —— 用户看到的是「我明明刚存过密码」。
 *
 * 锁住的契约（ConnectionInput.reuseSecretFrom）：
 *  1. 新建记录 + reuseSecretFrom 指向存在的连接 → 三个凭据字段都继承；
 *  2. 用户显式填写的值优先，留空的字段才继承；
 *  3. 显式传 '' 表示清除，不能被继承值顶回来；
 *  4. 不带 reuseSecretFrom 的新建行为不变（凭据为空）；
 *  5. 源 id 不存在时静默跳过，不抛错；
 *  6. 更新同 id 时不做跨 id 继承（undefined 仍是「保持原值」）；
 *  7. 继承只读源，源连接的凭据保持不变；
 *  8. 代理密码走同一套继承语义，且代理定义本身不落明文密码。
 *
 * 用法：node scripts/verify-conn-reuse.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.tsc-verify')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-reuse-'))
fs.mkdirSync(OUT_DIR, { recursive: true })

/* electron 桩：每台「电脑」一个数据目录 + 一把绑定该目录的密钥（模拟 DPAPI） */
const stub = path.join(OUT_DIR, 'electron-reuse-stub.cjs')
fs.writeFileSync(
  stub,
  `const crypto = require('crypto')
const dir = process.env.SW_MACHINE_DIR
const key = crypto.createHash('sha256').update('machine:' + dir).digest()
module.exports = {
  app: { getPath: () => dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString(s) {
      const iv = crypto.randomBytes(12)
      const c = crypto.createCipheriv('aes-256-gcm', key, iv)
      const d = Buffer.concat([c.update(s, 'utf8'), c.final()])
      return Buffer.concat([iv, c.getAuthTag(), d])
    },
    decryptString(b) {
      const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12))
      d.setAuthTag(b.subarray(12, 28))
      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')
    }
  }
}`
)

const bundle = path.join(OUT_DIR, 'reuse-bundle.cjs')
esbuild.buildSync({
  stdin: {
    contents: `
      export * from './src/main/store/repository'
      export { getSecret, hasSecret } from './src/main/store/vault'
    `,
    resolveDir: ROOT,
    loader: 'ts'
  },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle,
  external: ['ssh2'],
  logLevel: 'error',
  alias: { electron: stub, '@shared': path.join(ROOT, 'src/shared') }
})

/** 开一台新「电脑」：独立模块实例（独立缓存）+ 独立数据目录 + 独立密钥 */
function machine(name) {
  const dir = path.join(work, name)
  fs.mkdirSync(dir, { recursive: true })
  process.env.SW_MACHINE_DIR = dir
  delete require.cache[require.resolve(bundle)]
  const M = require(bundle)
  M.dir = dir
  return M
}

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

const PROXY = { type: 'socks5', host: '10.9.9.9', port: 1080, username: 'pu', password: 'proxy-old' }

async function main() {
  const M = machine('A')

  /* 原连接：三种凭据齐全 */
  const orig = await M.saveConnection({
    name: '原设备',
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authType: 'privateKey',
    privateKeyPath: 'C:/keys/id_rsa',
    group: '默认',
    tags: [],
    password: 'pw-old',
    passphrase: 'pp-old',
    proxy: PROXY
  })
  const base = {
    host: '10.0.0.1',
    port: 22,
    username: 'root',
    authType: 'privateKey',
    privateKeyPath: 'C:/keys/id_rsa',
    group: '默认',
    tags: []
  }

  /* ---------- 1：另存为新设备，凭据全部继承 ---------- */
  {
    const copy = await M.saveConnection({
      ...base,
      name: '另存设备',
      proxy: { type: 'socks5', host: '10.9.9.9', port: 1080, username: 'pu' },
      reuseSecretFrom: orig.id
    })
    const s = await M.getSecret(copy.id)
    check('另存生成新 id（不是原地覆盖）', copy.id !== orig.id, `${copy.id} vs ${orig.id}`)
    check('另存后密码沿用原连接', s.password === 'pw-old', JSON.stringify(s))
    check('另存后私钥口令沿用原连接', s.passphrase === 'pp-old', JSON.stringify(s))
    check('另存后代理密码沿用原连接', s.proxyPassword === 'proxy-old', JSON.stringify(s))
    check('另存后新连接被识别为「已保存凭据」', (await M.hasSecret(copy.id)) === true)
    check('代理定义里不落明文密码', copy.proxy && copy.proxy.password === undefined, JSON.stringify(copy.proxy))
  }

  /* ---------- 2：用户显式填写的优先，留空的才继承 ---------- */
  {
    const copy = await M.saveConnection({
      ...base,
      name: '另存改密码',
      password: 'pw-new',
      reuseSecretFrom: orig.id
    })
    const s = await M.getSecret(copy.id)
    check('显式填写的密码覆盖继承值', s.password === 'pw-new', JSON.stringify(s))
    check('未填写的口令仍然继承', s.passphrase === 'pp-old', JSON.stringify(s))
  }

  /* ---------- 3：不带 reuseSecretFrom 的新建行为不变 ---------- */
  {
    const plain = await M.saveConnection({ ...base, name: '裸新建' })
    const s = await M.getSecret(plain.id)
    check('不带 reuseSecretFrom 时新连接没有任何凭据',
      !s.password && !s.passphrase && !s.proxyPassword, JSON.stringify(s))
  }

  /* ---------- 4：源 id 不存在时静默跳过 ---------- */
  {
    let threw = null
    let ghost = null
    try {
      ghost = await M.saveConnection({ ...base, name: '源已删除', reuseSecretFrom: 'no-such-id' })
    } catch (e) {
      threw = e
    }
    check('源 id 不存在时不报错', threw === null, threw && threw.message)
    const s = ghost ? await M.getSecret(ghost.id) : { password: 'x' }
    check('源 id 不存在时新连接凭据为空',
      !s.password && !s.passphrase && !s.proxyPassword, JSON.stringify(s))
  }

  /* ---------- 5：更新同 id 不做跨 id 继承 ---------- */
  {
    const target = await M.saveConnection({ ...base, name: '待更新', password: 'pw-t' })
    const updated = await M.saveConnection({
      ...base,
      id: target.id,
      name: '待更新',
      // 编辑对话框里密码框留空 = undefined，同时带着 reuseSecretFrom（原连接 id）
      reuseSecretFrom: orig.id
    })
    const s = await M.getSecret(target.id)
    check('更新同 id 时密码保持原值（不被别的连接顶掉）',
      s.password === 'pw-t', JSON.stringify(s))
    check('更新同 id 不会新建记录', updated.id === target.id)
    check('更新同 id 后列表条数不变',
      (await M.listConnections()).filter((c) => c.name === '待更新').length === 1)
  }

  /* ---------- 6：显式传 '' 表示清除，继承值不能把它顶回来 ---------- */
  {
    const t = await M.saveConnection({ ...base, name: '要清空', password: 'pw-c' })
    await M.saveConnection({ ...base, id: t.id, name: '要清空', password: '', reuseSecretFrom: orig.id })
    const s = await M.getSecret(t.id)
    check('显式清空密码后不再保留任何密码', !s.password, JSON.stringify(s))
    check('清空后 hasSecret 为假', (await M.hasSecret(t.id)) === false)
  }

  /* ---------- 7：代理密码的继承与清除 ---------- */
  {
    const withProxy = await M.saveConnection({
      ...base,
      name: '代理留空',
      proxy: { type: 'socks5', host: '10.9.9.9', port: 1080, username: 'pu' },
      reuseSecretFrom: orig.id
    })
    check('代理密码留空时继承原连接',
      (await M.getSecret(withProxy.id)).proxyPassword === 'proxy-old',
      JSON.stringify(await M.getSecret(withProxy.id)))

    await M.saveConnection({
      ...base,
      id: withProxy.id,
      name: '代理留空',
      proxy: { type: 'socks5', host: '10.9.9.9', port: 1080, username: 'pu', password: '' },
      reuseSecretFrom: orig.id
    })
    check('代理密码显式传空串即清除',
      !(await M.getSecret(withProxy.id)).proxyPassword,
      JSON.stringify(await M.getSecret(withProxy.id)))
  }

  /* ---------- 8：继承只读源，源连接不受影响 ---------- */
  {
    const s = await M.getSecret(orig.id)
    check('原连接凭据保持不变',
      s.password === 'pw-old' && s.passphrase === 'pp-old' && s.proxyPassword === 'proxy-old',
      JSON.stringify(s))
    check('原连接仍只有一条', (await M.listConnections()).filter((c) => c.name === '原设备').length === 1)
  }

  /* ---------- 9：源连接被删掉后再另存，不能把凭据「借尸还魂」 ---------- */
  {
    const victim = await M.saveConnection({ ...base, name: '将被删除', password: 'pw-v' })
    await M.deleteConnection(victim.id)
    const after = await M.saveConnection({ ...base, name: '删后另存', reuseSecretFrom: victim.id })
    const s = await M.getSecret(after.id)
    check('源连接已删除时另存不带回凭据', !s.password, JSON.stringify(s))
  }

  fs.rmSync(work, { recursive: true, force: true })
  fs.rmSync(stub, { force: true })
  fs.rmSync(bundle, { force: true })
  console.log(`通过 ${pass}  失败 ${fail}`)
  fails.forEach((f) => console.log('  ✗ ' + f))
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.log('测试中断：' + (e && e.stack))
  process.exit(2)
})
