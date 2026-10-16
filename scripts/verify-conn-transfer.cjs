/**
 * 连接导出 / 导入测试：模拟两台电脑（各自的数据目录 + 各自的加密密钥，互相解不开），
 * 驱动主进程真实代码 connTransfer / repository / vault。
 * 覆盖：带凭据导出、私钥去重、跳板机重映射、代理密码、口令加密 / 错口令 / 篡改、
 *       重复导入（跳过 / 覆盖）、只导出部分分组、坏文件、3000 条规模。
 * 用法：node scripts/verify-conn-transfer.cjs
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.tsc-verify')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-transfer-'))
fs.mkdirSync(OUT_DIR, { recursive: true })

/* electron 桩：每台「电脑」有自己的 userData 和密钥，模拟 DPAPI 绑定本机账户 */
const stub = path.join(OUT_DIR, 'electron-transfer-stub.cjs')
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
const bundle = path.join(OUT_DIR, 'transfer-bundle.cjs')
esbuild.buildSync({
  stdin: {
    contents: `
      export * from './src/main/store/connTransfer'
      export * from './src/main/store/repository'
      export { getSecret } from './src/main/store/vault'
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
async function rejects(name, p, pattern) {
  try {
    await p
    check(name, false, '没有报错')
  } catch (e) {
    check(name, pattern.test(e.message), `报错：${e.message}`)
  }
}
const byName = (list) => new Map(list.map((c) => [c.name, c]))

async function main() {
  /* ================= 电脑 A：准备数据 ================= */
  const A = machine('A')
  const keyFile = path.join(A.dir, 'node_key')
  const keyData = Buffer.from('-----BEGIN RSA PRIVATE KEY-----\nTESTKEY\n-----END RSA PRIVATE KEY-----\n')
  fs.writeFileSync(keyFile, keyData)

  const mk = (o) =>
    A.saveConnection({ host: '10.0.0.1', port: 22, username: 'root', authType: 'password', group: 'G1', tags: [], ...o })
  await mk({ name: '网关-1', password: 'pw-c1', port: 1001 })
  await mk({ name: '网关-2', password: 'pw-c2', port: 1002, tags: ['网'], color: '#ff0000', remark: '备注' })
  await mk({ name: '无密码', port: 1003 })
  for (let i = 0; i < 5; i++) {
    await mk({ name: `节点-${i}`, port: 2000 + i, authType: 'privateKey', privateKeyPath: keyFile, passphrase: i === 0 ? 'kp' : undefined, group: 'G2' })
  }
  await mk({ name: '丢私钥', port: 3000, authType: 'privateKey', privateKeyPath: path.join(A.dir, 'nope'), group: 'G2' })
  const jump = await mk({ name: '跳板', port: 4000, password: 'pw-jump', group: 'G2' })
  await mk({
    name: '经跳板',
    port: 4001,
    password: 'pw-target',
    group: 'G1',
    proxyJump: [jump.id],
    proxy: { type: 'socks5', host: '1.2.3.4', port: 1080, username: 'pu', password: 'proxy-pw' }
  })
  const listA = await A.listConnections()

  /* ================= 直接拷数据目录的问题（对照） ================= */
  {
    const Copy = machine('copy')
    fs.mkdirSync(path.join(Copy.dir, 'data'), { recursive: true })
    for (const f of ['connections.json', 'secrets.json']) {
      fs.copyFileSync(path.join(A.dir, 'data', f), path.join(Copy.dir, 'data', f))
    }
    const c1 = (await Copy.listConnections()).find((c) => c.name === '网关-1')
    check('对照：直接拷目录密码解不开', !(await Copy.getSecret(c1.id)).password)
  }

  /* ================= 导出 ================= */
  const fPlain = path.join(work, 'plain.swconn')
  const e1 = await A.exportConnectionsToFile(fPlain, { includeSecrets: true })
  check('导出条数', e1.count === listA.length, `${e1.count}/${listA.length}`)
  check('5 台共用私钥只打包 1 份', e1.keyCount === 1, `实际 ${e1.keyCount}`)
  check('统计无密码连接', e1.noPassword === 1, `实际 ${e1.noPassword}`)
  check('统计丢失私钥', e1.missingKeys === 1, `实际 ${e1.missingKeys}`)
  check('全量导出不丢跳板', e1.droppedJumps === 0)
  check('导出后不留临时文件', !fs.existsSync(`${fPlain}.tmp`))

  const fLock = path.join(work, 'locked.swconn')
  await A.exportConnectionsToFile(fLock, { includeSecrets: true, passphrase: 'abcd1234' })
  const rawLock = fs.readFileSync(fLock, 'utf8')
  check('加密文件里没有明文密码', !rawLock.includes('pw-c1') && !rawLock.includes('TESTKEY'))
  check('加密文件里没有连接名', !rawLock.includes('网关'))
  await rejects('口令太短被拒绝', A.exportConnectionsToFile(path.join(work, 'x'), { includeSecrets: true, passphrase: 'ab' }), /至少/)

  const fNoSec = path.join(work, 'nosecret.swconn')
  await A.exportConnectionsToFile(fNoSec, { includeSecrets: false })
  const rawNoSec = fs.readFileSync(fNoSec, 'utf8')
  check('不带凭据时没有密码和私钥', !rawNoSec.includes('pw-') && !rawNoSec.includes('TESTKEY') && !rawNoSec.includes('proxy-pw'))

  const fG1 = path.join(work, 'g1.swconn')
  const eG1 = await A.exportConnectionsToFile(fG1, { includeSecrets: true, groups: ['G1'] })
  check('只导出 G1', eG1.count === listA.filter((c) => c.group === 'G1').length, `实际 ${eG1.count}`)
  check('G1 不含私钥', eG1.keyCount === 0)
  check('跳板机不在范围内被去掉', eG1.droppedJumps === 1, `实际 ${eG1.droppedJumps}`)
  await rejects('空范围报错', A.exportConnectionsToFile(path.join(work, 'x'), { includeSecrets: true, groups: ['不存在'] }), /没有连接/)

  /* ================= 电脑 B：导入（明文文件） ================= */
  const B = machine('B')
  const pv = await B.previewImport(fPlain)
  check('预览条数', pv.count === listA.length && pv.duplicates === 0, JSON.stringify({ count: pv.count, dup: pv.duplicates }))
  check('预览分组', pv.groups.map((g) => g.name).join() === 'G1,G2')
  check('预览私钥数', pv.keyCount === 1)

  const r1 = await B.applyImport(fPlain, undefined, 'skip')
  check('导入新增', r1.added === listA.length && r1.skipped === 0, JSON.stringify(r1))
  check('私钥写入 1 个文件', r1.keysWritten === 1)

  const listB = await B.listConnections()
  const mB = byName(listB)
  check('B 上连接 id 是新生成的', listB.every((c) => !listA.some((a) => a.id === c.id)))
  check('密码在 B 上能解开', (await B.getSecret(mB.get('网关-1').id)).password === 'pw-c1')
  check('B 的 secrets 用 B 的密钥加密', !fs.readFileSync(path.join(B.dir, 'data', 'secrets.json'), 'utf8').includes('pw-c1'))
  const c2 = mB.get('网关-2')
  check('标签/颜色/备注保留', c2.tags[0] === '网' && c2.color === '#ff0000' && c2.remark === '备注')

  const nodes = listB.filter((c) => c.name.startsWith('节点-'))
  const kp = nodes[0].privateKeyPath
  check('私钥路径改到 B 的数据目录', kp && kp.startsWith(path.join(B.dir, 'data', 'keys')), kp)
  check('私钥内容一致', kp && fs.readFileSync(kp).equals(keyData))
  check('5 台节点指向同一私钥文件', nodes.length === 5 && nodes.every((c) => c.privateKeyPath === kp))
  check('私钥口令带过来', (await B.getSecret(mB.get('节点-0').id)).passphrase === 'kp')
  check('丢私钥的连接保留为私钥认证但没有路径', mB.get('丢私钥').authType === 'privateKey' && !mB.get('丢私钥').privateKeyPath)

  const tgt = mB.get('经跳板')
  check('跳板机引用改成 B 上的 id', tgt.proxyJump?.length === 1 && tgt.proxyJump[0] === mB.get('跳板').id)
  check('代理配置保留且不落明文', tgt.proxy?.host === '1.2.3.4' && tgt.proxy.password === undefined)
  check('代理密码进凭据', (await B.getSecret(tgt.id)).proxyPassword === 'proxy-pw')
  check('connections.json 里没有明文密码', !fs.readFileSync(path.join(B.dir, 'data', 'connections.json'), 'utf8').includes('pw-'))

  /* ---- 重复导入 ---- */
  const pv2 = await B.previewImport(fPlain)
  check('再次预览全部识别为重复', pv2.duplicates === listA.length, `实际 ${pv2.duplicates}`)
  const r2 = await B.applyImport(fPlain, undefined, 'skip')
  check('跳过模式不新增', r2.added === 0 && r2.skipped === listA.length && r2.keysWritten === 0, JSON.stringify(r2))
  check('跳过后条数不变', (await B.listConnections()).length === listA.length)

  // B 上改密码，覆盖导入后应恢复成文件里的
  await B.saveConnection({ ...mB.get('网关-1'), password: 'changed-on-B' })
  const r3 = await B.applyImport(fPlain, undefined, 'overwrite')
  check('覆盖模式', r3.updated === listA.length && r3.added === 0, JSON.stringify(r3))
  check('覆盖后密码恢复', (await B.getSecret(mB.get('网关-1').id)).password === 'pw-c1')
  check('覆盖后 id 不变', (await B.listConnections()).every((c) => listB.some((b) => b.id === c.id)))

  // 无凭据文件覆盖：不应清掉已有密码
  await B.applyImport(fNoSec, undefined, 'overwrite')
  check('无凭据文件覆盖保留原密码', (await B.getSecret(mB.get('网关-1').id)).password === 'pw-c1')
  check('无凭据文件覆盖保留私钥路径', byName(await B.listConnections()).get('节点-1').privateKeyPath === kp)

  /* ================= 电脑 C：加密文件 ================= */
  const C = machine('C')
  check('识别为加密文件', (await C.inspectImportFile(fLock)).encrypted === true)
  await rejects('加密文件不给口令', C.previewImport(fLock), /口令/)
  await rejects('口令错误', C.previewImport(fLock, 'wrong-pass'), /口令错误/)
  const tampered = JSON.parse(rawLock)
  const d = Buffer.from(tampered.data, 'base64')
  d[10] ^= 0xff
  tampered.data = d.toString('base64')
  const fTamper = path.join(work, 'tamper.swconn')
  fs.writeFileSync(fTamper, JSON.stringify(tampered))
  await rejects('文件被篡改', C.previewImport(fTamper, 'abcd1234'), /口令错误|损坏/)
  const evil = { ...JSON.parse(rawLock), kdf: { ...JSON.parse(rawLock).kdf, N: 2 ** 24 } }
  const fEvil = path.join(work, 'evil.swconn')
  fs.writeFileSync(fEvil, JSON.stringify(evil))
  await rejects('异常加密参数被拒绝', C.previewImport(fEvil, 'abcd1234'), /格式不正确/)

  const rC = await C.applyImport(fLock, 'abcd1234', 'skip')
  check('加密文件导入成功', rC.added === listA.length, JSON.stringify(rC))
  const mC = byName(await C.listConnections())
  check('加密文件导入后密码可用', (await C.getSecret(mC.get('经跳板').id)).password === 'pw-target')

  /* ================= 坏文件 ================= */
  const bad = (name, content) => {
    const f = path.join(work, `bad-${name}.swconn`)
    fs.writeFileSync(f, content)
    return f
  }
  await rejects('非 JSON', C.previewImport(bad('a', 'hello')), /无法解析/)
  await rejects('别的 JSON', C.previewImport(bad('b', '{"a":1}')), /不是 SSH Workbench/)
  await rejects('版本过新', C.previewImport(bad('c', JSON.stringify({ format: 'ssh-workbench-connections', version: 99 }))), /版本/)
  const mixed = bad(
    'd',
    JSON.stringify({
      format: 'ssh-workbench-connections',
      version: 1,
      encrypted: false,
      payload: {
        connections: [
          { ref: 'x', name: 'ok', host: 'h', port: 22, username: 'u', authType: 'password', group: '', tags: [] },
          { name: '缺地址', port: 22, username: 'u', authType: 'password' },
          { name: '端口错', host: 'h', port: 99999, username: 'u', authType: 'password' },
          { name: '认证错', host: 'h', port: 22, username: 'u', authType: 'evil' },
          null
        ],
        keys: { k: { name: '../../evil', data: Buffer.from('x').toString('base64') } }
      }
    })
  )
  const D = machine('D')
  const pvD = await D.previewImport(mixed)
  check('坏条目被识别', pvD.count === 1 && pvD.invalid === 4, JSON.stringify({ count: pvD.count, invalid: pvD.invalid }))
  const rD = await D.applyImport(mixed, undefined, 'skip')
  check('只导入合法条目', rD.added === 1 && rD.invalid === 4)
  check('空分组归到默认', (await D.listConnections())[0].group === '默认')
  check('私钥文件名不能跳出目录', !fs.existsSync(path.join(D.dir, 'evil')) && !fs.existsSync(path.join(D.dir, 'data', 'evil')))

  /* ================= 规模：3000 条 ================= */
  const S = machine('S')
  const sKey = path.join(S.dir, 'k')
  fs.writeFileSync(sKey, keyData)
  const sConns = Array.from({ length: 3000 }, (_, i) => ({
    id: `s${i}`,
    name: `设备-${i}`,
    host: '192.168.1.200',
    port: 10000 + i,
    username: 'root',
    authType: i % 2 ? 'privateKey' : 'password',
    privateKeyPath: i % 2 ? sKey : undefined,
    group: `G${i % 30}`,
    tags: [],
    createdAt: 1,
    updatedAt: 1
  }))
  await S.bulkUpsertConnections(sConns)
  for (const c of sConns.filter((c) => c.authType === 'password').slice(0, 50)) {
    await S.saveConnection({ ...c, password: `p${c.id}` })
  }
  const fBig = path.join(work, 'big.swconn')
  let t = Date.now()
  const eBig = await S.exportConnectionsToFile(fBig, { includeSecrets: true, passphrase: 'bigpass' })
  const tExport = Date.now() - t
  const T = machine('T')
  t = Date.now()
  const rBig = await T.applyImport(fBig, 'bigpass', 'skip')
  const tImport = Date.now() - t
  check('3000 条导出', eBig.count === 3000 && eBig.keyCount === 1)
  check('3000 条导入', rBig.added === 3000, JSON.stringify(rBig))
  const tl = await T.listConnections()
  check('3000 条落盘', tl.length === 3000)
  check('抽查密码', (await T.getSecret(tl.find((c) => c.name === '设备-0').id)).password === 'ps0')
  console.log(`3000 条：导出 ${tExport}ms，导入 ${tImport}ms，文件 ${(fs.statSync(fBig).size / 1024).toFixed(0)}KB`)

  fs.rmSync(work, { recursive: true, force: true })
  fs.rmSync(bundle, { force: true })
  fs.rmSync(stub, { force: true })
  console.log(`通过 ${pass}  失败 ${fail}`)
  fails.forEach((f) => console.log('  ✗ ' + f))
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.log('测试中断：' + (e && e.stack))
  process.exit(2)
})
