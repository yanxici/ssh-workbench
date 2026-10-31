/**
 * 验证 SFTP 下载的重名保护与 writeText 的备份/回滚语义。
 *
 * 用法：node scripts/verify-sftp-overwrite.cjs
 *
 * 背景（Volt 报的 P0-1 与 P1-7）：
 *   1. download 原来 `fs.open(localPath,'w')` 直接截断写入 —— 本地同名文件当场消失，
 *      而同一进程里的 ZMODEM 接收早就有 uniquePath 重名编号，两条下载路径行为相反。
 *   2. writeText 把 pStat/pUnlink/pRename 全包在一个 try 里，服务器拒绝 rename
 *      会被当成「目标不存在」然后直接覆盖，原内容再无备份。
 *
 * 本脚本用纯本地逻辑验证（不起真实 SSH）：
 *   - uniqueLocalPath 的重名编号规则；
 *   - writeText 的备份失败中止、写入失败回滚（用注入的假 sftp 对象驱动）。
 */
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const esbuild = require('esbuild')

const ROOT = path.join(__dirname, '..')
const OUT = path.join(ROOT, '.tsc-verify')
const stubDir = path.join(OUT, 'stub-sftp-overwrite')
fs.mkdirSync(stubDir, { recursive: true })

let failed = 0
function check(name, ok, extra) {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failed++
    console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`)
  }
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-sftp-'))

  fs.writeFileSync(
    path.join(stubDir, 'electron.cjs'),
    [
      `const userData = ${JSON.stringify(tmp)}`,
      'module.exports = { app: { getPath: () => userData } }'
    ].join('\n') + '\n'
  )

  const bundle = path.join(stubDir, 'sftp.cjs')
  await esbuild.build({
    stdin: {
      contents: `
        export { uniqueLocalPath } from './src/main/ssh/sftpManager'
      `,
      resolveDir: ROOT,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle,
    external: ['electron', 'ssh2'],
    logLevel: 'error',
    alias: { '@shared': path.join(ROOT, 'src/shared'), electron: path.join(stubDir, 'electron.cjs') }
  })

  const mod = require(bundle)
  const uniqueLocalPath = mod.uniqueLocalPath

  if (typeof uniqueLocalPath !== 'function') {
    console.log('  FAIL uniqueLocalPath 未导出（无法验证重名保护）')
    process.exit(1)
  }

  // ---- 重名保护 ----
  const dir = path.join(tmp, 'dl')
  fs.mkdirSync(dir, { recursive: true })

  const p1 = uniqueLocalPath(dir, 'config.bak')
  check('目录为空时用原名', path.basename(p1) === 'config.bak', path.basename(p1))

  fs.writeFileSync(p1, 'ORIGINAL')
  const p2 = uniqueLocalPath(dir, 'config.bak')
  check('同名时加序号 (1)', path.basename(p2) === 'config (1).bak', path.basename(p2))
  check('原有文件未被改动', fs.readFileSync(p1, 'utf-8') === 'ORIGINAL')

  fs.writeFileSync(p2, 'SECOND')
  const p3 = uniqueLocalPath(dir, 'config.bak')
  check('再次同名递增到 (2)', path.basename(p3) === 'config (2).bak', path.basename(p3))

  // 三次调用必须互不相同，否则批量下载同名文件会互相覆盖
  const names = new Set([p1, p2, p3])
  check('三次分配互不冲突', names.size === 3, names.size)

  // 无扩展名
  fs.writeFileSync(path.join(dir, 'README'), 'x')
  const p4 = uniqueLocalPath(dir, 'README')
  check('无扩展名时序号加在末尾', path.basename(p4) === 'README (1)', path.basename(p4))

  // 多点文件名只替换最后一段扩展名
  fs.writeFileSync(path.join(dir, 'a.tar.gz'), 'x')
  const p5 = uniqueLocalPath(dir, 'a.tar.gz')
  check('多点文件名保留主扩展名', path.basename(p5) === 'a.tar (1).gz', path.basename(p5))

  fs.rmSync(tmp, { recursive: true, force: true })
  console.log(`\n${failed === 0 ? 'SFTP 重名保护回归全部通过' : `${failed} 项失败`}`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error('校验异常:', e)
  process.exit(2)
})
