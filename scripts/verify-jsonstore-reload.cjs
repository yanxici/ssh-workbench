/**
 * 验证 JsonStore 的外部改动感知（mtime 校验）与缓存正确性。
 *
 * 用法：node scripts/verify-jsonstore-reload.cjs
 *
 * 背景：JsonStore 原实现一旦读过就永不再读磁盘，与「JSON 可读可改」的卖点冲突 ——
 * 用户手动改 %APPDATA% 下的 connections.json，主进程到重启前都感知不到。
 * 加了 mtime 校验后必须同时保证两件事，否则等于引入更严重的回归：
 *   1. 外部改了文件 → 能读到新值（本次要修的问题）；
 *   2. 自己 update 之后 → 不能被自己的异步写盘误判成「外部改动」而丢更新。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, '.tsc-verify')
const stubDir = path.join(OUT, 'stub-jsonstore')
fs.mkdirSync(stubDir, { recursive: true })

let failed = 0
function check(name, ok, extra) {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failed++
    console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`)
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-jsonstore-'))
  fs.writeFileSync(
    path.join(stubDir, 'electron.cjs'),
    [
      `const userData = ${JSON.stringify(dir)}`,
      'module.exports = { app: { getPath: () => userData } }'
    ].join('\n') + '\n'
  )

  const bundle = path.join(stubDir, 'jsonstore.cjs')
  await esbuild.build({
    stdin: {
      contents: `export { JsonStore } from './src/main/store/jsonStore'`,
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['electron'],
    logLevel: 'error',
    alias: { '@shared': path.join(ROOT, 'src/shared'), electron: path.join(stubDir, 'electron.cjs') }
  })
  const { JsonStore } = require(bundle)

  const file = path.join(dir, 'data', 'test.json')
  const store = new JsonStore(file, () => [])

  // ---- 1. 首次读：文件不存在 → 兜底值 ----
  const first = await store.read()
  check('文件不存在时返回兜底值', Array.isArray(first) && first.length === 0)

  // ---- 2. 写入后读回 ----
  await store.write([{ id: 'a' }])
  const afterWrite = await store.read()
  check('写入后读回同值', afterWrite.length === 1 && afterWrite[0].id === 'a')

  // ---- 3. 外部改文件（模拟用户手改 JSON）→ 必须感知 ----
  // 等一个 tick 确保 mtime 一定变化（ext4/NTFS 的 mtime 精度足够，但稳妥起见）
  await new Promise((r) => setTimeout(r, 20))
  fs.writeFileSync(file, JSON.stringify([{ id: 'a' }, { id: 'external' }], null, 2), 'utf-8')
  const afterExternal = await store.read()
  check('外部改动后能读到新内容（缓存不再永久有效）', afterExternal.length === 2,
    `实际 ${afterExternal.length} 条`)
  check('外部新增的记录可见', afterExternal.some((x) => x.id === 'external'))

  // ---- 4. update 后立即 read：不能被自己的写盘误判 ----
  const updated = await store.update((list) => [...list, { id: 'b' }])
  check('update 返回含新记录', updated.length === 3, updated.length)
  const afterUpdate = await store.read()
  check('update 后立刻 read 不丢改动', afterUpdate.length === 3, afterUpdate.length)

  // ---- 5. 并发 update：串行锁不能被 mtime 校验破坏 ----
  await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      store.update((list) => [...list, { id: `c${i}` }])
    )
  )
  const afterConc = await store.read()
  check('30 次并发 update 全部保住（无丢更新）', afterConc.length === 33, afterConc.length)

  // ---- 6. 磁盘与内存一致 ----
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'))
  check('磁盘内容与内存一致', onDisk.length === 33, onDisk.length)

  // ---- 7. invalidate() ----
  store.invalidate()
  const afterInvalidate = await store.read()
  check('invalidate 后重新读盘仍一致', afterInvalidate.length === 33, afterInvalidate.length)

  // ---- 8. 文件被删除 → 回到兜底值而不是崩 ----
  fs.rmSync(file)
  store.invalidate()
  const afterDelete = await store.read()
  check('文件被删后回到兜底值', Array.isArray(afterDelete) && afterDelete.length === 0)

  fs.rmSync(dir, { recursive: true, force: true })
  console.log(`\n${failed === 0 ? 'JsonStore 缓存回归全部通过' : `${failed} 项失败`}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('校验异常:', e)
  process.exit(2)
})
