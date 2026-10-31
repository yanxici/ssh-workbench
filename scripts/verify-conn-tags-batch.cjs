/**
 * 验证批量改标签（updateConnectionsTags）: 一次读改写落盘、四种模式语义、并发安全。
 *
 * 用法：node scripts/verify-conn-tags-batch.cjs
 *
 * 为什么要它：批量打标签是新增通道（conn:update-tags），它替代了原来
 * 「多选后逐条 save」的 N 次 IPC 路径。这条路径一旦语义错了，
 * 用户的标签会被批量写坏，而且不会有任何报错。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, '.tsc-verify')
fs.mkdirSync(OUT, { recursive: true })

let failed = 0
function check(name, ok, extra) {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failed++
    console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`)
  }
}

async function main() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-tags-'))

  // electron stub：只提供 store 需要的 app.getPath
  const stubDir = path.join(OUT, 'stub-tags')
  fs.mkdirSync(stubDir, { recursive: true })
  fs.writeFileSync(
    path.join(stubDir, 'electron.cjs'),
    [
      `const userData = ${JSON.stringify(userData)}`,
      'module.exports = {',
      '  app: { getPath: () => userData },',
      '  safeStorage: {',
      '    isEncryptionAvailable: () => false,',
      '    encryptString: (s) => Buffer.from(s, "utf-8"),',
      '    decryptString: (b) => b.toString("utf-8")',
      '  }',
      '}'
    ].join('\n') + '\n'
  )

  const bundle = path.join(stubDir, 'conns.cjs')
  await esbuild.build({
    stdin: {
      contents: `
        export {
          listConnections, saveConnection, deleteConnections, updateConnectionsTags
        } from './src/main/store/repo/connections'
      `,
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['electron'],
    logLevel: 'error',
    alias: {
      '@shared': path.join(ROOT, 'src/shared'),
      electron: path.join(stubDir, 'electron.cjs')
    }
  })

  const { listConnections, saveConnection, deleteConnections, updateConnectionsTags } = require(bundle)

  // ---- 造 5 条测试连接 ----
  const ids = []
  for (let i = 0; i < 5; i++) {
    const c = await saveConnection({
      name: `T${i}`,
      host: `192.0.2.${i + 1}`,
      port: 22,
      username: 'u',
      authType: 'password',
      group: 'GTEST',
      tags: i === 0 ? ['base', 'x'] : ['base']
    })
    ids.push(c.id)
  }
  check('造 5 条连接', ids.length === 5, ids.length)

  // ---- add 模式：去重合并 ----
  const n1 = await updateConnectionsTags(ids, ['a', 'b', 'a'], 'add')
  check('add 返回改动条数 5', n1 === 5, n1)
  const afterAdd = await listConnections()
  const mine = afterAdd.filter((c) => ids.includes(c.id))
  check('add 后每条都有 a、b', mine.every((c) => c.tags.includes('a') && c.tags.includes('b')))
  check('add 后重复标签已去重', mine.every((c) => c.tags.filter((t) => t === 'a').length === 1))
  check('add 保留原有 base', mine.every((c) => c.tags.includes('base')))

  // ---- remove 模式 ----
  const n2 = await updateConnectionsTags(ids, ['a', 'base'], 'remove')
  check('remove 返回改动条数 5', n2 === 5, n2)
  const afterRemove = await listConnections()
  const mine2 = afterRemove.filter((c) => ids.includes(c.id))
  check('remove 后不再有 a/base', mine2.every((c) => !c.tags.includes('a') && !c.tags.includes('base')))
  check('remove 后 b 仍在', mine2.every((c) => c.tags.includes('b')))

  // ---- replace 模式 ----
  const n3 = await updateConnectionsTags(ids, ['only'], 'replace')
  check('replace 返回改动条数 5', n3 === 5, n3)
  const afterReplace = await listConnections()
  const mine3 = afterReplace.filter((c) => ids.includes(c.id))
  check('replace 后标签恰为 [only]', mine3.every((c) => c.tags.length === 1 && c.tags[0] === 'only'))

  // ---- 只影响目标 id ----
  const outsider = await saveConnection({
    name: 'OUT',
    host: '192.0.2.200',
    port: 22,
    username: 'u',
    authType: 'password',
    group: 'GOTHER',
    tags: ['untouched']
  })
  await updateConnectionsTags([ids[0]], ['zzz'], 'add')
  const afterPartial = await listConnections()
  const out = afterPartial.find((c) => c.id === outsider.id)
  const first = afterPartial.find((c) => c.id === ids[0])
  check('只改指定 id，不影响其他连接', out.tags.length === 1 && out.tags[0] === 'untouched')
  check('指定 id 确实被改', first.tags.includes('zzz'))

  // ---- 边界 ----
  const n4 = await updateConnectionsTags([], ['x'], 'add')
  check('空 id 列表返回 0', n4 === 0, n4)
  const n5 = await updateConnectionsTags(ids, [], 'add')
  check('add 空标签返回 0', n5 === 0, n5)

  // ---- 并发：50 次并发 update 不丢更新 ----
  const conc = await Promise.all(
    Array.from({ length: 50 }, (_, i) => updateConnectionsTags(ids, ['c' + i], 'add'))
  )
  check('50 次并发都返回数字', conc.every((x) => typeof x === 'number'))
  const afterConc = await listConnections()
  const mineConc = afterConc.filter((c) => ids.includes(c.id))
  const expectedTags = ['only', 'zzz', ...Array.from({ length: 50 }, (_, i) => 'c' + i)]
  // ids[0] 有 zzz，其他只有 only；c0..c49 应全部出现在每一条上
  const allHaveAll = mineConc.every((c) =>
    Array.from({ length: 50 }, (_, i) => 'c' + i).every((t) => c.tags.includes(t))
  )
  check('并发后 50 个标签全部保住（无丢更新）', allHaveAll, mineConc[0]?.tags?.length)

  // ---- 落盘检查：直接读文件确认 ----
  const file = path.join(userData, 'data', 'connections.json')
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
  const fileMine = raw.filter((c) => ids.includes(c.id))
  check('文件里也是 50 个标签', fileMine.every((c) => c.tags.filter((t) => t.startsWith('c')).length === 50))

  // ---- 清理 ----
  const removed = await deleteConnections([...ids, outsider.id])
  check('清理测试数据', removed === 6, removed)

  fs.rmSync(userData, { recursive: true, force: true })

  console.log(`\n${failed === 0 ? '批量改标签回归全部通过' : `${failed} 项失败`}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('校验异常:', e)
  process.exit(2)
})
