#!/usr/bin/env node
/**
 * P0 Task 1 自检：老设备兼容算法（legacyAlgorithms）。
 *
 * 覆盖四件事：
 *   1. LEGACY_ALGORITHMS 的组成 —— 每一项都必须被 ssh2 支持，且「现代算法在前、
 *      老算法追加在末尾」的顺序严格成立（顺序直接决定协商优先级，写反了就会
 *      优先降级到弱算法）。
 *   2. buildConnectConfig 的开关语义 —— 未开启时绝不挂 cfg.algorithms，
 *      开启时挂的就是同一份常量。
 *   3. isNegotiationError 的判定 —— 只有算法协商失败才算，网络错误不算
 *      （否则指纹探测会对每一个连不上的设备都做一次无意义的老算法重试）。
 *   4. 持久化 —— 连接落盘、导入导出白名单、以及「只改 legacyAlgorithms 时
 *      原有密码与代理密码必须原样保留」（Review Focus ①）。
 *
 * 全部是纯 Node 断言，不连网、不开串口。
 */
const path = require('path')
const fs = require('fs')
const os = require('os')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, '.tsc-verify')
fs.mkdirSync(OUT, { recursive: true })

let failed = 0
function check(name, cond, extra) {
  if (cond) {
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`)
  }
}

async function build() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-algo-'))
  const stub = path.join(OUT, 'electron-stub-legacy-algo.cjs')
  fs.writeFileSync(
    stub,
    [
      `exports.app = { getPath: () => ${JSON.stringify(userData)}, getName: () => 'ssh-workbench-verify', getVersion: () => '0.0.0-verify', isPackaged: false }`,
      "exports.safeStorage = { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(String(s)), decryptString: (b) => b.toString() }",
      "exports.net = { request: () => ({ on() {}, end() {}, write() {}, abort() {} }) }",
      ''
    ].join('\n')
  )
  const bundle = path.join(OUT, 'legacy-algo-bundle.cjs')
  await esbuild.build({
    stdin: {
      contents: [
        "export { LEGACY_ALGORITHMS, isNegotiationError, buildConnectConfig, probeHostFingerprint } from './src/main/ssh/connectConfig'",
        "export { saveConnection, listConnections } from './src/main/store/repository'",
        "export { getSecret, setSecret } from './src/main/store/vault'",
        "export { exportConnectionsToFile, applyImport } from './src/main/store/connTransfer'"
      ].join('\n'),
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
  return { bundle, userData }
}

/** 读连接库原始 JSON，用于确认「字段到底有没有落盘」而不是被默认值掩盖 */
function readRaw(userData) {
  const file = path.join(userData, 'data', 'connections.json')
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}

function rawEntry(userData, id) {
  return readRaw(userData).find((c) => c.id === id)
}

async function main() {
  let built
  try {
    built = await build()
  } catch (err) {
    failed++
    console.log('  FAIL 构建自检 bundle -> ' + (err instanceof Error ? err.message : String(err)))
    console.log('')
    console.log(`自检失败：${failed} 项\n`)
    process.exit(1)
  }
  const { bundle, userData } = built
  const mod = require(bundle)
  const {
    LEGACY_ALGORITHMS,
    isNegotiationError,
    buildConnectConfig,
    probeHostFingerprint,
    saveConnection,
    listConnections,
    getSecret,
    exportConnectionsToFile,
    applyImport
  } = mod

  /* ---------------------------------------------------------------- *
   * 1. LEGACY_ALGORITHMS 的组成
   * ---------------------------------------------------------------- */
  console.log('LEGACY_ALGORITHMS 组成')
  const C = require('ssh2/lib/protocol/constants')
  const groups = [
    ['kex', 'DEFAULT_KEX', 'SUPPORTED_KEX'],
    ['serverHostKey', 'DEFAULT_SERVER_HOST_KEY', 'SUPPORTED_SERVER_HOST_KEY'],
    ['cipher', 'DEFAULT_CIPHER', 'SUPPORTED_CIPHER'],
    ['hmac', 'DEFAULT_MAC', 'SUPPORTED_MAC']
  ]
  check('LEGACY_ALGORITHMS 已导出且是对象', !!LEGACY_ALGORITHMS && typeof LEGACY_ALGORITHMS === 'object', typeof LEGACY_ALGORITHMS)
  for (const [field, defaultName, supportedName] of groups) {
    const list = LEGACY_ALGORITHMS ? LEGACY_ALGORITHMS[field] : undefined
    const def = C[defaultName]
    const sup = C[supportedName]
    check(`${field} 是数组`, Array.isArray(list), typeof list)
    if (!Array.isArray(list)) continue
    check(
      `${field} 每一项都被 ssh2 支持`,
      list.length > 0 && list.every((a) => sup.includes(a)),
      list.filter((a) => !sup.includes(a))
    )
    check(
      `${field} 前段顺序严格等于 ${defaultName}`,
      JSON.stringify(list.slice(0, def.length)) === JSON.stringify(def),
      { got: list.slice(0, def.length), want: def }
    )
    check(`${field} 在默认集合之后追加了老算法`, list.length > def.length, { len: list.length, defLen: def.length })
    check(`${field} 无重复项`, new Set(list).size === list.length, list)
  }

  /* ---------------------------------------------------------------- *
   * 2. buildConnectConfig 的门控
   * ---------------------------------------------------------------- */
  console.log('')
  console.log('buildConnectConfig 门控')
  const settings = { strictHostKey: false }
  const target = { host: '127.0.0.1', port: 2222, username: 'root', authType: 'password' }
  const secret = { password: 'p@ss' }

  const absent = await buildConnectConfig(target, secret, settings)
  check('未声明时 cfg.algorithms 不挂载', absent.algorithms === undefined, absent.algorithms)

  const off = await buildConnectConfig({ ...target, legacyAlgorithms: false }, secret, settings)
  check('legacyAlgorithms: false 时 cfg.algorithms 不挂载', off.algorithms === undefined, off.algorithms)

  const on = await buildConnectConfig({ ...target, legacyAlgorithms: true }, secret, settings)
  check(
    'legacyAlgorithms: true 时挂载 LEGACY_ALGORITHMS',
    on.algorithms !== undefined && on.algorithms === LEGACY_ALGORITHMS,
    on.algorithms
  )
  check(
    '挂载内容四组算法齐全且顺序未被打乱',
    !!on.algorithms &&
      JSON.stringify(on.algorithms.kex) === JSON.stringify(LEGACY_ALGORITHMS.kex) &&
      JSON.stringify(on.algorithms.serverHostKey) === JSON.stringify(LEGACY_ALGORITHMS.serverHostKey) &&
      JSON.stringify(on.algorithms.cipher) === JSON.stringify(LEGACY_ALGORITHMS.cipher) &&
      JSON.stringify(on.algorithms.hmac) === JSON.stringify(LEGACY_ALGORITHMS.hmac),
    on.algorithms
  )
  check('挂载老算法不影响既有连接参数', on.host === '127.0.0.1' && on.port === 2222 && on.tryKeyboard === true, on)

  /* ---------------------------------------------------------------- *
   * 3. isNegotiationError
   * ---------------------------------------------------------------- */
  console.log('')
  console.log('isNegotiationError')
  const neg = (msg) => (typeof isNegotiationError === 'function' ? isNegotiationError(msg) : 'not-a-function')
  check('识别 ssh2 的 Unable to negotiate', neg('Unable to negotiate kex') === true, neg('Unable to negotiate kex'))
  check('识别 no matching algorithm', neg('no matching algorithm found') === true, neg('no matching algorithm found'))
  check('网络错误不算协商失败', neg('connect ECONNREFUSED 10.0.0.1:22') === false, neg('connect ECONNREFUSED 10.0.0.1:22'))
  check('认证失败不算协商失败', neg('认证失败：用户名或密码/密钥不正确') === false, neg('认证失败：用户名或密码/密钥不正确'))
  check('空串不算协商失败', neg('') === false, neg(''))

  /* ---------------------------------------------------------------- *
   * 4. 持久化 + 更新路径不误清凭据
   * ---------------------------------------------------------------- */
  console.log('')
  console.log('连接持久化')
  const proxy = { type: 'socks5', host: '127.0.0.1', port: 1080, username: 'u', password: 'proxy-pass' }
  const ssh = await saveConnection({
    name: '老设备',
    host: '10.0.0.9',
    port: 22,
    username: 'root',
    authType: 'password',
    password: 'p@ss',
    group: 'lab',
    tags: [],
    proxy,
    legacyAlgorithms: true
  })
  check('SSH 连接回读 legacyAlgorithms === true', ssh.legacyAlgorithms === true, ssh.legacyAlgorithms)
  const rawSsh = rawEntry(userData, ssh.id)
  check('SSH 连接落盘写入了 legacyAlgorithms', !!rawSsh && rawSsh.legacyAlgorithms === true, rawSsh && rawSsh.legacyAlgorithms)
  check('代理密码不落盘', !!rawSsh && rawSsh.proxy && rawSsh.proxy.password === undefined, rawSsh && rawSsh.proxy)

  const plain = await saveConnection({
    name: '普通设备',
    host: '10.0.0.10',
    port: 22,
    username: 'root',
    authType: 'password',
    password: 'p@ss',
    group: 'lab',
    tags: []
  })
  check('未开启时不回读 legacyAlgorithms', plain.legacyAlgorithms === undefined, plain.legacyAlgorithms)
  const rawPlain = rawEntry(userData, plain.id)
  check('未开启时不写冗余字段', !!rawPlain && !('legacyAlgorithms' in rawPlain), rawPlain && Object.keys(rawPlain))

  const serial = await saveConnection({
    name: '串口设备',
    kind: 'serial',
    host: '',
    port: 0,
    username: '',
    authType: 'password',
    serial: { path: 'COM3', baudRate: 115200 },
    group: 'lab',
    tags: [],
    legacyAlgorithms: true
  })
  check('串口连接忽略 legacyAlgorithms', serial.legacyAlgorithms === undefined, serial.legacyAlgorithms)
  const rawSerial = rawEntry(userData, serial.id)
  check('串口连接不写 legacyAlgorithms 字段', !!rawSerial && !('legacyAlgorithms' in rawSerial), rawSerial && Object.keys(rawSerial))

  console.log('')
  console.log('更新路径不误清凭据（Review Focus ①）')
  const before = await getSecret(ssh.id)
  check('前置条件：登录密码已写入保险箱', before.password === 'p@ss', before.password)
  check('前置条件：代理密码已写入保险箱', before.proxyPassword === 'proxy-pass', before.proxyPassword)

  const updated = await saveConnection({
    id: ssh.id,
    name: '老设备',
    host: '10.0.0.9',
    port: 22,
    username: 'root',
    authType: 'password',
    // 开关兼容算法的这一次保存：凭据三项一律 undefined（沿用原值），代理只改 password
    password: undefined,
    passphrase: undefined,
    group: 'lab',
    tags: [],
    proxy: { type: 'socks5', host: '127.0.0.1', port: 1080, username: 'u', password: undefined },
    legacyAlgorithms: true
  })
  const after = await getSecret(ssh.id)
  check('更新后登录密码保留', after.password === 'p@ss', after.password)
  check('更新后代理密码保留', after.proxyPassword === 'proxy-pass', after.proxyPassword)
  check('更新后代理定义仍在且不落盘密码', !!updated.proxy && updated.proxy.host === '127.0.0.1' && updated.proxy.password === undefined, updated.proxy)
  check('更新后 legacyAlgorithms 仍为 true', updated.legacyAlgorithms === true, updated.legacyAlgorithms)

  /* ---------------------------------------------------------------- *
   * 5. 导入导出往返
   * ---------------------------------------------------------------- */
  console.log('')
  console.log('导入导出往返')
  const file = path.join(userData, 'connections-export.swb')
  await exportConnectionsToFile(file, { includeSecrets: false })
  const envelope = JSON.parse(fs.readFileSync(file, 'utf8'))
  const entries = envelope.payload.connections
  const expSsh = entries.find((e) => e.ref === ssh.id)
  const expSerial = entries.find((e) => e.ref === serial.id)
  check('导出文件保留 SSH 的 legacyAlgorithms', !!expSsh && expSsh.legacyAlgorithms === true, expSsh && expSsh.legacyAlgorithms)
  check('导出文件不给串口写 legacyAlgorithms', !!expSerial && !('legacyAlgorithms' in expSerial), expSerial && Object.keys(expSerial))

  // 清掉本地开关，再导入一次：只有白名单真的把字段带过来，才会被恢复
  await saveConnection({
    id: ssh.id,
    name: '老设备',
    host: '10.0.0.9',
    port: 22,
    username: 'root',
    authType: 'password',
    group: 'lab',
    tags: [],
    legacyAlgorithms: false
  })
  const cleared = (await listConnections()).find((c) => c.id === ssh.id)
  check('前置条件：开关已清空', !!cleared && cleared.legacyAlgorithms === undefined, cleared && cleared.legacyAlgorithms)

  const imported = await applyImport(file, undefined, 'overwrite')
  check('导入过程本身成功', imported.added + imported.updated > 0, imported)
  const restored = (await listConnections()).find((c) => c.id === ssh.id)
  check('导入后 legacyAlgorithms 恢复 true', !!restored && restored.legacyAlgorithms === true, restored && restored.legacyAlgorithms)
  const importedSerial = (await listConnections()).find((c) => c.name === '串口设备')
  check('串口导入后仍不带 legacyAlgorithms', !!importedSerial && importedSerial.legacyAlgorithms === undefined, importedSerial && importedSerial.legacyAlgorithms)

  /* ---------------------------------------------------------------- *
   * 6. 指纹探测：默认算法谈不拢时自动改用老算法重试
   *
   * 起一个只认 diffie-hellman-group1-sha1 的 ssh2 Server 当作老固件设备。
   * 这条断言有真正的区分度：现代客户端默认列表里没有 group1-sha1，
   * 没有回退这段代码就一定拿不到指纹。
   * ---------------------------------------------------------------- */
  console.log('')
  console.log('指纹探测自动回退')
  const { Server, Client } = require('ssh2')
  const { generateKeyPairSync, getDiffieHellman } = require('node:crypto')
  // Electron BoringSSL 移除了 modp2（group1-sha1），但两者都不在 DEFAULT_KEX 里
  const legacyKex = (() => {
    try {
      getDiffieHellman('modp2')
      return 'diffie-hellman-group1-sha1'
    } catch {
      return 'diffie-hellman-group14-sha1'
    }
  })()
  const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({
    type: 'pkcs1',
    format: 'pem'
  })
  const legacyServer = new Server(
    { hostKeys: [hostKey], algorithms: { kex: [legacyKex] } },
    (client) => {
      // 服务端这一侧也会因为协商失败抛错，不接住会掀翻整个进程
      client.on('error', () => {})
      client.on('authentication', (ctx) => ctx.reject())
    }
  )
  await new Promise((resolve) => legacyServer.listen(0, '127.0.0.1', resolve))
  const legacyPort = legacyServer.address().port
  try {
    // 前置证明：这台「设备」对默认算法确实谈不拢，否则后面的成功说明不了回退生效
    const modernOutcome = await new Promise((resolve) => {
      const c = new Client()
      let settled = false
      const timer = setTimeout(() => done('timeout'), 6000)
      function done(v) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          c.end()
        } catch {
          /* ignore */
        }
        resolve(v)
      }
      c.on('error', (e) => done(e.message))
      c.on('ready', () => done('ready'))
      c.connect({ host: '127.0.0.1', port: legacyPort, username: 'probe', password: 'x', readyTimeout: 5000 })
    })
    check(
      '前置条件：默认算法与老设备协商必然失败',
      /negotiat|matching/i.test(String(modernOutcome)),
      modernOutcome
    )

    let probed = null
    let probeErr = null
    try {
      probed = await probeHostFingerprint('127.0.0.1', legacyPort, 10000)
    } catch (err) {
      probeErr = err instanceof Error ? err.message : String(err)
    }
    check(
      '协商失败后自动用老算法拿到指纹',
      !probeErr && typeof probed === 'string' && /^SHA256:[A-Za-z0-9+/]{43}$/.test(probed),
      probeErr ?? probed
    )

    // 真实 Client 带 LEGACY_ALGORITHMS 建连：不得同步抛出 Unsupported algorithm，且能跨过 KEX 进入认证阶段
    const legacyOutcome = await new Promise((resolve) => {
      const c = new Client()
      let settled = false
      const timer = setTimeout(() => done('timeout'), 6000)
      function done(v) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          c.end()
        } catch {
          /* ignore */
        }
        resolve(v)
      }
      c.on('error', (e) => done(e.message))
      c.on('ready', () => done('ready'))
      try {
        c.connect({
          host: '127.0.0.1',
          port: legacyPort,
          username: 'probe',
          password: 'x',
          algorithms: LEGACY_ALGORITHMS,
          readyTimeout: 5000
        })
      } catch (e) {
        done('sync-throw:' + (e instanceof Error ? e.message : String(e)))
      }
    })
    check(
      '携带 LEGACY_ALGORITHMS 连老设备可跨过 KEX（无 Unsupported algorithm 同步抛错）',
      /All configured authentication methods failed/i.test(String(legacyOutcome)),
      legacyOutcome
    )
  } finally {
    legacyServer.close()
  }

  console.log('')
  if (failed > 0) {
    console.log(`自检失败：${failed} 项\n`)
    process.exit(1)
  }
  console.log('自检全部通过\n')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
