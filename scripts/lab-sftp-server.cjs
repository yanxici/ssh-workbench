/**
 * 临时实验用 SFTP 服务器（不进生产链路，仅用于本地复现上传问题）
 *
 * 用途：把本地临时目录通过 SFTP 暴露在 127.0.0.1:PORT，
 * 让 SSH Workbench 连上来做真实的上传/下载往返，验证主进程传输链路。
 *
 * 用法：
 *   SFTP_ROOT=C:\Temp\lab root SFTP_PORT=2222 SFTP_PASS=labpass node scripts/_lab-sftp-server.cjs
 */
const { Server, utils } = require('ssh2')
const fs = require('node:fs')
const crypto = require('node:crypto')
const path = require('node:path')

const SFTP = utils.sftp
const { OPEN_MODE, STATUS_CODE } = SFTP

const ROOT = path.resolve(process.env.SFTP_ROOT || path.join(process.env.TEMP || '.', 'sftp-lab-root'))
const PORT = Number(process.env.SFTP_PORT || 2222)
const PASS = process.env.SFTP_PASS || 'labpass'
const USER = process.env.SFTP_USER || 'lab'

fs.mkdirSync(ROOT, { recursive: true })

// 主机密钥固定落盘：每次启动指纹都一样，否则应用侧的「已知主机指纹」会判为变化
const KEY_FILE = process.env.SFTP_HOST_KEY || path.join(process.env.TEMP || '.', 'lab-host-key.pem')
let privateKey
if (fs.existsSync(KEY_FILE)) {
  privateKey = fs.readFileSync(KEY_FILE, 'utf8')
} else {
  privateKey = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' }
  }).privateKey
  fs.writeFileSync(KEY_FILE, privateKey)
}

/** 把 SFTP 里的 posix 路径映射到本地真实路径，拒绝越界 */
function local(p) {
  const rel = path.posix.normalize('/' + String(p || '/')).replace(/^\/+/, '')
  const full = path.resolve(ROOT, rel)
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) {
    const err = new Error('outside root')
    err.code = 'EACCES'
    throw err
  }
  return full
}

function posixOf(full) {
  const rel = path.relative(ROOT, full).split(path.sep).join('/')
  return '/' + rel
}

/** 统一回包：成功 reply(undefined)，失败 reply(STATUS_CODE) */
function replyErr(sftp, reqid, err) {
  const code =
    err && err.code === 'ENOENT'
      ? STATUS_CODE.NO_SUCH_FILE
      : err && (err.code === 'EACCES' || err.code === 'EPERM')
        ? STATUS_CODE.PERMISSION_DENIED
        : STATUS_CODE.FAILURE
  sftp.status(reqid, code)
}

function attrsOf(st) {
  const a = {
    mode: st.mode,
    uid: 0,
    gid: 0,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000)
  }
  if (st.isDirectory()) a.mode = (st.mode & 0o7777) | 0o040000
  return a
}

const handles = new Map()

/*
 * 断线注入的计数器必须是**进程级**的，不能放进每个连接的处理闭包里。
 * 放进去的话客户端一重连计数器就清零，故障会在新连接上再触发一次 ——
 * 于是「断一次」变成了「每重连一次就断一次」，续传永远追不上。
 * 真实的网络抖动是一次性事件，重连之后应当恢复。
 */
const dropAfter = Number(process.env.LAB_DROP_AFTER_BYTES || 0)
const dropTimes = Number(process.env.LAB_DROP_TIMES || 1)
const dropDir = String(process.env.LAB_DROP_DIR || 'upload')
let dropIn = 0
let dropOut = 0
let dropCount = 0
let nextIn = dropAfter
let nextOut = dropAfter

function newHandle(obj) {
  const id = crypto.randomBytes(8).toString('hex')
  handles.set(id, { ...obj, used: false })
  return Buffer.from(id, 'utf8')
}

const server = new Server({ hostKeys: [privateKey] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASS) return ctx.accept()
    if (ctx.method === 'none') return ctx.reject(['password'])
    ctx.reject()
  })
  /*
   * 断线注入（仅验收脚本用）。
   *
   * 为什么不给 SFTP 的 WRITE 回一个错误码：那样应用侧看到的是「这个分块失败了」，
   * 走的是单文件失败分支，测不到「链路整条消失」这条最真实的路径。
   * 直接把 TCP 连接干掉，应用的 pWrite 回调永远不会回来 —— 这正是现场
   * 「设备网络波动几秒」的样子，也是 withTimeout 能派上用场的唯一场景。
   *
   *   LAB_DROP_AFTER_BYTES  累计写入/读取多少字节后断一次（0=关闭，默认 0）
   *   LAB_DROP_TIMES        断几次（默认 1）
   *   LAB_DROP_DIR          upload | download | both（默认 upload）
   */
  const shouldDrop = (dir, bytes) => {
    if (dropAfter <= 0 || dropCount >= dropTimes) return false
    if (dropDir !== 'both' && dropDir !== dir) return false
    if (dir === 'upload') {
      dropIn += bytes
      if (dropIn < nextIn) return false
      nextIn += dropAfter
    } else {
      dropOut += bytes
      if (dropOut < nextOut) return false
      nextOut += dropAfter
    }
    dropCount += 1
    console.log(`[lab-sftp] 注入断线 #${dropCount}（${dir}，已累计 ${bytes} 字节）`)
    try {
      client.end()
    } catch {}
    return true
  }

  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      // 伪终端 + shell：应用开会话时会先请求 pty/shell，不实现会报
      // "Unable to request a pseudo-terminal"
      session.on('pty', (accept0) => accept0 && accept0())
      session.on('window-change', (accept0) => accept0 && accept0())
      session.on('shell', (acceptShell) => {
        const stream = acceptShell()
        stream.write('lab-shell ready\r\n')
        /*
         * trzsz 模拟（仅验收脚本用）。
         *
         * 目的：让「远端有没有装 trzsz」这两条分支都能在真应用里跑到 ——
         * 默认回 command not found（走没装的那条），收到 '@@TRZSZ:ON@@'
         * 之后改成回真实格式的握手串（走传输态的那条）。
         * 状态按 stream 存，多个会话互不影响。
         */
        let trzszMode = false
        let seq = 0
        stream.on('data', (d) => {
          const s = d.toString('utf8')
          /*
           * 压测用的批量输出发生器：收到 '@@PERF:<行数>:<标签>@@' 就吐 N 行
           * 带标签的文本。真 shell 里用 `for i in $(seq N)` 也行，但伪 shell
           * 只回显输入，回显是单行 —— 量不到「大段输出穿过过滤器」的开销。
           */
          const perf = /@@PERF:(\d+):([A-Za-z0-9_-]+)@@/.exec(s)
          if (perf) {
            const n = Math.min(20000, Number(perf[1]) || 0)
            let buf = ''
            for (let i = 0; i < n; i++) buf += 'L' + (i + 1) + ' PERF-TZ-' + perf[2] + '\r\n'
            stream.write(buf)
            return
          }
          /*
           * 收到 trzsz 的 Action 帧（'#ACT:' + base64）就回一行 ack：
           * 验收脚本据此判断「过滤器真的把回执发到远端了」，
           * 而不是只判断本地状态变了。
           */
          if (s.includes('#ACT:')) {
            stream.write('\r\nlab-saw-act\r\n')
            return
          }
          if (process.env.LAB_SHELL_TRZSZ === '1') {
            if (s.includes('@@TRZSZ:ON@@')) {
              trzszMode = true
              return
            }
            if (s.includes('trz') || s.includes('tsz')) {
              if (trzszMode) {
                const action = s.includes('tsz') ? 'S' : 'R'
                seq++
                stream.write('\r\n::TRZSZ:TRANSFER:' + action + ':1.1.6:' + (1000 + seq) + '\r\n')
              } else {
                const cmd = s.includes('tsz') ? 'tsz' : 'trz'
                stream.write('\r\nbash: ' + cmd + ': command not found\r\n')
              }
              return
            }
          }
          if (process.env.LAB_SHELL_ECHO === '1') stream.write(d)
        })
        stream.on('error', () => {})
      })
      session.on('exec', (acceptExec) => {
        const stream = acceptExec()
        stream.exit(0)
        stream.end()
      })
      session.on('sftp', (acceptSftp) => {
        const sftp = acceptSftp()

        sftp.on('REALPATH', (reqid, p) => {
          try {
            const full = local(p)
            const st = fs.existsSync(full) ? fs.statSync(full) : null
            sftp.name(reqid, [{ filename: posixOf(full), longname: posixOf(full), attrs: st ? attrsOf(st) : {} }])
          } catch (e) {
            replyErr(sftp, reqid, e)
          }
        })

        sftp.on('STAT', (reqid, p) => {
          try {
            sftp.attrs(reqid, attrsOf(fs.statSync(local(p))))
          } catch (e) {
            replyErr(sftp, reqid, e)
          }
        })

        sftp.on('LSTAT', (reqid, p) => {
          try {
            sftp.attrs(reqid, attrsOf(fs.lstatSync(local(p))))
          } catch (e) {
            replyErr(sftp, reqid, e)
          }
        })

        sftp.on('FSTAT', (reqid, handle) => {
          const h = handles.get(handle.toString())
          if (!h) return sftp.status(reqid, STATUS_CODE.FAILURE)
          try {
            sftp.attrs(reqid, attrsOf(fs.fstatSync(h.fd)))
          } catch (e) {
            replyErr(sftp, reqid, e)
          }
        })

        sftp.on('OPEN', (reqid, filename, flags, attrs) => {
          try {
            const full = local(filename)
            /*
             * READ|WRITE 同时置位（SFTP 的 'r+'，续传用的就是这个）必须是 O_RDWR。
             * 早先这里分别 push O_RDONLY 和 O_WRONLY 再按位或，O_RDONLY 是 0，
             * 结果得到纯 O_WRONLY —— 续传前的尾部指纹比对会 EBADF 而失败，
             * 在真服务器上根本不会出现。
             */
            const wantRead = !!(flags & OPEN_MODE.READ)
            const wantWrite = !!(flags & OPEN_MODE.WRITE)
            const base = wantRead && wantWrite ? fs.constants.O_RDWR : wantWrite ? fs.constants.O_WRONLY : fs.constants.O_RDONLY
            let parts = base
            if (flags & OPEN_MODE.APPEND) parts |= fs.constants.O_APPEND
            if (flags & OPEN_MODE.CREAT) parts |= fs.constants.O_CREAT
            if (flags & OPEN_MODE.TRUNC) parts |= fs.constants.O_TRUNC
            if (flags & OPEN_MODE.EXCL) parts |= fs.constants.O_EXCL
            const mode = attrs && attrs.mode ? attrs.mode & 0o777 : 0o644
            const fd = fs.openSync(full, parts, mode)
            sftp.handle(reqid, newHandle({ fd, path: full, writable: !!(flags & OPEN_MODE.WRITE) }))
          } catch (e) {
            replyErr(sftp, reqid, e)
          }
        })

        sftp.on('READ', (reqid, handle, offset, length) => {
          if (shouldDrop('download', length)) return
          const h = handles.get(handle.toString())
          if (!h || h.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
          const buf = Buffer.allocUnsafe(length)
          try {
            const bytes = fs.readSync(h.fd, buf, 0, length, offset)
            if (bytes === 0) sftp.status(reqid, STATUS_CODE.EOF)
            else sftp.data(reqid, buf.subarray(0, bytes))
          } catch (e) {
            replyErr(sftp, reqid, e)
          }
        })

        sftp.on('WRITE', (reqid, handle, offset, data) => {
          if (shouldDrop('upload', data.length)) return
          const h = handles.get(handle.toString())
          if (!h || h.fd === undefined) return sftp.status(reqid, STATUS_CODE.FAILURE)
          try {
            fs.writeSync(h.fd, data, 0, data.length, offset)
            sftp.status(reqid, STATUS_CODE.OK)
          } catch (e) {
            replyErr(sftp, reqid, e)
          }
        })

        sftp.on('CLOSE', (reqid, handle) => {
          const key = handle.toString()
          const h = handles.get(key)
          if (h && h.fd !== undefined) {
            try {
              fs.closeSync(h.fd)
            } catch {}
          }
          handles.delete(key)
          sftp.status(reqid, STATUS_CODE.OK)
        })

        sftp.on('OPENDIR', (reqid, p) => {
          try {
            const full = local(p)
            const names = fs.readdirSync(full)
            sftp.handle(reqid, newHandle({ dir: full, names, sent: false }))
          } catch (e) {
            replyErr(sftp, reqid, e)
          }
        })

        sftp.on('READDIR', (reqid, handle) => {
          const h = handles.get(handle.toString())
          if (!h || !h.names) return sftp.status(reqid, STATUS_CODE.FAILURE)
          if (h.sent) return sftp.status(reqid, STATUS_CODE.EOF)
          h.sent = true
          const list = h.names.map((n) => {
            const full = path.join(h.dir, n)
            let attrs = {}
            try {
              attrs = attrsOf(fs.statSync(full))
            } catch {}
            return { filename: n, longname: `${n}`, attrs }
          })
          sftp.name(reqid, list)
        })

        sftp.on('MKDIR', (reqid, p) => {
          try {
            fs.mkdirSync(local(p), { recursive: false })
            sftp.status(reqid, STATUS_CODE.OK)
          } catch (e) {
            if (e.code === 'EEXIST') return sftp.status(reqid, STATUS_CODE.OK)
            replyErr(sftp, reqid, e)
          }
        })

        sftp.on('RMDIR', (reqid, p) => {
          try {
            fs.rmdirSync(local(p))
            sftp.status(reqid, STATUS_CODE.OK)
          } catch (e) {
            replyErr(sftp, reqid, e)
          }
        })

        sftp.on('REMOVE', (reqid, p) => {
          try {
            fs.unlinkSync(local(p))
            sftp.status(reqid, STATUS_CODE.OK)
          } catch (e) {
            replyErr(sftp, reqid, e)
          }
        })

        sftp.on('RENAME', (reqid, from, to) => {
          try {
            fs.renameSync(local(from), local(to))
            sftp.status(reqid, STATUS_CODE.OK)
          } catch (e) {
            replyErr(sftp, reqid, e)
          }
        })

        sftp.on('SETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK))
        sftp.on('FSETSTAT', (reqid) => sftp.status(reqid, STATUS_CODE.OK))
        sftp.on('EXTENDED', (reqid) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED))
      })
    })
  })
  client.on('error', (e) => console.error('[client error]', e.message))
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[lab-sftp] listening 127.0.0.1:${PORT} root=${ROOT} user=${USER} pass=${PASS}`)
})
