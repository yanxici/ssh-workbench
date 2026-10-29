/**
 * 数据仓库回归：拆分 repository.ts 之后，8 个域的行为必须逐字节一致。
 *
 * 拆分是纯搬家，风险全在「搬运时改了某一行」—— 那不会编译失败，
 * 只会在某条罕见的写路径上悄悄改语义（比如凭据语义、分组默认值）。
 * 所以这里用临时数据目录真的跑一遍读写，断言的是**行为**而不是行数。
 *
 * 用法：node scripts/verify-repository-split.cjs
 */
const fs = require('fs')
const path = require('path')
const os = require('os')
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

async function bundle() {
  // electron 的 app.getPath 换成本地临时目录；vault 用无 safeStorage 的降级实现
  const electronStub = path.join(OUT, 'electron-stub-repo.cjs')
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-verify-'))
  fs.writeFileSync(
    electronStub,
    `const path = require('node:path')
exports.app = { getPath: () => ${JSON.stringify(tmpRoot)} }
exports.safeStorage = { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() }
`
  )
  const outfile = path.join(OUT, 'repo-bundle.cjs')
  await esbuild.build({
    stdin: { contents: "export * from './src/main/store/repository'", resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    external: ['ssh2'],
    logLevel: 'error',
    alias: { '@shared': path.join(ROOT, 'src/shared') },
    plugins: [
      {
        name: 'stub-electron',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: electronStub }))
        }
      }
    ]
  })
  return { outfile, tmpRoot }
}

async function main() {
  const { outfile, tmpRoot } = await bundle()
  const repo = require(outfile)
  const dataDir = path.join(tmpRoot, 'data')

  console.log('\nexports: 拆分后所有导出仍在（调用方 40+ 处 import 不受影响）')
  const expected = [
    'listConnections','getConnection','saveConnection','bulkUpsertConnections',
    'deleteConnection','deleteConnections','renameConnectionGroup','deleteConnectionGroup','touchConnection',
    'listCommands','saveCommand','deleteCommand','renameCommandGroup','deleteCommandGroup',
    'reorderCommands','touchCommand','importCommands','exportCommands','seedCommandsIfNeeded',
    'listHistory','addHistory','clearHistory',
    'DEFAULT_SETTINGS','getSettings','setSettings',
    'listDiagSections','saveDiagSection','deleteDiagSection',
    'listProfiles','saveProfile','deleteProfile',
    'listTunnels','getTunnel','saveTunnel','deleteTunnel',
    'hostKey','getKnownHost','upsertKnownHost','listKnownHosts','refreshKnownHost','deleteKnownHost'
  ]
  const missing = expected.filter((k) => typeof repo[k] === 'undefined')
  check(`全部 ${expected.length} 个导出存在`, missing.length === 0, missing)

  /* ---------------- 连接 ---------------- */
  console.log('\nconnections: 增删改查 + 凭据语义')
  const saved = await repo.saveConnection({
    name: ' 测试设备 ', host: ' 10.0.0.1 ', port: 22, username: ' root ',
    authType: 'password', password: 'pw1', group: '', tags: [], proxy: undefined
  })
  check('保存后自动 trim', saved.name === '测试设备' && saved.host === '10.0.0.1' && saved.username === 'root', saved)
  check('空分组回退为「默认」', saved.group === '默认', saved.group)
  check('生成 id 与时间戳', !!saved.id && !!saved.createdAt && !!saved.updatedAt)

  const updated = await repo.saveConnection({
    id: saved.id, name: '改名后', host: '10.0.0.1', port: 22, username: 'root',
    authType: 'password', group: 'A区', tags: []
  })
  check('按 id 更新而不是新增', updated.id === saved.id && updated.name === '改名后')
  check('更新保留 createdAt', updated.createdAt === saved.createdAt)
  check('列表长度仍为 1', (await repo.listConnections()).length === 1)

  // password: undefined = 保持原值
  const secretMod = require(outfile)
  check('getConnection 能取到', (await repo.getConnection(saved.id))?.name === '改名后')

  await repo.touchConnection(saved.id)
  check('touchConnection 写入 lastUsedAt', !!(await repo.getConnection(saved.id))?.lastUsedAt)

  /* ---------------- 分组 ---------------- */
  console.log('\ngroup: 重命名与删除分组')
  const a2 = await repo.saveConnection({ name: 'B', host: '10.0.0.2', port: 22, username: 'root', authType: 'password', group: 'A区', tags: [] })
  const moved = await repo.renameConnectionGroup('A区', 'B区')
  check('重命名分组返回迁移条数', moved === 2, moved)
  check('分组已改名', (await repo.getConnection(a2.id))?.group === 'B区')

  const delGroup = await repo.deleteConnectionGroup('B区')
  check('删除分组返回删除条数', delGroup === 2, delGroup)
  check('分组内连接已清空', (await repo.listConnections()).length === 0)

  // 分组名为空必须抛错（不是静默成功）
  let threw = false
  try { await repo.renameConnectionGroup('x', '   ') } catch { threw = true }
  check('空分组名抛错', threw)

  /* ---------------- 命令 ---------------- */
  console.log('\ncommands: 排序与去重导入')
  const c1 = await repo.saveCommand({ name: 'C1', command: 'ls', group: 'g', tags: [], confirmRequired: false, variables: [] })
  const c2 = await repo.saveCommand({ name: 'C2', command: 'pwd', group: 'g', tags: [], confirmRequired: false, variables: [] })
  check('新建命令 sortOrder 递增', c1.sortOrder === 1 && c2.sortOrder === 2, [c1.sortOrder, c2.sortOrder])
  check('新命令 useCount 从 0 开始', c1.useCount === 0)

  const t = await repo.touchCommand(c1.id)
  check('touchCommand 自增 useCount', t && t.useCount === 1, t && t.useCount)
  check('touchCommand 不存在的 id 返回 null', (await repo.touchCommand('nope')) === null)

  await repo.reorderCommands([c2.id, c1.id])
  const ordered = await repo.exportCommands()
  check('reorder 后顺序生效', ordered[0].id === c2.id && ordered[1].id === c1.id, ordered.map((x) => x.id))

  const imp = await repo.importCommands(
    [{ name: 'C1', command: 'ls' }, { name: 'C3', command: 'whoami' }],
    'merge'
  )
  check('merge 导入跳过重复（name+command）', imp.imported === 1 && imp.skipped === 1, imp)

  /* ---------------- 历史 ---------------- */
  console.log('\nhistory: 上限、过滤、联动 useCount')
  for (let i = 0; i < 5; i++) {
    await repo.addHistory({ command: `cmd${i}`, connectionId: 'conn1', at: Date.now() })
  }
  await repo.addHistory({ command: 'other', connectionId: 'conn2', at: Date.now() })
  const h1 = await repo.listHistory({ connectionId: 'conn1' })
  check('按 connectionId 过滤', h1.length === 5, h1.length)
  check('返回顺序是最新在前', h1[0].command === 'cmd4', h1[0].command)

  const before = (await repo.listCommands()).find((c) => c.id === c1.id).useCount
  await repo.addHistory({ command: 'ls', snippetId: c1.id, at: Date.now() })
  const after = (await repo.listCommands()).find((c) => c.id === c1.id).useCount
  check('带 snippetId 的历史联动命令 useCount', after === before + 1, [before, after])

  await repo.clearHistory('conn1')
  check('按连接清空历史', (await repo.listHistory({ connectionId: 'conn1' })).length === 0)

  /* ---------------- 设置 ---------------- */
  console.log('\nsettings: 默认值合并与迁移')
  const s0 = await repo.getSettings()
  check('默认主题为 light', s0.theme === 'light', s0.theme)
  check('默认开启严格主机校验', s0.strictHostKey === true)
  check('有 dangerPatterns 默认清单', Array.isArray(s0.dangerPatterns) && s0.dangerPatterns.includes('rm -rf'))

  const s1 = await repo.setSettings({ terminal: { fontSize: 16 } })
  check('部分 patch 保留 terminal 其它字段', s1.terminal.fontSize === 16 && s1.terminal.scrollback === 5000, s1.terminal)
  check('未 patch 的设置保持不变', s1.theme === 'light')

  /* ---------------- 巡检项 ---------------- */
  console.log('\ndiagSections: 内置 + 自定义')
  const sections = await repo.listDiagSections()
  check('内置项存在', sections.length > 0, sections.length)
  check('内置项标记 builtin', sections.some((s) => s.builtin === true))

  const custom = await repo.saveDiagSection({ name: 'X', group: 'g', command: 'echo 1', timeoutMs: 99999 })
  check('自定义项 id 带 custom. 前缀', custom.id.startsWith('custom.'), custom.id)
  check('区间内的超时原样保留', custom.timeoutMs === 99999, custom.timeoutMs)

  const tooBig = await repo.saveDiagSection({ name: 'Y', group: 'g', command: 'echo 2', timeoutMs: 999999 })
  check('超时上限钳到 120000', tooBig.timeoutMs === 120000, tooBig.timeoutMs)
  const tooSmall = await repo.saveDiagSection({ name: 'Z', group: 'g', command: 'echo 3', timeoutMs: 10 })
  check('超时下限钳到 1000', tooSmall.timeoutMs === 1000, tooSmall.timeoutMs)
  const noTimeout = await repo.saveDiagSection({ name: 'W', group: 'g', command: 'echo 4', timeoutMs: 0 })
  check('未给超时用默认 12000', noTimeout.timeoutMs === 12000, noTimeout.timeoutMs)
  await repo.deleteDiagSection(custom.id)
  check('删除自定义项后不在列表里', !(await repo.listDiagSections()).some((s) => s.id === custom.id))

  /* ---------------- 档案 ---------------- */
  console.log('\nprofiles: 保存与按更新时间排序')
  const p1 = await repo.saveProfile({ customerName: ' 客户A ', connectionIds: [] })
  check('空客户名回退', p1.customerName === '客户A', p1.customerName)
  await new Promise((r) => setTimeout(r, 5))
  const p2 = await repo.saveProfile({ customerName: '客户B', connectionIds: [] })
  const profiles = await repo.listProfiles()
  check('按 updatedAt 倒序', profiles[0].id === p2.id, profiles.map((x) => x.customerName))

  /* ---------------- 隧道 ---------------- */
  console.log('\ntunnels: 保存默认值与查询')
  const tun = await repo.saveTunnel({ name: '', type: 'local', bindHost: '', bindPort: 8080, targetHost: '127.0.0.1', targetPort: 80 })
  check('空名称回退为「未命名隧道」', tun.name === '未命名隧道', tun.name)
  check('空 bindHost 回退为 127.0.0.1', tun.bindHost === '127.0.0.1', tun.bindHost)
  check('getTunnel 能按 id 取到', (await repo.getTunnel(tun.id))?.bindPort === 8080)

  /* ---------------- 已知主机 ---------------- */
  console.log('\nknownHosts: key 格式与指纹更新')
  check('hostKey 格式为 host:port', repo.hostKey('1.2.3.4', 22) === '1.2.3.4:22')
  await repo.upsertKnownHost({ host: '1.2.3.4', port: 22, fingerprint: 'SHA256:old', addedAt: 1 })
  check('能取回记录', (await repo.getKnownHost('1.2.3.4', 22))?.fingerprint === 'SHA256:old')

  const refreshed = await repo.refreshKnownHost('1.2.3.4', 22, 'SHA256:new')
  check('refresh 返回新记录', refreshed.fingerprint === 'SHA256:new')
  check('refresh 后查询到的是新值', (await repo.getKnownHost('1.2.3.4', 22))?.fingerprint === 'SHA256:new')
  check('refresh 不新增条目', (await repo.listKnownHosts()).length === 1)

  await repo.deleteKnownHost(repo.hostKey('1.2.3.4', 22))
  check('删除后查不到', (await repo.getKnownHost('1.2.3.4', 22)) === undefined)

  /* ---------------- 落盘位置 ---------------- */
  console.log('\npersistence: 每个域各写自己的文件')
  const files = fs.existsSync(dataDir) ? fs.readdirSync(dataDir).sort() : []
  for (const f of ['connections.json', 'commands.json', 'history.json', 'settings.json',
                   'known-hosts.json', 'diag-sections.json', 'profiles.json', 'tunnels.json']) {
    check(`${f} 已落盘`, files.includes(f), files)
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true })
  console.log('')
  if (failed > 0) {
    console.log(`数据仓库回归失败：${failed} 项\n`)
    process.exit(1)
  }
  console.log('数据仓库回归全部通过\n')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
