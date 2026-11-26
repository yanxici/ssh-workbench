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

  /* ---- R8：写盘失败必须回滚缓存，read() 交出的仍是磁盘上的真实旧值 ----
   * 造失败的方式：在临时文件路径上占一个**目录**，writeFile 直接 EISDIR，
   * 而正式文件毫发无损 —— 这样才能同时验证「磁盘没坏」和「缓存没中毒」。 */
  const file8 = path.join(dir, 'data', 'f8.json')
  const store8 = new JsonStore(file8, () => [])
  await store8.write([{ id: 'old' }])
  fs.mkdirSync(file8 + '.tmp')
  let write8Rejected = false
  try {
    await store8.write([{ id: 'new' }, { id: 'new2' }])
  } catch {
    write8Rejected = true
  }
  check('R8a 占住临时路径后写入确实失败', write8Rejected)
  fs.rmSync(file8 + '.tmp', { recursive: true, force: true })
  const afterFail = await store8.read()
  check(
    'R8b 写失败后 read() 返回磁盘真实旧值而非幻影新值',
    Array.isArray(afterFail) && afterFail.length === 1 && afterFail[0].id === 'old',
    afterFail
  )
  const onDisk8 = JSON.parse(fs.readFileSync(file8, 'utf-8'))
  check('R8c 磁盘上仍是旧值（没被半截写入污染）', onDisk8.length === 1 && onDisk8[0].id === 'old', onDisk8)

  /* ---- R9：读文件遇非 ENOENT 的 OS 错误（EBUSY/EISDIR/UNKNOWN）不得隔离现场 ----
   * 旧实现只把 5 个错误码当瞬时错误，其余一律 rename 成 .corrupt-<ts>：
   * 杀软、OneDrive、索引服务一个 EISDIR/EAGAIN 就把整库改名隔离。
   * 这里用「路径被占成目录」稳定复现 EISDIR（Windows/Unix 行为一致）。 */
  const dir9 = path.join(dir, 'data', 'f9.json')
  fs.mkdirSync(dir9)
  const store9 = new JsonStore(dir9, () => [])
  const [read9, update9] = await Promise.allSettled([store9.read(), store9.update((l) => [...l, { id: 'x' }])])
  check('R9a 读取遇到非 ENOENT 错误时 read() 不抛、回兜底', read9.status === 'fulfilled' && Array.isArray(read9.value), read9.status)
  check(
    'R9b 同一环境下 update() 明确失败而不是拿空值覆盖',
    update9.status === 'rejected' && /已放弃本次写入/.test(String(update9.reason && update9.reason.message)),
    update9.status === 'rejected' ? String(update9.reason.message).slice(0, 80) : update9.status
  )
  check('R9c 现场没被改名隔离（目录仍在、无 .corrupt-*）', fs.existsSync(dir9) && fs.readdirSync(path.join(dir, 'data')).filter((n) => n.includes('.corrupt-')).length === 0)

  /* ---- R10：损坏读与 write() 竞态不得把**新写入**改名成 .corrupt-* ---- */
  const file10 = path.join(dir, 'data', 'f10.json')
  fs.writeFileSync(file10, '{ this is not json')
  const store10 = new JsonStore(file10, () => [])
  const initial10 = await store10.read()
  check('R10a 损坏文件读回兜底值', Array.isArray(initial10) && initial10.length === 0, initial10)
  fs.writeFileSync(file10, '{ still broken')
  store10.invalidate()
  const [, wrote10] = await Promise.allSettled([store10.read(), store10.write([{ id: 'good' }])])
  check('R10b 竞态下 write() 成功', wrote10.status === 'fulfilled', wrote10.status)
  const corrupts = fs.readdirSync(path.join(dir, 'data')).filter((n) => n.includes('.corrupt-'))
  const badCorrupt = corrupts.filter((n) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'data', n), 'utf-8'))
      return Array.isArray(parsed) && parsed.some((it) => it && it.id === 'good')
    } catch {
      return false
    }
  })
  check('R10c 没有把刚写入的有效数据改名成 .corrupt-*', badCorrupt.length === 0, badCorrupt)
  const final10 = await store10.read()
  check('R10d 竞态后 read() 读到的是新写入的数据', Array.isArray(final10) && final10.length === 1 && final10[0].id === 'good', final10)

  /* ---- R10e：冷缓存 + 损坏 JSON 上调用 update() 绝不能在 mutateChain 上自死锁 ---- */
  const file10e = path.join(dir, 'data', 'f10e.json')
  fs.writeFileSync(file10e, '{ broken for mutate')
  const store10e = new JsonStore(file10e, () => [])
  const update10e = await Promise.race([
    store10e.update((list) => [...list, { id: 'recovered' }]).then((v) => ({ ok: true, v })),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), 3000))
  ])
  check(
    'R10e 损坏 JSON 上 update() 不会自死锁且正常落盘',
    update10e.ok && Array.isArray(update10e.v) && update10e.v.length === 1 && update10e.v[0].id === 'recovered',
    JSON.stringify(update10e)
  )
  const disk10e = JSON.parse(fs.readFileSync(file10e, 'utf-8'))
  check('R10e2 磁盘内容已恢复为有效 JSON', Array.isArray(disk10e) && disk10e[0]?.id === 'recovered', disk10e)

  /* ---- R10f：readFile 已返回损坏内容后，在 rename/stat 窗口并发 write() 不得投毒缓存 ---- */
  const file10f = path.join(dir, 'data', 'f10f.json')
  fs.writeFileSync(file10f, '{ corrupt before write')
  const store10f = new JsonStore(file10f, () => [])
  const origReadFile = fs.promises.readFile
  let writePromise10f = null
  fs.promises.readFile = async function (...args) {
    const out = await origReadFile.apply(this, args)
    if (args[0] === file10f && !writePromise10f) {
      // 在 readFile 刚返回损坏串、尚未进入 isolateCorrupt/statSignature 的瞬间发起并发 write
      writePromise10f = store10f.write([{ id: 'after-read' }])
    }
    return out
  }
  try {
    await store10f.read()
    if (writePromise10f) await writePromise10f
  } finally {
    fs.promises.readFile = origReadFile
  }
  const final10f = await store10f.read()
  check(
    'R10f rename/stat 窗口并发 write() 后缓存未被投毒',
    Array.isArray(final10f) && final10f.length === 1 && final10f[0].id === 'after-read',
    JSON.stringify(final10f)
  )
  const corrupts10f = fs.readdirSync(path.join(dir, 'data')).filter((n) => n.startsWith('f10f.json.corrupt-'))
  const badCorrupt10f = corrupts10f.filter((n) => {
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'data', n), 'utf-8'))
      return Array.isArray(parsed) && parsed.some((it) => it && it.id === 'after-read')
    } catch {
      return false
    }
  })
  check('R10f2 窗口内并发写入的有效文件未被误改名隔离', badCorrupt10f.length === 0, badCorrupt10f)

  fs.rmSync(dir, { recursive: true, force: true })
  fs.rmSync(stubDir, { recursive: true, force: true })
  console.log('\n' + (failed === 0 ? 'JsonStore 竞态回归全部通过' : failed + ' 项失败'))
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('校验异常:', e)
  process.exit(2)
})
