import { app, BrowserWindow, Menu, shell } from 'electron'
import {
  appendFileSync,
  existsSync,
  promises as fs,
  readFileSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { electronApp, is, optimizer } from '@electron-toolkit/utils'
import { IPC } from '@shared/ipc'
import { registerAllIpc } from './ipc'
import { getSettings, seedCommandsIfNeeded } from './store/repository'
import { batchRunner } from './ssh/batchExec'
import { diagnosticsRunner } from './ssh/diagnostics'
import { firmwareOps } from './ssh/firmware'
import { metricsSampler } from './ssh/metrics'
import { netScanner } from './ssh/netScan'
import { initUpdater } from './updater'
import { sessionManager } from './ssh/sessionManager'
import { sftpManager } from './ssh/sftpManager'
import { tunnelManager } from './ssh/portForward'
import { getMainWindow, setMainWindow } from './windowRef'

/** 正在进行的传输任务（用于任务栏进度条；完成/失败即移除） */
const activeTransfers = new Map<string, { transferred: number; total: number }>()

/** 把当前所有传输任务聚合成 Windows 任务栏进度；没有任务时清除 */
function updateTaskbarProgress(): void {
  const win = getMainWindow()
  if (!win || win.isDestroyed()) return
  if (activeTransfers.size === 0) {
    win.setProgressBar(-1)
    return
  }
  const tasks = [...activeTransfers.values()].filter((t) => t.total > 0)
  if (tasks.length === 0) {
    // 总大小未知（例如目录还在遍历）：任务栏显示不确定态
    win.setProgressBar(2)
    return
  }
  const ratio =
    tasks.reduce((sum, t) => sum + Math.min(t.transferred / t.total, 1), 0) / tasks.length
  // 传输中最多显示 99%，避免任务栏提前显示"已完成"
  win.setProgressBar(Math.min(Math.max(ratio, 0), 0.999))
}

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
app.disableHardwareAcceleration()

/* ------------------------------------------------------------------ *
 *  窗口
 * ------------------------------------------------------------------ */


/** 冒烟自检：--smoke / SSHW_SMOKE=1 启动 → 渲染完成后截图 → 写结果文件（userData + cwd 双落盘）→ 退出 */
function runSmoke(win: BrowserWindow): void {
  const report = (status: string, extra: Record<string, unknown> = {}): void => {
    const payload = JSON.stringify({ status, at: Date.now(), ...extra }, null, 2)
    try {
      writeFileSync(join(app.getPath('userData'), 'smoke-result.json'), payload)
    } catch {
      /* ignore */
    }
    try {
      writeFileSync(join(process.cwd(), 'smoke-result.json'), payload)
    } catch {
      /* ignore */
    }
  }

  let finished = false
  const finish = (fn: () => void): void => {
    if (finished) return
    finished = true
    fn()
    app.quit()
  }

  /** 截图落盘，返回路径与字节数。
   *  关掉带 backdrop-blur 的浮层后，合成器会残留一帧带模糊的旧画面，
   *  capturePage 就会拿到整体发虚的图（PNG 体积也会明显变小）。
   *  invalidate() 强制重绘一帧，连续拍两次取后一张。 */
  const shoot = async (name: string): Promise<{ shot: string; bytes: number }> => {
    win.webContents.invalidate()
    await new Promise((r) => setTimeout(r, 160))
    await win.webContents.capturePage()
    await new Promise((r) => setTimeout(r, 80))
    const image = await win.webContents.capturePage()
    const png = image.toPNG()
    const out = join(app.getPath('userData'), name)
    await fs.writeFile(out, png)
    return { shot: out, bytes: png.length }
  }

  /** 等渲染层稳定若干毫秒（浮层动画约 120ms，留足裕量） */
  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  /** 注入一次组合键（走真实输入管线，因此会经过全局 capture 监听） */
  const pressKey = (keyCode: string, modifiers: Array<'control' | 'shift'> = []): void => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'char', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
  }

  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      void (async () => {
        try {
          const list = await shoot('smoke-shot.png')

          /*
           * 性能断言：用户报「客户端好卡」。
           * 判据不看截图看 DOM 规模 —— 2929 条连接若全量展开是万级节点，
           * 这里必须远小于那个量级，否则说明分页/折叠没生效。
           * 同时记录命令中心从 Ctrl+K 到可见的耗时。
           */
          const perfProbe = (await win.webContents.executeJavaScript(`
            (() => {
              const sidebar = document.querySelector('[data-testid="connection-sidebar"]')
              const t0 = performance.now()
              return new Promise((resolve) => {
                requestAnimationFrame(() => {
                  const t1 = performance.now()
                  resolve({
                    totalNodes: document.querySelectorAll('*').length,
                    sidebarNodes: sidebar ? sidebar.querySelectorAll('*').length : -1,
                    sidebarRows: sidebar ? sidebar.querySelectorAll('[data-conn-id]').length : -1,
                    frameMs: Math.round((t1 - t0) * 100) / 100
                  })
                })
              })
            })()
          `)) as {
            totalNodes: number
            sidebarNodes: number
            sidebarRows: number
            frameMs: number
          }

          /*
           * 分页展开断言：XCMD 组有 2917 条，默认折叠。
           * 手动展开后一次只应铺 PAGE_SIZE(60) 条，而不是 2917 条 ——
           * 这是「客户端很卡」的直接成因，必须用 DOM 规模验证。
           */
          const expandProbe = (await (async () => {
            const clicked = (await win.webContents.executeJavaScript(`
              (() => {
                const sidebar = document.querySelector('[data-testid="connection-sidebar"]')
                if (!sidebar) return { found: false }
                const header = Array.from(sidebar.querySelectorAll('button'))
                  .find((b) => /XCMD/.test(b.textContent || ''))
                if (!header) return { found: true, header: false }
                const label = (header.textContent || '').trim().slice(0, 32)
                header.click()
                return { found: true, header: true, label }
              })()
            `)) as { found: boolean; header?: boolean; label?: string }
            if (!clicked.header) return clicked
            // React 提交是异步的，等两帧再读，否则拿到的还是折叠前的高度
            await settle(200)
            const after = (await win.webContents.executeJavaScript(`
              (() => {
                const sidebar = document.querySelector('[data-testid="connection-sidebar"]')
                const seg = sidebar && sidebar.querySelector('[data-conn-group]')
                return {
                  rowsAfterExpand: sidebar ? sidebar.querySelectorAll('[data-conn-id]').length : -1,
                  nodesAfterExpand: sidebar ? sidebar.querySelectorAll('*').length : -1,
                  groupNodes: seg ? seg.querySelectorAll('*').length : -1
                }
              })()
            `)) as { rowsAfterExpand: number; nodesAfterExpand: number }
            return { ...clicked, ...after }
          })()) as {
            found: boolean
            header?: boolean
            label?: string
            rowsAfterExpand?: number
            nodesAfterExpand?: number
          }

          // 命令中心：Ctrl+K 应弹出全屏浮层（这是本次 UI 改造的核心入口）
          // 用轮询测真实打开耗时，而不是用固定 settle 时长糊过去。
          const openT0 = Date.now()
          pressKey('K', ['control'])
          let openMs = -1
          for (let i = 0; i < 120; i++) {
            const ready = (await win.webContents.executeJavaScript(
              `!!document.querySelector('[data-testid="command-center-list"]')`
            )) as boolean
            if (ready) {
              openMs = Date.now() - openT0
              break
            }
            await settle(16)
          }
          await settle(220)
          const center = await shoot('smoke-shot-command-center.png')

          /*
           * 按钮墙断言：没输入关键字时必须铺成分组网格，而不是列表。
           * 判据是 DOM 结构（网格容器 + 每块卡片），不依赖截图 —— 光靠图
           * 看不出「是不是列表」，而这正是用户抱怨的那一点。
           */
          const wallProbe = (await win.webContents.executeJavaScript(`
            (() => {
              const host = document.querySelector('[data-testid="command-center-list"]')
              if (!host) return { found: false }
              const grids = host.querySelectorAll('[style*="grid-template-columns"]')
              const cards = host.querySelectorAll('[data-active]')
              const groupTitles = host.querySelectorAll('[data-wall-group]')
              const first = host.querySelector('[data-active="true"]')
              return {
                found: true,
                gridCount: grids.length,
                cols: grids.length > 0
                  ? getComputedStyle(grids[0]).gridTemplateColumns.split(' ').length
                  : 0,
                cardCount: cards.length,
                groupCount: groupTitles.length,
                firstCardName: first ? (first.textContent || '').trim().slice(0, 24) : ''
              }
            })()
          `)) as {
            found: boolean
            gridCount?: number
            cols?: number
            cardCount?: number
            groupCount?: number
            firstCardName?: string
          }

          // 浮层里输入关键字，验证 fuzzy 检索确实跑了
          for (const ch of 'disk') {
            win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
          }
          await settle(400)
          const filtered = await shoot('smoke-shot-command-center-query.png')

          // 输入关键字后应退回列表模式：网格消失、列表行出现
          const listProbe = (await win.webContents.executeJavaScript(`
            (() => {
              const host = document.querySelector('[data-testid="command-center-list"]')
              if (!host) return { found: false }
              return {
                found: true,
                gridCount: host.querySelectorAll('[style*="grid-template-columns"]').length,
                rowCount: host.querySelectorAll('[data-result-row]').length
              }
            })()
          `)) as { found: boolean; gridCount?: number; rowCount?: number }

          // Esc 关闭，界面应回到初始状态
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
          await settle(300)
          const closed = await shoot('smoke-shot-closed.png')

          // 设置面板：验证分区导航 + 「栏宽」分组能正常滚到
          pressKey(',', ['control'])
          await settle(700)
          const settings = await shoot('smoke-shot-settings.png')

          // 「栏宽」分组在设置面板下方：展开它并滚到可见位置，验证可滚动可达
          const layoutSection: unknown = await win.webContents.executeJavaScript(`
            (() => {
              const head = [...document.querySelectorAll('button')]
                .find((b) => b.textContent?.includes('栏宽'))
              if (!head) return { error: 'section-not-found' }
              head.click()
              head.scrollIntoView({ block: 'center' })
              return { clicked: true }
            })()
          `)
          await settle(600)
          const layoutShot = await shoot('smoke-shot-settings-layout.png')

          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
          await settle(400)

          // 命令按钮墙断言：命令栏常驻在窗口右侧，不需要切视图，直接验结构。
          // 用户明确要求「一行三个命令，这样好找一点」——列数必须正好是 3，
          // 而且拖动命令栏宽度时列数不能变（变了「第三行右边那个」这种空间记忆就失效）。
          await settle(450)
          const panelWallProbe = (await win.webContents.executeJavaScript(`
            (() => {
              const rail = document.querySelector('section[aria-label="常用命令栏"]')
              const panel = document.querySelector('[data-testid="command-panel"]')
              if (!panel) return { found: false }
              const grids = panel.querySelectorAll('.grid')
              const cards = panel.querySelectorAll('[data-cmd-id]')
              const cols = grids.length > 0
                ? getComputedStyle(grids[0]).gridTemplateColumns.split(' ').length
                : 0
              return {
                found: true,
                railPresent: Boolean(rail),
                railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
                gridCount: grids.length,
                cols,
                cardCount: cards.length
              }
            })()
          `)) as {
            found: boolean
            railPresent?: boolean
            railWidth?: number
            gridCount?: number
            cols?: number
            cardCount?: number
          }

          // 命令面板筛选态：点「最近」chip 后应是空状态提示（此时还没执行过命令）
          const recentOk: unknown = await win.webContents.executeJavaScript(`
            (() => {
              const btn = [...document.querySelectorAll('button')]
                .find((b) => b.textContent?.trim() === '最近')
              if (!btn) return 'chip-not-found'
              btn.click()
              return 'clicked'
            })()
          `)
          await settle(400)
          // 顺便探一下有没有残留的浮层（截图上出现了整体发白的现象，先排除是遮罩没清掉）
          const leftovers: unknown = await win.webContents.executeJavaScript(`
            ({
              overlays: document.querySelectorAll('.modal-overlay').length,
              fixed: [...document.querySelectorAll('div')].filter(
                (d) => getComputedStyle(d).position === 'fixed' && d.offsetWidth > 1000
              ).length,
              focusTag: document.activeElement?.tagName ?? null
            })
          `)
          await settle(1200)
          const filtered2 = await shoot('smoke-shot-panel-recent.png')

          // 排查看不清的那张图：是不是「关掉带 backdrop-blur 的浮层后残留了模糊层」
          const sharpProbe: unknown = await win.webContents.executeJavaScript(`
            (() => {
              const blurry = [...document.querySelectorAll('*')].filter((el) => {
                const s = getComputedStyle(el)
                return s.backdropFilter && s.backdropFilter !== 'none'
              })
              return {
                blurLayers: blurry.map((el) => el.className + ' → ' + getComputedStyle(el).backdropFilter),
                dpr: window.devicePixelRatio,
                zoom: window.outerWidth / window.innerWidth
              }
            })()
          `)
          // 强制一次重排/重绘，再拍一张对比
          await win.webContents.executeJavaScript(`
            document.body.style.transform = 'translateZ(0)'
            void document.body.offsetHeight
            document.body.style.transform = ''
          `)
          await settle(800)
          const sharpRetry = await shoot('smoke-shot-panel-recent2.png')

          // 键盘链路回归：Ctrl+K → 输入 disk → ↓ 选中第二行 → ↵ 执行
          // 当前没有会话，执行应弹 toast 提示并关闭浮层（说明 Enter 真的走到了执行流水线）
          pressKey('K', ['control'])
          await settle(500)
          for (const ch of 'disk') {
            win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
          }
          await settle(400)
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
          await settle(200)
          win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' })
          win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' })
          await settle(700)
          const keyboardRun: unknown = await win.webContents.executeJavaScript(`
            (() => {
              const overlay = [...document.querySelectorAll('div')].find(
                (d) => getComputedStyle(d).position === 'fixed' && d.offsetWidth > 1000
              )
              const toast = document.body.innerText.includes('没有活动终端')
              return { overlayOpen: Boolean(overlay), toast }
            })()
          `)
          const keyboardShot = await shoot('smoke-shot-keyboard-run.png')

          /*
           * 外壳几何断言：新版五段结构。
           * 规范把尺寸写死了（标题栏 44 / 活动栏 48 / 侧栏 280 / 状态栏 28），
           * 这类数值最容易在后续改动里被悄悄带偏，所以直接量 getBoundingClientRect。
           * 同时校验品牌绿只出现在标题栏（这是规范里最容易被滥用的约束）。
           */
          const shellProbe = (await win.webContents.executeJavaScript(`
            (() => {
              const rect = (sel) => {
                const el = document.querySelector(sel)
                if (!el) return null
                const b = el.getBoundingClientRect()
                return { w: Math.round(b.width), h: Math.round(b.height) }
              }
              const titlebar = document.querySelector('header.titlebar')
              const bg = titlebar ? getComputedStyle(titlebar).backgroundColor : ''
              // 数一下页面里有几个元素用了品牌绿做背景：只允许标题栏一处
              const brandBg = [...document.querySelectorAll('*')].filter((el) => {
                const c = getComputedStyle(el).backgroundColor
                return c === 'rgb(39, 201, 63)'
              })
              return {
                titlebar: rect('header.titlebar'),
                activitybar: rect('nav[aria-label="活动栏"]'),
                sidebar: rect('aside[aria-label="侧边栏"]'),
                statusbar: rect('footer.statusbar'),
                main: rect('main'),
                titlebarBg: bg,
                brandBgCount: brandBg.length,
                brandBgTags: brandBg.map((el) => el.tagName + '.' + (el.className || '').slice(0, 24)),
                /*
                 * 主题落点：外壳换代后默认应是浅色 + vscode 配色
                 * （app #ffffff / panel #f8f9fa）。老配置靠 migrateShell 一次性迁过来，
                 * 这里把实际计算值抓出来，避免「改了默认值却没生效」这类静默失败。
                 */
                themeClass: document.documentElement.className,
                appBg: getComputedStyle(document.documentElement).getPropertyValue('--c-app').trim(),
                mainBg: (() => {
                  const m = document.querySelector('main')
                  return m ? getComputedStyle(m).backgroundColor : ''
                })(),
                sidebarBg: (() => {
                  const a = document.querySelector('aside[aria-label="侧边栏"]')
                  return a ? getComputedStyle(a).backgroundColor : ''
                })()
              }
            })()
          `)) as Record<string, unknown>

          /*
           * 先造 3 个假标签再量。
           * 冒烟环境没有 SSH 服务器，标签栏本来是空的 —— 而「标签在绿栏里不满格」
           * 只有有标签时才量得出来（空标签栏的 stripH 也可能恰好是 44）。
           *
           * 造 14 个：满高只看 3 个就够，但横向滚动要溢出才看得见（每个标签 128~220px），
           * 3 个撑不满一行，滚动条根本不会出现，`tabsScrollProbe` 就量不到东西。
           */
          await win.webContents.executeJavaScript(`
            (() => {
              const t = window.__lazy_test
              if (t && typeof t.seedTabs === 'function') t.seedTabs(14)
            })()
          `)
          await settle(250)

          /*
           * 标签页「满格」断言。
           *
           * 用户反馈：「连接在标题绿色栏不满格显示，看着好难受」。
           * 根因是 TabBar 根容器缺 `h-full` —— 它是块级 flex 容器，height 默认 auto，
           * 只有内容高度（≈28px），而标题栏是 44px，于是标签上下各留一条绿边，
           * 视觉上把标题栏切成三条横向色带。
           *
           * 判据：标签条自身的 top 必须贴着标题栏 top、高度必须撑满 44、每个标签
           * 也必须是 44。只量标签不够 —— 容器没满时标签会被拉伸到容器高度，
           * 看上去「高度对」，但上下仍露绿边，所以 strip 的两个值才是主判据。
           */
          const tabStripProbe = (await win.webContents.executeJavaScript(`
            (() => {
              const bar = document.querySelector('header.titlebar')
              if (!bar) return { found: false }
              const barRect = bar.getBoundingClientRect()
              const strip = bar.querySelector('[data-tab-strip]')
              const stripRect = strip ? strip.getBoundingClientRect() : null
              const tabs = [...bar.querySelectorAll('[data-tab-id]')]
              return {
                found: true,
                barH: Math.round(barRect.height),
                stripH: stripRect ? Math.round(stripRect.height) : -1,
                stripGapTop: stripRect ? Math.round(stripRect.top - barRect.top) : -1,
                tabCount: tabs.length,
                tabH: tabs.length ? Math.round(tabs[0].getBoundingClientRect().height) : -1,
                tabGapTop: tabs.length
                  ? Math.round(tabs[0].getBoundingClientRect().top - barRect.top)
                  : -1
              }
            })()
          `)) as Record<string, unknown>
          /* 有标签的状态单独拍一张：这张图就是「标签是否满格」的直接证据 */
          const tabStripShot = await shoot('smoke-shot-tabs.png')

          /*
           * 标签条横向滚动探针。
           *
           * 用户反馈：「多会话连接后，绿色标题栏上方的滚动条无法使用」。
           * 两个根因，各自都有可测量的痕迹：
           * 1) 滚动容器带 `-webkit-app-region: drag`，滚动条收不到鼠标事件 →
           *    断言容器的 computed `-webkit-app-region` 必须是 `no-drag`；
           * 2) 原生横向滚动条要占 8px 高，标签就不满高 →
           *    断言 strip 的 clientHeight - offsetHeight === 0（没有横向滚动条占位），
           *    且 strip 的 scrollWidth > clientWidth（确实溢出，滚动能力还在），
           *    并且存在自绘的 .tabs-scrollbar-thumb。
           * 再真的拖一把：把滑块往右推 120px，看 scrollLeft 是否跟上了。
           */
          const tabsScrollProbe = (await win.webContents.executeJavaScript(`
            (async () => {
              const bar = document.querySelector('header.titlebar')
              const strip = bar ? bar.querySelector('[data-tab-strip]') : null
              if (!strip) return { found: false }
              const appRegion = getComputedStyle(strip).getPropertyValue('-webkit-app-region').trim()
              const nativeBarH = strip.offsetHeight - strip.clientHeight
              const overflow = strip.scrollWidth - strip.clientWidth
              let thumb = document.querySelector('.tabs-scrollbar-thumb')
              const thumbBefore = thumb ? thumb.getBoundingClientRect() : null
              const wait = (ms) => new Promise((r) => setTimeout(r, ms))
              let scrolled = 0
              if (thumb && overflow > 0) {
                const startX = thumbBefore.left + thumbBefore.width / 2
                const startY = thumbBefore.top + thumbBefore.height / 2
                const opts = (x) => ({
                  bubbles: true, cancelable: true, clientX: x, clientY: startY, button: 0, buttons: 1
                })
                const down = new MouseEvent('mousedown', opts(startX))
                const el = thumb
                el.dispatchEvent(down)
                for (const dx of [30, 60, 90, 120]) {
                  window.dispatchEvent(new MouseEvent('mousemove', opts(startX + dx)))
                  await wait(16)
                }
                window.dispatchEvent(new MouseEvent('mouseup', opts(startX + 120)))
                await wait(60)
                scrolled = strip.scrollLeft
              }
              /*
               * 滚轮：先归零，再竖着滚 3×120px。
               * 标签条没有竖向可滚内容，竖滚轮必须被翻译成横向位移 ——
               * 这是「只能用滚轮、拖不动」这类半残状态的反向验证。
               * 顺带记 defaultPrevented：没锁住的话页面会被带着一起滚。
               */
              let wheeled = -1
              let wheelPrevented = false
              if (overflow > 0) {
                strip.scrollLeft = 0
                await wait(30)
                for (let i = 0; i < 3; i++) {
                  const ev = new WheelEvent('wheel', {
                    bubbles: true, cancelable: true, deltaY: 120, deltaX: 0
                  })
                  strip.dispatchEvent(ev)
                  if (ev.defaultPrevented) wheelPrevented = true
                  await wait(24)
                }
                await wait(40)
                wheeled = Math.round(strip.scrollLeft)
              }
              thumb = document.querySelector('.tabs-scrollbar-thumb')
              const thumbAfter = thumb ? thumb.getBoundingClientRect() : null
              return {
                found: true,
                appRegion,
                nativeBarH,
                overflow,
                tabCount: strip.querySelectorAll('[data-tab-id]').length,
                hasThumb: !!thumb,
                thumbW: thumbBefore ? Math.round(thumbBefore.width) : -1,
                thumbMoved: thumbBefore && thumbAfter ? Math.round(thumbAfter.left - thumbBefore.left) : -1,
                scrolled: Math.round(scrolled),
                wheeled,
                wheelPrevented
              }
            })()
          `)) as Record<string, unknown>
          const tabsScrollShot = await shoot('smoke-shot-tabs-scroll.png')

          /*
           * 视觉约束断言（规范里的硬性禁止项）：
           * 1) 不许任何 backdrop-filter —— 终端在 canvas 上逐帧重绘，上层毛玻璃会掉帧，
           *    Windows 上还会有「关掉浮层后整窗发虚」的合成器残留；
           * 2) 过渡时长不许超过 150ms，也不许用 transition-all（会把布局属性也带上）；
           * 3) 不许用 transform 缩放动画（规范明确禁止）。
           */
          const visualProbe = (await win.webContents.executeJavaScript(`
            (() => {
              const all = [...document.querySelectorAll('*')]
              const blurred = all.filter((el) => {
                const s = getComputedStyle(el)
                return s.backdropFilter && s.backdropFilter !== 'none'
              })
              const longTransitions = all
                .map((el) => getComputedStyle(el))
                .filter((s) => {
                  const d = s.transitionDuration
                  if (!d || d === '0s') return false
                  return d.split(',').some((p) => parseFloat(p) > 0.15)
                })
              /*
               * transition-property 的计算值默认就是 all，所以只数 property 会把
               * 上千个没设置过渡的元素也统计进来。必须同时要求 duration > 0。
               */
              const allTransition = all.filter((el) => {
                const s = getComputedStyle(el)
                if (!s.transitionDuration || s.transitionDuration === '0s') return false
                return s.transitionProperty
                  .split(',')
                  .some((p) => p.trim() === 'all')
              })
              const animated = all.filter((el) => {
                const s = getComputedStyle(el)
                const a = s.animationName
                return a && a !== 'none' && s.animationDuration !== '0s'
              })
              return {
                blurCount: blurred.length,
                longTransitionCount: longTransitions.length,
                transitionAllCount: allTransition.length,
                transitionAllTags: allTransition
                  .slice(0, 8)
                  .map((el) => el.tagName + '.' + String(el.className || '').slice(0, 30)),
                animatedCount: animated.length,
                animatedNames: animated.map((el) => getComputedStyle(el).animationName)
              }
            })()
          `)) as Record<string, unknown>

          /*
           * 活动栏切换断言：这是新版外壳的核心交互。
           * 点某个主视图切换到该面板；再点一次同一项应收起侧栏。
           * 用真实 click() 走 React 事件，不直接改 store —— 要测的是接线正确。
           *
           * 注意：常用命令已经不在侧栏里了（m03213 起移到窗口右侧常驻命令栏），
           * 所以这里只剩 5 个视图，命令栏的开合用活动栏底部的独立开关验。
           */
          const clickActivity = async (label: string): Promise<Record<string, unknown>> => {
            return (await win.webContents.executeJavaScript(`
              (() => {
                const btn = document.querySelector('nav[aria-label="活动栏"] button[aria-label="${label}"]')
                if (!btn) return { found: false }
                btn.click()
                return { found: true }
              })()
            `)) as Record<string, unknown>
          }

          const readShell = `(() => {
            const aside = document.querySelector('aside[aria-label="侧边栏"]')
            const panel = document.querySelector('[data-testid="command-panel"]')
            const main = document.querySelector('main')
            const grids = panel ? panel.querySelectorAll('.grid') : []
            // 侧栏里当前可见面板的头部高度：6 个面板必须都是 32px，
            // 否则切面板时正文会整块上下跳（这个坑修过一次，加断言防回归）
            const visiblePane = aside
              ? [...aside.querySelectorAll('[data-pane]')].find(
                  (p) => getComputedStyle(p).display !== 'none'
                )
              : null
            const head = visiblePane ? visiblePane.querySelector('.panel-head') : null
            const rail = document.querySelector('section[aria-label="常用命令栏"]')
            return {
              asidePresent: Boolean(aside),
              asideWidth: aside ? Math.round(aside.getBoundingClientRect().width) : 0,
              mainWidth: main ? Math.round(main.getBoundingClientRect().width) : 0,
              railPresent: Boolean(rail),
              railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
              panelPresent: Boolean(panel),
              gridCount: grids.length,
              cardCount: panel ? panel.querySelectorAll('[data-cmd-id]').length : 0,
              cols: grids.length > 0
                ? getComputedStyle(grids[0]).gridTemplateColumns.split(' ').length
                : 0,
              pane: visiblePane ? visiblePane.dataset.pane : null,
              headH: head ? Math.round(head.getBoundingClientRect().height) : 0
            }
          })()`

          // 起点：切到「文件」视图（从 commands 切过去一定是 expand，不会误触收起）
          await clickActivity('文件')
          await settle(350)
          const filesProbe = (await win.webContents.executeJavaScript(`
            (() => {
              const aside = document.querySelector('aside[aria-label="侧边栏"]')
              if (!aside) return { found: false }
              // keep-alive 之后侧栏里同时挂着连接/文件/命令三个面板，
              // 只统计 files 这一层，否则数出来的是三个面板的总和
              const pane = aside.querySelector('[data-pane="files"]') || aside
              const text = aside.innerText || ''
              const head = pane.querySelector('.panel-head')
              return {
                found: true,
                tabs: [...pane.querySelectorAll('button')]
                  .map((b) => (b.textContent || '').trim())
                  .filter((t) => t === '工作区' || t === '文件系统').length,
                hasHead: Boolean(head),
                headH: head ? Math.round(head.getBoundingClientRect().height) : 0,
                hasGuide: text.includes('还没有连接任何设备'),
                hasConnectCta: text.includes('去连接设备'),
                nodeCount: pane.querySelectorAll('*').length
              }
            })()
          `)) as Record<string, unknown>
          const filesShot = await shoot('smoke-shot-files.png')

          // 切到历史视图：侧栏应换内容，而右侧命令栏不受影响（始终在、始终 3 列）
          await clickActivity('命令历史')
          await settle(400)
          const switchProbe = (await win.webContents.executeJavaScript(readShell)) as Record<
            string,
            unknown
          >
          const switched = await shoot('smoke-shot-activity-history.png')

          // 再点一次同一项：按 VS Code 行为应收起侧栏，主区域明显变宽
          await clickActivity('命令历史')
          await settle(350)
          const collapseProbe = (await win.webContents.executeJavaScript(readShell)) as Record<
            string,
            unknown
          >
          const collapsed = await shoot('smoke-shot-sidebar-collapsed.png')

          // 恢复：切回连接视图，后续（若有）断言按旧假设走
          await clickActivity('连接')
          await settle(300)

          /*
           * keep-alive 断言：切走过的面板必须还挂在 DOM 里（display:none），
           * 这样滚动位置 / 折叠状态 / 搜索词才留得住。
           * 只断言「还在 + 隐藏」，不断言内部状态 —— 状态属于组件内部实现。
           */
          const keepAliveProbe = (await win.webContents.executeJavaScript(`
            (() => {
              const aside = document.querySelector('aside[aria-label="侧边栏"]')
              if (!aside) return { found: false, panes: [], visible: [] }
              const panes = [...aside.querySelectorAll('[data-pane]')]
              const visible = panes.filter((p) => getComputedStyle(p).display !== 'none')
              return {
                found: true,
                panes: panes.map((p) => p.dataset.pane),
                visible: visible.map((p) => p.dataset.pane),
                hiddenCount: panes.length - visible.length
              }
            })()
          `)) as Record<string, unknown>

          /*
           * 侧栏拖拽断言：分隔条是新接回来的能力（旧外壳里它一度成了死代码）。
           * 合成 PointerEvent 走真实的 pointerdown/move/up 路径，测的是
           * React 事件接线 + 尺寸换算，不是直接改 store。
           *
           * 两个注意点：
           * 1) React 18 的 setState 是异步的，派发完必须先 settle 再读 DOM，
           *    否则量到的是拖拽前的旧宽度；
           * 2) 指针事件必须带 pointerId，setPointerCapture 在缺这个参数时会抛。
           */
          const beforeDrag = (await win.webContents.executeJavaScript(
            `Math.round(document.querySelector('aside[aria-label="侧边栏"]').getBoundingClientRect().width)`
          )) as number
          const dragProbe = (await win.webContents.executeJavaScript(`
            (() => {
              // 用 aria-label 精确定位侧栏分隔条：窗口里有两个分隔条，
              // 裸 [role="separator"] 靠 DOM 顺序猜，改布局就会抓错目标
              const rz = document.querySelector('[role="separator"][aria-label="调整侧边栏"]')
              if (!rz) return { found: false }
              const rect = rz.getBoundingClientRect()
              const startX = Math.round(rect.left + rect.width / 2)
              const y = Math.round(rect.top + rect.height / 2)
              const fire = (type, x) =>
                rz.dispatchEvent(
                  new PointerEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    pointerId: 1,
                    pointerType: 'mouse',
                    button: type === 'pointermove' ? -1 : 0,
                    buttons: 1,
                    clientX: x,
                    clientY: y
                  })
                )
              fire('pointerdown', startX)
              fire('pointermove', startX + 90)
              fire('pointerup', startX + 90)
              return { found: true, orientation: rz.getAttribute('aria-orientation'), startX }
            })()
          `)) as Record<string, unknown>
          await settle(300)
          const afterDrag = (await win.webContents.executeJavaScript(
            `Math.round(document.querySelector('aside[aria-label="侧边栏"]').getBoundingClientRect().width)`
          )) as number
          const dragged = await shoot('smoke-shot-sidebar-resized.png')

          /*
           * 双击复位：把宽度恢复默认，避免污染后面的截图。
           * 双击是 PaneResizer 自己实现的复位入口，也必须走通。
           */
          await win.webContents.executeJavaScript(`
            (() => {
              const rz = document.querySelector('[role="separator"][aria-label="调整侧边栏"]')
              if (!rz) return false
              const rect = rz.getBoundingClientRect()
              const opts = {
                bubbles: true,
                cancelable: true,
                clientX: Math.round(rect.left + rect.width / 2),
                clientY: Math.round(rect.top + rect.height / 2)
              }
              rz.dispatchEvent(new MouseEvent('dblclick', opts))
              return true
            })()
          `)
          await settle(300)
          const afterReset = (await win.webContents.executeJavaScript(
            `Math.round(document.querySelector('aside[aria-label="侧边栏"]').getBoundingClientRect().width)`
          )) as number
          const resizerProbe = { beforeDrag, afterDrag, afterReset, ...dragProbe }

          /*
           * 命令栏断言：原来这里测「侧栏变宽 → 按钮墙列数自适应」，
           * 现在列数是写死的三列（用户要求「一行三个命令，这样好找一点」），
           * 所以断言正好反过来 —— 拖动命令栏宽度时列数必须**恒为 3**。
           *
           * 顺便验两件「常驻」承诺：命令栏一直存在（不需要切视图），
           * 收起后主工作区明显变宽。
           */
          const readRail = `(() => {
            const rail = document.querySelector('section[aria-label="常用命令栏"]')
            const panel = document.querySelector('[data-testid="command-panel"]')
            const grid = panel ? panel.querySelector('.grid') : null
            return {
              railPresent: Boolean(rail),
              railWidth: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
              mainWidth: Math.round(
                document.querySelector('main').getBoundingClientRect().width
              ),
              cols: grid ? getComputedStyle(grid).gridTemplateColumns.split(' ').length : 0,
              cardCount: panel ? panel.querySelectorAll('[data-cmd-id]').length : 0
            }
          })()`
          const railDefault = (await win.webContents.executeJavaScript(readRail)) as Record<
            string,
            unknown
          >

          // 拖命令栏左侧的分隔条（sign=-1，往左拖 = 变宽）
          await win.webContents.executeJavaScript(`
            (() => {
              const rz = document.querySelector('[role="separator"][aria-label="调整命令栏"]')
              if (!rz) return false
              const rect = rz.getBoundingClientRect()
              const startX = Math.round(rect.left + rect.width / 2)
              const y = Math.round(rect.top + rect.height / 2)
              const fire = (type, x) =>
                rz.dispatchEvent(
                  new PointerEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    pointerId: 1,
                    pointerType: 'mouse',
                    button: type === 'pointermove' ? -1 : 0,
                    buttons: 1,
                    clientX: x,
                    clientY: y
                  })
                )
              fire('pointerdown', startX)
              fire('pointermove', startX - 180)
              fire('pointerup', startX - 180)
              return true
            })()
          `)
          await settle(400)
          const railWide = (await win.webContents.executeJavaScript(readRail)) as Record<
            string,
            unknown
          >
          const wallColsShot = await shoot('smoke-shot-command-rail-wide.png')

          // 复位：双击分隔条回到默认 380
          await win.webContents.executeJavaScript(`
            (() => {
              const rz = document.querySelector('[role="separator"][aria-label="调整命令栏"]')
              if (!rz) return false
              const rect = rz.getBoundingClientRect()
              rz.dispatchEvent(
                new MouseEvent('dblclick', {
                  bubbles: true,
                  cancelable: true,
                  clientX: Math.round(rect.left + rect.width / 2),
                  clientY: Math.round(rect.top + rect.height / 2)
                })
              )
              return true
            })()
          `)
          await settle(350)
          const railReset = (await win.webContents.executeJavaScript(readRail)) as Record<
            string,
            unknown
          >
          const wallColsProbe = { railDefault, railWide, railReset }

          /*
           * 命令栏开合：活动栏底部的常驻开关是唯一稳定入口
           * （命令栏自己的关闭按钮收起之后自己也跟着没了）。
           * 用 aria-label 的正则式匹配，因为按钮文案在两种状态间切换。
           */
          await win.webContents.executeJavaScript(`
            (() => {
              const nav = document.querySelector('nav[aria-label="活动栏"]')
              const btn = [...(nav ? nav.querySelectorAll('button') : [])].find(
                (b) => (b.getAttribute('aria-label') || '').includes('常用命令栏')
              )
              if (btn) btn.click()
            })()
          `)
          await settle(350)
          const railCollapsed = (await win.webContents.executeJavaScript(readRail)) as Record<
            string,
            unknown
          >
          await win.webContents.executeJavaScript(`
            (() => {
              const nav = document.querySelector('nav[aria-label="活动栏"]')
              const btn = [...(nav ? nav.querySelectorAll('button') : [])].find(
                (b) => (b.getAttribute('aria-label') || '').includes('常用命令栏')
              )
              if (btn) btn.click()
            })()
          `)
          await settle(350)
          const railExpanded = (await win.webContents.executeJavaScript(readRail)) as Record<
            string,
            unknown
          >
          const railToggleProbe = { railCollapsed, railExpanded }

          /*
           * 压测（用户明确要求「做完记得测一下 压测」）。
           *
           * 不看单次操作耗时，而是连续高频做最容易掉帧的三件事 ——
           * 命令中心开、命令中心关、活动栏切视图 —— 再统计每帧间隔。
           * 判据用 `maxFrameMs` / `longFrames`（>50ms 的帧数），不用平均帧率：
           * 平均会被空闲帧拉平，看不到尖峰，而「卡顿」正是尖峰。
           *
           * 采样器与驱动都放在页面里，但**由主进程逐步 await 驱动**，原因：
           * 第一版写成页面内 setInterval 自循环，一旦某次 toggle 抛错，
           * `step++` 就再也走不到，setInterval 永远跑下去 → 整个冒烟只能靠
           * 兜底超时收场（实测两次都是 timeout）。改成主进程驱动 + try/catch
           * 之后，任何一步失败都只是这一步记成 false，流程继续。
           */
          /*
           * 先确保窗口在前台，再开始采样。
           *
           * 踩过的坑：某次冒烟 stressProbe 返回 frames: 0 —— 窗口被别的实例遮住时
           * Chromium 会把 requestAnimationFrame 降到 0Hz，采样器一帧都收不到，
           * 报告里就出现「avgFrameMs: 0」，看着像完美，实际是根本没测。
           */
          win.show()
          win.focus()
          await settle(400)

          await win.webContents.executeJavaScript(`
            (() => {
              window.__stress = { frames: [], last: performance.now(), on: true }
              const tick = () => {
                if (!window.__stress.on) return
                const now = performance.now()
                window.__stress.frames.push(now - window.__stress.last)
                window.__stress.last = now
                requestAnimationFrame(tick)
              }
              requestAnimationFrame(tick)
            })()
          `)

          let stressActions = 0
          let stressErrors = 0
          /*
           * 用**真实输入**驱动，不用 store：
           * 生产构建里 `__lazy_test` 不存在（ZM_TEST 只在验证构建注入），
           * 第一版靠 store 驱动在打包版上 45 次全失败（errors:45, actions:0），
           * 压测等于没跑。改成点活动栏按钮 + 按 Ctrl+K，走的就是用户的路。
           */
          const views = ['connections', 'files', 'history', 'logs', 'tunnels']
          for (let i = 0; i < 45; i++) {
            if (i % 3 === 2) {
              const view = views[i % views.length]
              const ok = (await win.webContents.executeJavaScript(`
                (() => {
                  const btn = document.querySelector('[data-activity="${view}"]')
                  if (!btn) return false
                  btn.click()
                  return true
                })()
              `)) as boolean
              if (ok) stressActions++
              else stressErrors++
            } else {
              pressKey('K', ['control'])
              stressActions++
            }
            await settle(45)
          }

          const stressProbe = (await win.webContents.executeJavaScript(`
            (() => {
              window.__stress.on = false
              const f = window.__stress.frames.slice(2)
              const sum = f.reduce((a, b) => a + b, 0)
              return {
                frames: f.length,
                avgFrameMs: Math.round((sum / Math.max(1, f.length)) * 100) / 100,
                maxFrameMs: f.length ? Math.round(Math.max(...f) * 100) / 100 : 0,
                longFrames: f.filter((x) => x > 50).length,
                over100: f.filter((x) => x > 100).length
              }
            })()
          `)) as Record<string, unknown>
          stressProbe.actions = stressActions
          stressProbe.errors = stressErrors
          /*
           * frames 太少直接判压测无效。
           *
           * 不能只看 avgFrameMs —— 没采到帧时它是 0，报告上比任何优化都好听。
           * 45 个动作 × 45ms ≈ 2s，正常应该采到 ~120 帧（60Hz）。
           */
          stressProbe.valid = (stressProbe.frames as number) >= 30
          // 压测把浮层/视图留在了随机状态，复位到连接视图再往下走（同样走真实输入）
          pressKey('Escape')
          await settle(200)
          await win.webContents.executeJavaScript(`
            (() => {
              const btn = document.querySelector('[data-activity="connections"]')
              if (btn) btn.click()
            })()
          `)
          await settle(300)

          /*
           * 窗口图标探针。
           *
           * 图标加载失败在 Electron 里是静默的：路径写错不会抛错，只会安静地退回默认
           * 白图标（Win11 浅色任务栏上几乎看不见）。所以这里断言四件事 ——
           *   1. pickIconPath() 能解析出路径（iconPath 非空）
           *   2. 该文件确实存在且非空（iconBytes > 0）
           *   3. 打包版里能读到 extraResources 拷出来的那份（fromResources）
           *   4. **图标文件里真的有小尺寸**（icoSizes 含 16/24/32）
           *
           * 第 4 条是这次「任务栏仍发白」的根因断言。之前只给 build/icon.png，
           * electron-builder 转出的 ico 里只有一条 256×256 PNG 记录，任务栏要 24/32px
           * 时只能让 GDI 缩 256 的图，白边把绿色糊掉 —— 光看路径存在是查不出来的。
           */
          const iconPath = pickIconPath()
          const icoSizes: number[] = []
          if (iconPath && iconPath.endsWith('.ico')) {
            const head = readFileSync(iconPath).subarray(0, 6 + 16 * 32)
            const count = head.length >= 6 ? head.readUInt16LE(4) : 0
            for (let i = 0; i < count && 6 + i * 16 < head.length; i++) {
              const o = 6 + i * 16
              const w = head[o] === 0 ? 256 : head[o]
              icoSizes.push(w)
            }
          }
          const iconProbe = {
            iconPath: iconPath ?? null,
            iconBytes: iconPath && existsSync(iconPath) ? statSync(iconPath).size : 0,
            fromResources: iconPath ? iconPath.startsWith(process.resourcesPath ?? '\u0000') : false,
            icoSizes,
            smallSizesOk: [16, 24, 32].every((n) => icoSizes.includes(n)),
            packaged: app.isPackaged
          }

          await clickActivity('连接')
          await settle(250)

          finish(() =>
            report('ok', {
              screenshot: list.shot,
              bytes: list.bytes,
              commandCenter: center,
              commandCenterQuery: filtered,
              perfProbe,
              expandProbe,
              commandCenterOpenMs: openMs,
              wallProbe,
              listProbe,
              afterClose: closed,
              settings,
              layoutSection,
              layoutShot,
              panelRecent: filtered2,
              panelRecentClick: recentOk,
              panelWallProbe,
              leftovers,
              sharpProbe,
              sharpRetry,
              keyboardRun,
              keyboardShot,
              shellProbe,
              tabStripProbe,
              tabStripShot,
              tabsScrollProbe,
              tabsScrollShot,
              visualProbe,
              switchProbe,
              switched,
              collapseProbe,
              collapsed,
              filesProbe,
              filesShot,
              keepAliveProbe,
              resizerProbe,
              wallColsProbe,
              railToggleProbe,
              iconProbe,
              stressProbe,
              wallColsShot,
              dragged
            })
          )
        } catch (err) {
          finish(() => report('capture-failed', { error: String(err) }))
        }
      })()
    }, 2500)
  })

  win.webContents.on('did-fail-load', (_e, code, desc) => {
    finish(() => report('load-failed', { code, desc }))
  })

  // 兜底：整条交互回归（含多次截图与拖拽等待）约 20s，留足余量
  /*
   * 兜底超时。原来是 60s —— 加上压测（约 3s）之后不够用了，偶尔会打 timeout
   * 而不是真正的失败。放宽到 150s：这个值只需要「明显大于正常流程耗时」，
   * 卡死时仍然能在两分半内退出，不至于让 CI 无限等。
   */
  setTimeout(() => finish(() => report('timeout', { reason: '冒烟流程未在 150s 内完成' })), 150000)
}

/**
 * 窗口图标路径（见 createWindow 里的注释）。
 * 依次探测打包版的两个位置与开发模式的仓库路径，都不存在时返回 undefined，
 * 让 Electron 走自己的默认行为（至少不会因为传了坏路径而抛错）。
 */
function pickIconPath(): string | undefined {
  /*
   * .ico 优先，.png 兜底。
   *
   * 为什么要 ico：Windows 任务栏在 125%/150% 缩放比下要 20/24/32/40px 的图标，
   * 而一张 256×256 的 png 交给系统缩，GDI 的双线性会把圆角边缘的白边抹开，
   * 蓝色/绿色的小图标缩完常常整块发白 —— 这正是「图标明明是绿的，任务栏却白」
   * 的来源。ico 里带 16/24/32/48/64/128/256 七个尺寸，系统按需挑，不必缩。
   */
  const candidates = [
    join(process.resourcesPath ?? '', 'icon.ico'),
    join(__dirname, '../../resources/icon.ico'),
    join(app.getAppPath(), 'resources/icon.ico'),
    join(process.resourcesPath ?? '', 'icon.png'),
    join(__dirname, '../../resources/icon.png'),
    join(app.getAppPath(), 'resources/icon.png')
  ]
  for (const p of candidates) {
    if (p && existsSync(p)) return p
  }
  return undefined
}

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
      onStatus: (sessionId, status, error) =>
        getMainWindow()?.webContents.send(IPC.EVT_SESSION_STATUS, { sessionId, status, error }),
      onLatency: (sessionId, ms) =>
        getMainWindow()?.webContents.send(IPC.EVT_SESSION_LATENCY, { sessionId, ms })
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
      if (
        event.status === 'running' ||
        event.status === 'pending' ||
        event.status === 'paused'
      ) {
        activeTransfers.set(event.taskId, {
          transferred: event.transferred,
          total: event.total
        })
      } else {
        activeTransfers.delete(event.taskId)
      }
      updateTaskbarProgress()
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

    netScanner.setProgressHandler((event) => {
      getMainWindow()?.webContents.send(IPC.EVT_DISCOVER_PROGRESS, event)
    })

    // 会话关闭时清理其上的 SFTP 通道、运行中的隧道与监控
    sessionManager.setOnClosed((sessionId) => {
      sftpManager.clearSession(sessionId)
      tunnelManager.onSessionClosed(sessionId)
      metricsSampler.onSessionClosed(sessionId)
    })

    registerAllIpc()
    log('ipc registered')
    bootLog('ipc registered')

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
    if (process.platform !== 'darwin') app.quit()
  })
}
