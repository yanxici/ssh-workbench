/**
 * 文件面板「刷新很慢 / 按钮按不下去」回归 —— **静态源码断言，不是行为测试**。
 *
 * 用法：node scripts/verify-files-refresh.cjs
 *
 * 定性：扫源码文字，防的是「改回去」。它不验证点击真的发了请求，
 * 真正的行为覆盖要等 lab SSH + CDP 那轮。
 *
 * 背景（用户报的：文件面板刷新很慢、刷新按钮按下去没反应）：
 *   1) SessionFileTree 的 TreeLevel 只看缓存是否在 30s 新鲜期内：
 *      刚展开过的目录点刷新，effect 直接 return —— 一次请求都不发。
 *   2) 刷新按钮没有任何在途反馈（图标不转、不禁用），点下去像没反应。
 *   3) FileExplorer 的 forced 分支有缓存时不进 loading，同一个症状。
 *   4) 主进程 readdir 没有超时：链路悄悄断掉时 ssh2 回调永不触发，
 *      界面永远 loading，按钮被 disabled 锁死无法自愈。
 *   5) list() 里任何 readdir 失败都 invalidate 整条 SFTP 通道，
 *      一个没权限的目录就让下一个请求重新握手 —— 这才是「慢」的主因。
 */
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
let failed = 0
function check(name, ok, extra) {
  if (ok) console.log(`  ok   ${name}`)
  else {
    failed++
    console.log(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`)
  }
}

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf-8')

function main() {
  const tree = read('src/renderer/src/components/files/SessionFileTree.tsx')
  const explorer = read('src/renderer/src/components/files/FileExplorer.tsx')
  const sftp = read('src/main/ssh/sftpManager.ts')

  /* ---- 1. 强制刷新必须绕过 30s 新鲜期 ---- */
  check(
    'TreeLevel 命中新鲜缓存时仍区分 forceRefresh',
    /if \(fresh && !forceRefresh\)/.test(tree)
  )
  check(
    '不再有无条件 \'if (fresh) return\' 的早退',
    !/if \(fresh\) \{\s*setRefreshing\(false\)\s*return/.test(tree)
  )

  /* ---- 2. 刷新按钮要有在途反馈 ---- */
  check('SessionFileTree 刷新按钮会转', /RefreshCw size=\{12\} className=\{cn\(loadingLevels > 0 && 'animate-spin'\)\}/.test(tree))
  check('SessionFileTree 刷新按钮加载中禁用', /disabled=\{loadingLevels > 0\}/.test(tree))
  check('SessionFileTree 用计数而非布尔跟踪在途层级', /setLoadingLevels\(\(n\) => Math\.max\(0, n \+ \(busy \? 1 : -1\)\)\)/.test(tree))
  check('TreeLevel 把 busy 回报给上层', /onBusyRef\.current\(true\)/.test(tree) && /onBusyRef\.current\(false\)/.test(tree))

  check('FileExplorer 刷新按钮会转', /RefreshCw size=\{13\} className=\{cn\(loading && 'animate-spin'\)\}/.test(explorer))
  check('FileExplorer 刷新按钮加载中禁用', /title=\{loading \? (?:t\('files\.ui\.refreshing'\)|'正在刷新…') : (?:t\('files\.ui\.refreshDir'\)|'刷新当前目录')\}[\s\S]{0,80}disabled=\{loading\}/.test(explorer))
  check('FileExplorer forced 时即使有缓存也进 loading', /setLoading\(!hit\.cached \|\| forced\)/.test(explorer))

  /* ---- 3. 主进程：全部元数据原语必须带超时 ---- */
  /*
   * 只堵 readdir 的洞不够用。链路断掉后 ssh2 回调一律不触发，
   * 而没有超时的那些原语是三条独立用户路径的唯一入口：
   *   pStat   -> removeRecursive 判类型、目录传输逐文件探测、download 判目录
   *   pUnlink -> 删除（文件与递归删除的每一步）
   *   pRename -> 改名、writeText 的 .bak 备份与回滚
   *   pOpen   -> 上传/下载/文本读写的句柄获取
   * 任何一个缺超时，对应路径就表现为「不报错也不结束」。
   */
  for (const fn of ['pReaddir', 'pStat', 'pUnlink', 'pRename', 'pOpen']) {
    const body = new RegExp('function ' + fn + '[\\s\\S]{0,600}?\\}')
    const src = sftp.match(new RegExp('function ' + fn + '[\\s\\S]{0,700}?\\n\\}'))?.[0] ?? ''
    check(fn + ' 套了 withTimeout', /withTimeout\(/.test(src), body.source)
    check(fn + ' 超时用 META_TIMEOUT_MS', /META_TIMEOUT_MS/.test(src))
  }

  /* ---- 4. 单个目录失败不该作废整条通道 ---- */
  check(
    'list() 只对非 SFTP 状态码的错作废通道',
    /if \(typeof \(err as \{ code\?: unknown \}\)\.code !== 'number'\) this\.invalidate\(sessionId\)/.test(sftp)
  )

  console.log('')
  if (failed) {
    console.log(`失败 ${failed} 项`)
    process.exit(1)
  }
  console.log('文件面板刷新回归全部通过')
}

main()
