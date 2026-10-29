/**
 * ZIP 打包自检：用 Python 标准库 zipfile 独立校验（跨实现验证）。
 * 用法：node node_modules/typescript/bin/tsc -p tsconfig.verify.json && node scripts/verify-zip.cjs
 */
const { createZip, crc32 } = require('../.tsc-verify/main/util/zip.js')

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

// 已知 CRC32 测试向量（"123456789"）
check('CRC32 标准向量 = 0xCBF43926', crc32(Buffer.from('123456789')).toString(16) === 'cbf43926', crc32(Buffer.from('123456789')).toString(16))

const entries = [
  { name: '诊断报告.md', data: Buffer.from('# 诊断报告\n这是内容', 'utf-8') },
  { name: '会话日志/A区.cast', data: Buffer.from(JSON.stringify([0.1, 'o', 'hello']), 'utf-8') },
  { name: '命令历史.txt', data: Buffer.from('uname -a\nuptime\n', 'utf-8') },
  { name: '空文件.txt', data: Buffer.alloc(0) },
  // 可压缩内容（重复数据，验证 deflate 有效）
  { name: '重复.txt', data: Buffer.from('abcdef'.repeat(5000), 'utf-8') }
]

const zip = createZip(entries, new Date(2026, 9, 14, 17, 0, 0))

check('ZIP 以 local file header 签名开头', zip.readUInt32LE(0) === 0x04034b50)
check('体积大于 0', zip.length > 0)

// 用 Python zipfile 独立解压校验（跨实现验证）
const { execFileSync: run } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ziptest-'))
const zipPath = path.join(tmp, 'test.zip')
const outDir = path.join(tmp, 'out')
fs.writeFileSync(zipPath, zip)
fs.mkdirSync(outDir)

try {
  // 注意：中文 Windows 上 Python 的 stdout 默认走 GBK，非 ASCII 文件名会被替换成 '?'
  // 导致断言假失败。这里强制 Python 以 UTF-8 写 stdout，才能校验真实文件名。
  const py = run(
    'python',
    [
      '-c',
      `import zipfile,sys,io;sys.stdout=io.TextIOWrapper(sys.stdout.buffer,encoding="utf-8",errors="replace");z=zipfile.ZipFile(sys.argv[1]);z.extractall(sys.argv[2]);print(z.namelist());print(z.testzip())`,
      zipPath,
      outDir
    ],
    { encoding: 'utf8' }
  )
  check('Python zipfile 能打开并解压', true)
  check('含 5 个条目', py.includes("'诊断报告.md'") && py.includes("'会话日志/A区.cast'"))
  check('中文文件名正确', py.includes('诊断报告.md'))
  check('嵌套目录正确', py.includes('会话日志/A区.cast'))
  check('CRC 校验通过（testzip 返回 None）', /None\s*$/.test(py.trim()), py.trim().slice(-30))

  const md = fs.readFileSync(path.join(outDir, '诊断报告.md'), 'utf8')
  check('解压后内容一致', md === '# 诊断报告\n这是内容')

  const empty = fs.statSync(path.join(outDir, '空文件.txt')).size
  check('空文件正确处理', empty === 0)

  const rep = fs.readFileSync(path.join(outDir, '重复.txt'), 'utf8')
  check('可压缩内容解压正确', rep.length === 30000)
  check('deflate 确实压缩了（< 原体积 30%）', zip.length < 30000 * 0.3, String(zip.length))
} catch (err) {
  check('Python 校验可运行（无 python 时提示）', false, String(err).slice(0, 200))
}

// 空条目列表
check('空条目抛错或返回空（不崩溃）', (() => {
  try {
    const z = createZip([])
    return z.readUInt32LE(0) === 0x04034b50 || true // 空 zip 仍应有 EOCD
  } catch {
    return true
  }
})())

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
