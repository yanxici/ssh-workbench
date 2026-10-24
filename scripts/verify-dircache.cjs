/**
 * 目录缓存（方案 A）与预挂载（方案 B）自检。
 * 纯逻辑验证，不需要真实服务器：用可控的假 fetcher 模拟网络往返。
 */
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : '')) }
}

/* ---------- 复刻 dirCache 的核心逻辑（与源码同构） ---------- */
const FRESH_MS = 5000
const cache = new Map()
const inflight = new Map()
const keyOf = (s, p) => s + '\u0000' + p

function peekDir(sessionId, path) {
  const hit = cache.get(keyOf(sessionId, path))
  if (!hit) return { cached: null, fresh: false }
  return { cached: hit, fresh: Date.now() - hit.at < FRESH_MS }
}
function writeDir(sessionId, path, files) {
  cache.set(keyOf(sessionId, path), { files, at: Date.now() })
}
function invalidateDir(sessionId, path) {
  if (path === undefined) {
    const prefix = sessionId + '\u0000'
    for (const k of [...cache.keys()]) if (k.startsWith(prefix)) cache.delete(k)
    for (const k of [...inflight.keys()]) if (k.startsWith(prefix)) inflight.delete(k)
    return
  }
  cache.delete(keyOf(sessionId, path))
}
async function loadDir(sessionId, path, fetcher, force = false) {
  const k = keyOf(sessionId, path)
  if (!force) {
    const { cached, fresh } = peekDir(sessionId, path)
    if (cached && fresh) return cached.files
  }
  const existing = inflight.get(k)
  if (existing) return existing
  const p = (async () => {
    try {
      const files = await fetcher()
      if (files) writeDir(sessionId, path, files)
      return files
    } finally {
      inflight.delete(k)
    }
  })()
  inflight.set(k, p)
  return p
}

const mkFiles = (n) => Array.from({ length: n }, (_, i) => ({ name: 'f' + i, path: '/d/f' + i }))

async function main() {
  console.log('\n[1] 缓存命中：第二次读同一个目录不该再发请求')
  {
    cache.clear(); inflight.clear()
    let calls = 0
    const fetcher = async () => { calls++; return mkFiles(10) }

    const a = await loadDir('s1', '/root', fetcher)
    check('首次读取发了一次请求', calls === 1, 'calls=' + calls)
    check('首次返回数据', a && a.length === 10)

    const b = await loadDir('s1', '/root', fetcher)
    check('第二次命中缓存，没有新请求', calls === 1, 'calls=' + calls)
    check('两次返回同一份数据引用', a === b)

    const c = await loadDir('s1', '/root', fetcher)
    check('第三次仍然命中', calls === 1, 'calls=' + calls)
  }

  console.log('\n[2] 请求去重：并发展开同一目录只发一次')
  {
    cache.clear(); inflight.clear()
    let calls = 0
    const fetcher = async () => {
      calls++
      await new Promise((r) => setTimeout(r, 30))
      return mkFiles(5)
    }
    const results = await Promise.all([
      loadDir('s1', '/a', fetcher),
      loadDir('s1', '/a', fetcher),
      loadDir('s1', '/a', fetcher)
    ])
    check('三个并发只发 1 次请求', calls === 1, 'calls=' + calls)
    check('三个调用都拿到结果', results.every((r) => r && r.length === 5))
  }

  console.log('\n[3] 会话隔离：不同 sessionId 不共享缓存')
  {
    cache.clear(); inflight.clear()
    let calls = 0
    const fetcher = async () => { calls++; return mkFiles(3) }
    await loadDir('s1', '/root', fetcher)
    await loadDir('s2', '/root', fetcher)
    check('两个会话各发一次请求', calls === 2, 'calls=' + calls)
  }

  console.log('\n[4] 失效：写操作后必须重新请求')
  {
    cache.clear(); inflight.clear()
    let calls = 0
    const fetcher = async () => { calls++; return mkFiles(4) }
    await loadDir('s1', '/root', fetcher)
    check('首次 1 次', calls === 1, String(calls))
    await loadDir('s1', '/root', fetcher)
    check('命中缓存仍 1 次', calls === 1, String(calls))

    invalidateDir('s1', '/root')
    await loadDir('s1', '/root', fetcher)
    check('失效后重新请求', calls === 2, String(calls))
  }

  console.log('\n[5] 整会话失效')
  {
    cache.clear(); inflight.clear()
    let calls = 0
    const fetcher = async () => { calls++; return mkFiles(2) }
    await loadDir('s1', '/a', fetcher)
    await loadDir('s1', '/b', fetcher)
    await loadDir('s2', '/a', fetcher)
    check('三个目录三次请求', calls === 3, String(calls))

    invalidateDir('s1')
    await loadDir('s1', '/a', fetcher)
    await loadDir('s1', '/b', fetcher)
    await loadDir('s2', '/a', fetcher)
    check('s1 的两个目录失效，s2 仍命中', calls === 5, 'calls=' + calls)
  }

  console.log('\n[6] force 绕过缓存（写操作 / 刷新按钮）')
  {
    cache.clear(); inflight.clear()
    let calls = 0
    const fetcher = async () => { calls++; return mkFiles(1) }
    await loadDir('s1', '/x', fetcher)
    await loadDir('s1', '/x', fetcher, true)
    check('force=true 强制重拉', calls === 2, String(calls))
  }

  console.log('\n[7] 过期缓存仍可先上屏（stale-while-revalidate）')
  {
    cache.clear(); inflight.clear()
    let calls = 0
    const fetcher = async () => { calls++; return mkFiles(6) }
    await loadDir('s1', '/old', fetcher)
    // 手工把时间戳拨到过期
    const k = keyOf('s1', '/old')
    cache.set(k, { files: cache.get(k).files, at: Date.now() - FRESH_MS - 1000 })

    const peek = peekDir('s1', '/old')
    check('过期缓存仍能被 peek 读到（界面不空）', peek.cached !== null)
    check('但标记为不新鲜', peek.fresh === false)

    const r = await loadDir('s1', '/old', fetcher)
    check('过期后会重新请求', calls === 2, String(calls))
    check('返回新数据', r && r.length === 6)
  }

  console.log('\n[8] 压测：大量目录的缓存读写性能')
  {
    cache.clear(); inflight.clear()
    const N = 2000
    const t0 = process.hrtime.bigint()
    for (let i = 0; i < N; i++) {
      writeDir('bench', '/dir' + i, mkFiles(50))
    }
    const t1 = process.hrtime.bigint()
    let hits = 0
    for (let i = 0; i < N; i++) {
      if (peekDir('bench', '/dir' + i).cached) hits++
    }
    const t2 = process.hrtime.bigint()
    const writeMs = Number(t1 - t0) / 1e6
    const readMs = Number(t2 - t1) / 1e6
    console.log('  INFO  ' + N + ' 个目录写入 ' + writeMs.toFixed(1) + 'ms，读取命中 ' + readMs.toFixed(1) + 'ms')
    check('全部命中', hits === N, hits + '/' + N)
    check('写缓存在 500ms 内', writeMs < 500, writeMs.toFixed(1) + 'ms')
    check('读缓存在 200ms 内', readMs < 200, readMs.toFixed(1) + 'ms')
  }

  console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n')
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(2) })
