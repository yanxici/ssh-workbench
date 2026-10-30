#!/usr/bin/env node
/**
 * 调试小工具：在正在运行的渲染进程里求值一段 JS，打印结果。
 * 配合 `--remote-debugging-port=9357` 启动的应用使用。
 *
 * 用法：node scripts/dev-page-eval.cjs 9357 "document.title"
 *       node scripts/dev-page-eval.cjs 9357 "window.api.sftp.downloadsDir()"
 */
const port = Number(process.argv[2] || 9357)
const expr = process.argv.slice(3).join(' ')

async function main() {
  if (!expr) {
    console.error('用法：node scripts/dev-page-eval.cjs <port> "<表达式>"')
    process.exit(2)
  }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  if (!target) {
    console.error(`[eval] ${port} 上没有可用的 page target`)
    process.exit(1)
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', rej)
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = 1
      const onMsg = (ev) => {
        const m = JSON.parse(ev.data)
        if (m.id === id) {
          ws.removeEventListener('message', onMsg)
          resolve(m)
        }
      }
      ws.addEventListener('message', onMsg)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const r = await send('Runtime.evaluate', {
    expression: expr,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
    includeCommandLineAPI: true
  })
  if (r.result?.exceptionDetails) {
    console.error('[eval] 异常:', r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text)
    ws.close()
    process.exit(1)
  }
  const v = r.result?.result?.value
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2))
  ws.close()
}

main().catch((e) => {
  console.error('[eval] 失败', e && e.message)
  process.exit(1)
})
