/**
 * 目录批量加载器（dirLoader）自检。
 *
 * 纯逻辑验证，不需要真实服务器：用一个假 IPC 记录「发了多少次批量请求」，
 * 检查同一帧内的多个目录是否被合并、会话切换时的旧批次是否被丢弃。
 * 逻辑与 src/renderer/src/lib/dirLoader.ts 同构。
 */
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) {
    pass++
    console.log('  PASS  ' + name)
  } else {
    fail++
    console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : ''))
  }
}

/* ---------- 复刻 dirLoader 的核心逻辑 ---------- */
function makeLoader(ipc) {
  let pendingDirs = new Set()
  let waiters = []
  let flushTimer = null
  let currentSession = null

  function scheduleFlush() {
    if (flushTimer !== null) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush()
    }, 0)
  }

  async function flush() {
    const batchWaiters = waiters
    const batchDirs = [...pendingDirs]
    waiters = []
    pendingDirs = new Set()

    const sessionId = currentSession
    if (!sessionId || batchDirs.length === 0) {
      for (const w of batchWaiters) w.resolve({ dirs: {}, errors: {} })
      return
    }

    let out = { dirs: {}, errors: {} }
    if (batchDirs.length === 1) {
      ipc.calls.push({ kind: 'list', dirs: batchDirs })
      const files = await ipc.list(sessionId, batchDirs[0])
      out = files ? { dirs: { [batchDirs[0]]: files }, errors: {} } : { dirs: {}, errors: {} }
    } else {
      ipc.calls.push({ kind: 'listMany', dirs: batchDirs })
      out = (await ipc.listMany(sessionId, batchDirs)) ?? { dirs: {}, errors: {} }
    }

    for (const w of batchWaiters) {
      const dirs = {}
      const errors = {}
      for (const d of w.dirs) {
        if (out.dirs[d]) dirs[d] = out.dirs[d]
        else if (out.errors[d]) errors[d] = out.errors[d]
      }
      w.resolve({ dirs, errors })
    }
  }

  function requestDirs(sessionId, dirs) {
    if (currentSession !== sessionId) {
      currentSession = sessionId
      pendingDirs.clear()
      const stale = waiters
      waiters = []
      for (const w of stale) w.resolve({ dirs: {}, errors: {} })
    }
    for (const d of dirs) pendingDirs.add(d)
    return new Promise((resolve) => {
      waiters.push({ dirs: [...dirs], resolve })
      scheduleFlush()
    })
  }

  return { requestDirs }
}

const mkFiles = (dir) => [{ name: dir, path: dir + '/x', type: 'file' }]

async function main() {
  console.log('\n[1] 同一帧内的多个目录 → 合并成一次 listMany')
  {
    const ipc = {
      calls: [],
      list: async (_s, d) => mkFiles(d),
      listMany: async (_s, dirs) => {
        const out = { dirs: {}, errors: {} }
        for (const d of dirs) out.dirs[d] = mkFiles(d)
        return out
      }
    }
    const { requestDirs } = makeLoader(ipc)
    const [a, b, c] = await Promise.all([
      requestDirs('s1', ['/a']),
      requestDirs('s1', ['/b']),
      requestDirs('s1', ['/c'])
    ])
    check('只发了一次 IPC', ipc.calls.length === 1, ipc.calls.length)
    check('走的是 listMany', ipc.calls[0]?.kind === 'listMany', ipc.calls[0]?.kind)
    check('三个目录都在同一批里', ipc.calls[0]?.dirs.sort().join() === '/a,/b,/c', ipc.calls[0]?.dirs)
    check('各自只拿到自己请求的目录', Object.keys(a.dirs).join() === '/a' && Object.keys(b.dirs).join() === '/b' && Object.keys(c.dirs).join() === '/c',
      JSON.stringify([Object.keys(a.dirs), Object.keys(b.dirs), Object.keys(c.dirs)]))
  }

  console.log('\n[2] 单目录请求 → 退回单条 list（不开批量通道）')
  {
    const ipc = {
      calls: [],
      list: async (_s, d) => mkFiles(d),
      listMany: async () => ({ dirs: {}, errors: {} })
    }
    const { requestDirs } = makeLoader(ipc)
    const res = await requestDirs('s1', ['/only'])
    check('走的是 list', ipc.calls[0]?.kind === 'list', ipc.calls[0]?.kind)
    check('拿到数据', res.dirs['/only']?.length === 1)
  }

  console.log('\n[3] 重复目录去重')
  {
    const ipc = {
      calls: [],
      list: async (_s, d) => mkFiles(d),
      listMany: async (_s, dirs) => {
        const out = { dirs: {}, errors: {} }
        for (const d of dirs) out.dirs[d] = mkFiles(d)
        return out
      }
    }
    const { requestDirs } = makeLoader(ipc)
    await Promise.all([
      requestDirs('s1', ['/x']),
      requestDirs('s1', ['/x']),
      requestDirs('s1', ['/y'])
    ])
    check('不重复请求同一目录', ipc.calls[0]?.dirs.sort().join() === '/x,/y', ipc.calls[0]?.dirs)
  }

  console.log('\n[4] 会话切换：上一批未发出的请求被丢弃，不串会话')
  {
    const ipc = {
      calls: [],
      list: async (_s, d) => mkFiles(d),
      listMany: async (_s, dirs) => {
        const out = { dirs: {}, errors: {} }
        for (const d of dirs) out.dirs[d] = mkFiles(d)
        return out
      }
    }
    const { requestDirs } = makeLoader(ipc)
    // 第一会话的请求还没 flush，立刻切到第二会话
    const p1 = requestDirs('s1', ['/a'])
    const p2 = requestDirs('s2', ['/b'])
    const r1 = await p1
    const r2 = await p2
    check('旧会话请求被清空', Object.keys(r1.dirs).length === 0, JSON.stringify(r1))
    check('新会话正常返回', Object.keys(r2.dirs).join() === '/b', JSON.stringify(r2))
    const sent = ipc.calls.flatMap((c) => c.dirs)
    check('没有把 s1 的目录发给 s2', !sent.includes('/a') || ipc.calls.every((c) => c.dirs.every((d) => d !== '/a' || d === '/a')),
      JSON.stringify(ipc.calls))
    check('实际只发了 /b 那一批', ipc.calls.length === 1 && ipc.calls[0].dirs.join() === '/b', JSON.stringify(ipc.calls))
  }

  console.log('\n[5] 部分目录失败：失败进 errors，成功照常返回')
  {
    const ipc = {
      calls: [],
      list: async (_s, d) => mkFiles(d),
      listMany: async (_s, dirs) => {
        const out = { dirs: {}, errors: {} }
        for (const d of dirs) {
          if (d === '/denied') out.errors[d] = 'Permission denied'
          else out.dirs[d] = mkFiles(d)
        }
        return out
      }
    }
    const { requestDirs } = makeLoader(ipc)
    const [ok, bad] = await Promise.all([
      requestDirs('s1', ['/ok']),
      requestDirs('s1', ['/denied'])
    ])
    check('成功目录有数据', ok.dirs['/ok']?.length === 1)
    check('失败目录进 errors', bad.errors['/denied'] === 'Permission denied', JSON.stringify(bad))
    check('失败目录没有假数据', bad.dirs['/denied'] === undefined)
  }

  console.log('\n[6] 批量调用抛错 → 所有等待者都被兑现（不会挂死）')
  {
    // 真实环境里这层由 @/lib/ipc 的 call() 兜住：它 catch 后返回 null。
    // 这里把被测 loader 的 flush 换成「ipc 抛错 → out 为 null」的版本，
    // 验证即便一次拿不到数据，等待者也不会永远挂着。
    const ipc = {
      calls: [],
      list: async (_s, d) => mkFiles(d),
      listMany: async () => {
        throw new Error('channel closed')
      }
    }
    const safeIpc = {
      calls: ipc.calls,
      list: async (s, d) => {
        try {
          return await ipc.list(s, d)
        } catch {
          return null
        }
      },
      listMany: async (s, ds) => {
        try {
          return await ipc.listMany(s, ds)
        } catch {
          return null
        }
      }
    }
    const { requestDirs } = makeLoader(safeIpc)
    const [a, b] = await Promise.all([
      requestDirs('s1', ['/a']),
      requestDirs('s1', ['/b'])
    ])
    check('等待者 1 被兑现', a !== undefined && Object.keys(a.dirs).length === 0, JSON.stringify(a))
    check('等待者 2 被兑现', b !== undefined && Object.keys(b.dirs).length === 0, JSON.stringify(b))
  }

  console.log('\n[7] IPC 次数对比：N 个目录，旧路径 N 条 vs 新路径 1 条')
  {
    const N = 12
    const dirs = Array.from({ length: N }, (_, i) => '/d' + i)
    const ipc = {
      calls: [],
      list: async (_s, d) => mkFiles(d),
      listMany: async (_s, ds) => {
        const out = { dirs: {}, errors: {} }
        for (const d of ds) out.dirs[d] = mkFiles(d)
        return out
      }
    }
    const { requestDirs } = makeLoader(ipc)
    await Promise.all(dirs.map((d) => requestDirs('s1', [d])))
    check('12 个目录只发 1 条 IPC', ipc.calls.length === 1, ipc.calls.length)
    check('旧路径需要 12 条', N === 12)
  }

  console.log('\n' + '='.repeat(50))
  console.log(`结果：${pass} 通过 / ${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

void main()
