/* eslint-disable */
/**
 * 中英别名扩展自检：跑 esbuild 打包 → require → 断言。
 * 重点验证「敲 disk 能搜到中文名的磁盘命令」这条用户可见路径。
 */
const path = require('node:path')
const fs = require('node:fs')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')
const out = path.join(root, '.tsc-verify', 'synonyms.cjs')

esbuild.buildSync({
  entryPoints: [path.join(root, 'src/renderer/src/lib/commandSearch.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: out,
  logLevel: 'error',
  alias: { '@shared': path.join(root, 'src/shared') }
})

const { searchCommands, synonymsOf } = require(out)

/* ---------------- 测试用命令集（贴近真实种子数据） ---------------- */
const NOW = 1_700_000_000_000
const mk = (id, name, command, group = '系统信息', extra = {}) => ({
  id,
  name,
  command,
  group,
  description: '',
  icon: 'Terminal',
  sortOrder: 0,
  useCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...extra
})

const COMMANDS = [
  mk('1', '磁盘占用', 'df -h', '进程与资源'),
  mk('2', '磁盘写入测试', 'dd if=/dev/zero of={path} bs=1M count=10', '进程与资源'),
  mk('3', 'CPU 温度', 'for z in /sys/class/thermal/*/temp; do echo $z; cat $z; done', '嵌入式专项'),
  mk('4', 'GPIO 状态', 'cat /sys/kernel/debug/gpio 2>/dev/null || echo "debugfs 未挂载"', '嵌入式专项'),
  mk('5', '内存占用', 'free -m', '进程与资源'),
  mk('6', '端口监听列表', 'netstat -tunlp 2>/dev/null || ss -tunlp', '网络诊断'),
  mk('7', '系统负载', 'cat /proc/loadavg', '进程与资源'),
  mk('8', '固件版本探测', 'cat /etc/version /etc/fw_version', '设备维护'),
  // 以下三条是「短别名子序列噪声」的真实样本：旧实现下敲 disk 会被它们污染
  mk('9', '错误关键字汇总', 'dmesg | grep -iE "error|fail|oops|panic|segfault" | tail -n 50', '日志排查'),
  mk('10', '查看 IP 地址', 'ip addr 2>/dev/null || ifconfig', '网络诊断'),
  mk('11', '重启网络服务', 'systemctl restart networking 2>/dev/null || /etc/init.d/networking restart', '系统信息'),
  mk('12', '磁盘分区表', 'parted -l 2>/dev/null || fdisk -l', '进程与资源')
]

let pass = 0
let fail = 0
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass++
  else {
    fail++
    console.log(`  ✗ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`)
  }
}
const ok = (name, cond, extra) => {
  if (cond) pass++
  else {
    fail++
    console.log(`  ✗ ${name}${extra ? ` — ${JSON.stringify(extra)}` : ''}`)
  }
}

/* ---------------- synonymsOf ---------------- */
ok('disk → 有中文别名', synonymsOf('disk').includes('磁盘'), synonymsOf('disk'))
ok('disk → 含 df', synonymsOf('disk').includes('df'), synonymsOf('disk'))
ok('磁盘 → 含 disk', synonymsOf('磁盘').includes('disk'), synonymsOf('磁盘'))
ok('mem → 含 内存', synonymsOf('mem').includes('内存'), synonymsOf('mem'))
ok('单字符不扩展', synonymsOf('a').length === 0, synonymsOf('a'))
ok('空串不扩展', synonymsOf('  ').length === 0, synonymsOf('  '))
ok('无关词不扩展', synonymsOf('zzzz').length === 0, synonymsOf('zzzz'))
ok('结果不含原词', !synonymsOf('disk').includes('disk'), synonymsOf('disk'))
ok('去重', new Set(synonymsOf('disk')).size === synonymsOf('disk').length)

/* ---------------- searchCommands 走别名兜底 ---------------- */
const names = (q, extra = {}) =>
  searchCommands({ commands: COMMANDS, query: q, scope: { kind: 'all' }, now: NOW, ...extra }).map(
    (r) => r.command.name
  )

// 直接命中优先，别名兜底
ok('df 直接命中磁盘占用', names('df').includes('磁盘占用'), names('df'))
ok('disk 别名命中磁盘占用', names('disk').includes('磁盘占用'), names('disk'))
ok('disk 别名命中磁盘写入测试', names('disk').includes('磁盘写入测试'), names('disk'))
ok('磁盘 直接命中两条', names('磁盘').length >= 2, names('磁盘'))
ok('mem 别名命中内存占用', names('mem').includes('内存占用'), names('mem'))
ok('温度 直接命中 CPU 温度', names('温度').includes('CPU 温度'), names('温度'))

// 别名不得污染完全无关的命令
ok('disk 不返回端口监听', !names('disk').includes('端口监听列表'), names('disk'))
ok('disk 不返回固件版本探测', !names('disk').includes('固件版本探测'), names('disk'))
// 关键回归：别名只认子串命中。df / mount 这种两三个字母的别名
// 若走子序列，会把 dmesg...fail、ip addr...|| 这类命令全捞进来
ok('disk 不返回错误关键字汇总', !names('disk').includes('错误关键字汇总'), names('disk'))
ok('disk 不返回查看 IP 地址', !names('disk').includes('查看 IP 地址'), names('disk'))
ok('disk 不返回重启网络服务', !names('disk').includes('重启网络服务'), names('disk'))
ok('disk 结果集精炼', names('disk').length <= 6, names('disk'))
ok('disk 含磁盘分区表', names('disk').includes('磁盘分区表'), names('disk'))
// 子序列噪声：GPIO 的命令原文里能凑出 d…i…s…k（debugfs … kernel … disk），
// 靠保底分过滤掉，否则 41 条命令里总有一条长 shell 行来搅局
ok('disk 不返回 GPIO 状态', !names('disk').includes('GPIO 状态'), names('disk'))

// 命中的条目必须带 via 标记，便于 UI 提示「≈磁盘」
const diskHit = searchCommands({
  commands: COMMANDS,
  query: 'disk',
  scope: { kind: 'all' },
  now: NOW
}).find((r) => r.command.name === '磁盘占用')
ok('别名命中带 via', diskHit && diskHit.via === '磁盘', diskHit && diskHit.via)

// 直接命中不该带 via
const directHit = searchCommands({
  commands: COMMANDS,
  query: '磁盘',
  scope: { kind: 'all' },
  now: NOW
}).find((r) => r.command.name === '磁盘占用')
ok('直接命中无 via', directHit && directHit.via === undefined, directHit && directHit.via)

// 别名权重低于直接命中：'磁盘' 的第一名应当仍是中文直接命中项，
// 而不是靠英文别名反查出来的条目
const top = names('磁盘')[0]
ok('磁盘 首位是直接命中', top === '磁盘占用' || top === '磁盘写入测试', top)

// 与 scope 正交：收窄到分组后别名仍然生效
const scoped = searchCommands({
  commands: COMMANDS,
  query: 'disk',
  scope: { kind: 'group', group: '进程与资源' },
  now: NOW
}).map((r) => r.command.name)
ok('scope + 别名', scoped.includes('磁盘占用') && scoped.includes('磁盘写入测试'), scoped)

// 耗时护栏：41 条命令 × 别名扩展应在 5ms 内
const t0 = process.hrtime.bigint()
for (let i = 0; i < 500; i++) {
  searchCommands({ commands: COMMANDS, query: 'disk', scope: { kind: 'all' }, now: NOW })
}
const perCall = Number(process.hrtime.bigint() - t0) / 1e6 / 500
ok(`单次检索 ${perCall.toFixed(3)}ms < 5ms`, perCall < 5)

// 只删自己的产物：整目录删除会把 tsconfig.verify.json 编出的 main/util/*.js 一起清掉，
// 批量跑时排在后面的 verify-zip / verify-diff 等就找不到模块
fs.rmSync(out, { force: true })
console.log(`\n通过 ${pass} 失败 ${fail}`)
process.exit(fail ? 1 : 0)
