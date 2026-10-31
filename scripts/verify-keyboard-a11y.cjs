/**
 * 验证两处键盘可达性修复 —— **静态源码断言，不是行为测试**。
 *
 * 用法：node scripts/verify-keyboard-a11y.cjs
 *
 * 定性（重要，别误读）：本脚本扫 FileExplorer.tsx / ConnectionSidebar.tsx 的源码
 * 文字，断言「同一行元素内既有 tabIndex 又有 onKeyDown」「Delete 前先 setSelected」
 * 这类结构事实。它能防住「改回去」的回归，成本极低；
 * 但它**不验证键盘事件真能触发** —— 断言通过不代表按 Tab 真的落到了那一行。
 * 真正的行为覆盖（CDP Input.dispatchKeyEvent：Tab 聚焦 → Enter 展开 → Delete 弹框）
 * 要等 lab server 那轮和隧道 e2e 一起补。
 * 另外它依赖具体写法：重构一次文件结构就可能误伤，误伤时优先核代码再看脚本。
 *
 * 背景（Prism 报的 P2-7 / P2-8）：
 *   P2-7 文件树行是不可聚焦的 div，Tab 键落不到上面，§5.5 的 focus-visible
 *        约束在文件树上等于摆设；而连接列表的行有 tabIndex + Enter/Delete，
 *        两处手感不一致。
 *   P2-8 连接列表：单击不选中（有意设计，避免高亮干扰视线），
 *        于是 Tab 到某行直接按 Delete 时 selectedIds 是空的，
 *        弹出「删除选中的 0 条连接」——用户以为要删这行，确认后什么都没发生。
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
  /* ---------------- P2-7 文件树行键盘可达 ---------------- */
  const explorer = read('src/renderer/src/components/files/FileExplorer.tsx')

  check('FileExplorer 里有 tabIndex', /tabIndex=\{0\}/.test(explorer))
  check('FileExplorer 行有 focus-visible 样式', /focus-visible:bg-hover/.test(explorer))
  check('FileExplorer 行绑定了 onKeyDown', /onKeyDown=\{\(e\) => \{[\s\S]{0,900}?e\.key === 'Enter'/.test(explorer))
  check('Enter 在目录上走 toggleDir', /if \(isDir\) toggleDir\(file\.path\)/.test(explorer))
  check('Enter 在文件上走 openEditor', /else void openEditor\(sessionId, file\.path\)/.test(explorer))
  check('Delete 打开消除确认（不直接删）', /setPendingDelete\(file\)/.test(explorer))

  /*
   * 计数断言：行元素（data-file-path 那个 div）必须同时有 tabIndex 与 onKeyDown。
   * 光在别处出现 tabIndex 不算 —— 侧栏那些按钮本来就有。
   */
  const rowBlock = explorer.slice(
    explorer.indexOf('data-file-path={file.path}'),
    explorer.indexOf('data-file-path={file.path}') + 1400
  )
  check('同一行元素内既有 tabIndex 又有 onKeyDown',
    rowBlock.includes('tabIndex={0}') && rowBlock.includes('onKeyDown'), 
    { hasTabIndex: rowBlock.includes('tabIndex={0}'), hasKeyDown: rowBlock.includes('onKeyDown') })
  // 用全文而非 rowBlock 窗口：Delete 分支距 data-file-path 锚点超过 1400 字符
  check('Delete 前先 setSelected，保证删的是焦点行',
    /e\.key === 'Delete'[\s\S]{0,200}?setSelected\(file\.path\)/.test(explorer))

  /* ---------------- P2-8 Delete 删焦点行而非空集 ---------------- */
  const sidebar = read('src/renderer/src/components/connections/ConnectionSidebar.tsx')

  check('侧栏行有 tabIndex', /tabIndex=\{0\}/.test(sidebar))
  check('Delete 分支内含 selectedIds.has 判断',
    /e\.key === 'Delete'[\s\S]{0,600}?selectedIds\.has\(c\.id\)/.test(sidebar))
  check('不在选中集时把自己塞进集合',
    /if \(!selectedIds\.has\(c\.id\)\) \{[\s\S]{0,160}?setSelectedIds\(new Set\(\[c\.id\]\)\)/.test(sidebar))
  check('确认后遇到空集直接返回（不弹「已删除 0 条」）',
    /if \(ids\.length === 0\) \{[\s\S]{0,200}?return/.test(sidebar))

  console.log(`\n${failed === 0 ? '键盘可达性回归全部通过' : `${failed} 项失败`}`)
  process.exit(failed === 0 ? 0 : 1)
}

main()
