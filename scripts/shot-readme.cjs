/**
 * 截图：README 门面图（整窗概览 + 真实会话）。
 * 用法：env -u ELECTRON_RUN_AS_NODE npx electron scripts/shot-readme.cjs
 * 输出：docs/ui/overview.png
 *
 * 为什么脚本里要起一个本地 ssh2 服务端：
 * 只截空态工作区看不出这软件在干什么；门面图必须是「连着机器、终端里有内容」。
 * 所以这里用临时 userData + 合成连接 + 一个只听 127.0.0.1 的假 ssh2 服务端，
 * 把一次真实连接走完整条链路（握手 → 指纹 → 密码 → shell），再截服务端的终端输出。
 * 图里没有任何真实内网主机名或凭据。
 */
const { app, BrowserWindow, safeStorage } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { Server, utils, Client } = require('ssh2')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------- 1. 假 ssh2 服务端：密码随意，shell 里吐一段真运维画面 ---------- */
const HOST_KEY = utils.generateKeyPairSync('ed25519').private
const BANNER = [
  '\x1b[1;37mWelcome to Ubuntu 24.04.2 LTS (GNU/Linux 6.8.0-45-generic x86_64)\x1b[0m',
  '',
  ' * Documentation:  https://help.ubuntu.com',
  ' * Management:     https://landscape.canonical.com',
  '',
  'Last login: Wed Nov 19 09:41:12 from 10.20.0.5'
].join('\r\n')
const PROMPT = '\x1b[1;32mdev@devbox\x1b[0m:\x1b[1;34m~\x1b[0m$ '
const TRANSCRIPT = [
  'systemctl status nginx --no-pager',
  '\x1b[1;32m● \x1b[0mnginx.service - A high performance web server and a reverse proxy server',
  '     Loaded: loaded (\x1b[2m/lib/systemd/system/nginx.service\x1b[0m; enabled; preset: enabled)',
  '     Active: \x1b[1;32mactive (running)\x1b[0m since Wed 2026-11-19 09:12:40 CST; 34min ago',
  '   Main PID: 814 (nginx)',
  '      Tasks: 3 (limit: 4652)',
  '     Memory: 6.2M',
  '        CPU: 128ms',
  '',
  'df -h /data',
  'Filesystem      Size  Used Avail Use% Mounted on',
  '/dev/nvme0n1p3   98G   41G   52G  45% /data',
  '',
  'tail -n 3 /var/log/nginx/error.log',
  '\x1b[2m2026/11/19 09:44:02 [warn] 814#814: upstream server temporarily disabled while connecting to upstream\x1b[0m',
  '\x1b[2m2026/11/19 09:44:05 [error] 814#814: *1203 connect() failed (111: Connection refused) while connecting to upstream\x1b[0m',
  '\x1b[2m2026/11/19 09:44:05 [warn] 814#814: upstream server temporarily disabled\x1b[0m'
].join('\r\n')

const server = new Server({ hostKeys: [HOST_KEY] }, (client) => {
  client.on('error', () => {})
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password') ctx.accept()
    else ctx.reject(['password'])
  })
  client.on('session', (accept) => {
    const session = accept()
    session.on('pty', (a) => a && a())
    session.on('window-change', (a) => a && a())
    session.on('shell', (a) => {
      const s = a()
      s.write('\x1b[2J\x1b[H' + BANNER + '\r\n' + PROMPT + TRANSCRIPT + '\r\n' + PROMPT)
      s.on('data', () => {})
    })
  })
})

const listen = (p = 0) =>
  new Promise((res, rej) => {
    const onErr = (e) => rej(e)
    server.once('error', onErr)
    server.listen(p, '127.0.0.1', () => {
      server.removeListener('error', onErr)
      res(server.address().port)
    })
  })

/* ---------- 2. 临时 userData + 合成连接 ---------- */
const TMP_UD = path.join(os.tmpdir(), 'sshw-shot-readme-' + Date.now())
const DATA = path.join(TMP_UD, 'data')
fs.mkdirSync(DATA, { recursive: true })
app.setPath('userData', TMP_UD)

const now = Date.now()
const conn = (id, name, host, port, group, color, tags) => ({
  id, name, host, port, username: 'deploy', authType: 'password', group, tags, color,
  createdAt: now, updatedAt: now
})

;(async () => {
  // 优先占 22，其次 2222（常见本机/容器 SSH 端口），避免落到随机高位端口像测试残留
  const port = await listen(22).catch(() => listen(2222)).catch(() => listen(0))
  fs.writeFileSync(
    path.join(DATA, 'connections.json'),
    JSON.stringify(
      [
        conn('c6', '本地开发机', '127.0.0.1', port, '本机', '#0ea5e9', ['dev']),
        conn('c1', '生产 Web 01', '10.20.0.11', 22, '生产环境', '#e5534b', ['nginx', '核心']),
        conn('c2', '生产 DB 主库', '10.20.0.12', 22, '生产环境', '#e5534b', ['mysql']),
        conn('c3', '测试应用服务器', '10.30.1.21', 22, '测试环境', '#3b82f6', ['tomcat']),
        conn('c4', '边缘网关 A', '192.168.8.1', 22, '边缘设备', '#22c55e', ['openwrt']),
        conn('c5', '内网跳板机', '10.0.0.5', 22, '运维', '#a855f7', ['jump'])
      ],
      null,
      2
    )
  )
  await app.whenReady()

  /* 指纹：与 src/main/ssh/connectConfig.ts 的 hostKeyFingerprint 同一算法。
     先探一次拿原始主机公钥，再写 known-hosts，避免截图时弹出「未知主机」对话框。 */
  const rawKey = await new Promise((resolve, reject) => {
    const c = new Client()
    c.on('ready', () => { c.end(); reject(new Error('unexpected ready')) })
    c.on('error', () => {})
    c.connect({
      host: '127.0.0.1', port, username: 'probe', password: 'x',
      hostVerifier: (key) => { resolve(key); return false }
    })
    setTimeout(() => reject(new Error('fingerprint probe timeout')), 8000)
  })
  const fp = 'SHA256:' + crypto.createHash('sha256').update(rawKey).digest('base64').replace(/=+$/, '')
  fs.writeFileSync(
    path.join(DATA, 'known-hosts.json'),
    JSON.stringify({
      ['127.0.0.1:' + port]: { host: '127.0.0.1', port, fingerprint: fp, addedAt: now }
    })
  )
  fs.writeFileSync(
    path.join(DATA, 'secrets.json'),
    JSON.stringify({ c6: { password: safeStorage.encryptString('devpass').toString('base64') } })
  )

  require(path.join(__dirname, '..', 'out', 'main', 'index.js'))

  let win = null
  for (let i = 0; i < 80; i++) {
    win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (win) break
    await sleep(250)
  }
  if (!win) throw new Error('no window')
  // 必须先 show：隐藏窗口不参与合成，capturePage 会一直返回同一帧（见 shot-command-wall.cjs）
  win.show()
  win.setSize(1440, 900)
  await sleep(4000)

  // 双击第一条连接 = 走 UI 真实的打开流程（建标签、建 xterm、连 SSH）
  const opened = await win.webContents.executeJavaScript(
    '(function(){' +
      'var el = document.querySelector("[data-conn-id=\\"c6\\"]");' +
      'if (!el) return "no-conn";' +
      'el.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));' +
      'return "ok";' +
    '})()',
    true
  )
  await sleep(4000)

  const probe = await win.webContents.executeJavaScript(
    '(function(){' +
      'var rows = Array.prototype.map.call(document.querySelectorAll(".xterm-rows"), function(n){' +
        'return n.innerText.replace(/\\s+/g, " ").trim();' +
      '}).join(" | ");' +
      'return {' +
        'conns: document.querySelectorAll("[data-conn-id]").length,' +
        'cmds: document.querySelectorAll("[data-cmd-id]").length,' +
        'tabs: document.querySelectorAll("[role=\\"tab\\"], [data-testid=\\"tab\\"]").length,' +
        'opened: ' + JSON.stringify(opened) + ',' +
        'termChars: rows.length,' +
        'termHead: rows.slice(0, 160),' +
        // 面板坐标 + 底色：ASCII 看不出「哪块是终端」，用数字确认版面真的被填满了
        'panels: Array.prototype.map.call(document.querySelectorAll("[data-testid=connection-sidebar], [data-testid=command-panel], .xterm"), function(n){' +
          'var r = n.getBoundingClientRect();' +
          'return (n.getAttribute("data-testid") || "xterm") + "@" + Math.round(r.x) + "," + Math.round(r.y) + " " + Math.round(r.width) + "x" + Math.round(r.height);' +
        '}),' +
        'body: document.body.innerText.replace(/\\s+/g, " ").slice(0, 300)' +
      '};' +
    '})()',
    true
  )

  const OUT = path.join(__dirname, '..', 'docs', 'ui')
  fs.mkdirSync(OUT, { recursive: true })
  const img = await win.webContents.capturePage()
  const file = path.join(OUT, 'overview.png')
  fs.writeFileSync(file, img.toPNG())

  const { width, height } = img.getSize()
  const buf = img.toBitmap()
  let dark = 0
  const seen = new Set()
  for (let i = 0; i + 3 < buf.length; i += 4) {
    const l = 0.114 * buf[i] + 0.587 * buf[i + 1] + 0.299 * buf[i + 2]
    if (l < 60) dark++
    if (i % (4 * 997) < 4) seen.add((buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2])
  }
  console.log(JSON.stringify({ file, width, height, colors: seen.size, darkPct: +(100 * dark / (width * height)).toFixed(2), probe }, null, 1))
  try { fs.rmSync(TMP_UD, { recursive: true, force: true }) } catch {}
  server.close()
  app.exit(0)
})().catch((e) => { console.error(e); app.exit(1) })