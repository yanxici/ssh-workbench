import type * as React from 'react'
import { useEffect, useRef, useState } from 'react'
import { Eraser, History, Play, Search, Star } from 'lucide-react'
import type { CommandHistoryEntry } from '@shared/types'
import { useCommandStore } from '@/stores/commandStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { useExecutionStore } from '@/stores/executionStore'
import { useToastStore } from '@/stores/toastStore'
import { useI18n } from '@/i18n'
import { call } from '@/lib/ipc'
import { formatRelativeTime } from '@/lib/utils'
import { ConfirmDialog, EmptyState } from '@/components/ui'

/**
 * 命令历史（侧栏「历史」页）：
 * 全局搜索所有会话的历史命令，可一键重新执行或收藏为常用命令。
 */
export function HistoryPanel(): React.JSX.Element {
  const { t } = useI18n()
  const connections = useConnectionStore((s) => s.connections)
  const [entries, setEntries] = useState<CommandHistoryEntry[]>([])
  const [keyword, setKeyword] = useState('')
  const [connectionId, setConnectionId] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)

  /*
   * 请求序号：每次 reload 先 +1，回来时只认最后一次。
   * 关键词是逐字触发的，慢请求后到就会把快请求的结果盖掉 ——
   * 表现为「搜索框写着 abc，列表却是 ab 的结果」，而且不会自己恢复。
   */
  const reqRef = useRef(0)
  const reload = async (): Promise<void> => {
    const seq = ++reqRef.current
    const list = await call(
      window.api.history.list({
        keyword: keyword.trim() || undefined,
        connectionId: connectionId || undefined,
        limit: 300
      }),
      { silent: true }
    )
    if (seq !== reqRef.current) return
    setEntries(list ?? [])
  }

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, connectionId])

  const rerun = (e: CommandHistoryEntry): void => {
    useExecutionStore.getState().requestRun({
      name: t('panel.history.rerunName'),
      template: e.command,
      variables: [],
      confirmRequired: false,
      source: 'manual'
    })
  }

  const favorite = async (e: CommandHistoryEntry): Promise<void> => {
    const name = e.command.length > 30 ? `${e.command.slice(0, 30)}…` : e.command
    const saved = await call(
      window.api.command.save({
        name,
        command: e.command,
        description: t('panel.history.favoriteDesc', { name: e.connectionName }),
        group: t('panel.history.favoriteGroup'),
        confirmRequired: false,
        variables: []
      }),
      { errorTitle: t('panel.history.favoriteError') }
    )
    if (saved) {
      await useCommandStore.getState().load()
      useToastStore.getState().push({
        kind: 'success',
        title: t('panel.history.favoriteSuccess'),
        detail: t('panel.history.favoriteSuccessDetail')
      })
    }
  }

  return (
    <div className="flex h-full flex-col">
      {/*
       * 头部：和连接/命令/日志面板对齐成同一高度，切面板时内容不跳
       */}
      <div className="panel-head">
        <History size={13} className="shrink-0 text-ink-3" />
        <span className="panel-title">{t('panel.history.title')}</span>
        <span className="panel-count">{entries.length}</span>
        <span className="flex-1" />
        <button
          className="btn-icon h-6 w-6"
          title={t('panel.history.clearTitle')}
          onClick={() => setConfirmClear(true)}
        >
          <Eraser size={13} />
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
            placeholder={t('panel.history.searchPlaceholder')}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <select
          className="input h-7 w-[104px] shrink-0 text-2xs"
          value={connectionId}
          onChange={(e) => setConnectionId(e.target.value)}
          title={t('panel.history.filterByConn')}
        >
          <option value="">{t('panel.history.allConns')}</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <div className="panel-body">
        {entries.length === 0 && (
          <EmptyState
            icon={<Play size={24} />}
            title={t('panel.history.emptyTitle')}
            hint={t('panel.history.emptyHint')}
          />
        )}

        {entries.map((e) => (
          <div
            key={e.id}
            className="group rounded-md px-2 py-1.5 transition-colors hover:bg-hover/60"
          >
            <div className="selectable truncate font-mono text-2xs text-ink-2" title={e.command}>
              {e.command}
            </div>
            <div className="mt-1 flex items-center gap-1.5 text-3xs text-ink-3">
              <span>{formatRelativeTime(e.executedAt)}</span>
              <span className="text-ink-3/50">·</span>
              <span className="truncate">{e.connectionName}</span>
              {e.source === 'snippet' && (
                <span className="rounded-sm border border-accent/30 px-1 text-accent/80">
                  {t('panel.history.sourceSnippet')}
                </span>
              )}
              <span className="flex-1" />
              <button
                className="btn-icon h-5 w-5 opacity-0 group-hover:opacity-100"
                title={t('panel.history.rerun')}
                onClick={() => rerun(e)}
              >
                <Play size={11} />
              </button>
              <button
                className="btn-icon h-5 w-5 opacity-0 group-hover:opacity-100"
                title={t('panel.history.favorite')}
                onClick={() => void favorite(e)}
              >
                <Star size={11} />
              </button>
            </div>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={confirmClear}
        title={t('panel.history.clearDialogTitle')}
        danger
        confirmText={t('panel.history.clearConfirm')}
        message={
          connectionId
            ? t('panel.history.clearMessageFiltered')
            : t('panel.history.clearMessageAll')
        }
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          setConfirmClear(false)
          void call(window.api.history.clear(connectionId || undefined)).then(() => void reload())
        }}
      />
    </div>
  )
}
