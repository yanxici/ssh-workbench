/**
 * 连接搜索精准度回归测试（v2.5.0）：
 *
 * 背景：2,900+ 台共用同一 NAT IP（10.42.42.200）不同端口的设备库里，
 * 旧实现在 host 上跑 fuzzy 子序列匹配，搜索 `1022` 会命中 `10.42.42.200`
 * （1 → 0 → 2 → 2，152 分 >= 118 保底分），把全部 2,900 台都吐出来。
 *
 * 断言：
 *  1. 搜 `1022` 只命中名称/端口含连续 `1022` 的设备，绝不子序列误命中 `10.42.42.200` 或 `Robot-10-v2-2`
 *  2. 搜 `41506` / `10.42.42.200:41506` 命中对应端口与 host:port
 *  3. 搜 `COM3` / `ttyUSB0` 命中串口连接
 *  4. 搜字母/中文（`r223`、`盘空`、`测试`）保留正常 fuzzy 匹配
 *  5. 搜 `root` 在 username 上按连续子串命中，但不跨字符误命中 `r_o_o_t`
 *
 * 运行：node scripts/verify-connection-search.cjs
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-conn-search-'))
const outFile = path.join(tmpDir, 'store.cjs')

// connectionStore 引入了 ipc / settingsStore / toastStore，用极简 stub 打包即可纯 Node 测试 groupConnections / scoreConnection
const stubSettings = path.join(tmpDir, 'settings.cjs')
const stubToast = path.join(tmpDir, 'toast.cjs')
const stubIpc = path.join(tmpDir, 'ipc.cjs')
fs.writeFileSync(stubSettings, 'module.exports = { useSettingsStore: { getState: () => ({ settings: {} }), setState: () => {} } }')
fs.writeFileSync(stubToast, 'module.exports = { useToastStore: { getState: () => ({ push: () => {} }) } }')
fs.writeFileSync(stubIpc, 'module.exports = { call: async () => null }')

async function main() {
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'src/renderer/src/stores/connectionStore.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: outFile,
    logLevel: 'error',
    alias: {
      '@': path.join(ROOT, 'src/renderer/src'),
      '@shared': path.join(ROOT, 'src/shared')
    },
    plugins: [
      {
        name: 'stub-stores',
        setup(build) {
          build.onResolve({ filter: /^\.\/settingsStore$/ }, () => ({ path: stubSettings }))
          build.onResolve({ filter: /^\.\/toastStore$/ }, () => ({ path: stubToast }))
          build.onResolve({ filter: /^@\/lib\/ipc$/ }, () => ({ path: stubIpc }))
        }
      }
    ]
  })

  const { groupConnections, scoreConnection } = require(outFile)

  let pass = 0
  let fail = 0
  function check(name, cond, detail = '') {
    if (cond) {
      pass++
      console.log('  ok  ', name)
    } else {
      fail++
      console.log('  FAIL', name, detail)
    }
  }

  function makeConn(overrides) {
    return {
      id: overrides.id,
      name: overrides.name,
      host: overrides.host ?? '10.42.42.200',
      port: overrides.port ?? 22,
      username: overrides.username ?? 'root',
      authType: 'password',
      group: overrides.group ?? 'XCMD',
      tags: overrides.tags ?? [],
      createdAt: 1,
      updatedAt: 1,
      ...overrides
    }
  }

  const conns = [
    makeConn({ id: 'c1022', name: '讯飞-测试-充电桩-C1022', port: 41022 }),
    makeConn({ id: 'r1506', name: '讯飞-测试-3399机器人-R1506', port: 31506 }),
    makeConn({ id: 'c1506', name: '讯飞-测试-充电桩-C1506', port: 41506 }),
    makeConn({ id: 'c3001', name: '讯飞-测试-充电桩-C3001', port: 43001 }),
    makeConn({ id: 'noise1', name: 'Robot-10-v2-2', port: 2222 }),
    makeConn({ id: 'noise2', name: '普通节点', port: 2200, username: 'r_o_o_t' }),
    makeConn({ id: 'r223', name: '机器人-R223', host: '192.168.1.50', port: 22, tags: ['盘点空间'] }),
    makeConn({
      id: 'ser1',
      name: '调试板串口',
      kind: 'serial',
      host: '',
      port: 0,
      username: '',
      serial: { path: 'COM3', baudRate: 115200 }
    }),
    makeConn({
      id: 'ser2',
      name: 'Linux串口',
      kind: 'serial',
      host: '',
      port: 0,
      username: '',
      serial: { path: '/dev/ttyUSB0', baudRate: 115200 }
    })
  ]

  const idsOf = (kw) =>
    groupConnections(conns, kw)
      .flatMap((g) => g.items)
      .map((c) => c.id)

  check(
    '搜 1022 只命中 C1022，不子序列误命中 10.42.42.200 与 Robot-10-v2-2',
    JSON.stringify(idsOf('1022')) === JSON.stringify(['c1022']),
    JSON.stringify(idsOf('1022'))
  )

  check(
    '搜 1506 精准命中 R1506 与 C1506',
    idsOf('1506').length === 2 && idsOf('1506').includes('r1506') && idsOf('1506').includes('c1506'),
    JSON.stringify(idsOf('1506'))
  )

  check(
    '搜 41506 命中端口 41506 的 C1506',
    JSON.stringify(idsOf('41506')) === JSON.stringify(['c1506']),
    JSON.stringify(idsOf('41506'))
  )

  check(
    '搜 10.42.42.200:41506 精准命中 host:port',
    JSON.stringify(idsOf('10.42.42.200:41506')) === JSON.stringify(['c1506']),
    JSON.stringify(idsOf('10.42.42.200:41506'))
  )

  check(
    '搜 COM3 命中串口设备',
    JSON.stringify(idsOf('COM3')) === JSON.stringify(['ser1']),
    JSON.stringify(idsOf('COM3'))
  )

  check(
    '搜 ttyUSB0 命中 Linux 串口设备',
    JSON.stringify(idsOf('ttyUSB0')) === JSON.stringify(['ser2']),
    JSON.stringify(idsOf('ttyUSB0'))
  )

  check(
    '搜 r223 保留名称模糊/大小写无关命中',
    idsOf('r223').includes('r223'),
    JSON.stringify(idsOf('r223'))
  )

  check(
    '搜 盘空 保留中文标签子序列匹配',
    idsOf('盘空').includes('r223'),
    JSON.stringify(idsOf('盘空'))
  )

  check(
    '搜 root 不跨字符误命中 username=r_o_o_t',
    !idsOf('root').includes('noise2') && idsOf('root').includes('c1022'),
    JSON.stringify(idsOf('root'))
  )

  check(
    '名称直接命中分值高于仅端口命中分值',
    scoreConnection(conns[0], '1022') > scoreConnection(makeConn({ id: 'p', name: '其他', port: 41022 }), '1022')
  )

  fs.rmSync(tmpDir, { recursive: true, force: true })
  console.log(`\n连接搜索精准度：${pass} 通过 / ${fail} 失败`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
  console.error(e)
  process.exit(2)
})
