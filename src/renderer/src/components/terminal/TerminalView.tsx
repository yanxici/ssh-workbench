import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import {
  AlertCircle,
  ChevronDown,
  ChevronUp,
  Fingerprint,
  Loader2,
  PlugZap,
  RefreshCw,
  Search,
  X
} from 'lucide-react'
import type { SessionUi } from '@/stores/sessionStore'
import { terminalRegistry, useSessionStore } from '@/stores/sessionStore'
import { applyOsc7, feedTerminalInput } from '@/stores/cwdStore'
import { resolveDark, useSettingsStore } from '@/stores/settingsStore'
import { matchShortcut, resolveShortcuts } from '@/lib/shortcuts'
import { getXtermTheme } from '@/theme/colorThemes'
import { ContextMenu, useContextMenu, type MenuEntry } from '@/components/ui'
import { call } from '@/lib/ipc'
import { useConnectionStore } from '@/stores/connectionStore'
import { useToastStore } from '@/stores/toastStore'
import { ensureZmodem, detachZmodem, bytesToBase64, requestZmodemConfirm } from '@/lib/zmodem'

function ReconnectButton({ sessionId }: { sessionId: string }): JSX.Element {
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
function UpdateHostKeyButton({ session }: { session: SessionUi }): JSX.Element | null {
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
}): JSX.Element {
  const sessionId = session.id
  const containerRef = useRef<HTMLDivElement>(null)

  const [searchOpen, setSearchOpen] = useState(false)
  const [searchText, setSearchText] = useState('')
  const [searchCount, setSearchCount] = useState<{ index: number; count: number }>({
    index: -1,
    count: 0
  })

  const { menu, openMenu, closeMenu } = useContextMenu<'context'>()

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
    term.loadAddon(new WebLinksAddon())
    term.open(el)

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
      void window.api.session.write(sessionId, data)
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
      if (e.type !== 'keydown') return true
      const map = resolveShortcuts(useSettingsStore.getState().settings.shortcuts)
      if (matchShortcut(e, map.terminalCopy)) {
        const selection = term.getSelection()
        if (selection) void call(window.api.clip.write(selection), { silent: true })
        return false
      }
      if (matchShortcut(e, map.terminalPaste)) {
        void call(window.api.clip.read(), { silent: true }).then((text) => {
          if (text) term.paste(text)
        })
        return false
      }
      if (matchShortcut(e, map.terminalSearch)) {
        setSearchOpen(true)
        return false
      }
      return true
    })

    terminalRegistry.set(sessionId, { term, fit, search })

    // ZMODEM：挂上 Sentry，之后本会话的输出统一经它转发
    // （协议帧被拦下，普通输出回落到 term.write）
    ensureZmodem(sessionId, {
      write: (text) => term.write(text),
      send: (bytes) => {
        // 协议控制字节是二进制，必须走专用通道；
        // session.write 会按 UTF-8 编码，>127 的字节会失真。
        void window.api.zmodem.sendBytes(sessionId, bytesToBase64(bytes))
      },
      confirm: (direction) => requestZmodemConfirm(direction),
      afterTransfer: () => {
        // 传输结束后补换行：远端 sz/rz 退出时不补 \r\n，
        // 提示符会与最后一行进度挤在一起。
        term.write('\r\n')
      }
    })

    return () => {
      terminalRegistry.delete(sessionId)
      detachZmodem(sessionId)
      cancelAnimationFrame(fitRaf)
      resizeObserver.disconnect()
      dataDisposer.dispose()
      oscDisposer.dispose()
      searchResultDisposer.dispose()
      term.dispose()
    }
  }, [sessionId])

  /* ---------- 设置变化：字体 / 主题实时生效 ---------- */
  const terminalPrefs = useSettingsStore((s) => s.settings.terminal)
  const themeMode = useSettingsStore((s) => s.settings.theme)
  const colorTheme = useSettingsStore((s) => s.settings.colorTheme)
  useEffect(() => {
    const entry = terminalRegistry.get(sessionId)
    if (!entry) return
    entry.term.options.fontFamily = terminalPrefs.fontFamily
    entry.term.options.fontSize = terminalPrefs.fontSize
    entry.term.options.lineHeight = terminalPrefs.lineHeight
    entry.term.options.cursorStyle = terminalPrefs.cursorStyle
    entry.term.options.cursorBlink = terminalPrefs.cursorBlink
    entry.term.options.scrollback = terminalPrefs.scrollback
    entry.term.options.theme = getXtermTheme(colorTheme, resolveDark(themeMode))
    requestAnimationFrame(() => {
      try {
        entry.fit.fit()
      } catch {
        /* 容器不可见时忽略 */
      }
    })
  }, [sessionId, terminalPrefs, themeMode, colorTheme])

  /* ---------- 标签切换后重新 fit ---------- */
  useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => {
      const entry = terminalRegistry.get(sessionId)
      if (!entry) return
      try {
        entry.fit.fit()
      } catch {
        /* ignore */
      }
      entry.term.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [active, sessionId])

  /* ---------- 搜索 ---------- */
  const runSearch = (text: string, backwards = false): void => {
    const entry = terminalRegistry.get(sessionId)
    if (!entry || !text) return
    if (backwards) entry.search.findPrevious(text, { caseSensitive: false })
    else entry.search.findNext(text, { caseSensitive: false })
  }

  const closeSearch = (): void => {
    setSearchOpen(false)
    terminalRegistry.get(sessionId)?.search.clearDecorations()
    terminalRegistry.get(sessionId)?.term.focus()
  }

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
          if (text) {
            terminalRegistry.get(sessionId)?.term.paste(text)
            terminalRegistry.get(sessionId)?.term.focus()
          }
        })
      }
    },
    { label: '全选', onClick: () => terminalRegistry.get(sessionId)?.term.selectAll() },
    {
      label: '查找',
      separatorBefore: true,
      onClick: () => setSearchOpen(true)
    },
    { label: '清屏', onClick: () => terminalRegistry.get(sessionId)?.term.clear() }
  ]

  /* ---------- 状态覆盖层 ---------- */
  const showOverlay = session.status !== 'connected'

  return (
    <div className="relative flex h-full flex-col bg-app">
      {/* 终端挂载点：内层容器不设 padding，保证 fit 计算的尺寸精确 */}
      <div className="min-h-0 flex-1 px-3 pb-1 pt-2">
        <div
          ref={containerRef}
          className="h-full w-full"
          onContextMenu={(e) => openMenu(e, 'context')}
        />
      </div>

      {/* 搜索条 */}
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
            title="上一个 (Shift+Enter)"
          >
            <ChevronUp size={12} />
          </button>
          <button className="btn-icon h-5 w-5" onClick={() => runSearch(searchText)} title="下一个 (Enter)">
            <ChevronDown size={12} />
          </button>
          <button className="btn-icon h-5 w-5" onClick={closeSearch} title="关闭 (Esc)">
            <X size={12} />
          </button>
        </div>
      )}

      {/* 连接中 / 错误 / 已断开 覆盖层 */}
      {showOverlay && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-app/88">
          {session.status === 'connecting' && (
            <div className="flex items-center gap-2.5 text-xs text-ink-2">
              <Loader2 size={15} className="animate-spin text-accent" />
              正在连接 {session.username}@{session.host}…
            </div>
          )}
          {session.status === 'disconnected' && (
            <div className="flex max-w-[420px] flex-col items-center gap-2 text-center">
              <PlugZap size={22} className="text-ink-3" />
              <div className="text-xs text-ink-2">连接已断开</div>
              <div className="text-2xs text-ink-3">远端关闭了会话，或网络中断。</div>
              <ReconnectButton sessionId={sessionId} />
            </div>
          )}
          {session.status === 'error' && (
            <div className="flex max-w-[460px] flex-col items-center gap-2 text-center">
              <AlertCircle size={22} className="text-danger" />
              <div className="text-xs font-medium text-ink">连接失败</div>
              <div className="selectable whitespace-pre-line break-all text-2xs leading-relaxed text-ink-3">
                {session.error ?? '未知错误'}
              </div>
              {/指纹/.test(session.error ?? '') && <UpdateHostKeyButton session={session} />}
              <ReconnectButton sessionId={sessionId} />
            </div>
          )}
        </div>
      )}

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />}
    </div>
  )
}
