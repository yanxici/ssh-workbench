import { app } from 'electron'
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { IPC } from '@shared/ipc'
import type { TextEncoding } from '@shared/types'
import { assertRemotePath } from '@shared/remotePath'
import { assertSafeReadPaths, assertSafeWriteDir } from '../store/pathGuard'
import { showOpenDialog } from '../windowRef'
import { dialogDefaultPath, rememberDialogDir, rememberDialogPick } from '../util/dialogDirs'
import { getSettings, updateSettings } from '../app/settingsService'
import { handle } from './handle'
import { sftpManager } from '../ssh/sftpManager'

/**
 * SFTP 文件管理：目录浏览、增删改、远程编辑、上传下载与传输控制。
 *
 * 所有「选文件的系统对话框」都在这里：目标目录解析统一退化为远端 home，
 * 绝不静默落到根目录 `/`（历史上这么干过，用户文件会跑到根下）。
 */
export function registerSftpIpc(): void {
  handle(IPC.SFTP_LIST, (sessionId: string, path: string) => sftpManager.list(sessionId, path))
  handle(IPC.SFTP_LIST_MANY, (sessionId: string, dirs: string[]) =>
    sftpManager.listMany(sessionId, dirs)
  )
  handle(IPC.SFTP_BOOTSTRAP, (sessionId: string) => sftpManager.bootstrap(sessionId))
  handle(IPC.SFTP_HOME, (sessionId: string) => sftpManager.home(sessionId))
  /*
   * 只读查询当前后端，不触发探测：探测要真去握一次 SFTP 子系统，
   * 让「打开面板」这条只读路径替用户挡住 300~800ms 不合适 —— 预热已经在连上时做了。
   */
  handle(IPC.SFTP_MODE, (sessionId: string) => sftpManager.getMode(sessionId) ?? 'sftp')
  /*
   * 写操作的路径在主进程兜一道校验。
   *
   * 渲染层的弹框已经拦过一次，但 IPC 是程序入口：一个渲染层 bug（或将来某个
   * 批量脚本）拼出 /a/../../etc 时，界面上看不出动手的是哪条路径。
   * 校验只拦「相对路径、控制字符、.. 穿越」—— 完整绝对路径一律放行，
   * 运维本来就要动 /etc 和 /opt。
   */
  handle(IPC.SFTP_MKDIR, (sessionId: string, path: string) =>
    sftpManager.mkdir(sessionId, assertRemotePath(path, '新建目录'))
  )
  handle(IPC.SFTP_DELETE, (sessionId: string, path: string) =>
    sftpManager.remove(sessionId, assertRemotePath(path, '删除'))
  )
  handle(IPC.SFTP_RENAME, (sessionId: string, from: string, to: string) =>
    sftpManager.rename(
      sessionId,
      assertRemotePath(from, '重命名'),
      assertRemotePath(to, '重命名')
    )
  )
  handle(IPC.SFTP_CHMOD, (sessionId: string, path: string, mode: number) =>
    sftpManager.chmod(sessionId, assertRemotePath(path, '修改权限'), mode)
  )
  handle(IPC.SFTP_READ, (sessionId: string, path: string) =>
    sftpManager.readText(sessionId, assertRemotePath(path, '读取文件'))
  )
  handle(
    IPC.SFTP_WRITE,
    (sessionId: string, path: string, content: string, encoding?: TextEncoding) =>
      sftpManager.writeText(
        sessionId,
        assertRemotePath(path, '写入文件'),
        content,
        encoding
      )
  )

  handle(
    IPC.SFTP_UPLOAD,
    async (
      sessionId: string,
      localPaths: string[],
      remoteDir: string,
      options?: { keepRoot?: boolean; force?: boolean }
    ) => {
      // 兜底：渲染层传空/空白目录时不再落到远端根 '/'，改用 home
      const target = remoteDir?.trim()
        ? assertRemotePath(remoteDir, '上传目标目录')
        : await sftpManager.home(sessionId)
      // 来源路径必须校验：不校验就是「渲染层可把任意本地文件推到远端」。
      if (!Array.isArray(localPaths) || localPaths.length === 0) {
        throw new Error('上传文件：没有选中任何文件')
      }
      return sftpManager.upload(
        sessionId,
        assertSafeReadPaths(localPaths, '上传文件'),
        target,
        options
      )
    }
  )

  handle(IPC.SFTP_DOWNLOAD, (sessionId: string, remotePaths: string[], localDir: string) =>
    sftpManager.download(
      sessionId,
      // 逐个校验：一批里混进一条相对路径，落盘位置就会变成进程 cwd
      remotePaths.map((p) => assertRemotePath(p, '下载')),
      // 落点同样要校验：不校验就是「往任意本地目录写文件」。
      // 用 assertSafeWriteDir 而不是 assertSafeLocalPath —— 后者是给删除/改名用的
      // 破坏性守卫，禁掉 homedir 与盘符根会让默认下载目录（homedir）100% 报错。
      assertSafeWriteDir(localDir, '下载目录')
    )
  )

  handle(IPC.SFTP_TRANSFER_PAUSE, (taskId: string) => sftpManager.pauseTransfer(taskId))
  handle(IPC.SFTP_TRANSFER_RESUME, (taskId: string) => sftpManager.resumeTransfer(taskId))
  handle(IPC.SFTP_TRANSFER_CANCEL, (taskId: string) => sftpManager.cancelTransfer(taskId))

  // 通过系统对话框选择文件（文件树面板的单点上传）
  handle(IPC.SFTP_UPLOAD_DIALOG, async (sessionId: string, remoteDir: string, force?: boolean) => {
    const target = remoteDir?.trim()
      ? assertRemotePath(remoteDir, '上传目标目录')
      : await sftpManager.home(sessionId)
    const res = await showOpenDialog({
      title: `选择要上传到 ${target} 的文件`,
      buttonLabel: '上传',
      defaultPath: dialogDefaultPath('file'),
      properties: ['openFile', 'multiSelections']
    })
    if (res.canceled || res.filePaths.length === 0) return { canceled: true, count: 0 }
    // 多选时只要有一个路径就足以反推目录；用第一个即可
    rememberDialogPick('file', res.filePaths[0], false)
    const ids = sftpManager.upload(sessionId, res.filePaths, target, { force })
    return { canceled: false, count: ids.length }
  })

  // 上传文件夹：系统对话框只让选目录，落点是「远端目标目录/本地目录名」
  handle(
    IPC.SFTP_UPLOAD_FOLDER_DIALOG,
    async (sessionId: string, remoteDir: string, keepRoot?: boolean, force?: boolean) => {
      const target = remoteDir?.trim()
        ? assertRemotePath(remoteDir, '上传目标目录')
        : await sftpManager.home(sessionId)
      const res = await showOpenDialog({
        title: `选择要上传到 ${target} 的文件夹（可多选）`,
        buttonLabel: '上传',
        defaultPath: dialogDefaultPath('folder'),
        properties: ['openDirectory', 'multiSelections']
      })
      if (res.canceled || res.filePaths.length === 0) return { canceled: true, count: 0 }
      rememberDialogPick('folder', res.filePaths[0], true)
      const ids = sftpManager.upload(sessionId, res.filePaths, target, {
        // 默认保留目录名，用户明确选的是「文件夹」而不是「文件夹里的东西」
        keepRoot: keepRoot !== false,
        force
      })
      return { canceled: false, count: ids.length }
    }
  )

  // 扫描待上传目录（选择文件夹后先给出文件数/体积预览，再决定是否上传）
  handle(IPC.SFTP_SCAN_FOLDERS, (localPaths: string[]) =>
    sftpManager.scanFolders(
      // 只读扫描，但仍然要拦住相对路径与 .. 穿越：后面 upload 会照这份清单读盘
      Array.isArray(localPaths) ? assertSafeReadPaths(localPaths, '扫描目录') : []
    )
  )

  handle(IPC.SFTP_DOWNLOAD_DIALOG, async (sessionId: string, remotePaths: string[]) => {
    const res = await showOpenDialog({
      title: '选择保存目录',
      buttonLabel: '下载到此处',
      defaultPath: dialogDefaultPath('folder'),
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return { canceled: true, count: 0 }
    rememberDialogDir('folder', res.filePaths[0])
    const ids = sftpManager.download(
      sessionId,
      remotePaths.map((p) => assertRemotePath(p, '下载')),
      assertSafeWriteDir(res.filePaths[0], '下载目录')
    )
    return { canceled: false, count: ids.length }
  })

  /*
   * 一键下载的落点。
   *
   * 优先用设置里的下载目录；它可能已经失效（移动硬盘拔了、网络盘掉线），
   * 这时回退系统「下载」而不是把整个下载弄失败 —— 用户要的是文件落地，
   * 不是「路径校验报告」。两个目录都按需建出来（精简版 Windows 可能没有「下载」）。
   */
  handle(IPC.SFTP_DOWNLOADS_DIR, async () => {
    const settings = await getSettings()
    const custom = usableLocalDir(settings.downloadDir)
    const dir = custom ?? app.getPath('downloads')
    mkdirSync(dir, { recursive: true })
    return dir
  })

  /** 选一个下载目录并写进设置（返回设置后的生效目录） */
  handle(IPC.SFTP_PICK_DOWNLOAD_DIR, async () => {
    const settings = await getSettings()
    const res = await showOpenDialog({
      title: '选择下载目录',
      buttonLabel: '下载到这里',
      defaultPath: usableLocalDir(settings.downloadDir) ?? dialogDefaultPath('folder'),
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || res.filePaths.length === 0) return { canceled: true, dir: '' }
    // 与 SFTP_DOWNLOAD 共用同一个守卫：否则设置页允许选定、点下载才报错
    const dir = assertSafeWriteDir(res.filePaths[0], '下载目录')
    rememberDialogDir('folder', dir)
    await updateSettings({ downloadDir: dir })
    return { canceled: false, dir }
  })
}

/**
 * 设置里的自定义下载目录是否还能用。
 *
 * 只放行绝对路径 + 已存在的目录：失效路径塞给对话框或 mkdir 会得到
 * 「第一次下载要等 5 秒才失败」这种最难解释的症状。
 */
function usableLocalDir(dir: string | undefined): string | undefined {
  if (!dir || !isAbsolute(dir)) return undefined
  try {
    if (!existsSync(dir)) return undefined
    if (!statSync(dir).isDirectory()) return undefined
    return dir
  } catch {
    return undefined
  }
}
