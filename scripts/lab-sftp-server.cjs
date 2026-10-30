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
        stream.on('data', (d) => {
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
            const parts = []
            if (flags & OPEN_MODE.READ) parts.push(fs.constants.O_RDONLY)
            if (flags & OPEN_MODE.WRITE) parts.push(fs.constants.O_WRONLY)
            if (flags & OPEN_MODE.APPEND) parts.push(fs.constants.O_APPEND)
            if (flags & OPEN_MODE.CREAT) parts.push(fs.constants.O_CREAT)
            if (flags & OPEN_MODE.TRUNC) parts.push(fs.constants.O_TRUNC)
            if (flags & OPEN_MODE.EXCL) parts.push(fs.constants.O_EXCL)
            const mode = attrs && attrs.mode ? attrs.mode & 0o777 : 0o644
            const fd = fs.openSync(full, parts.reduce((a, b) => a | b, 0) || fs.constants.O_RDONLY, mode)
            sftp.handle(reqid, newHandle({ fd, path: full, writable: !!(flags & OPEN_MODE.WRITE) }))
          } catch (e) {
            replyErr(sftp, reqid, e)
          }
        })

        sftp.on('READ', (reqid, handle, offset, length) => {
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
