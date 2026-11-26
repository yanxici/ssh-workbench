import type * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Columns2,
  Fingerprint,
  Loader2,
  PlugZap,
  RefreshCw,
  Rows2,
  Search,
  Wrench,
  X,
  XCircle
} from 'lucide-react'
import type { SessionUi } from '@/stores/sessionStore'
import { terminalRegistry, useSessionStore } from '@/stores/sessionStore'
import { applyOsc7, feedTerminalInput, useCwdStore } from '@/stores/cwdStore'
import { resolveDark, useSettingsStore } from '@/stores/settingsStore'
import { matchShortcut, resolveShortcuts } from '@/lib/shortcuts'
import { getXtermTheme } from '@/theme/colorThemes'
import { ContextMenu, useContextMenu, type MenuEntry } from '@/components/ui'
import { call } from '@/lib/ipc'
import { useConnectionStore } from '@/stores/connectionStore'
import { useToastStore } from '@/stores/toastStore'
import { useSplitStore } from '@/stores/splitStore'
import { MAX_PANES, countLeaves, leafIds } from '@/lib/paneTree'
import { ensureZmodem, detachZmodem, bytesToBase64, requestZmodemConfirm } from '@/lib/zmodem'
import { writeSessionData } from '@/lib/highlightRuntime'
import { isCanvasFontApplied } from '@/lib/canvasFont'
import { isImeComposing } from '@/lib/ime'
import { hasOpenOverlay } from '@/lib/overlayKeys'
import { useI18n } from '@/i18n'
import {
  decideRightClickAction,
  decideTerminalCopy,
  extractTerminalBuffer,
  stepTempFontSize
} from '@/lib/terminalUx'
import { useTrzszOf } from '@/stores/trzszStore'
import { countDraggedFiles, decideDropAction, type DropAction } from '@/lib/terminalDrop'
import { resolveUploadDir } from '@/lib/uploadDir'
import { invalidateDir } from '@/lib/dirCache'
import { analyzePaste, type PasteAnalysis } from '@/lib/pasteGuard'
import { paneOwnerOf } from '@/lib/paneRegistry'
import { resolveSyncTargets } from '@/lib/tabUnread'
import { PasteConfirmDialog } from './PasteConfirmDialog'
import { SerialBootBar } from './SerialBootBar'

/**
 * 重新 fit 一屏，并把新尺寸告诉远端 PTY。
 *
 * 只调 fit.fit() 是不够的：fit 改的是本地 cols/rows，远端还按旧尺寸排版，
 * vim / htop / tmux 会画出半屏错位。而 resize IPC 原本只挂在 ResizeObserver
 * 上 —— 改字号、拖分隔条松手这两种场景容器像素经常一点没变，
 * ResizeObserver 根本不会再触发，于是本地重排了、远端没跟上。
 * 所有「补一次 fit」的地方都必须走这里。
 */
function fitAndSyncSize(sessionId: string): void {
  const entry = terminalRegistry.get(sessionId)
  if (!entry) return
  /*
   * 隐藏的标签必须直接跳过，**不能**指望 fit.fit() 抛异常。
   *
   * 后台标签是靠 style.display = 'none' 藏起来的，而它的父元素是
   * w-full h-full（width/height: 100%）。addon-fit 的 proposeDimensions()
   * 此时读 getComputedStyle 得到的是 "100%"，parseInt 出来是 100 —— 既不是
   * NaN 也不抛错，于是它「算出」一个约 10×5 的尺寸，下面的 resize IPC 就
   * 把某个后台标签的远端 PTY 缩成 10 列。用户在 A 标签拖一下分隔条或改个
   * 字号，B 标签里跑着的 vim/htop 就被压花，切回去一片错乱。
   * 判据与 doFit 一致：拿真实像素，为 0 就是没显示。
   */
  const parent = entry.term.element?.parentElement
  if (!parent || parent.clientWidth === 0 || parent.clientHeight === 0) return
  try {
    entry.fit.fit()
  } catch {
    /* 极端时序下（容器正在被移除）fit 仍可能抛，忽略即可 */
    return
  }
  if (entry.term.cols > 0 && entry.term.rows > 0) {
    useSessionStore.getState().setSize(sessionId, entry.term.cols, entry.term.rows)
    void window.api.session.resize(sessionId, entry.term.cols, entry.term.rows)
  }
}

function ReconnectButton({ sessionId }: { sessionId: string }): React.JSX.Element {
  return (
    <button
      className="btn btn-primary mt-1 h-7 px-3 text-xs"
      onClick={() => useSessionStore.getState().reconnect(sessionId)}
    >
      <RefreshCw size={12} />
      重新连接
      <span className="text-2xs opacity-70">（或按 Enter）</span>
    </button>
  )
}

/**
 * 指纹冲突时的一键修复：重新探测设备当前指纹 → 写入已知主机 → 重连。
 *
 * 设备重装 / 固件升级后整台设备都连不上，而错误文案里让人去设置里翻记录，
 * 现场太绕；这里直接把动作放在报错的正下方。
 */
function UpdateHostKeyButton({ session }: { session: SessionUi }): React.JSX.Element | null {
  const [busy, setBusy] = useState(false)
  const connection = useConnectionStore((s) =>
    s.connections.find((c) => c.id === session.connectionId)
  )
  if (!connection) return null
  return (
    <button
      className="btn mt-1 h-7 px-3 text-xs"
      disabled={busy}
      title={`重新探测 ${connection.host}:${connection.port} 的指纹并写入本地记录`}
      onClick={() => {
        void (async () => {
          setBusy(true)
          try {
            const probe = await call(
              window.api.knownHosts.probe(connection.host, connection.port),
              { errorTitle: `无法获取 ${connection.host}:${connection.port} 的指纹` }
            )
            if (!probe) return
            const saved = await call(
              window.api.knownHosts.refresh(connection.host, connection.port, probe.fingerprint),
              { errorTitle: '更新主机指纹失败' }
            )
            if (!saved) return
            useToastStore.getState().push({
              kind: 'success',
              title: '已更新主机指纹',
              detail: '正在重新连接…'
            })
            useSessionStore.getState().reconnect(session.id)
          } finally {
            setBusy(false)
          }
        })()
      }}
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : <Fingerprint size={12} />}
      更新主机指纹并重连
    </button>
  )
}

/**
 * 报错是否属于「算法协商失败」这类需要开老算法兼容的故障。
 *
 * 串口会话一律排除：它跟 SSH 算法协商没有交集（见设计文档的串口隔离约束）。
 * kind 在旧数据里可能缺省为 undefined（历史连接没有这个字段），
 * 那时按 ssh 处理 —— 所以判据写成「不是串口」而不是「等于 ssh」。
 */
function needsLegacyAlgorithms(session: SessionUi): boolean {
  if (session.kind === 'serial') return false
  return /算法协商失败|no matching|Unable to negotiate/i.test(session.error ?? '')
}

/**
 * 算法协商失败的一键修复：给这条连接打上 legacyAlgorithms 再重连。
 *
 * 现场遇到的形态是老固件只认 group1-sha1 / 3des-cbc，报错文案却是英文原文，
 * 让人去编辑器里翻开关太绕；这里把动作放在报错正下方，和上面的指纹按钮同款。
 *
 * 凭据必须原样保留：save 的入参里 password / passphrase / 代理密码全部写
 * undefined，交给 saveConnection 的「未提供即保留」语义（这是设计文档
 * Review Focus #2 的硬约束，改成空串就会把用户保存的密码清掉）。
 */
function EnableLegacyAlgoButton({
  session
}: {
  session: SessionUi
}): React.JSX.Element | null {
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const connection = useConnectionStore((s) =>
    s.connections.find((c) => c.id === session.connectionId)
  )
  // 已经开过的连接不再显示，避免用户点第二次时困惑
  if (!connection || connection.legacyAlgorithms) return null
  return (
    <button
      className="btn mt-1 h-7 px-3 text-xs"
      disabled={busy}
      title={t('terminal.legacyAlgo.enableAndReconnect')}
      onClick={() => {
        void (async () => {
          setBusy(true)
          try {
            const saved = await useConnectionStore.getState().save({
              ...connection,
              legacyAlgorithms: true,
              password: undefined,
              passphrase: undefined,
              proxy: connection.proxy
                ? { ...connection.proxy, password: undefined }
                : undefined
            })
            if (!saved) return
            useToastStore.getState().push({
              kind: 'success',
              title: t('terminal.legacyAlgo.enabledToast')
            })
            useSessionStore.getState().reconnect(session.id)
          } finally {
            setBusy(false)
          }
        })()
      }}
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
      {t('terminal.legacyAlgo.enableAndReconnect')}
    </button>
  )
}

/**
 * 同步输入：把「一次按键该发给谁」算出来并投递。
 *
 * 三个必守的边界（都是设计文档 Review Focus #5 点名的地方）：
 *   1. 只在**当前标签**内部广播 —— 目标集合来自这棵 pane 树的叶子，不是全部会话；
 *   2. 只发给 connected 的窗格；自己永远在集合里（哪怕自己正断着，也不影响别人）；
 *   3. 单目标时老老实实走 session.write，不为了「统一」多开一条广播路径 ——
 *      广播在单目标下语义相同，但多一次 IPC 参数编解码，而这是每一次按键。
 *
 * 用 getState() 现取而不是闭包捕获：这个函数会被注册进 init effect
 * （依赖只有 sessionId），捕获到的 syncByTab / trees 会一直是首次渲染那份，
 * 用户开了同步开关却要重开标签才生效 —— 那种 bug 在真机上极难复现。
 */
function sendTerminalInput(sessionId: string, data: string): void {
  const split = useSplitStore.getState()
  const owner = paneOwnerOf(sessionId)
  const targets = resolveSyncTargets(
    split.trees[owner],
    split.syncByTab[owner] === true,
    useSessionStore.getState().sessions,
    sessionId
  )
  if (targets.length > 1) {
    void window.api.session.broadcast(targets, data)
    return
  }
  void window.api.session.write(sessionId, data)
}

/**
 * 终端视图：一个 SessionUi 对应一个 xterm 实例。
 * - 实例挂到 terminalRegistry，会话数据事件由 App 层写入；
 * - 容器尺寸变化（含标签切换、窗口缩放）自动 fit 并同步 cols/rows 到主进程；
 * - Ctrl+F 打开搜索条，右键菜单提供 复制/粘贴/全选/清屏/查找。
 */
export function TerminalView({
  session,
  active
}: {
  session: SessionUi
  active: boolean
}): React.JSX.Element {
  const sessionId = session.id
  const containerRef = useRef<HTMLDivElement>(null)
  const tempFontSizeRef = useRef<number | null>(null)
  const lastGlobalFontSizeRef = useRef<number>(
    useSettingsStore.getState().settings.terminal.fontSize
  )
  const { t } = useI18n()

  const [searchOpen, setSearchOpen] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [searchCount, setSearchCount] = useState<{ index: number; count: number }>({
    index: -1,
    count: 0
  })

  const { menu, openMenu, closeMenu } = useContextMenu<'context'>()

  /* 待确认的多行粘贴；非空时渲染确认框 */
  const [pasteRequest, setPasteRequest] = useState<{
    text: string
    analysis: PasteAnalysis
  } | null>(null)

  /**
   * 三处粘贴入口（快捷键 / 右键菜单 / 右键直接粘贴）的唯一汇合点。
   *
   * 单行内容走 else 分支，与改造前的行为逐字节一致：不弹窗、不加延时、
   * 不抢焦点。只有 pasteGuard 判定需要确认时才会拦下来 —— 拦截本身必须
   * 便宜，因为它挂在每一次 Ctrl+V 上。
   *
   * 设置用 getState() 现取而非闭包捕获：快捷键处理器注册在 init effect 里
   * （只依赖 sessionId），捕获的 settings 会一直是首次渲染那份，用户改了
   * 「多行确认」开关后不重启终端就永远不生效。
   */
  const requestPaste = useCallback(
    (raw: string): void => {
      if (!raw) return
      const { terminal, dangerPatterns } = useSettingsStore.getState().settings
      const analysis = analyzePaste(raw, dangerPatterns, terminal.confirmMultilinePaste !== false)
      if (!analysis.shouldConfirm) {
        /*
         * 这里刻意只写本地 xterm，不自己再广播一遍：term.paste() 会触发
         * onData，而那条路已经统一走 sendTerminalInput —— 同步开启时自然
         * 跟着广播。在这里补一次广播等于每个字符发两遍。
         */
        const entry = terminalRegistry.get(sessionId)
        entry?.term.paste(raw)
        entry?.term.focus()
        return
      }
      setPasteRequest({ text: raw, analysis })
    },
    [sessionId]
  )

  /* ---------- 初始化（每个会话一次） ---------- */
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const { settings } = useSettingsStore.getState()
    const term = new Terminal({
      fontFamily: settings.terminal.fontFamily,
      fontSize: settings.terminal.fontSize,
      lineHeight: settings.terminal.lineHeight,
      cursorStyle: settings.terminal.cursorStyle,
      cursorBlink: settings.terminal.cursorBlink,
      scrollback: settings.terminal.scrollback,
      theme: getXtermTheme(settings.colorTheme, resolveDark(settings.theme)),
      allowProposedApi: true,
      macOptionIsMeta: true
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    /*
     * 必须自己给 linkHandler。
     *
     * 无参默认处理器是 `const t = window.open(); ...; t.location.href = uri` ——
     * 先开空白窗再改地址，Electron 的 setWindowOpenHandler 收到的是
     * about:blank，被 isWebUrl() 判否后 deny，window.open() 返回 null，
     * 于是终端里所有链接点击都是死的（只在控制台留一句警告）。
     * 直接把真实 URL 交出去，主进程才能校验并 shell.openExternal。
     */
    term.loadAddon(
      new WebLinksAddon((_event, uri) => {
        try {
          const parsed = new URL(uri)
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            window.open(parsed.href, '_blank', 'noopener,noreferrer')
          }
        } catch {
          /* 非法 URL 直接忽略 */
        }
      })
    )
    term.open(el)
    /*
     * 渲染后端：**默认 DOM，WebGL 改为可选**（settings.experimental.terminalRenderer）。
     *
     * 历史：v2.1.0 默认 WebGL 后，本机（Intel UHD + ANGLE D3D11）字形明显小于格子 ——
     * 格子 32~33px 不变，但 `MWMWMWMW` 墨迹只有 27~34px，`i`/`l` 细笔只剩 5~7px。
     * v2.1.1 先把默认翻回 DOM 绕开；v2.1.2 查清真因是 addon 拼 canvas font 时留下
     * 前导空格，Chromium 不 trim 就静默退回 10px sans-serif（详见 lib/canvasFont.ts）。
     * 现在字问题已修，默认仍保守留在 DOM；想用 WebGL 可在设置里切，挂载前会自检。
     *
     * 为什么必须 try/catch 而不是查能力位：addon 在构造/激活时会自己检测 WebGL2 上下文，
     * 失败有两种表现 —— 构造抛错，或构造成功但上下文创建失败（此时 onContextLoss 才触发）。
     * 只判 navigator.gpu 之类的前置条件必然漏掉后一种。
     *
     * 上下文丢失（驱动重置、远程桌面切换显卡）也要回落：webgl 的 canvas 一旦 loss，
     * 终端就成了白板，必须 dispose 掉让 DOM 渲染器接管。
     *
     * 最后一道自检（isCanvasFontApplied）解决的是另一类「静默降级」：
     * addon 拼字体串时非斜体分支会留下前导空格（" normal 15px ..."），
     * Chromium 的 canvas font 解析器不 trim，整串被判非法后 setter 静默失败，
     * 图集就按初始的 10px sans-serif 光栅化 —— 格子按配置算、字却只有 10px，
     * 观感是「笔画细、字距变宽」。lib/canvasFont.ts 已经修掉这次的坑，
     * 但字体族名、系统缺字体、将来 addon 换拼法都可能再次触发，
     * 所以挂载前先实测一次：字形没按配置生效就干脆不挂 WebGL，用户永远看不到那块「小字」。
     */
    const renderer = settings.experimental?.terminalRenderer ?? 'dom'
    /* 先做字体自检，再决定要不要挂 WebGL：自检不过就没必要让用户先看一眼小字 */
    const canvasFontOk = isCanvasFontApplied(
      settings.terminal.fontFamily,
      settings.terminal.fontSize
    )
    let webglAttached = false
    if (renderer !== 'dom' && canvasFontOk) {
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => {
          /* 上下文丢失后立即卸载 addon：xterm 会自动回到 DOM 渲染器 */
          try { webgl.dispose() } catch { /* 已释放 */ }
        })
        term.loadAddon(webgl)
        webglAttached = true
      } catch {
        /* 无 WebGL2 / 软件渲染 / 驱动限制：静默回落 DOM，不打扰用户 */
        webglAttached = false
      }
    }
    if (!webglAttached) {
      // DOM 渲染器无需额外 addon，xterm 默认即是；这里仅记录一次便于诊断
      console.info(
        renderer === 'dom'
          ? '[terminal] 按设置使用 DOM 渲染器（默认）'
          : canvasFontOk
            ? '[terminal] WebGL 不可用，回落到 DOM 渲染'
            : '[terminal] canvas 未应用终端字体，回落到 DOM 渲染'
      )
    }

    const doFit = (): void => {
      if (!containerRef.current || containerRef.current.clientWidth === 0) return
      try {
        fit.fit()
      } catch {
        return
      }
      if (term.cols > 0 && term.rows > 0) {
        useSessionStore.getState().setSize(sessionId, term.cols, term.rows)
        void window.api.session.resize(sessionId, term.cols, term.rows)
      }
    }

    // fit 合帧：ResizeObserver 在拖动窗口时会高频触发，若每次都新排一个 rAF
    // 而不取消上一个，回调会无上限积压（每个都做一次 fit + IPC 往返）。
    // 这里保留唯一的待执行句柄，重复触发只覆盖，确保每帧最多 fit 一次。
    let fitRaf = 0
    const scheduleFit = (): void => {
      if (fitRaf) return
      fitRaf = requestAnimationFrame(() => {
        fitRaf = 0
        /*
         * 拖分隔条期间不 fit。
         *
         * 拖拽时每帧容器宽度都在变，ResizeObserver 跟着每帧触发；
         * 而 fit.fit() 会让 xterm 重排整屏（换行位置全变、回滚区重建），
         * 拖起来画面剧烈抖动，每次 fit 还带一次 resize IPC 往返。
         * 松手时 splitStore 把 draggingSplit 置 false 并 refitTick+1，
         * 由下面那个 effect 统一补一次 fit。
         */
        if (useSplitStore.getState().draggingSplit) return
        doFit()
      })
    }

    scheduleFit()
    const resizeObserver = new ResizeObserver(scheduleFit)
    resizeObserver.observe(el)

    // 输入 -> 主进程
    const dataDisposer = term.onData((data) => {
      const st = useSessionStore.getState().sessions.find((x) => x.id === sessionId)?.status
      if (st === 'disconnected' || st === 'error') {
        // 断开状态下按回车直接重连
        if (data === '\r') useSessionStore.getState().reconnect(sessionId)
        return
      }
      /*
       * 顺手把用户敲的这一行喂给 cwd 追踪器（见 @/lib/shellCwd）。
       * 放在发送之前：侧栏跟随的目标以「用户想去的目录」为准，
       * 不必等远端命令真的执行完 —— 失败了侧栏也停下而已，无害。
       */
      feedTerminalInput(sessionId, data)
      sendTerminalInput(sessionId, data)
    })

    /*
     * OSC 7：远端 shell 配了 shell-integration 时会上报真实 cwd，
     * 用来校正上面那层本地解析。没配的机器上永远收不到，也就零成本。
     */
    const oscDisposer = term.parser.registerOscHandler(7, (payload) => {
      applyOsc7(sessionId, payload)
      return true
    })

    // 搜索计数
    const searchResultDisposer = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setSearchCount({ index: resultIndex, count: resultCount })
    })

    /*
     * 快捷键：复制/粘贴/搜索。
     * 组合键一律从 settingsStore 现取，不再写死 —— 设置页把它们列为可自定义项，
     * 之前硬编码导致「改了没反应」。用 getState() 取而非闭包捕获 settings，
     * 这样用户改完键位立刻生效，不必重建终端（init effect 只依赖 sessionId）。
     */
    term.attachCustomKeyEventHandler((e) => {
      /*
       * 有弹层时一律让 xterm 别管（必须排在 e.type !== 'keydown' 之前）：
       * 否则 keydown 返回 false 不设 _keyDownHandled，随后的 keypress/keyup 仍会进 xterm
       * 把可打印字符/Enter 漏发给远端 SSH 或重新把焦点拉回终端。
       */
      if (hasOpenOverlay()) return false
      if (e.type !== 'keydown') return true
      const map = resolveShortcuts(useSettingsStore.getState().settings.shortcuts)
      const copyAction = decideTerminalCopy(e, map.terminalCopy, term.hasSelection())
      if (copyAction === 'copy') {
        e.preventDefault()
        const selection = term.getSelection()
        if (selection) void call(window.api.clip.write(selection), { silent: true })
        return false
      }
      if (copyAction === 'passthrough') return true
      if (copyAction === 'noop') {
        e.preventDefault()
        return false
      }
      if (matchShortcut(e, map.terminalPaste)) {
        e.preventDefault()
        void call(window.api.clip.read(), { silent: true }).then((text) => {
          if (text) requestPaste(text)
        })
        return false
      }
      if (matchShortcut(e, map.terminalSearch)) {
        e.preventDefault()
        setSearchOpen(true)
        return false
      }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === '0') {
        if (tempFontSizeRef.current !== null) {
          e.preventDefault()
          tempFontSizeRef.current = null
          term.options.fontSize = useSettingsStore.getState().settings.terminal.fontSize
          scheduleFit()
          return false
        }
      }
      return true
    })

    // Copy-on-select (debounced to avoid spamming clipboard during drag)
    let copyTimer: ReturnType<typeof setTimeout> | undefined
    const selectionDisposer = term.onSelectionChange(() => {
      if (useSettingsStore.getState().settings.terminal.copyOnSelect !== true) return
      if (copyTimer) clearTimeout(copyTimer)
      copyTimer = setTimeout(() => {
        copyTimer = undefined
        if (useSettingsStore.getState().settings.terminal.copyOnSelect !== true) return
        const selection = term.getSelection()
        if (selection) void call(window.api.clip.write(selection), { silent: true })
      }, 120)
    })

    // Per-terminal temporary font zoom via Ctrl+wheel (capture phase so TUI apps do not swallow it)
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      e.stopPropagation()
      const base =
        tempFontSizeRef.current ?? useSettingsStore.getState().settings.terminal.fontSize
      const next = stepTempFontSize(base, e.deltaY)
      if (next === base) return
      tempFontSizeRef.current = next
      term.options.fontSize = next
      scheduleFit()
    }
    el.addEventListener('wheel', onWheel, { passive: false, capture: true })

    /*
     * 接管原生粘贴。
     *
     * Ctrl+V 走的是上面那个 keydown 处理器（已经过 requestPaste），但
     * Shift+Insert、鼠标右键系统菜单、输入法工具栏走的都是浏览器原生 paste ——
     * xterm 自己监听 textarea 的 paste 直接写进终端，多行 / 危险命令确认框
     * 全程被绕过。这里在捕获阶段拦下来，把所有来源统一送回唯一入口。
     *
     * 用 capture 且挂在容器上：textarea 是 xterm 内部创建的，我们拿不到稳定引用；
     * 捕获阶段会先经过容器，抢在 xterm 的处理器之前。
     */
    const onNativePaste = (e: ClipboardEvent): void => {
      const text = e.clipboardData?.getData('text') ?? ''
      if (!text) return
      e.preventDefault()
      e.stopPropagation()
      requestPaste(text)
    }
    el.addEventListener('paste', onNativePaste, { capture: true })

    terminalRegistry.set(sessionId, { term, fit, search })

    // ZMODEM：挂上 Sentry，之后本会话的输出统一经它转发
    // （协议帧被拦下，普通输出回落到 term.write）
    ensureZmodem(sessionId, {
      // 走统一写入口：ZMODEM 转发的普通输出也要经过高亮（命中行才染色）
      write: (text) => writeSessionData(sessionId, term, text),
      send: async (bytes) => {
        // 协议控制字节是二进制，必须走专用通道；
        // session.write 会按 UTF-8 编码，>127 的字节会失真。
        const res = await window.api.zmodem.sendBytes(sessionId, bytesToBase64(bytes))
        return res.ok ? res.data : { ok: false, reason: res.error }
      },
      confirm: (direction) => requestZmodemConfirm(sessionId, direction),
      afterTransfer: () => {
        // 传输结束后补换行：远端 sz/rz 退出时不补 \r\n，
        // 提示符会与最后一行进度挤在一起。
        term.write('\r\n')
      }
    })

    return () => {
      terminalRegistry.delete(sessionId)
      detachZmodem(sessionId)
      if (copyTimer) clearTimeout(copyTimer)
      selectionDisposer.dispose()
      el.removeEventListener('wheel', onWheel, { capture: true })
      el.removeEventListener('paste', onNativePaste, { capture: true })
      cancelAnimationFrame(fitRaf)
      resizeObserver.disconnect()
      dataDisposer.dispose()
      oscDisposer.dispose()
      searchResultDisposer.dispose()
      term.dispose()
    }
    /*
     * requestPaste 是 useCallback([sessionId])，与这里的依赖同源，
     * 列进来不会导致终端重建；不列则会捕获首次渲染那份闭包。
     */
  }, [sessionId, requestPaste])

  /* ---------- 设置变化：字体 / 主题实时生效 ---------- */
  const terminalPrefs = useSettingsStore((s) => s.settings.terminal)
  const themeMode = useSettingsStore((s) => s.settings.theme)
  const colorTheme = useSettingsStore((s) => s.settings.colorTheme)
  useEffect(() => {
    const entry = terminalRegistry.get(sessionId)
    if (!entry) return
    if (terminalPrefs.fontSize !== lastGlobalFontSizeRef.current) {
      lastGlobalFontSizeRef.current = terminalPrefs.fontSize
      tempFontSizeRef.current = null
    }
    entry.term.options.fontFamily = terminalPrefs.fontFamily
    entry.term.options.fontSize = tempFontSizeRef.current ?? terminalPrefs.fontSize
    entry.term.options.lineHeight = terminalPrefs.lineHeight
    entry.term.options.cursorStyle = terminalPrefs.cursorStyle
    entry.term.options.cursorBlink = terminalPrefs.cursorBlink
    entry.term.options.scrollback = terminalPrefs.scrollback
    entry.term.options.theme = getXtermTheme(colorTheme, resolveDark(themeMode))
    // 不带 cancel 的 rAF 在设置连续变更（拖字号滑块）时会积压一堆待执行回调
    const raf = requestAnimationFrame(() => fitAndSyncSize(sessionId))
    return () => cancelAnimationFrame(raf)
  }, [sessionId, terminalPrefs, themeMode, colorTheme])

  /* ---------- 分隔条松手后统一补一次 fit ---------- */
  const refitTick = useSplitStore((s) => s.refitTick)
  useEffect(() => {
    if (refitTick === 0) return
    const raf = requestAnimationFrame(() => fitAndSyncSize(sessionId))
    return () => cancelAnimationFrame(raf)
  }, [refitTick, sessionId])

  /* ---------- 标签切换后重新 fit ---------- */
  useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => {
      const entry = terminalRegistry.get(sessionId)
      if (!entry) return
      fitAndSyncSize(sessionId)
      if (!hasOpenOverlay()) entry.term.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [active, sessionId])

  /* ---------- 搜索 ---------- */
  /*
   * 必须带 decorations 调用 findNext/findPrevious。
   *
   * @xterm/addon-search 在 options.decorations 缺省时会直接短路返回，
   * 既不画匹配括号也不派发 onDidChangeResults —— 于是查找框永远显示「无结果」，
   * 命中了也看不见。颜色用半透明，深浅两套主题下都不至于糊掉文字。
   */
  const searchOptions = {
    caseSensitive: false,
    decorations: {
      matchBackground: 'rgba(255, 196, 0, 0.35)',
      matchOverviewRuler: '#ffc400',
      activeMatchBackground: 'rgba(255, 122, 0, 0.65)',
      activeMatchColorOverviewRuler: '#ff7a00'
    }
  }
  const runSearch = (text: string, backwards = false): void => {
    const entry = terminalRegistry.get(sessionId)
    if (!entry) return
    if (!text) {
      /* 清空输入时把高亮一起收掉，别留一块黄底在屏幕上 */
      entry.search.clearDecorations()
      setSearchCount({ index: -1, count: 0 })
      return
    }
    if (backwards) entry.search.findPrevious(text, searchOptions)
    else entry.search.findNext(text, searchOptions)
  }

  const closeSearch = (): void => {
    setSearchOpen(false)
    terminalRegistry.get(sessionId)?.search.clearDecorations()
    terminalRegistry.get(sessionId)?.term.focus()
  }

  /* ---------- P1-1 拖放上传：默认 SFTP 直传当前目录，Alt 临时切 trzsz ---------- */
  const trzsz = useTrzszOf(sessionId)
  const canTrzsz = session.kind !== 'serial' && session.status === 'connected'
  const dropCwd = useCwdStore((s) => s.path[sessionId] ?? '')

  /**
   * 拖放时提示条的状态。
   *
   * 拖拽过程里 dragOver 会以每秒几十次的频率触发，所以只在 action / 目标目录
   * 真正变化时才 setState —— 否则 React 会把整棵终端树重渲染几十遍。
   */
  const [dropHint, setDropHint] = useState<{
    action: DropAction
    files: number
    dir: string
  } | null>(null)

  const resolveDropAction = (
    e: React.DragEvent<HTMLDivElement>,
    fileCount: number
  ): DropAction =>
    decideDropAction({
      kind: session.kind ?? 'ssh',
      status: session.status,
      fileCount,
      prefMode: terminalPrefs.dropUploadMode ?? 'sftp',
      altKey: e.altKey
    })

  /**
   * 把拖进来的若干条路径交给主进程上传。
   *
   * 路径必须用 webUtils.getPathForFile 取（Electron 32 起 File.path 已移除），
   * 而且要在渲染进程侧取 —— 主进程拿到的 File 不是同一个对象。
   * 文件内容一个字节都不进 IPC：主进程按路径自己 readFile。
   */
  const startUpload = (paths?: string[]): void => {
    if (paths && paths.length === 0) return
    void call(
      paths ? window.api.trzsz.upload(sessionId, paths) : window.api.trzsz.upload(sessionId),
      {
        errorTitle: 'trzsz 上传失败'
      }
    )
  }

  const dropPaths = (e: React.DragEvent<HTMLDivElement>): string[] => {
    const files = Array.from(e.dataTransfer?.files ?? [])
    return files.map((f) => window.api.filePathOf(f)).filter((p) => Boolean(p))
  }

  /**
   * SFTP 直传：目标目录取终端 cwd。
   *
   * cwd 可能还没被 OSC7 报上来（刚连上、或远端 shell 不报），这时才退到
   * resolveUploadDir（记住的上次目录 → home）。宁可多发一次 home 查询，
   * 也不要默认往 '/' 上传 —— 那是最容易把文件丢到找不着的地方的做法。
   *
   * keepRoot: true 与 SFTP 面板拖放保持一致：拖一个文件夹进来时保留它本身
   * 那一层目录名，否则多个文件会被摊平到 cwd 里混在一起。
   */
  const uploadViaSftp = async (paths: string[]): Promise<void> => {
    const target = dropCwd || (await resolveUploadDir(sessionId))
    if (!target) {
      useToastStore.getState().push({ kind: 'error', title: t('terminal.drop.error') })
      return
    }
    const done = await call(window.api.sftp.upload(sessionId, paths, target, { keepRoot: true }), {
      silent: true
    })
    if (!done) {
      useToastStore.getState().push({ kind: 'error', title: t('terminal.drop.error') })
      return
    }
    /* 传完立刻让目录缓存失效：不失效的话用户在文件面板里看到的还是旧列表 */
    invalidateDir(sessionId, target)
    useToastStore.getState().push({
      kind: 'success',
      title: t('terminal.drop.done', { count: done.length, dir: target })
    })
  }

  const runDropAction = (action: DropAction, paths: string[]): void => {
    if (action === 'trzsz') startUpload(paths)
    else if (action === 'sftp') void uploadViaSftp(paths)
  }

  /* ---------- 分屏：终端右键入口 ---------- */
  /*
   * 分屏原先只有标签栏右键一个入口。标签栏本身只有 44px 高、还横向滚动，
   * 鼠标要精准落在某一条标签的几十像素上才点得到；而想分屏时视线和鼠标
   * 其实都在终端里。这里再挂一份，两个入口共用同一条 splitStore 链路，
   * 不新增任何状态。
   *
   * 判据刻意与 TabBar 保持一致（已连接 + 未超 MAX_PANES），而且是从
   * paneTree 里 import 同一个常量算的 —— 不是各写一个 4。以后上限改动
   * 只改一处，两个入口不会分叉。
   */
  const splitTrees = useSplitStore((s) => s.trees)
  const splitPane = useSplitStore((s) => s.splitPane)
  const closePane = useSplitStore((s) => s.closePane)
  /** 本会话所属标签的 id；独立标签就是自己 */
  const paneOwner = ((): string => {
    for (const [ownerId, node] of Object.entries(splitTrees)) {
      if (leafIds(node).includes(sessionId)) return ownerId
    }
    return sessionId
  })()
  const paneTotal = splitTrees[paneOwner] ? countLeaves(splitTrees[paneOwner]) : 1
  // 串口是独占的 COM 句柄，分屏会开第二个抢同一口的会话，两个都读不到数据
  const canSplit =
    session.status === 'connected' && session.kind !== 'serial' && paneTotal < MAX_PANES

  /* ---------- 右键菜单 ---------- */
  const menuItems: MenuEntry[] = [
    {
      label: '复制',
      onClick: () => {
        const entry = terminalRegistry.get(sessionId)
        const selection = entry?.term.getSelection()
        if (selection) void call(window.api.clip.write(selection), { silent: true })
      }
    },
    {
      label: '粘贴',
      onClick: () => {
        void call(window.api.clip.read(), { silent: true }).then((text) => {
          if (text) requestPaste(text)
        })
      }
    },
    { label: '全选', onClick: () => terminalRegistry.get(sessionId)?.term.selectAll() },
    /*
     * 发送文件：trzsz 的本地发起方向。
     *
     * 与 ZMODEM 相反 —— zmodem 永远由远端 sz/rz 发起，这边被动响应；
     * trzsz 支持本地主动推（先给远端发 Ctrl-C 再发 trz 把它拉进接收态），
     * 所以需要这个入口。串口会话上没有意义，直接不显示。
     */
    ...(canTrzsz
      ? [
          {
            label: '发送文件…',
            separatorBefore: true,
            onClick: () => startUpload()
          } as MenuEntry
        ]
      : []),
    ...(trzsz?.active
      ? [
          {
            label: '取消传输',
            danger: true,
            onClick: () => {
              void call(window.api.trzsz.cancel(sessionId), { errorTitle: '取消传输失败' })
            }
          } as MenuEntry
        ]
      : []),
    /*
     * 分屏入口。与标签栏右键指向同一组动作：
     *   splitPane(sessionId, dir) 内部会 openTerminal 复用同一条 SSH 连接开新 shell，
     *   再把当前格 replaceLeaf 成 split 节点 —— 所以在这里点「向下分屏」，
     *   当前这块会变成「上半 + 下半」，新格在下半。
     *
     * 「关闭此分屏」只在真的分了屏时才出现：单格时 closePane 等价于关标签，
     * 而终端右键菜单里多一个「关掉整个终端」既危险又多余（标签上有 ×）。
     */
    {
      label: '向右分屏',
      icon: <Columns2 size={12} />,
      separatorBefore: true,
      disabled: !canSplit,
      onClick: () => splitPane(sessionId, 'row')
    },
    {
      label: '向下分屏',
      icon: <Rows2 size={12} />,
      disabled: !canSplit,
      onClick: () => splitPane(sessionId, 'col')
    },
    ...(paneTotal > 1
      ? [
          {
            label: '关闭此分屏',
            icon: <XCircle size={12} />,
            onClick: () => closePane(sessionId)
          } as MenuEntry
        ]
      : []),
    {
      label: t('editor.find'),
      separatorBefore: true,
      onClick: () => setSearchOpen(true)
    },
    {
      label: t('terminal.exportBuffer'),
      onClick: () => {
        const entry = terminalRegistry.get(sessionId)
        if (!entry) return
        const text = extractTerminalBuffer(entry.term)
        if (!text) {
          useToastStore.getState().push({
            kind: 'info',
            title: t('terminal.exportBuffer.empty')
          })
          return
        }
        const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
        const base = session.connectionName || session.target || 'terminal'
        void call(window.api.session.exportBuffer(`${base}-${stamp}.txt`, text), {
          errorTitle: t('terminal.exportBuffer.error')
        }).then((res) => {
          if (res && !res.canceled) {
            useToastStore.getState().push({
              kind: 'success',
              title: t('terminal.exportBuffer.done'),
              detail: res.path
            })
          }
        })
      }
    },
    { label: '清屏', onClick: () => terminalRegistry.get(sessionId)?.term.clear() }
  ]

  const handleContextMenu = (e: React.MouseEvent<HTMLDivElement>): void => {
    const entry = terminalRegistry.get(sessionId)
    const action = decideRightClickAction(
      useSettingsStore.getState().settings.terminal.rightClickPaste === true,
      e.shiftKey,
      Boolean(entry?.term.hasSelection())
    )
    if (action === 'menu') {
      openMenu(e, 'context')
      return
    }
    e.preventDefault()
    if (action === 'copy') {
      const selection = entry?.term.getSelection()
      if (selection) void call(window.api.clip.write(selection), { silent: true })
    } else {
      void call(window.api.clip.read(), { silent: true }).then((text) => {
        if (text) requestPaste(text)
      })
    }
  }

  /* ---------- 状态覆盖层 ---------- */
  const showOverlay = session.status !== 'connected'

  return (
    <div className="relative flex h-full flex-col bg-app">
      {/* 串口会话顶部的刷机引导条（SSH 会话不渲染） */}
      {session.kind === 'serial' && <SerialBootBar session={session} />}

      {/* 终端挂载点：外层留呼吸边距，内层容器不设 padding，保证 fit 计算的尺寸精确 */}
      <div className="min-h-0 flex-1 px-3.5 py-2.5">
        <div
          ref={containerRef}
          className="h-full w-full"
          onContextMenu={handleContextMenu}
          /*
           * 拖文件进终端 = 上传到远端（默认 SFTP 直传 cwd，Alt 或设置项切 trzsz）。
           *
           * 只拦带文件的拖拽：拖常用命令进来是另一条链路（App.tsx 的
           * handleTerminalDragOver），那边靠 dataTransfer.types 区分，
           * 这里用 files.length 区分，互不干扰。stopPropagation 是必要的 ——
           * 否则同一个 drop 也会被工作区那层的命令处理器看到。
           *
           * 命令拖拽的 files.length 恒为 0，所以 decideDropAction 的 fileCount
           * 判据把它挡在第一步 —— 不会出现「拖一条命令进来弹出上传提示」。
           */
          onDragOver={(e) => {
            /* 不能用 e.dataTransfer.files.length：Windows 在未落下时它是保护模式，恒为 0 */
            const fileCount = countDraggedFiles(e.dataTransfer)
            const action = resolveDropAction(e, fileCount)
            if (action === 'ignore') {
              if (dropHint) setDropHint(null)
              return
            }
            e.preventDefault()
            e.stopPropagation()
            e.dataTransfer.dropEffect = 'copy'
            setDropHint((prev) =>
              prev && prev.action === action && prev.files === fileCount && prev.dir === dropCwd
                ? prev
                : { action, files: fileCount, dir: dropCwd }
            )
          }}
          /*
           * 只在真正离开这个容器时才收提示层。
           * dragleave 会随光标进出每个子元素各冒泡一次，不判 relatedTarget
           * 是否仍在容器内的话，鼠标划过 xterm 的 canvas / 覆盖层本身就会闪一下。
           */
          onDragLeave={(e) => {
            if (e.currentTarget.contains(e.relatedTarget as Node | null)) return
            if (dropHint) setDropHint(null)
          }}
          onDrop={(e) => {
            /* drop 阶段 files 已填好，但仍走同一个计数函数：两条路径只有一个真相 */
            const action = resolveDropAction(e, countDraggedFiles(e.dataTransfer))
            setDropHint(null)
            if (action === 'ignore') return
            const paths = dropPaths(e)
            if (paths.length === 0) return
            e.preventDefault()
            e.stopPropagation()
            runDropAction(action, paths)
          }}
        />

        {/*
         * 拖放目标提示条。刻意用纯色 bg-app/[0.88] 而不是 backdrop-filter:
         * 模糊层会让 xterm 的 canvas 每帧重合成，拖拽时肉眼可见地掉帧。
         */}
        {dropHint && dropHint.action !== 'ignore' && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-app/[0.88]">
            <div className="flex max-w-[420px] flex-col items-center gap-1.5 rounded-xl border border-accent/40 bg-panel px-5 py-3 text-center shadow-pop">
              <div className="text-xs font-medium text-ink">
                {t('terminal.drop.overlay.title', { dir: dropHint.dir || '~' })}
              </div>
              <div className="text-2xs text-ink-3">
                {t('terminal.drop.overlay.alt', {
                  mode:
                    dropHint.action === 'sftp'
                      ? t('terminal.dropUploadMode.trzsz')
                      : t('terminal.dropUploadMode.sftp')
                })}
              </div>
            </div>
          </div>
        )}
      </div>

      {searchOpen && (
        <div className="absolute right-3 top-2 z-10 flex animate-pop-in items-center gap-1 rounded-lg border border-edge bg-panel px-2 py-1 shadow-pop">
          <Search size={12} className="text-ink-3" />
          <input
            autoFocus
            value={searchText}
            onChange={(e) => {
              setSearchText(e.target.value)
              runSearch(e.target.value)
            }}
            onKeyDown={(e) => {
              if (isImeComposing(e)) return
              if (e.key === 'Enter') runSearch(searchText, e.shiftKey)
              if (e.key === 'Escape') closeSearch()
            }}
            placeholder="在终端中查找…"
            className="h-6 w-44 selectable border-none bg-transparent text-xs text-ink outline-none placeholder:text-ink-3"
          />
          <span className="min-w-[52px] text-center font-mono text-2xs text-ink-3">
            {searchCount.count > 0 ? `${searchCount.index + 1}/${searchCount.count}` : '无结果'}
          </span>
          <button
            className="btn-icon h-5 w-5"
            onClick={() => runSearch(searchText, true)}
            title={t('editor.prevMatch')}
          >
            <ChevronUp size={12} />
          </button>
          <button
            className="btn-icon h-5 w-5"
            onClick={() => runSearch(searchText)}
            title={t('editor.nextMatch')}
          >
            <ChevronDown size={12} />
          </button>
          <button
            className="btn-icon h-5 w-5"
            onClick={closeSearch}
            title={t('editor.closeFind')}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {showOverlay && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-app/[0.88] p-4">
          {session.status === 'connecting' && (
            <div className="flex items-center gap-2.5 rounded-lg border border-edge bg-panel px-5 py-3.5 text-xs text-ink-2 shadow-pop">
              <Loader2 size={15} className="animate-spin text-accent" />
              正在连接 {session.target}…
            </div>
          )}
          {session.status === 'disconnected' && (
            <div className="flex max-w-[420px] flex-col items-center gap-2 rounded-lg border border-edge bg-panel px-6 py-5 text-center shadow-pop">
              <PlugZap size={22} className="text-ink-3" />
              <div className="text-xs font-medium text-ink">连接已断开</div>
              <div className="text-2xs text-ink-3">远端关闭了会话，或网络中断。</div>
              <ReconnectButton sessionId={sessionId} />
            </div>
          )}
          {session.status === 'error' && (
            <div className="flex max-w-[460px] flex-col items-center gap-2 rounded-lg border border-edge bg-panel px-6 py-5 text-center shadow-pop">
              <AlertCircle size={22} className="text-danger" />
              <div className="text-xs font-medium text-ink">连接失败</div>
              <div className="selectable whitespace-pre-line break-all text-2xs leading-relaxed text-ink-3">
                {session.error ?? '未知错误'}
              </div>
              {/指纹/.test(session.error ?? '') && <UpdateHostKeyButton session={session} />}
              {needsLegacyAlgorithms(session) && <EnableLegacyAlgoButton session={session} />}
              <ReconnectButton sessionId={sessionId} />
            </div>
          )}
        </div>
      )}

      {/* 多行粘贴确认框：挂在终端容器之外，免得成为 xterm 兄弟节点影响 fit */}
      {pasteRequest && (
        <PasteConfirmDialog
          target={session.title || session.target}
          analysis={pasteRequest.analysis}
          text={pasteRequest.text}
          onCancel={() => {
            setPasteRequest(null)
            /* 取消后把焦点还给终端：用户接下来大概率要继续敲命令 */
            terminalRegistry.get(sessionId)?.term.focus()
          }}
          onConfirm={(finalText) => {
            setPasteRequest(null)
            const entry = terminalRegistry.get(sessionId)
            entry?.term.paste(finalText)
            entry?.term.focus()
          }}
        />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />}
    </div>
  )
}
