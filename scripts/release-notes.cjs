/**
 * 生成 Release 正文：从 CHANGELOG.md 抽当前版本的整段。
 *
 * 为什么不再用仓库里的 release-notes-v<ver>.md：一版一个 md 堆在仓库根目录，
 * 20 个文件读起来像一堆重复碎片；内容其实 CHANGELOG 里已经有一份（唯一需要
 * 维护的那份）。改成发布时现抽，仓库里不再保留任何 release-notes 文件。
 *
 * 用法：
 *   node scripts/release-notes.cjs                  # 打印到 stdout
 *   node scripts/release-notes.cjs --out <path>     # 写入文件（release.ps1 / CI 用）
 *   node scripts/release-notes.cjs --version 2.2.0  # 指定版本（默认读 package.json）
 *
 * 退出码非 0 = CHANGELOG 没有这一版条目或正文过短，发布应当中止。
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const MIN_CHARS = 200

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out.out = argv[++i]
    else if (argv[i] === '--version') out.version = argv[++i]
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
const version = args.version || pkg.version

const lines = fs
  .readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8')
  .split(/[\r]?[\n]/)
  .map((l) => l.replace(/[\r]$/, ''))

const prefix = '## ['
const candidates = ['## [' + version + ']', '## [v' + version + ']']
const start = lines.findIndex((l) => candidates.some((c) => l.startsWith(c)))
if (start < 0) {
  console.error('CHANGELOG.md 里没有 [' + version + '] 条目 —— 先写这一版再发版')
  process.exit(1)
}

let end = lines.length
for (let i = start + 1; i < lines.length; i++) {
  if (/^##\s/.test(lines[i])) {
    end = i
    break
  }
}

const dateMatch = /-\s*(\d{4}-\d{2}-\d{2})/.exec(lines[start])
const header = '# SSH Workbench v' + version + (dateMatch ? '（' + dateMatch[1] + '）' : '')
const text = header + '\n\n' + lines.slice(start + 1, end).join('\n').trim() + '\n'

const chars = [...text].length
if (chars < MIN_CHARS) {
  console.error('从 CHANGELOG 抽出的 v' + version + ' 正文只有 ' + chars + ' 字符（下限 ' + MIN_CHARS + '），疑似占位符')
  process.exit(1)
}

if (args.out) {
  fs.writeFileSync(args.out, text, 'utf8')
  console.log('Release 正文已生成：' + args.out + '（' + chars + ' 字符，取自 CHANGELOG [' + version + ']）')
} else {
  process.stdout.write(text)
}
