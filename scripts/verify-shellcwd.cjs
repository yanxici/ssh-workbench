/**
 * shellCwd 纯逻辑单测：把 src/renderer/src/lib/shellCwd.ts 用 esbuild 打成 CJS 直接跑。
 * 测的就是线上那份代码，不复制粘贴。
 *
 * 用法：node scripts/verify-shellcwd.cjs
 * 退出码 0 = 全部通过。
 */
const path = require('path')
const esbuild = require('esbuild')

const SRC = path.join(__dirname, '../src/renderer/src/lib/shellCwd.ts')
const out = esbuild.buildSync({
  entryPoints: [SRC],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  write: false,
  logLevel: 'silent'
})
const mod = { exports: {} }
new Function('module', 'exports', 'require', out.outputFiles[0].text)(mod, mod.exports, require)
const {
  createInputTracker,
  normalizePosix,
  resolveCdPath,
  containsCdCommand,
  parseOsc7
} = mod.exports

let pass = 0
const fails = []
function eq(actual, expected, label) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) pass++
  else fails.push(`${label}\n    期望 ${e}\n    实际 ${a}`)
}

const HOME = '/home/dev'

/* ---------------- 1. InputTracker：把按键还原成整行 ---------------- */
{
  const t = createInputTracker()
  eq(t.feed('ls -la\r'), 'ls -la', 'T1 普通一行')
  eq(t.feed('cd /va'), null, 'T2 未回车返回 null')
  eq(t.feed('r\r'), 'cd /var', 'T3 分段送达后拼成一行')
}
{
  const t = createInputTracker()
  eq(t.feed('\r'), null, 'T4 空行不算命令')
  eq(t.feed('   \r'), null, 'T5 全空白不算命令')
}
{
  const t = createInputTracker()
  // 退格修正
  eq(t.feed('cd /etcc\x7f\r'), 'cd /etc', 'T6 退格删字符')
  // Ctrl-U 清行
  eq(t.feed('garbage\x15cd /tmp\r'), 'cd /tmp', 'T7 Ctrl-U 清空整行')
  // Ctrl-W 删词：`cd /var/log` → `cd ` （空格保留，与 bash 一致）
  eq(t.feed('cd /var/log\x17tmp\r'), 'cd tmp', 'T8 Ctrl-W 删最后一个词后继续输入')
}
{
  const t = createInputTracker()
  // Ctrl-C 放弃
  eq(t.feed('cd /etc\x03'), null, 'T9 Ctrl-C 放弃且无输出')
  // Tab 补全 → 这一行不可信
  eq(t.feed('cd /us\tr\r'), null, 'T10 Tab 补全后整行不可信')
  eq(t.feed('cd /opt\r'), 'cd /opt', 'T11 不可信只影响那一行')
}
{
  const t = createInputTracker()
  // 方向键翻历史 → 不可信（我们看不到翻出来的是什么）
  eq(t.feed('cd /ho\x1b[Ame\r'), null, 'T12 方向键后整行不可信')
  eq(t.feed('cd /srv\r'), 'cd /srv', 'T13 方向键只污染当行')
}
{
  const t = createInputTracker()
  const long = 'x'.repeat(5000)
  eq(t.feed(long + '\r'), null, 'T14 超长行被丢弃')
  eq(t.feed('cd /srv\r'), 'cd /srv', 'T15 超长行之后恢复正常')
}
{
  // bracketed paste：`\x1b[200~ … \x1b[201~` 里的内容是可见的，照常累积
  const t = createInputTracker()
  eq(t.feed('\x1b[200~cd /opt/my app\x1b[201~'), null, 'T16 粘贴未回车返回 null')
  eq(t.feed('\r'), 'cd /opt/my app', 'T17 单行粘贴可识别')
  eq(t.feed('\x1b[200~cd /a && cd b\x1b[201~\r'), 'cd /a && cd b', 'T18 一次 feed 完成整段粘贴+回车')
}
{
  // 粘贴块里带换行 → 执行到哪一行不可判定，整行作废
  const t = createInputTracker()
  eq(t.feed('\x1b[200~cd /a\ncd /b\x1b[201~\r'), null, 'T19 多行粘贴整行不可信')
  eq(t.feed('cd /srv\r'), 'cd /srv', 'T20 多行粘贴后恢复正常')
}
{
  // 粘贴标记被拆到两次 feed（终端一次只给几个字节）
  const t = createInputTracker()
  eq(t.feed('\x1b[20'), null, 'T21 半个粘贴起始标记暂存')
  eq(t.feed('0~cd /etc\x1b[201'), null, 'T22 结束标记也被拆开')
  eq(t.feed('~\r'), 'cd /etc', 'T23 拆开的粘贴标记仍能拼回')
}
{
  // 行中粘贴：光标永远在行尾（移动光标会标 unknown），所以拼接结果就是 readline 里的内容
  const t = createInputTracker()
  eq(t.feed('cd /a\x1b[200~ cd /b\x1b[201~\r'), 'cd /a cd /b', 'T24 行中粘贴按字面拼接')
  // 但这样的行不是一个合法 cd，解析层会自行放弃
  eq(resolveCdPath('cd /a cd /b', HOME, HOME), null, 'T24b 双参数 cd 解析为 null')
}

/* ---------------- 2. normalizePosix ---------------- */
eq(normalizePosix('/a/b/../c'), '/a/c', 'N1 折叠 ..')
eq(normalizePosix('/a//b///c/'), '/a/b/c', 'N2 折叠重复斜杠与尾斜杠')
eq(normalizePosix('/a/./b'), '/a/b', 'N3 去掉 .')
eq(normalizePosix('/..'), '/', 'N4 根之上仍是根')
eq(normalizePosix('/'), '/', 'N5 根目录')

/* ---------------- 3. containsCdCommand ---------------- */
eq(containsCdCommand('cd /tmp'), true, 'C1 裸 cd')
eq(containsCdCommand('  cd\t/tmp'), true, 'C2 前导空白 + 制表符')
eq(containsCdCommand('ls && cd /tmp'), true, 'C3 在 && 之后')
eq(containsCdCommand('echo hi;cd /x'), true, 'C4 在 ; 之后')
eq(containsCdCommand('ls -l /abcd'), false, 'C5 abcd 不命中')
eq(containsCdCommand('mount /dev/cdrom'), false, 'C6 cdrom 不命中')
eq(containsCdCommand('cdrecord -v'), false, 'C7 cdrecord 不命中')

/* ---------------- 4. resolveCdPath ---------------- */
const cases = [
  ['cd /etc', '/etc'],
  ['cd /etc/', '/etc'],
  ['cd /etc/../var', '/var'],
  ['cd var', '/home/dev/var'],
  ['cd ..', '/home'],
  ['cd ../..', '/'],
  ['cd ~', '/home/dev'],
  ['cd ~/work', '/home/dev/work'],
  ['cd', '/home/dev'],
  ['cd -- /etc', '/etc'],
  ['cd -P /etc', '/etc'],
  ['cd -LP /etc', '/etc'],
  ['builtin cd /etc', '/etc'],
  ['command cd /etc', '/etc'],
  ['cd "/opt/my app"', '/opt/my app'],
  ["cd '/opt/my app'", '/opt/my app'],
  ['cd /opt/my\\ app', '/opt/my app'],
  // 多个 cd 取最后一个（与 shell 的最终 cwd 一致）
  ['cd /a && cd b', '/home/dev/b'],
  ['cd /a; cd /b', '/b'],
  // 不可判定 → null（宁可不动，也不要跟错）
  ['cd ~other/x', null],
  ['cd $DIR', null],
  ['cd /opt/*', null],
  ['cd `pwd`', null],
  ['cd -', null],
  ['ls -la', null],
  ['echo cd', null],
  ['pushd /etc', null],
  ['z foo', null],
  // 后面的命令不影响最终 cwd：shell 执行完还是停在 /etc
  ['cd /etc && rm -rf $X', '/etc'],
  // 但 cd 自己的参数是动态的，就不可判定
  ['cd /etc && cd $X', null],
  ['cd "/opt/unclosed', null],
  // 多参数 cd：shell 报 too many arguments，目录不动
  ['cd /a /b', null],
  ['cd /a b', null]
]
for (const [line, want] of cases) eq(resolveCdPath(line, HOME, HOME), want, `R ${line}`)

// 相对路径在没有基准时必须放弃
eq(resolveCdPath('cd var', '', HOME), null, 'R 无基准的相对路径 → null')
// 有基准时用基准而不是 home
eq(resolveCdPath('cd sub', '/srv/app', HOME), '/srv/app/sub', 'R 用当前基准拼相对路径')

/* ---------------- 5. parseOsc7 ---------------- */
eq(parseOsc7('file://host/home/dev'), '/home/dev', 'O1 常见载荷')
eq(parseOsc7('file:///home/dev'), '/home/dev', 'O2 空 host')
eq(parseOsc7('file://host/opt/my%20app'), '/opt/my app', 'O3 百分号解码')
eq(parseOsc7('file://host/opt/%zz'), '/opt/%zz', 'O4 非法编码按原样')
eq(parseOsc7('file://host/rel'), '/rel', 'O5 host 之后的段按绝对路径处理')
eq(parseOsc7('file://host'), null, 'O5b 只有 host 没有路径 → null')
eq(parseOsc7('http://host/x'), null, 'O6 非 file scheme → null')
eq(parseOsc7(''), null, 'O7 空载荷 → null')

/* ---------------- 6. 端到端：敲一行 → 得到目录 ---------------- */
{
  const t = createInputTracker()
  const line = t.feed('cd /var/log\r')
  eq(resolveCdPath(line, HOME, HOME), '/var/log', 'E1 端到端 cd /var/log')
}
{
  const t = createInputTracker()
  t.feed('cd /tmp\r')
  // 同一行再 cd 一次（路径没变）——seq 机制交给 store 测，这里只验解析稳定
  eq(resolveCdPath(t.feed('cd /tmp\r'), '/tmp', HOME), '/tmp', 'E2 重复 cd 同一路径')
}

/* ---------------- 输出 ---------------- */
if (fails.length) {
  console.error(`\n✗ ${fails.length} 项失败，${pass} 项通过\n`)
  for (const f of fails) console.error('  - ' + f)
  process.exit(1)
}
console.log(`✓ shellCwd 全部 ${pass} 项通过`)
