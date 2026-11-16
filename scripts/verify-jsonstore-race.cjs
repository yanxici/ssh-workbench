/**
 * JsonStore 写-读竞态回归（v2.1.5 分屏落盘时暴露）。
 *
 * 被修的 bug：load() 在 await fs.readFile 期间有 update/write 落地时，
 * 旧实现会继续把磁盘内容（ENOENT 时甚至是 fallback() 空值）写进 cache，
 * 并把 cacheSignature 刷成**新文件**的指纹 —— 于是「缓存命中」条件成立，
 * 之后每次 read() 都返回空值，直到文件 mtime 再变。
 * 实测表现：渲染层写 splitLayout 成功、紧接着 IPC 读回 {}，重启后又正常。
 *
 * 断言判据（区分度）：
 *   R2/R3 是核心 —— 修复没落地时 read() 返回 fallback（空表），必然红。
 *   只断言「write 返回了新值」是假绿：那是内存里的返回值，跟 cache 污染无关。
 *
 * 用法：node scripts/verify-jsonstore-race.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, '.tsc-verify')
/* JS_SRC 可指向一份变异副本，用来验证「修复没落地时这些断言会红」 */
const SRC = process.env.JS_SRC || './src/main/store/jsonStore.ts'

let failed = 0
function check(name, ok, extra) {
  if (ok) console.log('  ok   ' + name)
  else {
    failed++
    console.log('  FAIL ' + name + (extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''))
  }
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-jsonrace-'))
  const stubDir = path.join(OUT, 'stub-jsonrace')
  fs.mkdirSync(stubDir, { recursive: true })
  fs.writeFileSync(
    path.join(stubDir, 'electron.cjs'),
    ['const userData = ' + JSON.stringify(dir), 'module.exports = { app: { getPath: () => userData } }'].join('\n') + '\n'
  )

  const bundle = path.join(stubDir, 'jsonstore.cjs')
  await esbuild.build({
    stdin: { contents: 'export { JsonStore } from ' + JSON.stringify(SRC), resolveDir: ROOT, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['electron'],
    logLevel: 'error',
    alias: { '@shared': path.join(ROOT, 'src/shared'), electron: path.join(stubDir, 'electron.cjs') }
  })
  const { JsonStore } = require(bundle)

  const file = path.join(dir, 'data', 'race.json')
  const store = new JsonStore(file, () => [])

  /* ---- R1：读盘（文件不存在）进行中，写入落地 ---- */
  const readP = store.read()
  const writeP = store.write([{ id: 'w1' }, { id: 'w2' }])
  const raced = await readP
  await writeP
  check('R1 竞态读回来的不是兜底空表', Array.isArray(raced) && raced.length === 2, raced)

  /* ---- R2：之后再 read()（走缓存命中分支）仍然是写入的值 ---- */
  const after = await store.read()
  check('R2 后续 read() 仍能读到写入的两条（缓存没被空值污染）', Array.isArray(after) && after.length === 2, after)
  check('R3 条目的 id 完整', after.length === 2 && after[0].id === 'w1' && after[1].id === 'w2', after)

  /* ---- R4：同一条 store 再 update，继续可见 ---- */
  const updated = await store.update((list) => [...list, { id: 'w3' }])
  check('R4 竞态之后 update 仍能基于正确基线', updated.length === 3, updated.length)
  const afterUpdate = await store.read()
  check('R5 update 后 read() 一致', afterUpdate.length === 3, afterUpdate.length)

  /* ---- R6：文件后来真的被删（外部）→ 必须回到兜底值，不能永久缓存 ---- */
  fs.rmSync(file, { force: true })
  store.invalidate()
  const afterDelete = await store.read()
  check('R6 文件被删后回到兜底空表', Array.isArray(afterDelete) && afterDelete.length === 0, afterDelete)

  /* ---- R7：并发 update 与 read 混跑不丢更新 ---- */
  const store2 = new JsonStore(path.join(dir, 'data', 'race2.json'), () => [])
  await store2.write([])
  const ops = []
  for (let i = 0; i < 20; i++) {
    ops.push(store2.update((list) => [...list, { id: 'n' + i }]))
    ops.push(store2.read())
  }
  await Promise.all(ops)
  const finalList = await store2.read()
  check('R7 20 次并发 update 与 read 混跑后条数完整', finalList.length === 20, finalList.length)

  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(stubDir, { recursive: true, force: true })
  console.log('\n' + (failed === 0 ? 'JsonStore 竞态回归全部通过' : failed + ' 项失败'))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('校验异常:', e)
  process.exit(2)
})
