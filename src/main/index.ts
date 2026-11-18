import { app, BrowserWindow, Menu, shell } from 'electron'
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { IPC } from '@shared/ipc'
import { registerAllIpc } from './ipc'
import { getSettings, seedCommandsIfNeeded } from './store/repository'
import { updateSettings } from './app/settingsService'
import { batchRunner } from './ssh/batchExec'
import { diagnosticsRunner } from './ssh/diagnostics'
import { firmwareOps } from './ssh/firmware'
import { metricsSampler } from './ssh/metrics'
import { netScanner } from './ssh/netScan'
import { initUpdater } from './updater'
import { tftpServer } from './tftp/server'
import { sessionManager } from './ssh/sessionManager'
import { SerialWatcher } from './transport/serialWatcher'
import { setSerialWatcher, getSerialWatcher } from './transport/serialWatcherHolder'
import { sftpManager } from './ssh/sftpManager'
import { tunnelManager } from './ssh/portForward'
import { getMainWindow, setMainWindow } from './windowRef'
import { runSmoke } from './smoke'
import { setRecordChangeHandler, sweepStale } from './store/transferRecord'
import { onTransferProgress } from './window/taskbar'
import { pickIconPath } from './window/icon'

/* ------------------------------------------------------------------ *
 *  启动日志与全局异常 —— 排查"静默退出"的关键抓手
 * ------------------------------------------------------------------ */

function log(...args: unknown[]): void {
  process.stdout.write(`[main] ${args.map(String).join(' ')}\n`)
}

/** 启动诊断日志（仅冒烟模式写文件，避免正常使用时累积；也用于无人工验证启动流程） */
function bootLog(...args: unknown[]): void {
  if (process.env.SSHW_SMOKE !== '1' && !process.argv.includes('--smoke')) return
  const line = `[${new Date().toISOString()}] ${args.map(String).join(' ')}\n`
  try {
    appendFileSync(join(app.getPath('userData'), 'boot.log'), line)
  } catch {
    /* ignore */
  }
  try {
    appendFileSync(join(process.cwd(), 'boot.log'), line)
  } catch {
    /* ignore */
  }
}

process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err)
  bootLog('uncaughtException:', String(err))
})
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason)
  bootLog('unhandledRejection:', String(reason))
})

log('boot: module loaded')
bootLog('boot: module loaded')

// 终端工具用 canvas 渲染，无需 GPU 加速；禁用可避免远程桌面/虚拟机/老机器上的
// GPU 进程崩溃（GPU 崩溃会导致整个应用退出），对技术支持场景的稳定性至关重要。
/*
 * 是否强制软件渲染。
 *
 * 关键约束：`disableHardwareAcceleration()` 必须在 whenReady 之前**同步**调用，
 * 而 getGPUInfo 是异步的 —— 所以这里只能同步读一次 settings.json。
 * 读文件失败（首次启动/文件损坏）一律当 false，保持硬件加速。
 *
 * 为什么不改成异步：Electron 在 app ready 之后再调用该 API 会抛错且不生效。
 */
function readSoftwareRenderSync(): boolean {
  try {
    const p = join(app.getPath('userData'), 'data', 'settings.json')
    const raw = readFileSync(p, 'utf-8')
    const parsed = JSON.parse(raw) as { experimental?: { softwareRender?: boolean } }
    return parsed?.experimental?.softwareRender === true
  } catch {
    return false
  }
}

const softwareRender = readSoftwareRenderSync()
if (softwareRender) {
  app.disableHardwareAcceleration()
  bootLog('software render forced by settings.experimental.softwareRender')
} else {
  // 默认**不**关加速：终端走 WebGL 需要 GPU。崩溃时由下面的自愈逻辑降级。
}

/* ------------------------------------------------------------------ *
 *  窗口
 * ------------------------------------------------------------------ */


/** 冒烟自检：--smoke / SSHW_SMOKE=1 启动 → 渲染完成后截图 → 写结果文件（userData + cwd 双落盘）→ 退出 */


function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 812,
    minWidth: 1000,
    minHeight: 640,
    show: false,
    frame: false,
    backgroundColor: '#0D1117',
    title: 'SSH Workbench',
    /*
     * 显式给窗口一个图标。
     *
     * 打包后 exe 自身带图标（electron-builder 从 build/icon.ico 生成），任务栏
     * 正常情况下读的是 exe 资源；但在 Windows 上「窗口图标」与「进程图标」是两套
     * 东西 —— 无边框窗口且未设置 icon 时，任务栏会退回进程默认图标（Electron 默认
     * 图标在浅色任务栏上是近乎全白的方块）。所以这里显式传一份，开发模式也走同一条路。
     *
     * 候选路径（打包版 → 开发版，ico 优先见 pickIconPath 的注释）：
     *   1. /resources/icon.ico     —— extraResources 拷到 asar 之外
     *   2. app.asar.unpacked/resources/icon.ico —— asarUnpack 的产物
     *   3. 仓库内 resources/icon.ico —— npm run dev
     * 逐个探测而不是写死一个，是因为「图标加载失败」在 Electron 里是静默的：
     * 路径不对不会报错，只会安静地回退到默认白图标，正是这次要修的现象。
     */
    icon: pickIconPath(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  setMainWindow(win)
  win.on('ready-to-show', () => win.show())
  win.on('closed', () => setMainWindow(null))

  // 外部链接交给系统浏览器
  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // 开发期 F12 开关 DevTools（无边框窗口没有菜单栏，快捷键需要手动补）
  if (is.dev) {
    win.webContents.on('before-input-event', (_event, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') {
        getMainWindow()?.webContents.toggleDevTools()
      }
    })
    // 渲染层 console 转发到终端，方便在启动阶段定位渲染错误
    win.webContents.on('console-message', (_event, level, message) => {
      log(`renderer[${level}]:`, message)
    })
  }

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('[main] renderer process gone:', details)
    bootLog('render-process-gone:', JSON.stringify(details))
  })
  win.webContents.on('did-fail-load', (_event, code, desc, url) => {
    console.error(`[main] page load failed: ${code} ${desc} ${url}`)
    bootLog('did-fail-load:', code, desc, url)
  })
  win.webContents.on('did-finish-load', () => {
    log('renderer page loaded')
    bootLog('renderer page loaded')
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  if (process.argv.includes('--smoke') || process.env.SSHW_SMOKE === '1') runSmoke(win)
}

/* ------------------------------------------------------------------ *
 *  生命周期
 * ------------------------------------------------------------------ */

const gotLock = app.requestSingleInstanceLock()
bootLog('requestSingleInstanceLock:', String(gotLock))
if (!gotLock) {
  log('another instance holds the lock, exiting')
  bootLog('no lock, exiting')
  app.quit()
} else {
  app.on('second-instance', () => {
    const existing = getMainWindow()
    if (existing) {
      if (existing.isMinimized()) existing.restore()
      existing.focus()
    }
  })

  void app.whenReady().then(async () => {
    log('app ready')
    bootLog('app ready')
    electronApp.setAppUserModelId('com.sshworkbench.app')
    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    app.on('child-process-gone', (_event, details) => {
      console.error('[main] child process gone:', details)
      /*
       * 自愈式降级：GPU 进程连续崩说明这台机器的显卡/驱动不可靠（远程桌面、老显卡、
       * 虚拟机的半虚拟化驱动都常见）。这时继续用硬件加速只会反复崩。
       *
       * 做法：把 settings.experimental.softwareRender 置 true 并落盘 —— 下次启动
       * 在 whenReady 之前就关掉硬件加速，终端自动回落到 DOM 渲染。
       *
       * 为什么只认 type === 'GPU'：渲染进程崩溃（OOM、页面异常）与显卡无关，
       * 不该由它触发全局降级。
       */
      if (details.type !== 'GPU') return
      void (async () => {
        try {
          const cur = await getSettings()
          if (cur.experimental?.softwareRender === true) return
          await updateSettings({ experimental: { ...cur.experimental, softwareRender: true } })
          console.error('[main] GPU crashed; software rendering will be used on next launch')
        } catch (e) {
          console.error('[main] failed to persist software render flag:', e)
        }
      })()
    })

    // 无边框自绘标题栏：去掉默认菜单（菜单的加速键也一并不存在，属预期）
    Menu.setApplicationMenu(null)

    await seedCommandsIfNeeded()
    log('seed commands done')
    bootLog('seed commands done')

    sessionManager.setHandlers({
      onData: (sessionId, data, raw) =>
        getMainWindow()?.webContents.send(IPC.EVT_SESSION_DATA, {
          sessionId,
          data,
          raw: raw?.length ? raw.toString('base64') : undefined
        }),
      onStatus: (sessionId, status, error, phase) =>
        getMainWindow()?.webContents.send(IPC.EVT_SESSION_STATUS, { sessionId, status, error, phase }),
      onLatency: (sessionId, ms) =>
        getMainWindow()?.webContents.send(IPC.EVT_SESSION_LATENCY, { sessionId, ms }),
      /*
       * trzsz 传输状态。
       *
       * 只发状态条需要的那几个字段，不发进度条文本 —— 进度条本身是普通终端输出，
       * 已经在 onData 里下发了。两条路分开的好处是重绘频率互不影响。
       */
      onTrzszState: (sessionId, state) =>
        getMainWindow()?.webContents.send(IPC.EVT_TRZSZ_STATE, { sessionId, ...state })
    })

    /*
     * 注入 SFTP 预挂载：SSH 一连接就在后台把 SFTP 子系统挂好。
     * 放在这里是因为 sessionManager 与 sftpManager 互相 import，
     * 只有在两者都完成模块初始化之后才能安全地建立这条引用。
     */
    sessionManager.setSftpPrewarm((sessionId) => sftpManager.prewarm(sessionId))

    // 自动重连进度转发到渲染层（标签栏显示倒计时/重试次数）
    sessionManager.setReconnectHandler((event) => {
      getMainWindow()?.webContents.send(IPC.EVT_RECONNECT, event)
    })

    sftpManager.setProgressHandler((event) => {
      getMainWindow()?.webContents.send(IPC.EVT_TRANSFER_PROGRESS, event)
      // 聚合逻辑（进/出 Map、算进度）全在 window/taskbar.ts，
      // 这里只负责把事件转发给渲染层再喂给它。
      onTransferProgress(event)
    })

    tunnelManager.setStatusHandler((info) => {
      getMainWindow()?.webContents.send(IPC.EVT_TUNNEL_STATUS, info)
    })

    diagnosticsRunner.setProgressHandler((event) => {
      getMainWindow()?.webContents.send(IPC.EVT_DIAG_PROGRESS, event)
    })

    batchRunner.setProgressHandler((event) => {
      getMainWindow()?.webContents.send(IPC.EVT_BATCH_PROGRESS, event)
    })

    metricsSampler.setEventHandler((event) => {
      getMainWindow()?.webContents.send(IPC.EVT_METRICS, event)
    })

    firmwareOps.setLogHandler((event) => {
      getMainWindow()?.webContents.send(IPC.EVT_FW_LOG, event)
    })

    // 内置 TFTP 服务端：刷 7628 时 U-Boot 的 RRQ / 重传 / 完成都从这里出去，
    // 串口引导条靠它显示现场排错信息
    tftpServer.setLogHandler((event) => {
      getMainWindow()?.webContents.send(IPC.EVT_TFTP_LOG, event)
    })

    netScanner.setProgressHandler((event) => {
      getMainWindow()?.webContents.send(IPC.EVT_DISCOVER_PROGRESS, event)
    })

    // 会话关闭时清理其上的 SFTP 通道、运行中的隧道与监控
    sessionManager.setOnClosed((sessionId) => {
      sftpManager.clearSession(sessionId)
      tunnelManager.onSessionClosed(sessionId)
      metricsSampler.onSessionClosed(sessionId)
    })

    /*
     * 传输记录变更信号。
     *
     * 主进程落盘后只发一条「变了」的信号（300ms 节流在 store 里做），
     * 面板收到就重拉列表 —— 不广播内容，避免渲染层维护一份
     * 与磁盘可能不同步的镜像。
     */
    setRecordChangeHandler(() => {
      getMainWindow()?.webContents.send(IPC.EVT_TRANSFER_RECORD_CHANGED)
    })

    /*
     * 清理上一次运行遗留的僵尸记录。
     *
     * 入队时写一条 running，只在状态跃迁时更新。进程被强杀/崩溃时那条记录
     * 就永远停在 running —— 面板上会显示成「还在传」，实际什么都没在传。
     * 启动时统一改判为 interrupted（可重试），是唯一一个「事后可确定」的时刻。
     */
    void sweepStale().catch((e) => {
      console.error('[main] sweep transfer records failed:', e)
    })

    registerAllIpc()
    log('ipc registered')
    bootLog('ipc registered')

    /*
     * 串口热插拔监听。
     *
     * 启动时机放在 IPC 注册之后：watcher 的第一次枚举是异步的，若在注册前
     * 完成，渲染层还没订阅 EVT_SERIAL_PORTS，首次通知会丢。
     *
     * 失败不阻塞启动：串口是可选能力，监听起不来（原生模块缺失等）时
     * SSH 全流程必须照常可用。
     */
    const serialWatcher = new SerialWatcher({
      onPorts: (ports) => {
        getMainWindow()?.webContents.send(IPC.EVT_SERIAL_PORTS, ports)
        // 设备插回来了：让挂起的串口会话自己恢复（内部按 USB 身份匹配端口）
        void sessionManager.resumeSerialSessions()
      }
    })
    setSerialWatcher(serialWatcher)
    void serialWatcher
      .start()
      .then((ports) => log(`serial watcher started, ${ports.length} port(s)`))
      .catch((err) => log(`serial watcher failed: ${String(err)}`))

    createWindow()
    log('window created')
    bootLog('window created')

    /*
     * 应用内更新。
     *
     * 放在 createWindow 之后：更新状态要用 win.webContents.send 推送，
     * 窗口还没建时 broadcast 全是空操作。而首轮检查本身又延后若干秒
     * （见 initUpdater 的 initialDelayMs），等渲染层订阅完再推，不会丢事件。
     *
     * 配置全部读用户设置，读失败就按默认值走 —— 更新不该成为启动的阻塞项。
     */
    try {
      const settings = await getSettings()
      initUpdater({
        log,
        broadcast: (status) => {
          getMainWindow()?.webContents.send(IPC.EVT_UPDATE_STATUS, status)
        },
        autoCheck: settings.update?.autoCheck !== false,
        autoDownload: settings.update?.autoDownload === true,
        proxyUrl: settings.update?.proxyUrl
      })
      bootLog('updater initialized')
    } catch (err) {
      log('[updater] init failed:', err instanceof Error ? err.message : String(err))
      bootLog('updater init failed')
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    bootLog('window-all-closed fired')
    // 停掉串口轮询：它的 timer 已 unref，但显式停一次能让退出路径更干净，
    // 也避免退出过程中还去枚举设备（Windows 上会短暂占用句柄）
    getSerialWatcher()?.stop()
    // TFTP 持有 69 端口和文件句柄，退出必须关；否则下次启动会报端口被占用
    tftpServer.stop()
    if (process.platform !== 'darwin') app.quit()
  })
}