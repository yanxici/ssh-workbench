/**
 * 回归护栏：sftpStore 里被各面板共用的「传输 / 编辑」执行链路，必须由调用方显式传入 sessionId。
 *
 * 踩过的坑（v1.6.x）：上传/下载/远端编辑统一收敛到 sftpStore 之后，函数体里写的是
 * `const sessionId = get().sessionId`。而 store.sessionId 只在 openFor 里赋值，
 * 全应用没有一处调用 openFor —— 于是会话内文件树里点「上传」直接静默 return null：
 * 不弹系统对话框、不发 IPC、不提示，表现为「上传坏了」。
 *
 * 钉住三条不变量：
 *   1. 这 8 个动作的函数体里不允许再出现 get().sessionId
 *   2. 它们的第一个形参必须是 sessionId
 *   3. 各面板调用它们时第一个实参必须是 sessionId
 *      （FileExplorer 自有的同名包装函数是本地定义，正则跳过）
 */
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const storePath = path.join(root, 'src/renderer/src/stores/sftpStore.ts')
const actions = [
  'uploadPaths',
  'uploadFileDialog',
  'uploadFolder',
  'requestUpload',
  'downloadPaths',
  'downloadTo',
  'downloadToDefault',
  'openEditor'
]
const callerFiles = [
  'src/renderer/src/components/files/useUploadTarget.ts',
  'src/renderer/src/components/files/FileExplorer.tsx',
  'src/renderer/src/components/files/SessionFileTree.tsx',
  'src/renderer/src/components/files/LocalPane.tsx',
  'src/renderer/src/components/files/RemotePane.tsx',
  'src/renderer/src/components/files/FileManagerPanel.tsx'
]

let failed = 0
const pass = (msg) => console.log('  PASS  ' + msg)
const fail = (msg) => {
  failed++
  console.log('  FAIL  ' + msg)
}

const store = fs.readFileSync(storePath, 'utf8')
const lineOf = (text, index) => text.slice(0, index).split(/\r?\n/).length

/* 1. 动作函数体里不允许读 store 自己的 sessionId */
console.log('\n[1] 动作函数体不依赖 store.sessionId')
for (const name of actions) {
  const marker = new RegExp(`^  ${name}: async \\(`, 'm')
  const m = marker.exec(store)
  if (!m) {
    fail(`sftpStore.ts 找不到 ${name} 的实现`)
    continue
  }
  const rest = store.slice(m.index)
  const end = rest.search(/\r?\n  \},?\r?\n/)
  const body = end > 0 ? rest.slice(0, end) : rest.slice(0, 800)
  if (/get\(\)\.sessionId/.test(body)) {
    fail(`${name} 仍在函数体里读 get().sessionId（sftpStore.ts:${lineOf(store, m.index)}）`)
  } else {
    pass(`${name} 只使用传入的 sessionId`)
  }
}

/* 2. 动作签名第一个形参是 sessionId */
console.log('\n[2] 动作签名显式声明 sessionId')
for (const name of actions) {
  const decl = new RegExp(`${name}:\\s*\\(\\s*sessionId:\\s*string\\s*\\|\\s*null`)
  if (decl.test(store)) pass(`${name}(sessionId, …)`)
  else fail(`${name} 未把 sessionId 声明为第一个形参`)
}

/* 3. 调用点第一个实参是 sessionId（跳过同名本地包装） */
console.log('\n[3] 面板调用点显式传 sessionId')
for (const rel of callerFiles) {
  const abs = path.join(root, rel)
  const src = fs.readFileSync(abs, 'utf8')
  const hits = []
  for (const name of actions) {
    const locallyDefined = new RegExp(
      `(?:const|function)\\s+${name}\\s*(?::[^=]*)?=\\s*(?:\\(|async|function)|function\\s+${name}\\s*\\(`
    ).test(src)
    if (locallyDefined) continue
    const callPattern = new RegExp(`\\b${name}\\(\\s*(?!sessionId\\b)`, 'g')
    let m
    while ((m = callPattern.exec(src)) !== null) {
      hits.push(`${name}() @ ${rel}:${lineOf(src, m.index)} 首参不是 sessionId`)
    }
  }
  if (hits.length === 0) pass(`${rel} 全部显式传参`)
  else hits.forEach(fail)
}

console.log('')
if (failed > 0) {
  console.log(`RESULT: FAIL (${failed}) — 上传/下载/编辑链路又退化成依赖 store.sessionId 了`)
  process.exit(1)
}
console.log('RESULT: PASS — 上传/下载/远端编辑全部由调用方显式传入 sessionId')
