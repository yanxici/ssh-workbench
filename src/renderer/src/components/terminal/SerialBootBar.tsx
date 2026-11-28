import type * as React from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ChevronRight,
  Gauge,
  HardDriveDownload,
  Play,
  Radio,
  Send,
  Square,
  Usb,
  Zap
} from 'lucide-react'
import { SERIAL_BAUD_PRESETS } from '@shared/serialBaud'
import type { SessionUi } from '@/stores/sessionStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useTftpStore } from '@/stores/tftpStore'
import { useToastStore } from '@/stores/toastStore'
import { isImeComposing } from '@/lib/ime'
import { call } from '@/lib/ipc'
import { cn, formatBytes } from '@/lib/utils'
import { useI18n } from '@/i18n'

/**
 * 串口会话顶部的刷机引导条。
 *
 * 存在的理由：7628 的 U-Boot 刷机是一条**时序很紧的键盘序列**——
 * 上电 2 秒内按 2 进命令行、输 Y 但别回车、回车、再回车、输固件名、回车。
 * 以前这套动作靠人对着文档数秒、手敲，错一步就重来一遍上电。
 * 这里把「时序」和「该敲什么」变成按钮，人只负责上电。
 *
 * 四条设计约束：
 *   1. 不抢串口输入。用户随时可以在终端里自己敲，引导条只是快捷方式。
 *   2. 波特率只「显示 + 可选地改」。默认值来自连接配置；改是就地改驱动，
 *      不回写连接配置 —— 用户可能只是想看看另一个速率下有没有输出，
 *      不该因此永久改掉自己保存的连接。
 *   3. 自动发 '2' 是**可选**的：勾了才在倒计时结束时发，默认不勾 ——
 *      万一板子已经在命令行里，多按一个 2 会打断正在输入的命令。
 *   4. 波特率与 BREAK 放在刷机三步之前、单独一段：它们不是刷机步骤，
 *      是「设备不吐字 / 要打断自动启动」时的排查手段。
 */

/**
 * 倒计时总时长。
 *
 * U-Boot 的窗口是「上电后 2 秒」，而这里的计时起点是**点按钮那一刻**，
 * 不是上电那一刻 —— 中间还隔着人去拨电源开关的动作。所以不能按 2 秒设，
 * 否则人还没摸到开关，`2` 就已经发完了。6 秒是「够拨开关、又不至于忘掉」的量。
 */
const AUTOKEY_DELAY_MS = 6000
/** 倒计时结束后每 250ms 补一发，持续 4 秒 —— 见 armAutoKey 的注释 */
const BURST_INTERVAL_MS = 250
const BURST_SHOTS = 16
const DEFAULT_FIRMWARE_HINT = 'openwrt-21.02.2-7628n-PgwayCount.bin'

interface Props {
  session: SessionUi
}

export function SerialBootBar({ session }: Props): React.JSX.Element {
  const { t } = useI18n()
  const [open, setOpen] = useState(false)
  const [autoKey, setAutoKey] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'wait' | 'burst'>('idle')
  const [remaining, setRemaining] = useState(0)
  const [firmware, setFirmware] = useState<{ path: string; name: string; size: number } | null>(null)
  const [baud, setBaud] = useState<string>('')
  const [pacing, setPacing] = useState(false)
  const tickRef = useRef<number | null>(null)
  const burstRef = useRef<number | null>(null)
  const applySerialBaud = useSessionStore((s) => s.applySerialBaud)

  const server = useTftpStore((s) => s.server)
  const logs = useTftpStore((s) => s.logs)
  const busy = useTftpStore((s) => s.busy)
  const refresh = useTftpStore((s) => s.refresh)
  const startServer = useTftpStore((s) => s.start)
  const stopServer = useTftpStore((s) => s.stop)
  const push = useToastStore((s) => s.push)

  const connected = session.status === 'connected'
  // 连发期间可能断线；用 ref 让定时器回调看到最新状态，断线就收手，而不是刷一屏 toast
  const connectedRef = useRef(connected)
  connectedRef.current = connected

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

  // 当前速率跟着会话走：主进程是权威（拔插恢复、别人改了连接都可能变），
  // 这里只做镜像。用字符串存是因为输入框允许「正在输入的中间态」（如空串）。
  const sessionBaud = session.serialConfig?.baudRate
  useEffect(() => {
    if (sessionBaud !== undefined) setBaud(String(sessionBaud))
  }, [sessionBaud])

  // 组件卸载 / 换会话时清掉所有定时器，避免把字符打到已关闭的会话上
  useEffect(() => {
    return () => {
      if (tickRef.current !== null) window.clearInterval(tickRef.current)
      if (burstRef.current !== null) window.clearInterval(burstRef.current)
    }
  }, [])

  const send = useCallback(
    (text: string): void => {
      if (!connected) {
        push({
          kind: 'error',
          title: t('term.serial.notConnected'),
          detail: t('term.serial.waitConnectSend')
        })
        return
      }
      void window.api.session.write(session.id, text)
    },
    [connected, push, session.id, t]
  )

  const stopAutoKey = useCallback((): void => {
    if (tickRef.current !== null) window.clearInterval(tickRef.current)
    if (burstRef.current !== null) window.clearInterval(burstRef.current)
    tickRef.current = null
    burstRef.current = null
    setPhase('idle')
    setRemaining(0)
  }, [])

  /**
   * 倒计时 → 连发。
   *
   * 只发一次 `2` 是不够的：U-Boot 的窗口只有 2 秒，而人对「拨开关」这个动作
   * 的反应误差远大于 2 秒。发一次等于赌自己恰好卡在窗口里。改成连发 ——
   * 倒计时结束后每 250ms 发一个 `2`，持续 4 秒，16 次里只要有一次落进窗口
   * 就进命令行；进了命令行之后多余的 `2` 只是回显，按一次回车就清干净。
   */
  const armAutoKey = useCallback((): void => {
    if (tickRef.current !== null) window.clearInterval(tickRef.current)
    if (burstRef.current !== null) window.clearInterval(burstRef.current)
    const burst = (): void => {
      if (burstRef.current !== null) window.clearInterval(burstRef.current)
      burstRef.current = null
      setPhase('idle')
    }
    let left = AUTOKEY_DELAY_MS
    setPhase('wait')
    setRemaining(left)
    tickRef.current = window.setInterval(() => {
      left -= 100
      if (left > 0) {
        setRemaining(left)
        return
      }
      if (tickRef.current !== null) window.clearInterval(tickRef.current)
      tickRef.current = null
      if (!connectedRef.current) {
        setPhase('idle')
        setRemaining(0)
        return
      }
      setPhase('burst')
      send('2')
      let shots = 1
      burstRef.current = window.setInterval(() => {
        shots += 1
        // 中途断线就停：继续发只会堆一屏「串口未连接」的提示
        if (shots > BURST_SHOTS || !connectedRef.current) {
          burst()
          return
        }
        send('2')
      }, BURST_INTERVAL_MS)
    }, 100)
  }, [send])

  /**
   * 应用波特率。
   *
   * 成功后只有两件事要跟着变：本组件的输入框（用主进程返回的真实生效值回填，
   * 不是用户填的那个）与会话 store 里的 target（标签栏 / 状态栏都读它）。
   * 切换失败不改任何显示 —— 显示成新值而驱动还在旧速率上，比不切更坑。
   */
  const applyBaud = useCallback(async (): Promise<void> => {
    if (!connected) {
      push({
        kind: 'error',
        title: t('term.serial.notConnected'),
        detail: t('term.serial.waitConnectBaud')
      })
      return
    }
    const next = Number(baud)
    if (!Number.isInteger(next) || next <= 0) {
      push({
        kind: 'error',
        title: t('term.serial.invalidBaud'),
        detail: t('term.serial.invalidBaudHint')
      })
      return
    }
    if (next === sessionBaud) return
    setPacing(true)
    try {
      const applied = await call(window.api.session.setBaud(session.id, next), {
        errorTitle: t('term.serial.setBaudFailed')
      })
      if (applied === null) return
      setBaud(String(applied))
      applySerialBaud(session.id, applied)
      push({
        kind: 'success',
        title: t('term.serial.baudApplied', { baud: applied }),
        detail: t('term.serial.baudAppliedDetail')
      })
    } finally {
      setPacing(false)
    }
  }, [applySerialBaud, baud, connected, push, session.id, sessionBaud, t])

  /**
   * 发 BREAK。
   *
   * 不提示「成功」：BREAK 的价值在于对端有没有反应（有没有掉进 U-Boot、
   * 有没有进维护模式），本地成功只代表线被拉低过头，说明不了任何事。
   * 反倒是失败要提示 —— 那多半是驱动不支持或端口已断。
   */
  const fireBreak = useCallback(async (): Promise<void> => {
    if (!connected) {
      push({
        kind: 'error',
        title: t('term.serial.notConnected'),
        detail: t('term.serial.waitConnectBreak')
      })
      return
    }
    await call(window.api.session.break(session.id), { errorTitle: t('term.serial.breakFailed') })
  }, [connected, push, session.id, t])

  const pickFirmware = useCallback(async (): Promise<void> => {
    const picked = await call(window.api.firmware.pickFile(), {
      errorTitle: t('term.serial.pickFirmwareFailed')
    })
    if (!picked || picked.canceled || !picked.file) return
    setFirmware(picked.file)
  }, [t])

  const toggleServer = useCallback(async (): Promise<void> => {
    if (server?.running) {
      await stopServer()
      return
    }
    if (!firmware) {
      push({
        kind: 'error',
        title: t('term.serial.pickFirmwareFirst'),
        detail: t('term.serial.tftpSingleFile')
      })
      return
    }
    await startServer(firmware.path)
  }, [firmware, push, server?.running, startServer, stopServer, t])

  const ipHint = server?.addresses?.[0] ?? t('term.serial.noNic')

  return (
    <div className="shrink-0 border-b border-edge bg-panel/60">
      {
        /* 折叠头：一行说清"这条是干什么的" + 当前波特率 */
      }
      <button
        className="flex h-7 w-full min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap px-3 text-left text-2xs text-ink-3 hover:text-ink-2"
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight size={11} className={cn('chev-rot shrink-0', open && 'rotate-90')} />
        <Usb size={11} className="shrink-0" />
        <span className="shrink-0 text-ink-2">{t('term.serial.barTitle')}</span>
        <span className="min-w-0 truncate text-ink-3">{t('term.serial.barSub')}</span>
        {sessionBaud !== undefined && (
          <span className="flex shrink-0 items-center gap-0.5 font-mono text-ink-3">
            <Gauge size={10} />
            {sessionBaud}
          </span>
        )}
        {phase !== 'idle' && (
          <span className="ml-auto flex items-center gap-1 text-accent">
            <Play size={10} />
            {phase === 'wait'
              ? t('term.serial.waitBurst', { sec: (Math.ceil(remaining / 100) / 10).toFixed(1) })
              : t('term.serial.bursting')}
          </span>
        )}
        {phase === 'idle' && server?.running && (
          <span className="ml-auto flex items-center gap-1 text-success">
            <Radio size={10} />
            TFTP {server.port} · {server.file}
          </span>
        )}
      </button>

      {open && (
        <div className="motion-reveal flex flex-col gap-2 px-3 pb-2.5">
          {/*
           * 串口参数：与刷机三步分开，因为「设备不吐字」和「刷机」是两件事。
           * 波特率错了的表现就是一片空白或满屏乱码 —— 这里能就地试另一个速率，
           * 不用断开重连；BREAK 用来打断已经在自动启动的板子。
           */}
          <div className="flex flex-wrap items-center gap-1.5">
            <Gauge size={11} className="text-ink-3" />
            <span className="text-2xs text-ink-2">{t('term.serial.baudLabel')}</span>
            <input
              type="number"
              className="input h-6 w-20 px-1 text-center font-mono text-2xs"
              value={baud}
              min={50}
              max={4000000}
              step={1}
              onChange={(e) => setBaud(e.target.value)}
              onKeyDown={(e) => {
                if (isImeComposing(e)) return
                if (e.key === 'Enter') void applyBaud()
              }}
              disabled={!connected || pacing}
              title={t('term.serial.baudInputTitle')}
            />
            <select
              className="input h-6 px-1 text-2xs"
              value=""
              onChange={(e) => {
                if (e.target.value) setBaud(e.target.value)
              }}
              disabled={!connected || pacing}
              title={t('term.serial.baudPresetTitle')}
            >
              <option value="">{t('term.serial.baudPresetPlaceholder')}</option>
              {SERIAL_BAUD_PRESETS.map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
            <button
              className="btn h-6 px-2 text-2xs"
              onClick={() => void applyBaud()}
              disabled={!connected || pacing || String(sessionBaud ?? '') === baud}
              title={t('term.serial.baudApplyTitle')}
            >
              {pacing ? t('term.serial.switching') : t('term.serial.apply')}
            </button>
            <button
              className="btn ml-2 h-6 px-2 text-2xs"
              onClick={() => void fireBreak()}
              disabled={!connected}
              title={t('term.serial.breakTitle')}
            >
              <Zap size={10} />
              BREAK
            </button>
          </div>
          <div className="pl-5 text-3xs leading-relaxed text-ink-3">
            {t('term.serial.baudHelp')}
          </div>

          {
            /* 第一步：进 U-Boot 命令行 */
          }
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-4 text-2xs text-ink-3">1</span>
            <span className="text-2xs text-ink-2">{t('term.serial.step1Text')}</span>
            <code className="rounded bg-raised px-1 py-0.5 font-mono text-2xs text-accent">2</code>
            <label className="ml-1 flex items-center gap-1 text-2xs text-ink-3">
              <input
                type="checkbox"
                className="h-3 w-3 accent-accent"
                checked={autoKey}
                onChange={(e) => {
                  setAutoKey(e.target.checked)
                  if (!e.target.checked) stopAutoKey()
                }}
              />
              {t('term.serial.autoBurst')}
            </label>
            {phase !== 'idle' ? (
              <button className="btn h-6 px-2 text-2xs" onClick={stopAutoKey}>
                <Square size={10} />
                {phase === 'wait'
                  ? t('term.serial.cancelWaitBurst', {
                      sec: (Math.ceil(remaining / 100) / 10).toFixed(1)
                    })
                  : t('term.serial.stopBurst')}
              </button>
            ) : (
              <button
                className="btn h-6 px-2 text-2xs"
                onClick={() => (autoKey ? armAutoKey() : send('2'))}
                disabled={!connected}
                title={
                  autoKey
                    ? t('term.serial.armBurstTitle', {
                        sec: AUTOKEY_DELAY_MS / 1000,
                        shots: BURST_SHOTS
                      })
                    : t('term.serial.send2Title')
                }
              >
                <Play size={10} />
                {autoKey ? t('term.serial.armBurstBtn') : t('term.serial.send2Btn')}
              </button>
            )}
          </div>

          <div className="pl-5 text-3xs leading-relaxed text-ink-3">
            {t('term.serial.step1Help')}
          </div>

          {
            /* 第二步：Y（不带回车） */
          }
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-4 text-2xs text-ink-3">2</span>
            <span className="text-2xs text-ink-2">{t('term.serial.step2Text')}</span>
            <code className="rounded bg-raised px-1 py-0.5 font-mono text-2xs text-accent">Y</code>
            <span className="text-2xs text-ink-3">{t('term.serial.noEnter')}</span>
            <button
              className="btn h-6 px-2 text-2xs"
              onClick={() => send('Y')}
              disabled={!connected}
            >
              <Send size={10} />
              {t('term.serial.sendY')}
            </button>
          </div>

          {
            /* 第三步：两次回车 + 固件名 */
          }
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="w-4 text-2xs text-ink-3">3</span>
            <span className="text-2xs text-ink-2">{t('term.serial.step3Text')}</span>
            <button className="btn h-6 px-2 text-2xs" onClick={() => send('\r')} disabled={!connected}>
              {t('term.serial.enter')}
            </button>
            <button
              className="btn h-6 px-2 text-2xs"
              onClick={() => send(`${server?.file ?? DEFAULT_FIRMWARE_HINT}\r`)}
              disabled={!connected}
              title={t('term.serial.sendFirmwareTitle')}
            >
              {t('term.serial.sendFirmwareBtn')}
            </button>
            <span className="font-mono text-2xs text-ink-3">
              {server?.file ?? DEFAULT_FIRMWARE_HINT}
            </span>
          </div>

          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 border-t border-edge/60 pt-2">
            <span className="text-2xs text-ink-2">{t('term.serial.tftpServer')}</span>
            <button className="btn h-6 px-2 text-2xs" onClick={() => void pickFirmware()}>
              <HardDriveDownload size={10} />
              {firmware ? t('term.serial.changeFirmware') : t('term.serial.chooseFirmware')}
            </button>
            <button
              className={cn('btn h-6 px-2 text-2xs', server?.running && 'text-danger')}
              onClick={() => void toggleServer()}
              disabled={busy}
            >
              {server?.running ? t('term.serial.stop') : t('term.serial.start')}
            </button>
            {firmware && (
              <span className="selectable font-mono text-2xs text-ink-3" title={firmware.path}>
                {firmware.name} · {formatBytes(firmware.size)}
              </span>
            )}
            {server?.running && (
              <span className="selectable text-2xs text-ink-3">
                {t('term.serial.localIp')}{' '}
                <span className="font-mono text-accent">{ipHint}</span>
              </span>
            )}
          </div>

          {server?.running && (
            <div className="text-3xs leading-relaxed text-ink-3">
              {t('term.serial.tftpHelp')}
            </div>
          )}

          {
            /* 最近几条日志：现场排错就看这里 */
          }
          {logs.length > 0 && (
            <div className="scroll-thin max-h-20 overflow-y-auto rounded border border-edge bg-app px-2 py-1">
              {logs.slice(-6).map((line, i) => (
                <div
                  key={`${line.at}-${i}`}
                  className={cn(
                    'whitespace-pre-wrap break-all font-mono text-2xs leading-relaxed',
                    line.level === 'error' ? 'text-danger' : 'text-ink-3'
                  )}
                >
                  {line.message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
