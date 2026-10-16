/**
 * 资源采样解析自检（/proc 帧解析 + 差分数学，无需构建环境）。
 * 用法：node node_modules/typescript/bin/tsc -p tsconfig.verify.json && node scripts/verify-metrics.cjs
 */
const { parseSample } = require('../.tsc-verify/main/util/parseProcSample.js')

/** 第 1 帧：total=1170156, idle=999999, rx=eth0+wlan0=13345678, tx=88154321 */
const FRAME1 = [
  'cpu  123456 234 45678 987654 12345 0 789 0 0 0',
  '0.15 0.10 0.05 2/345 6789',
  [
    'MemTotal:        2048000 kB',
    'MemFree:          200000 kB',
    'MemAvailable:    1536000 kB',
    'Buffers:           30000 kB',
    'Cached:           400000 kB'
  ].join('\n'),
  [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo:  100000    1000    0    0    0     0          0         0   100000    1000    0    0    0     0       0          0',
    '  eth0: 12345678    9000    0    0    0     0          0         0  87654321    8000    0    0    0     0       0          0',
    ' wlan0:  1000000    500    0    0    0     0          0         0    500000     400    0    0    0     0       0          0'
  ].join('\n'),
  '/dev/root      1024000  512000  512000  50% /',
  '45000'
].join('\n@@@\n')

/** 第 2 帧：Δtotal=2200, Δidle=1000；Δrx=Δtx=100000（lo 变化 100000 应被忽略）；时长 2s */
const FRAME2 = [
  'cpu  124456 234 45878 988654 12345 0 789 0 0 0',
  '0.20 0.12 0.06 1/345 6790',
  [
    'MemTotal:        2048000 kB',
    'MemFree:          100000 kB',
    'MemAvailable:    1024000 kB',
    'Buffers:           30000 kB',
    'Cached:           400000 kB'
  ].join('\n'),
  [
    'Inter-|   Receive                                                |  Transmit',
    ' face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed',
    '    lo:  200000    2000    0    0    0     0          0         0   100000    1000    0    0    0     0       0          0',
    '  eth0: 12445678    9100    0    0    0     0          0         0  87754321    8100    0    0    0     0       0          0',
    ' wlan0:  1000000    500    0    0    0     0          0         0    500000     400    0    0    0     0       0          0'
  ].join('\n'),
  '/dev/root      1024000  512000  512000  50% /',
  '46500'
].join('\n@@@\n')

let pass = 0
let fail = 0

function check(name, condition, detail) {
  if (condition) {
    pass += 1
    console.log(`  PASS  ${name}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${name}${detail !== undefined ? `  -> ${detail}` : ''}`)
  }
}

const T0 = 1_800_000_000_000

console.log('== 第 1 帧（无基准）==')
let snap1
{
  const { snapshot, metrics } = parseSample(FRAME1, null, T0)
  snap1 = snapshot
  check('快照解析成功', snapshot !== null)
  check('首次无 CPU 差分数值', metrics.cpuPercent === undefined, String(metrics.cpuPercent))
  check('首次无网络速率数值', metrics.netRxKbps === undefined)
  check('内存使用率 = 25%（512/2048 MB）', metrics.memPercent === 25, String(metrics.memPercent))
  check('内存明细 = 500/2000 MB', metrics.memUsedMb === 500 && metrics.memTotalMb === 2000)
  check('磁盘使用率 = 50%', metrics.diskPercent === 50, String(metrics.diskPercent))
  check('磁盘容量 ≈ 0.5/1 GB', metrics.diskUsedGb === 0.5 && metrics.diskTotalGb === 1)
  check('温度 = 45℃（毫摄氏度换算）', metrics.tempC === 45, String(metrics.tempC))
  check('负载 = 0.2', metrics.load1 === 0.2, String(metrics.load1))
  check('快照累计值正确（total=1170156, idle=999999）', snapshot.cpuTotal === 1170156 && snapshot.cpuIdle === 999999)
  check('网络累计已排除 lo（13345678）', snapshot.netRx === 13345678, String(snapshot.netRx))
}

console.log('== 第 2 帧（差分生效）==')
{
  const { snapshot, metrics } = parseSample(FRAME2, snap1, T0 + 2000)
  check('CPU 使用率 = 54.5%（Δidle=1000, Δtotal=2200）', metrics.cpuPercent === 54.5, String(metrics.cpuPercent))
  check('下行速率 = 48.8 KB/s（Δ100000B/2s）', metrics.netRxKbps === 48.8, String(metrics.netRxKbps))
  check('上行速率 = 48.8 KB/s', metrics.netTxKbps === 48.8, String(metrics.netTxKbps))
  check('lo 的巨大变化被忽略（否则将达 97.7）', metrics.netRxKbps !== 97.7)
  check('内存使用率 = 50%（1024000/2048000）', metrics.memPercent === 50, String(metrics.memPercent))
  check('快照已更新', snapshot !== null && snapshot.cpuTotal === 1172356, String(snapshot && snapshot.cpuTotal))
}

console.log('== MemAvailable 缺失 → MemFree+Buffers+Cached 回退 ==')
{
  const frame = [
    'cpu  1 1 1 1 1 0 0 0 0 0',
    '0.00',
    ['MemTotal:        1000000 kB', 'MemFree:          200000 kB', 'Buffers:           50000 kB', 'Cached:           250000 kB'].join('\n'),
    '',
    '/dev/sda1  500000  100000  400000  20% /',
    // 无温度段
  ].join('\n@@@\n')
  const { metrics } = parseSample(frame, null, T0)
  check('回退可用内存 500000 → 使用率 50%', metrics.memPercent === 50, String(metrics.memPercent))
  check('无温度数据时字段缺省', metrics.tempC === undefined)
}

console.log('== 畸形/空输入不崩溃 ==')
{
  const { snapshot, metrics } = parseSample('garbage@@@bad@@@\n@@@\nmalformed@@@\n@@@\nnot-a-number', null, T0)
  check('快照为空（无 /proc/stat cpu 行）', snapshot === null)
  check('指标对象返回且无脏值', typeof metrics === 'object' && metrics.cpuPercent === undefined && metrics.memPercent === undefined)
  const { snapshot: s2 } = parseSample('', null, T0)
  check('空字符串同样安全', s2 === null)
}

console.log('== BusyBox df 变体（6 列）==')
{
  const frame = [
    'cpu  1 1 1 1 1 0 0 0 0 0',
    '0.00',
    '',
    '',
    'ubi0:rootfs    262144    131072     131072  50% /',
    ''
  ].join('\n@@@\n')
  const { metrics } = parseSample(frame, null, T0)
  check('ubi 根分区解析成功', metrics.diskPercent === 50 && metrics.diskUsedGb !== undefined, JSON.stringify(metrics))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
