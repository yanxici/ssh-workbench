import { shell } from 'electron'
import { promises as fs } from 'node:fs'
import { basename } from 'node:path'
import { IPC } from '@shared/ipc'
import type { TunnelInput } from '@shared/types'
import { showSaveDialog } from '../windowRef'
import { dialogDefaultPath, rememberDialogPick } from '../util/dialogDirs'
import { handle } from './handle'
import { backupStore } from '../store/backups'
import { createBackup, diffBackup, restoreBackup } from '../ssh/configBackup'
import { deleteTunnel, listTunnels, saveTunnel } from '../store/repository'
import { buildSafeLocalTunnelUrl, tunnelManager } from '../ssh/portForward'
import { discoverRemotePorts } from '../ssh/remotePorts'
import { recorder } from '../ssh/recorder'
import {
  listSessionLogs,
  readSessionLog,
  removeSessionLog,
  resolveSessionLogPath
} from '../store/sessionLogs'

/** 配置备份对比 + 端口转发/隧道 + 会话日志（录制/回放） */
export function registerBackupTunnelIpc(): void {
  /* ---------------- 配置备份对比 ---------------- */
  handle(IPC.BACKUP_LIST, () => backupStore.list())
  handle(IPC.BACKUP_CREATE, (sessionId: string, name: string, paths: string[]) =>
    createBackup(sessionId, name, paths)
  )
  handle(IPC.BACKUP_DELETE, (id: string) => backupStore.remove(id))
  handle(IPC.BACKUP_DETAIL, (id: string) => backupStore.detail(id))
  handle(IPC.BACKUP_DIFF, (id: string, path: string, sessionId: string) =>
    diffBackup(id, path, sessionId)
  )
  handle(IPC.BACKUP_RESTORE, (id: string, sessionId: string, paths: string[]) =>
    restoreBackup(id, sessionId, paths)
  )
  handle(IPC.BACKUP_OPEN_DIR, () => backupStore.openDir())

  /* ---------------- 端口转发 / 隧道 ---------------- */
  handle(IPC.TUNNEL_LIST, () => listTunnels())
  handle(IPC.TUNNEL_SAVE, (input: TunnelInput) => saveTunnel(input))
  /*
   * 删除配置前必须先摘掉运行时。
   * 原实现只从 JSON 里 filter 掉这条记录，runtime 原样留在 Map 里：
   * 状态还是 active、net.Server 继续监听、forwardIn 还绑在远端，
   * 但 TUNNEL_LIST 已经列不出它 —— 用户失去关闭入口，只能重启应用。
   */
  handle(IPC.TUNNEL_DELETE, async (id: string) => {
    tunnelManager.dispose(id)
    return deleteTunnel(id)
  })
  handle(IPC.TUNNEL_START, (tunnelId: string, sessionId: string) =>
    tunnelManager.start(tunnelId, sessionId)
  )
  handle(IPC.TUNNEL_STOP, (tunnelId: string) => tunnelManager.stop(tunnelId))
  handle(IPC.TUNNEL_STATES, () => tunnelManager.states())
  // 探测当前会话远端的 TCP 监听端口（给「一键临时转发」提供候选）
  handle(IPC.TUNNEL_DISCOVER_PORTS, (sessionId: string) => discoverRemotePorts(sessionId))
  handle(
    IPC.TUNNEL_QUICK_START,
    (
      sessionId: string,
      input: { targetHost: string; targetPort: number; process?: string }
    ) => tunnelManager.startQuickForward(sessionId, input)
  )
  handle(IPC.TUNNEL_PROMOTE, (ephemeralId: string, customName?: string) =>
    tunnelManager.promoteQuickForward(ephemeralId, customName)
  )
  /*
   * 打开临时转发对应的本机页面。
   *
   * URL 一律由主进程用白名单端口拼出来，绝不接受渲染层传完整 URL：
   * shell.openExternal 会把任何协议交给系统处理，等于把「用默认程序打开」
   * 变成一个任意协议执行入口（file: / 自定义 scheme 都能被拖进来）。
   */
  handle(IPC.TUNNEL_OPEN_LOCAL, async (protocol: string, port: number) => {
    const safe = protocol === 'https' ? 'https' : protocol === 'http' ? 'http' : null
    if (!safe) throw new Error('不支持的协议：' + String(protocol))
    await shell.openExternal(buildSafeLocalTunnelUrl(safe, port))
  })

  /* ---------------- 会话日志（录制 / 回放） ---------------- */
  handle(IPC.LOG_LIST, () => listSessionLogs())
  handle(IPC.LOG_READ, (path: string) => readSessionLog(path))
  handle(IPC.LOG_DELETE, (path: string) => removeSessionLog(path))
  handle(IPC.LOG_OPEN_DIR, async () => {
    const dir = recorder.logDir()
    /*
     * 一次都没录过时这个目录还不存在，openPath 只返回一个错误码字符串、
     * 什么都不打开 —— 用户点了「打开日志目录」以为按钮坏了。
     * 先建出来再开，并且把 openPath 的返回值当错误处理。
     */
    await fs.mkdir(dir, { recursive: true })
    const err = await shell.openPath(dir)
    if (err) throw new Error('打开日志目录失败：' + err)
  })
  handle(IPC.LOG_EXPORT, async (path: string) => {
    // 入参必须落在日志目录内：这里紧跟着就是 fs.copyFile，不校验等于任意文件外泄
    const source = resolveSessionLogPath(path)
    const res = await showSaveDialog({
      title: '导出会话日志',
      defaultPath: dialogDefaultPath('report', basename(path)),
      filters: [
        // 按被导出的那份决定默认扩展名：另存对话框里过滤器顺序会影响补全的后缀，
        // 把不匹配的那一种排在前面，用户导出的纯文本就会莫名带上 .cast
        ...(path.endsWith('.log')
          ? [{ name: '文本日志', extensions: ['log'] }]
          : [{ name: 'Asciinema Cast', extensions: ['cast'] }]),
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (res.canceled || !res.filePath) return { canceled: true }
    rememberDialogPick('report', res.filePath, false)
    await fs.copyFile(source, res.filePath)
    return { canceled: false, path: res.filePath }
  })
}
