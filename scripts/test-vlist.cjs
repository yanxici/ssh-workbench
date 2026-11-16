/**
 * 虚拟列表门禁的包装器。
 *
 * 为什么需要单独一条：verify-virtual-list.cjs 依赖 `ZM_TEST=1` 构建才有的测试桥
 * （window.__lazy_test），而主门禁 run-all-verify 用的是普通构建。
 * 把「构建测试版 → 跑断言 → 恢复普通构建」封装在这里，三条好处：
 *   1. 主门禁不会被一个需要特殊构建的脚本污染；
 *   2. 人手跑 `npm run test:vlist` 也能一键复现；
 *   3. **结束时一定恢复普通构建** —— 否则 out/ 里留着带测试钩子的产物，
 *      后面的 e2e 会看到一个多出全局对象的环境，问题极难查。
 *
 * 用法：npm run test:vlist
 */
const { spawnSync } = require('node:child_process')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
function run(cmd, args, env) {
  const r = spawnSync(cmd, args, { cwd: ROOT, env, stdio: 'inherit', shell: process.platform === 'win32' })
  return r.status === 0
}

const baseEnv = { ...process.env }
delete baseEnv.ELECTRON_RUN_AS_NODE

console.log('[1/3] 构建测试版（ZM_TEST=1）')
if (!run('npm', ['run', 'build'], { ...baseEnv, ZM_TEST: '1' })) {
  console.error('测试版构建失败')
  process.exit(1)
}

console.log('[2/3] 运行虚拟列表断言')
const ok = run(process.execPath, [path.join('scripts', 'check-virtual-list.cjs')], baseEnv)

console.log('[3/3] 恢复普通构建（避免测试钩子残留进后续 e2e）')
const restored = run('npm', ['run', 'build'], baseEnv)
if (!restored) console.error('!! 普通构建恢复失败，请手动 npm run build')

process.exit(ok && restored ? 0 : 1)