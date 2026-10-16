import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Pause, Play, RotateCcw, ScrollText } from 'lucide-react'
import type { SessionLogFile } from '@shared/types'
import { call } from '@/lib/ipc'
import { resolveDark, useSettingsStore } from '@/stores/settingsStore'
import { getTerminalTheme } from '@/theme/terminalThemes'

interface CastEvent {
  t: number
  type: 'o' | 'i'
  data: string
}

function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const m = Math.floor(s / 60)
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/**
 * 会话日志回放器：按录制时间轴把终端输出重放到只读 xterm。
 * 支持 播放/暂停、1x-8x 变速、从头重播；进度条只读展示。
 */
export function LogPlayerDialog({
  log,
  onClose
}: {
  log: SessionLogFile
  onClose: () => void
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const eventsRef = useRef<CastEvent[]>([])
  const idxRef = useRef(0)
  const currentEvtRef = useRef(0)
  const durationRef = useRef(0.1)
  const speedRef = useRef(2)

  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState(false)
  const [progress, setProgress] = useState(0)
  const [elapsed, setElapsed] = useState(0)
  const [speed, setSpeed] = useState(2)
  const [duration, setDuration] = useState(0.1)

  useEffect(() => {
    speedRef.current = speed
  }, [speed])

  /* 初始化终端 + 加载日志数据 */
  useEffect(() => {
    const el = containerRef.current
    if (!el) return

    const { settings } = useSettingsStore.getState()
    const term = new Terminal({
      fontFamily: settings.terminal.fontFamily,
      fontSize: settings.terminal.fontSize,
      lineHeight: settings.terminal.lineHeight,
      theme: getTerminalTheme(resolveDark(settings.theme)),
      disableStdin: true,
      cursorBlink: false,
      scrollback: 10000
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    termRef.current = term
    requestAnimationFrame(() => {
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
    })
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
    })
    ro.observe(el)

    void (async () => {
      const content = await call(window.api.logs.read(log.path), { errorTitle: '读取日志失败' })
      if (!content) return
      try {
        const lines = content.split('\n').filter((l) => l.trim())
        const events: CastEvent[] = []
        let maxT = 0
        for (let i = 0; i < lines.length; i += 1) {
          if (i === 0) continue // 头部行（version/width/height/title）
          const row = JSON.parse(lines[i]) as unknown
          if (Array.isArray(row) && typeof row[0] === 'number' && typeof row[2] === 'string') {
            events.push({
              t: row[0] as number,
              type: row[1] === 'i' ? 'i' : 'o',
              data: row[2] as string
            })
            maxT = Math.max(maxT, row[0] as number)
          }
        }
        eventsRef.current = events
        durationRef.current = Math.max(maxT, 0.1)
        setDuration(Math.max(maxT, 0.1))
        setReady(true)
      } catch {
        setError('日志格式无法解析，文件可能损坏')
      }
    })()

    return () => {
      ro.disconnect()
      term.dispose()
      termRef.current = null
    }
  }, [log.path])

  /* 播放循环：按时间轴重放输出事件 */
  useEffect(() => {
    if (!playing || !ready) return
    const base = { wall: Date.now(), evt: currentEvtRef.current }
    let raf = 0
    let lastUi = 0

    const tick = (): void => {
      const term = termRef.current
      if (!term) return
      const evt = base.evt + ((Date.now() - base.wall) / 1000) * speedRef.current
      const events = eventsRef.current
      while (idxRef.current < events.length && events[idxRef.current].t <= evt) {
        const e = events[idxRef.current]
        if (e.type === 'o') term.write(e.data)
        idxRef.current += 1
      }
      currentEvtRef.current = Math.min(evt, durationRef.current)

      const now = Date.now()
      if (now - lastUi > 150) {
        lastUi = now
        setElapsed(currentEvtRef.current)
        setProgress(Math.min(currentEvtRef.current / durationRef.current, 1))
      }

      if (idxRef.current >= events.length) {
        setPlaying(false)
        setElapsed(durationRef.current)
        setProgress(1)
        return
      }
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [playing, ready])

  const restart = (): void => {
    idxRef.current = 0
    currentEvtRef.current = 0
    setElapsed(0)
    setProgress(0)
    termRef.current?.reset()
    setPlaying(true)
  }

  const togglePlay = (): void => {
    if (!ready) return
    if (idxRef.current >= eventsRef.current.length) {
      restart()
      return
    }
    setPlaying((p) => !p)
  }

  return (
    <div
      className="modal-overlay items-start justify-center pt-[7vh]"
      style={{ zIndex: 46 }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="modal max-w-4xl">
        <div className="modal-header">
          <div className="modal-title flex min-w-0 items-center gap-2">
            <ScrollText size={13} className="shrink-0 text-accent" />
            <span className="truncate font-mono text-2xs">{log.name}</span>
          </div>
          <span className="shrink-0 font-mono text-2xs text-ink-3">
            {formatDuration(elapsed)} / {formatDuration(duration)}
          </span>
        </div>

        <div className="modal-body p-0">
          <div ref={containerRef} className="h-[52vh] w-full bg-app p-2" />
        </div>

        <div className="modal-footer">
          <button className="btn" title="从头重播" onClick={restart}>
            <RotateCcw size={13} />
          </button>
          <button className="btn btn-primary" onClick={togglePlay} disabled={!ready}>
            {playing ? <Pause size={13} /> : <Play size={13} />}
            {playing ? '暂停' : '播放'}
          </button>

          {/* 只读进度条 */}
          <div className="mx-2 h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-raised">
            <div
              className="h-full rounded-full bg-accent transition-all duration-150"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>

          <select
            className="input h-7 w-[92px] shrink-0 px-1 text-2xs"
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
          >
            {[1, 2, 4, 8].map((s) => (
              <option key={s} value={s}>
                {s}x 速度
              </option>
            ))}
          </select>
          <button className="btn" onClick={onClose}>
            关闭
          </button>
        </div>

        {error && <div className="border-t border-edge-soft px-4 py-2 text-2xs text-danger">{error}</div>}
      </div>
    </div>
  )
}
