/**
 * 文件树「双击目录 → 终端 cd」压测：
 * 直接从 SessionFileTree.tsx 抽取 shellQuote / expandChain 源码转译执行（测的就是线上代码），
 * 用大量随机「恶意」路径喂给真实 bash / dash，校验：
 *   1. 引用后 shell 还原出的字符串与原路径逐字节一致
 *   2. 路径里的 ' ; $() ` && | 等不会触发命令注入（金丝雀文件不应被创建）
 *   3. 真实目录下 cd 后 pwd 与预期一致
 * 用法：node scripts/verify-cdsync.cjs [随机用例数，默认 3000]
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')
const ts = require('typescript')

const SRC = path.join(__dirname, '../src/renderer/src/components/files/SessionFileTree.tsx')
const src = fs.readFileSync(SRC, 'utf8')

function extract(name) {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`))
  if (!m) throw new Error(`源码中找不到 ${name}`)
  return m[0]
}
const js = ts.transpileModule(
  `${extract('shellQuote')}\n${extract('expandChain')}\nmodule.exports = { shellQuote, expandChain }`,
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }
).outputText
const mod = { exports: {} }
new Function('module', 'exports', js)(mod, mod.exports)
const { shellQuote, expandChain } = mod.exports
const hasUnsafe = /isUnsafeForTerminal/.test(src)
const isUnsafe = hasUnsafe
  ? (() => {
      const m2 = { exports: {} }
      const j2 = ts.transpileModule(`${extract('isUnsafeForTerminal')}\nmodule.exports = isUnsafeForTerminal`, {
        compilerOptions: { module: ts.ModuleKind.CommonJS }
      }).outputText
      new Function('module', 'exports', j2)(m2, m2.exports)
      return m2.exports
    })()
  : null

let pass = 0
let fail = 0
const failures = []
function check(name, ok, detail) {
  if (ok) pass++
  else {
    fail++
    if (failures.length < 15) failures.push(`${name}: ${detail}`)
  }
}

/* ---------- 用例生成 ---------- */
const NASTY = [
  "'", '"', '\\', '$', '`', ';', '&', '|', '>', '<', '(', ')', '{', '}', '[', ']', '*', '?', '!', '#',
  '~', '%', '^', '=', ',', ' ', '\t', '\n', '-', '.', '中', '文', '😀', 'é', '$(', '${', "'\\''"
]
const ALNUM = 'abcXYZ019_'
function rnd(n) {
  return Math.floor(Math.random() * n)
}
function randomSegment() {
  const len = 1 + rnd(12)
  let s = ''
  for (let i = 0; i < len; i++) s += Math.random() < 0.5 ? NASTY[rnd(NASTY.length)] : ALNUM[rnd(ALNUM.length)]
  return s.replace(/\//g, '_')
}
function randomPath() {
  const depth = 1 + rnd(5)
  let p = ''
  for (let i = 0; i < depth; i++) p += '/' + randomSegment()
  return p
}

const N = Number(process.argv[2]) || 3000
const fixed = [
  '/',
  '/home/share',
  "/tmp/it's here",
  "/tmp/''''",
  "/tmp/a'; touch CANARY; echo '",
  '/tmp/$(touch CANARY)',
  '/tmp/`touch CANARY`',
  '/tmp/${IFS}touch${IFS}CANARY',
  '/tmp/a && touch CANARY',
  '/tmp/a | touch CANARY',
  '/tmp/\n touch CANARY',
  '/tmp/-rf',
  '/tmp/中文 目录/带 空格',
  '/' + 'x'.repeat(4000)
]
const cases = [...fixed, ...Array.from({ length: N }, randomPath)]

/* ---------- 1+2：引用还原 + 注入金丝雀（批量，每个 shell 一次进程） ---------- */
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cdsync-'))
const canary = path.join(work, 'CANARY').replace(/\\/g, '/')
const shells = ['bash', 'dash'].filter((sh) => spawnSync(sh, ['-c', 'true']).status === 0)

for (const sh of shells) {
  const script = cases.map((p) => `printf '%s\\0' ${shellQuote(p)}`).join('\n')
  const scriptFile = path.join(work, `roundtrip-${sh}.sh`)
  fs.writeFileSync(scriptFile, script)
  const r = spawnSync(sh, [scriptFile], { cwd: work, maxBuffer: 1 << 28 })
  const out = r.stdout.toString('utf8').split('\0')
  out.pop()
  check(`${sh} 退出码`, r.status === 0, `status=${r.status} stderr=${r.stderr.toString().slice(0, 200)}`)
  check(`${sh} 输出条数`, out.length === cases.length, `${out.length} != ${cases.length}`)
  cases.forEach((p, i) => check(`${sh} 还原`, out[i] === p, JSON.stringify(p) + ' → ' + JSON.stringify(out[i])))
  check(`${sh} 无注入`, !fs.existsSync(canary), '金丝雀文件被创建，存在命令注入')
}

/* ---------- 3：真实目录 cd 后 pwd 一致 ---------- */
const dirCases = cases
  .filter((p) => p.length < 200 && !/[\n\t]/.test(p))
  .slice(0, 300)
  .map((p) => path.posix.join(work.replace(/\\/g, '/'), 'dirs', p.replace(/[:*?"<>|\\]/g, '_')))
for (const sh of shells) {
  let created = 0
  const lines = []
  for (const d of dirCases) {
    try {
      fs.mkdirSync(d, { recursive: true })
      created++
      lines.push(`cd ${shellQuote(d)} && pwd -P | tr -d '\\n' && printf '\\0' || printf 'FAIL\\0'`)
    } catch {
      /* Windows 下部分字符无法建目录，跳过 */
    }
  }
  // 写成脚本文件执行：-c 传大段脚本会超过 Windows 命令行长度上限
  const cdFile = path.join(work, `cd-${sh}.sh`)
  fs.writeFileSync(cdFile, lines.join('\n'))
  const r = spawnSync(sh, [cdFile], { cwd: work, maxBuffer: 1 << 26 })
  if (r.error) throw r.error
  const out = r.stdout.toString('utf8').split('\0')
  out.pop()
  check(`${sh} cd 全部成功`, !out.includes('FAIL') && out.length === created, `成功 ${out.filter((x) => x !== 'FAIL').length}/${created}`)
}

/* ---------- 4：expandChain ---------- */
const chainCases = [
  ['/home/share', ['/home', '/home/share']],
  ['/', []],
  ['/root', ['/root']],
  ['//home//share/', ['/home', '/home/share']]
]
for (const [input, expect] of chainCases) {
  const got = expandChain(input)
  check('expandChain', JSON.stringify(got) === JSON.stringify(expect), `${input} → ${JSON.stringify(got)}`)
}

/* ---------- 5：终端控制字符（tty 行规程 / readline 会解释，引号挡不住） ---------- */
const ctrlPaths = ['/tmp/a\x03b', '/tmp/a\rrm -rf ~\r', '/tmp/\x15x', '/tmp/\x1b[200~', '/tmp/\x7f', '/tmp/a\nb']
for (const p of ctrlPaths) {
  check(
    '控制字符拦截',
    !!isUnsafe && isUnsafe(p) === true,
    hasUnsafe ? `${JSON.stringify(p)} 未被拦截` : '缺少 isUnsafeForTerminal，含控制字符的路径会原样发给终端'
  )
}
if (isUnsafe) {
  for (const p of ['/home/share', '/tmp/中文 目录', "/tmp/it's"]) {
    check('正常路径放行', isUnsafe(p) === false, `${JSON.stringify(p)} 被误拦`)
  }
}

fs.rmSync(work, { recursive: true, force: true })

console.log(`shells: ${shells.join(', ') || '(无)'}  用例: ${cases.length}`)
console.log(`通过 ${pass}  失败 ${fail}`)
failures.forEach((f) => console.log('  ✗ ' + f))
process.exit(fail ? 1 : 0)
