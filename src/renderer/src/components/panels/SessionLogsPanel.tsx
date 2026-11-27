import type * as React from 'react'
import { useEffect, useState } from 'react'
import { Download, FolderOpen, Play, RefreshCw, ScrollText, Search, Trash2 } from 'lucide-react'
import type { SessionLogFile } from '@shared/types'
import { useI18n } from '@/i18n'
import { call } from '@/lib/ipc'
import { cn, formatBytes, formatTime } from '@/lib/utils'
import { ConfirmDialog, EmptyState } from '@/components/ui'
import { useToastStore } from '@/stores/toastStore'
import { LogPlayerDialog } from './LogPlayerDialog'

/** 文件名 → 会话名与录制时间：20261014-155401-A区.cast / .log */
function parseLogName(name: string): { title: string; time: string } {
  const m = name.match(/^(\d{8})-(\d{6})-(.+)\.(cast|log)$/)
  if (!m) return { title: name.replace(/\.(cast|log)$/, ''), time: '' }
  const [, d, t, title] = m
  const time = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)} ${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}`
  return { title, time }
}

/**
 * 会话日志面板（侧栏「日志」页）：
 * 列出自动录制产生的 cast 文件，支持搜索、回放、导出、删除。
 */
export function SessionLogsPanel(): React.JSX.Element {
  const { t } = useI18n()
  const [logs, setLogs] = useState<SessionLogFile[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [playing, setPlaying] = useState<SessionLogFile | null>(null)
  const [pendingDelete, setPendingDelete] = useState<SessionLogFile | null>(null)

  const reload = async (): Promise<void> => {
    setLoading(true)
    const list = await call(window.api.logs.list(), { silent: true })
    setLogs(list ?? [])
    setLoading(false)
  }

  useEffect(() => {
    void reload()
  }, [])

  const kw = keyword.trim().toLowerCase()
  const filtered = kw ? logs.filter((l) => l.name.toLowerCase().includes(kw)) : logs

  const exportLog = async (log: SessionLogFile): Promise<void> => {
    const res = await call(window.api.logs.exportOne(log.path), {
      errorTitle: t('panel.logs.exportError')
    })
    if (res && !res.canceled) {
      useToastStore.getState().push({
        kind: 'success',
        title: t('panel.logs.exported'),
        detail: res.path
      })
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="panel-head">
        <ScrollText size={13} className="shrink-0 text-ink-3" />
        <span className="panel-title">{t('panel.logs.title')}</span>
        <span className="panel-count">{logs.length}</span>
        <span className="flex-1" />
        <button
          className="btn-icon h-6 w-6"
          title={t('panel.logs.openDir')}
          onClick={() => void call(window.api.logs.openDir(), { silent: true })}
        >
          <FolderOpen size={13} />
        </button>
        <button className="btn-icon h-6 w-6" title={t('panel.logs.refresh')} onClick={() => void reload()}>
          <RefreshCw size={13} className={cn(loading && 'animate-spin')} />
        </button>
      </div>

      <div className="panel-toolbar">
        <div className="relative flex-1">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            className="input h-7 pl-7 text-xs"
            placeholder={t('panel.logs.searchPlaceholder')}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
      </div>

      <div className="panel-body">
        {filtered.length === 0 && (
          <EmptyState
            icon={<ScrollText size={24} />}
            title={logs.length === 0 ? t('panel.logs.emptyTitle') : t('panel.logs.emptySearchTitle')}
            hint={
              logs.length === 0
                ? t('panel.logs.emptyHint')
                : t('panel.logs.emptySearchHint')
            }
          />
        )}

        {filtered.map((log) => {
          const { title, time } = parseLogName(log.name)
          return (
            <div
              key={log.path}
              className="group rounded-md px-2 py-1.5 transition-colors hover:bg-hover/60"
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={cn(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    log.format === 'log' ? 'bg-ink-3/60' : 'bg-danger/70'
                  )}
                  title={
                    log.format === 'log' ? t('panel.logs.formatText') : t('panel.logs.formatCast')
                  }
                />
                <span className="min-w-0 flex-1 truncate text-xs text-ink">{title}</span>
                {/*
                 * 同名两份是常态，纯文本那份必须能被一眼认出 —— 否则用户每次都得靠后缀猜
                 */}
                {log.format === 'log' && (
                  <span className="shrink-0 rounded border border-edge px-1 text-3xs text-ink-3">
                    txt
                  </span>
                )}
                <span className="shrink-0 font-mono text-2xs text-ink-3">
                  {formatBytes(log.size)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 pl-3 text-3xs text-ink-3">
                <span>{time || formatTime(log.mtime)}</span>
                <span className="flex-1" />
                {/*
                 * 纯文本没有时间轴，回放没有意义；不给按钮而不是给个点了没反应的按钮
                 */}
                {log.format !== 'log' && (
                  <button
                    className="btn-icon h-5 w-5 opacity-0 group-hover:opacity-100"
                    title={t('panel.logs.replay')}
                    onClick={() => setPlaying(log)}
                  >
                    <Play size={11} />
                  </button>
                )}
                <button
                  className="btn-icon h-5 w-5 opacity-0 group-hover:opacity-100"
                  title={
                    log.format === 'log'
                      ? t('panel.logs.exportTextTitle')
                      : t('panel.logs.exportCastTitle')
                  }
                  onClick={() => void exportLog(log)}
                >
                  <Download size={11} />
                </button>
                <button
                  className="btn-icon h-5 w-5 opacity-0 hover:text-danger group-hover:opacity-100"
                  title={t('panel.logs.delete')}
                  onClick={() => setPendingDelete(log)}
                >
                  <Trash2 size={11} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      {playing && <LogPlayerDialog log={playing} onClose={() => setPlaying(null)} />}

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t('panel.logs.deleteTitle')}
        danger
        confirmText={t('panel.logs.deleteConfirm')}
        message={
          <>
            {t('panel.logs.deletePrefix')}
            <span className="font-medium text-ink">
              {t('panel.logs.deleteQuoted', {
                name: pendingDelete ? parseLogName(pendingDelete.name).title : ''
              })}
            </span>
            {t('panel.logs.deleteSuffix')}
          </>
        }
        onCancel={() => setPendingDelete(null)}
        onConfirm={() => {
          const log = pendingDelete
          setPendingDelete(null)
          if (log) void call(window.api.logs.remove(log.path)).then(() => void reload())
        }}
      />
    </div>
  )
}
