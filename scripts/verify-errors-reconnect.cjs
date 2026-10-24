/**
 * 错误日志 + 自动重连 自检。
 *
 * 错误日志部分验证脱敏与去重（这是最容易出事的地方：日志被用户复制外发，
 * 里面混进明文密码就是安全事故）。
 * 重连部分验证指数退避序列与次数上限。
 */
let pass = 0
let fail = 0
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  PASS  ' + name) }
  else { fail++; console.log('  FAIL  ' + name + (detail !== undefined ? '  -> ' + detail : '')) }
}

/* ---------- 复刻 errorLog 的脱敏逻辑 ---------- */
function redact(text) {
  return text
    .replace(/((?:password|passwd|pwd|secret|token|apikey|api_key)\s*[=:]\s*)([^\s,;'"`\]}]+)/gi, '$1***')
    .replace(/("(?:password|passwd|secret|token)"\s*:\s*")([^"]*)(")/gi, '$1***$3')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[PRIVATE KEY REDACTED]')
    .replace(/-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*$/g, '[PRIVATE KEY REDACTED]')
}

console.log('\n[1] 错误日志脱敏（关键安全项）')
{
  const cases = [
    ['connect failed: password=hunter2', 'hunter2', 'key=value 形式的密码'],
    ['auth error passwd: s3cr3t at line 3', 's3cr3t', '冒号形式的密码'],
    ['{"user":"root","password":"p@ss word"}', 'p@ss word', 'JSON 里的密码'],
    ['token=ghp_abcdefg12345', 'ghp_abcdefg12345', 'token'],
    ['api_key=AKIA1234567890', 'AKIA1234567890', 'api_key'],
    ['secret: mysecretvalue', 'mysecretvalue', 'secret 冒号形式']
  ]
  for (const [input, secret, label] of cases) {
    const out = redact(input)
    check(label + ' 已被脱敏', !out.includes(secret), out)
  }

  const pem = 'before\n-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\n-----END RSA PRIVATE KEY-----\nafter'
  const redactedPem = redact(pem)
  check('PEM 私钥块整体抹除', redactedPem.includes('[PRIVATE KEY REDACTED]') && !redactedPem.includes('MIIEow'))
  check('私钥块前后的正常内容保留', redactedPem.includes('before') && redactedPem.includes('after'))

  const sshKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk=\ntrailing'
  check('OpenSSH 私钥被抹除', !redact(sshKey).includes('b3BlbnNzaC1rZXk='))

  // 不误伤：普通文本不该被改动
  const plain = '读取远程目录失败：No such file or directory'
  check('普通错误文本不被误伤', redact(plain) === plain)
  const normalCmd = '执行 ls -la /var/log 失败'
  check('含连字符的命令不被误伤', redact(normalCmd) === normalCmd)
}

console.log('\n[2] 错误去重聚合')
{
  // 复刻主进程的聚合规则：来源+标题+详情相同且 5 分钟内，累加 count
  const DEDUPE_WINDOW_MS = 5 * 60 * 1000
  const list = []
  function record(source, title, detail, now) {
    const dupIdx = list.findIndex(
      (e) => e.source === source && e.title === title && e.detail === detail && now - e.lastAt < DEDUPE_WINDOW_MS
    )
    if (dupIdx >= 0) {
      list[dupIdx] = { ...list[dupIdx], count: list[dupIdx].count + 1, lastAt: now }
      return
    }
    list.unshift({ source, title, detail, at: now, lastAt: now, count: 1 })
  }

  const t = 1000000
  // 模拟一次断网：同一错误连续 50 次
  for (let i = 0; i < 50; i++) record('ipc:sftp:list', '读取远程目录失败', 'Connection lost', t + i * 100)
  check('50 次相同错误聚合成 1 条', list.length === 1, String(list.length))
  check('count 累加到 50', list[0].count === 50, String(list[0].count))

  record('ipc:sftp:list', '读取远程目录失败', 'Permission denied', t + 6000)
  check('详情不同则单独记一条', list.length === 2, String(list.length))

  record('ipc:conn:save', '保存连接失败', 'Connection lost', t + 7000)
  check('来源不同则单独记一条', list.length === 3, String(list.length))

  // 超出窗口后再出现应新增
  record('ipc:sftp:list', '读取远程目录失败', 'Connection lost', t + DEDUPE_WINDOW_MS + 10000)
  check('超过聚合窗口后重新记一条', list.length === 4, String(list.length))
}

console.log('\n[3] 自动重连退避序列')
{
  const MAX = 20
  const delayOf = (attempt) => Math.min(2 ** (attempt - 1), 30)
  const seq = [1, 2, 3, 4, 5, 6, 7].map(delayOf)
  console.log('  INFO  退避序列（秒）: ' + seq.join(', '))
  check('第 1 次等 1 秒', delayOf(1) === 1)
  check('第 2 次等 2 秒', delayOf(2) === 2)
  check('第 3 次等 4 秒', delayOf(3) === 4)
  check('第 4 次等 8 秒', delayOf(4) === 8)
  check('第 5 次等 16 秒', delayOf(5) === 16)
  check('第 6 次达上限 30 秒', delayOf(6) === 30, String(delayOf(6)))
  check('之后不再增长', delayOf(10) === 30 && delayOf(MAX) === 30)

  // 累加时间：5 次重试总共等多久
  const total = seq.slice(0, 5).reduce((a, b) => a + b, 0)
  console.log('  INFO  默认 5 次重试累计等待 ' + total + ' 秒')
  check('5 次退避总计 31 秒（符合设计）', total === 31, String(total))
}

console.log('\n[4] 重连次数上限')
{
  const max = Math.max(1, Math.min(5, 20))
  let attempts = 0
  let gaveUp = false
  for (let i = 1; i <= 30; i++) {
    if (i > max) { gaveUp = true; break }
    attempts = i
  }
  check('最多尝试 5 次', attempts === 5, String(attempts))
  check('超限后标记放弃', gaveUp === true)

  check('上限被 clamp 到 1~20（下界）', Math.max(1, Math.min(-5, 20)) === 1)
  check('上限被 clamp 到 1~20（上界）', Math.max(1, Math.min(999, 20)) === 20)
  check('默认值 5 合法', Math.max(1, Math.min(undefined ?? 5, 20)) === 5)
}

console.log('\n[5] 用户主动关闭不应触发重连')
{
  // 复刻 teardown 里的判断
  const shouldReconnect = (closedByUser, status, enabled) =>
    !closedByUser && enabled !== false && (status === 'disconnected' || status === 'error')

  check('用户关标签 -> 不重连', shouldReconnect(true, 'disconnected', true) === false)
  check('意外断开 -> 重连', shouldReconnect(false, 'disconnected', true) === true)
  check('连接出错 -> 重连', shouldReconnect(false, 'error', true) === true)
  check('设置关闭 -> 不重连', shouldReconnect(false, 'disconnected', false) === false)
  check('正常状态 -> 不重连', shouldReconnect(false, 'connected', true) === false)
  check('connecting 状态 -> 不重连', shouldReconnect(false, 'connecting', true) === false)
}

console.log('\n[6] 压测：大量错误聚合性能')
{
  const DEDUPE_WINDOW_MS = 5 * 60 * 1000
  const list = []
  function record(source, title, detail, now) {
    const idx = list.findIndex(
      (e) => e.source === source && e.title === title && e.detail === detail && now - e.lastAt < DEDUPE_WINDOW_MS
    )
    if (idx >= 0) { list[idx].count++; list[idx].lastAt = now; return }
    list.unshift({ source, title, detail, at: now, lastAt: now, count: 1 })
  }

  const N = 20000
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < N; i++) {
    // 只有 20 种不同的错误，模拟真实场景的重复刷屏
    record('ipc:ch' + (i % 20), '错误' + (i % 20), 'detail', 1000000 + i)
  }
  const t1 = process.hrtime.bigint()
  const ms = Number(t1 - t0) / 1e6
  console.log('  INFO  ' + N + ' 条错误写入（20 种）耗时 ' + ms.toFixed(0) + 'ms，聚合后 ' + list.length + ' 条')
  check('聚合后只剩 20 条', list.length === 20, String(list.length))
  check(N + ' 条处理在 2000ms 内', ms < 2000, ms.toFixed(0) + 'ms')
  const totalCount = list.reduce((n, e) => n + e.count, 0)
  check('计数无丢失', totalCount === N, String(totalCount))
}

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败\n')
process.exit(fail === 0 ? 0 : 1)
