/**
 * 无构建环境下的逻辑自检：用 tsc 单独编译剪贴板解析模块，跑一组用例。
 * 用法：node node_modules/typescript/bin/tsc -p tsconfig.verify.json && node scripts/verify-parse.cjs
 */
const { parseSshCommand } = require('../.tsc-verify/main/util/parseSshCommand.js')

const cases = [
  { input: 'ssh root@192.168.1.10', expect: { ok: true, username: 'root', host: '192.168.1.10', port: 22 } },
  { input: 'ssh root@10.0.0.5 -p 2222', expect: { ok: true, username: 'root', host: '10.0.0.5', port: 2222 } },
  { input: 'ssh -p 2222 admin@192.168.8.9', expect: { ok: true, username: 'admin', host: '192.168.8.9', port: 2222 } },
  { input: 'ssh -i ~/.ssh/id_rsa root@172.16.1.3', expect: { ok: true, username: 'root', host: '172.16.1.3', port: 22, privateKeyPath: '~/.ssh/id_rsa' } },
  { input: 'ssh -l ubuntu 10.20.30.40', expect: { ok: true, username: 'ubuntu', host: '10.20.30.40', port: 22 } },
  { input: 'ssh -o StrictHostKeyChecking=no root@192.168.1.1', expect: { ok: true, username: 'root', host: '192.168.1.1', port: 22 } },
  { input: 'ssh root@192.168.1.10 "ls -la /tmp"', expect: { ok: true, username: 'root', host: '192.168.1.10', port: 22 } },
  { input: 'ssh -p2222 root@10.1.1.1', expect: { ok: true, username: 'root', host: '10.1.1.1', port: 2222 } },
  { input: 'ls -la', expect: { ok: false } },
  { input: 'ssh', expect: { ok: false } }
]

let pass = 0
let fail = 0

for (const { input, expect } of cases) {
  const actual = parseSshCommand(input)
  const ok =
    actual.ok === expect.ok &&
    (expect.ok === false ||
      (actual.username === expect.username &&
        actual.host === expect.host &&
        actual.port === expect.port &&
        (expect.privateKeyPath === undefined || actual.privateKeyPath === expect.privateKeyPath)))

  if (ok) {
    pass += 1
    console.log(`  PASS  ${JSON.stringify(input)}`)
  } else {
    fail += 1
    console.log(`  FAIL  ${JSON.stringify(input)}`)
    console.log(`        expect: ${JSON.stringify(expect)}`)
    console.log(`        actual: ${JSON.stringify(actual)}`)
  }
}

console.log(`\nparseSshCommand: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
