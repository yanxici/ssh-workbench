/**
 * 外部客户端导入测试：驱动主进程真实代码 src/main/store/externalImport.ts（不复制粘贴实现）。
 *
 * 判据（改动没落地时这些断言必须变红）：
 * - ssh_config：多别名必须拆成多条；Host * / Host *.prod 必须被忽略（否则会导入一个名叫 * 的连接）；
 *   IdentityFile 必须把 authType 变成 privateKey 并展开 ~；ProxyJump 必须记下依赖名，导入后绑成本机 id。
 * - MobaXterm：SubRep 必须转成 '客户A/网关' 形式的分组；RDP/VNC 行必须计入 skippedNonSsh 而不是被当成 SSH。
 * - Xshell：真实文件是 UTF-16LE + BOM，按 UTF-8 读会得到乱码名字 —— 断言中文 SessionName 精确相等。
 * - SecureCRT：端口是 8 位十六进制（000008ae = 2222），按十进制读会得到 8 或 NaN。
 * - FinalShell：JSON 里 host/port/user_name，非 SSH 协议必须跳过。
 * - apply：skip 不能重复入库；overwrite 不能把已有密码抹掉；跳板必须绑定到本机 id。
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, '.tsc-verify')
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-extimport-'))
fs.mkdirSync(OUT_DIR, { recursive: true })

/* electron 桩：每台「电脑」有自己的 userData 与密钥（模拟 DPAPI 绑定本机账户） */
const stub = path.join(OUT_DIR, 'electron-extimport-stub.cjs')
fs.writeFileSync(
  stub,
  'const crypto = require("crypto")\n' +
    'const dir = process.env.SW_MACHINE_DIR\n' +
    'const key = crypto.createHash("sha256").update("machine:" + dir).digest()\n' +
    'module.exports = {\n' +
    '  app: { getPath: () => dir },\n' +
    '  safeStorage: {\n' +
    '    isEncryptionAvailable: () => true,\n' +
    '    encryptString(s) {\n' +
    '      const iv = crypto.randomBytes(12)\n' +
    '      const c = crypto.createCipheriv("aes-256-gcm", key, iv)\n' +
    '      const d = Buffer.concat([c.update(s, "utf8"), c.final()])\n' +
    '      return Buffer.concat([iv, c.getAuthTag(), d])\n' +
    '    },\n' +
    '    decryptString(b) {\n' +
    '      const d = crypto.createDecipheriv("aes-256-gcm", key, b.subarray(0, 12))\n' +
    '      d.setAuthTag(b.subarray(12, 28))\n' +
    '      return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8")\n' +
    '    }\n' +
    '  }\n' +
    '}\n'
)

const bundle = path.join(OUT_DIR, 'extimport-bundle.cjs')
esbuild.buildSync({
  stdin: {
    contents:
      "export * from './src/main/store/externalImport'\n" +
      "export * from './src/main/store/repository'\n" +
      "export { getSecret, setSecret } from './src/main/store/vault'\n",
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
const fails = []
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    pass++
    return
  }
  fails.push(label + '\n    期望 ' + e + '\n    实际 ' + a)
}
function ok(cond, label) {
  if (cond) pass++
  else fails.push(label)
}

function writeFile(rel, content, enc) {
  const p = path.join(work, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content, enc)
  return p
}

const M = machine('parse')

/* ---------------- A. decodeTextAuto：BOM 识别 ---------------- */
eq(M.decodeTextAuto(Buffer.from('\uFEFFHost x', 'utf8')), 'Host x', 'A1 UTF-8 BOM 必须被剥离')
eq(
  M.decodeTextAuto(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('主机名', 'utf16le')])),
  '主机名',
  'A2 UTF-16LE BOM 必须解成中文'
)
const beBuf = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from('Host', 'utf16le').swap16()])
eq(M.decodeTextAuto(beBuf), 'Host', 'A3 UTF-16BE BOM 必须解成 ASCII')
eq(M.decodeTextAuto(Buffer.from('Host plain', 'utf8')), 'Host plain', 'A4 无 BOM 按 UTF-8')

/* ---------------- B. ~/.ssh/config ---------------- */
const SSH_CONFIG = [
  'Host web1',
  '  HostName 10.0.0.1',
  '  User root',
  '  Port 2222',
  '',
  'Host a1 a2',
  '  HostName a.example.com',
  '  User ubuntu',
  '  IdentityFile ~/.ssh/id_ed25519',
  '  ProxyJump bastion',
  '',
  'Host bastion',
  '  HostName 10.0.0.9',
  '  User jump',
  '',
  'Host *',
  '  ServerAliveInterval 30',
  '',
  'Host *.prod',
  '  User nobody',
  ''
].join('\n')
const cfg = M.parseSshConfig(SSH_CONFIG)
const cfgByName = new Map(cfg.connections.map((c) => [c.name, c]))
eq([...cfgByName.keys()], ['web1', 'a1', 'a2', 'bastion'], 'B1 多别名必须拆开、通配 Host 必须忽略')
eq(
  { host: cfgByName.get('web1').host, port: cfgByName.get('web1').port, username: cfgByName.get('web1').username },
  { host: '10.0.0.1', port: 2222, username: 'root' },
  'B2 HostName / Port / User 必须落到连接上'
)
eq(cfgByName.get('a1').authType, 'privateKey', 'B3 IdentityFile 必须切到 privateKey')
eq(
  cfgByName.get('a2').privateKeyPath,
  path.join(os.homedir(), '.ssh', 'id_ed25519'),
  'B4 IdentityFile 的 ~ 必须展开成绝对路径'
)
eq(cfgByName.get('a1').jumpNames, ['bastion'], 'B5 ProxyJump 必须记下依赖名')
eq(cfgByName.get('a2').host, 'a.example.com', 'B6 多别名的 HostName 必须一致')
eq(cfg.invalid, 0, 'B7 合法配置不应产生 invalid')
eq(cfg.skippedNonSsh, 0, 'B8 ssh_config 没有非 SSH 协议')

/* ---------------- C. MobaXterm .mxtsessions ---------------- */
const MOBA = [
  '[Bookmarks]',
  'SubRep=\u5ba2\u6237A\\\u7f51\u5173',
  'ImgNum=42',
  'SSH=#109#0%10.0.0.5%22%root%%-1%-1%%%22%%0%0%0%-1%-1%0%0',
  'RDP=#91#4%10.0.0.6%3389%administrator%%-1%-1%%%22%%0%0%0%-1%-1%0%0',
  'SubRep=\u5ba2\u6237B',
  'SSH=#109#0%10.0.0.7%2222%admin%%-1%-1%%%22%%0%0%0%-1%-1%0%0',
  // R-H25：自定义图标（120）的 SSH 必须照常导入
  'Custom=#120#0%10.0.0.9%22%deploy%%-1%-1%%%22%%0%0%0%-1%-1%0%0',
  // R-H25：图标仍是默认 109 的 RDP 不能被误当成 SSH
  'Fake=#109#4%10.0.0.10%3389%administrator%%-1%-1%%%22%%0%0%0%-1%-1%0%0',
  ''
].join('\r\n')
const moba = M.parseMobaXterm(MOBA)
eq(moba.connections.length, 3, 'C1 只导入 SSH 行')
eq(
  moba.connections.map((c) => c.group),
  ['\u5ba2\u6237A/\u7f51\u5173', '\u5ba2\u6237B', '\u5ba2\u6237B'],
  'C2 SubRep 的反斜杠必须转成分组分隔符'
)
eq(
  { name: moba.connections[0].name, host: moba.connections[0].host, port: moba.connections[0].port, username: moba.connections[0].username },
  { name: '10.0.0.5', host: '10.0.0.5', port: 22, username: 'root' },
  'C3 #109#0%host%port%user 字段顺序'
)
eq(moba.connections[1].port, 2222, 'C4 端口必须按十进制解析')
eq(moba.skippedNonSsh, 2, 'C5 RDP 行必须计入 skippedNonSsh')
/*
 * R-H25：#1 是图标号、#2 才是会话类型。按图标号判协议会同时判反两条 ——
 * 自定义图标的 SSH 被丢掉，图标留在 109 的 RDP 被当成 SSH 导进来。
 */
eq(
  moba.connections.map((c) => c.host),
  ['10.0.0.5', '10.0.0.7', '10.0.0.9'],
  'C6 按会话类型判定：#120#0 导入、#109#4 跳过'
)
eq(moba.connections[2].username, 'deploy', 'C7 自定义图标 SSH 的账号必须解析正确')

/* ---------------- D. Xshell .xsh（UTF-16LE + BOM） ---------------- */
const XSH = [
  '[CONNECTION]',
  'Protocol=SSH',
  'Host=10.0.0.8',
  'Port=22',
  '[SESSION]',
  'SessionName=\u5ba2\u6237A \u7f51\u5173',
  'UserName=deploy',
  ''
].join('\r\n')
const xshPath = writeFile('parse/xshell/ssh.xsh', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(XSH, 'utf16le')]))
const xshBuf = fs.readFileSync(xshPath)
const xsh = M.parseXshellFile(xshPath, xshBuf)
eq(xsh.connections.length, 1, 'D1 SSH 会话必须被解析')
eq(
  { name: xsh.connections[0].name, host: xsh.connections[0].host, port: xsh.connections[0].port, username: xsh.connections[0].username },
  { name: '\u5ba2\u6237A \u7f51\u5173', host: '10.0.0.8', port: 22, username: 'deploy' },
  'D2 UTF-16LE BOM 下的中文名 / 主机 / 端口 / 用户名'
)
const XSH_TELNET = ['[CONNECTION]', 'Protocol=TELNET', 'Host=10.0.0.8', 'Port=23', ''].join('\r\n')
const telnetPath = writeFile('parse/xshell/telnet.xsh', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(XSH_TELNET, 'utf16le')]))
const telnet = M.parseXshellFile(telnetPath, fs.readFileSync(telnetPath))
eq(telnet.connections.length, 0, 'D3 非 SSH 协议不得入库')
eq(telnet.skippedNonSsh, 1, 'D4 非 SSH 协议必须计数')

/* ---------------- E. SecureCRT .ini（十六进制端口） ---------------- */
const INI_A = ['S:"Protocol Name"=SSH2', 'S:"Hostname"=10.0.0.10', 'S:"Username"=root', 'D:"[SSH2] Port"=00000016', ''].join('\r\n')
const INI_B = ['S:"Protocol Name"=SSH2', 'S:"Hostname"=10.0.0.20', 'S:"Username"=admin', 'D:"[SSH2] Port"=000008ae', ''].join('\r\n')
const INI_RDP = ['S:"Protocol Name"=RDP', 'S:"Hostname"=10.0.0.30', ''].join('\r\n')
const iniA = writeFile('parse/securecrt/_0a1b2c3d.ini', INI_A)
const iniB = writeFile('parse/securecrt/_9f8e7d6c.ini', INI_B)
const iniRdp = writeFile('parse/securecrt/_rdp.ini', INI_RDP)
const crtA = M.parseSecureCrtFile(iniA, fs.readFileSync(iniA))
eq(crtA.connections[0].port, 22, 'E1 00000016 必须解成 22（十六进制）')
eq(crtA.connections[0].host, '10.0.0.10', 'E2 Hostname 解析')
eq(M.parseSecureCrtFile(iniB, fs.readFileSync(iniB)).connections[0].port, 2222, 'E3 000008ae 必须解成 2222')
const crtRdp = M.parseSecureCrtFile(iniRdp, fs.readFileSync(iniRdp))
eq(crtRdp.connections.length, 0, 'E4 非 SSH2 不得入库')
eq(crtRdp.skippedNonSsh, 1, 'E5 非 SSH2 必须计数')

/* ---------------- F. FinalShell conn_*.json ---------------- */
const FS_SSH = JSON.stringify({ name: '\u5ba2\u6237C-\u6838\u5fc3', host: '10.0.0.11', port: 22, user_name: 'ops' })
const FS_RDP = JSON.stringify({ name: 'rdp-box', host: '10.0.0.12', port: 3389, protocol: 'rdp' })
const fsA = writeFile('parse/finalshell/conn_aaa.json', FS_SSH)
const fsR = writeFile('parse/finalshell/conn_rdp.json', FS_RDP)
const ffA = M.parseFinalShellFile(fsA, fs.readFileSync(fsA))
eq(
  { name: ffA.connections[0].name, host: ffA.connections[0].host, port: ffA.connections[0].port, username: ffA.connections[0].username },
  { name: '\u5ba2\u6237C-\u6838\u5fc3', host: '10.0.0.11', port: 22, username: 'ops' },
  'F1 FinalShell JSON 字段'
)
const ffR = M.parseFinalShellFile(fsR, fs.readFileSync(fsR))
eq(ffR.connections.length, 0, 'F2 非 SSH 协议不得入库')
eq(ffR.skippedNonSsh, 1, 'F3 非 SSH 协议必须计数')

/* ---------------- G. 目录扫描：深度 8 / 上限 ---------------- */
const scanRoot = path.join(work, 'scan')
writeFile('scan/group/conn_ok.json', JSON.stringify({ name: 'ok', host: '10.0.0.11', port: 22, user_name: 'ops' }))
writeFile('scan/notes.txt', 'not a session file')
const deepEight = path.join('scan', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'conn_eight.json')
writeFile(deepEight, JSON.stringify({ name: 'eight', host: '10.0.0.13', port: 22, user_name: 'ops' }))
const deepNine = path.join('scan', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'conn_nine.json')
writeFile(deepNine, JSON.stringify({ name: 'nine', host: '10.0.0.14', port: 22, user_name: 'ops' }))
const scanned = M.scanConfigFiles(scanRoot, 'finalshell')
eq(scanned.length, 2, 'G1 只收 .json 且深度 8 以内（9 层的必须排除）')
ok(
  scanned.every((p) => path.basename(p) !== 'conn_nine.json'),
  'G2 深度超限的文件不得进入结果'
)
eq(M.scanConfigFiles(scanRoot, 'xshell').length, 0, 'G3 无匹配扩展名时返回空数组')

/* ---------------- H. preview / apply（临时 userData） ---------------- */
async function main() {
  const H = machine('apply')
  const sshPath = writeFile('apply/ssh_config', SSH_CONFIG)

  const preview0 = await H.previewExternalImport('ssh-config', [sshPath])
  eq(preview0.count, 4, 'H1 预览条数')
  eq(preview0.duplicates, 0, 'H2 空库时无重复')
  eq(preview0.withoutPasswordCount, 4, 'H3 外部导入不含密码，必须如实计数')
  eq(preview0.sampleNames.length, 4, 'H4 预览样本名')
  eq(
    preview0.groups.map((g) => g.name),
    ['SSH Config'],
    'H5 预览分组'
  )

  const r1 = await H.applyExternalImport('ssh-config', [sshPath], 'skip')
  eq({ added: r1.added, updated: r1.updated, skipped: r1.skipped }, { added: 4, updated: 0, skipped: 0 }, 'H6 首次导入 4 条')

  const list1 = await H.listConnections()
  eq(list1.length, 4, 'H7 入库条数')
  const web1 = list1.find((c) => c.name === 'web1')
  const bastion = list1.find((c) => c.name === 'bastion')
  eq(web1.kind, 'ssh', 'H8 外部导入一律是 ssh 连接')
  eq(web1.tags, [], 'H9 默认无标签')
  await H.setSecret(web1.id, { password: 'keep-me' })

  const r2 = await H.applyExternalImport('ssh-config', [sshPath], 'overwrite')
  eq({ added: r2.added, updated: r2.updated, skipped: r2.skipped }, { added: 0, updated: 4, skipped: 0 }, 'H10 overwrite 覆盖 4 条')
  eq((await H.getSecret(web1.id)).password, 'keep-me', 'H11 overwrite 不得抹掉已有密码')
  eq((await H.listConnections()).length, 4, 'H12 overwrite 不得产生重复行')

  const list2 = await H.listConnections()
  const web1b = list2.find((c) => c.name === 'web1')
  eq(web1b.id, web1.id, 'H13 overwrite 必须复用同一 id')
  eq(list2.find((c) => c.name === 'a1').proxyJump, [bastion.id], 'H14 ProxyJump 必须绑到本机 id')
  eq(list2.find((c) => c.name === 'a2').proxyJump, [bastion.id], 'H15 多别名各自绑定跳板')
  eq(list2.find((c) => c.name === 'bastion').proxyJump, undefined, 'H16 跳板自身没有上游')

  const r3 = await H.applyExternalImport('ssh-config', [sshPath], 'skip')
  eq({ added: r3.added, updated: r3.updated, skipped: r3.skipped }, { added: 0, updated: 0, skipped: 4 }, 'H17 skip 跳过重复')

  const preview3 = await H.previewExternalImport('ssh-config', [sshPath])
  eq(preview3.duplicates, 4, 'H18 重复计数必须与现有库一致')

  let modeErr = ''
  try {
    await H.applyExternalImport('ssh-config', [sshPath], 'merge')
  } catch (e) {
    modeErr = e.message
  }
  ok(modeErr.length > 0, 'H19 非法导入模式必须报错')

  // 文件型来源走完整链路：Xshell 目录 → 预览 → 入库
  const xshDir = path.join(work, 'apply-xshell')
  fs.mkdirSync(xshDir, { recursive: true })
  const xshFile = path.join(xshDir, 'session.xsh')
  fs.writeFileSync(xshFile, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(XSH, 'utf16le')]))
  const r4 = await H.applyExternalImport('xshell', [xshFile], 'skip')
  eq({ added: r4.added, skipped: r4.skipped }, { added: 1, skipped: 0 }, 'H20 文件型来源可解析入库')
  const xshConn = (await H.listConnections()).find((c) => c.name === '\u5ba2\u6237A \u7f51\u5173')
  ok(Boolean(xshConn), 'H21 Xshell 中文会话名入库')

  // MobaXterm：分组 + 跳过 RDP
  const mobaFile = path.join(xshDir, 'sessions.mxtsessions')
  fs.writeFileSync(mobaFile, MOBA, 'utf8')
  const previewM = await H.previewExternalImport('mobaxterm', [mobaFile])
  eq(previewM.count, 3, 'H22 MobaXterm 预览条数')
  eq(previewM.skippedNonSsh, 2, 'H23 MobaXterm 跳过 RDP 计数')

  if (fails.length > 0) {
    console.error('\n\u2717 verify-external-import 失败 ' + fails.length + ' 项（通过 ' + pass + ' 项）：\n')
    for (const f of fails) console.error('  - ' + f)
    process.exit(1)
  }
  console.log('\u2713 verify-external-import 通过：' + pass + ' 项断言')
}

main().catch((e) => {
  console.error('\u2717 verify-external-import 异常：' + (e && e.stack ? e.stack : e))
  process.exit(1)
})
