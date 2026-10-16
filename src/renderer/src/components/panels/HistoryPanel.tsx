import { useEffect, useState } from 'react'
import { Eraser, Play, Search, Star } from 'lucide-react'
import type { CommandHistoryEntry } from '@shared/types'
import { useCommandStore } from '@/stores/commandStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { useExecutionStore } from '@/stores/executionStore'
import { useToastStore } from '@/stores/toastStore'
import { call } from '@/lib/ipc'
import { formatRelativeTime } from '@/lib/utils'
import { ConfirmDialog, EmptyState } from '@/components/ui'

/**
 * 命令历史（侧栏「历史」页）：
 * 全局搜索所有会话的历史命令，可一键重新执行或收藏为常用命令。
 */
export function HistoryPanel(): JSX.Element {
  const connections = useConnectionStore((s) => s.connections)
  const [entries, setEntries] = useState<CommandHistoryEntry[]>([])
  const [keyword, setKeyword] = useState('')
  const [connectionId, setConnectionId] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)

  const reload = async (): Promise<void> => {
    const list = await call(
      window.api.history.list({
        keyword: keyword.trim() || undefined,
        connectionId: connectionId || undefined,
        limit: 300
      }),
      { silent: true }
    )
    setEntries(list ?? [])
  }

  useEffect(() => {
    void reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyword, connectionId])

  const rerun = (e: CommandHistoryEntry): void => {
    useExecutionStore.getState().requestRun({
      name: '历史命令',
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
        description: `来自 ${e.connectionName} 的历史命令`,
        group: '收藏',
        confirmRequired: false,
        variables: []
      }),
      { errorTitle: '收藏失败' }
    )
    if (saved) {
      await useCommandStore.getState().load()
      useToastStore.getState().push({
        kind: 'success',
        title: '已收藏为常用命令',
        detail: '可在「常用命令」面板的「收藏」分组中找到'
      })
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-1.5 border-b border-edge-soft p-2">
        <div className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            className="input pl-7"
            placeholder="搜索历史命令…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
        </div>
        <div className="flex items-center gap-1.5">
          <select
            className="input h-6 flex-1 text-2xs"
            value={connectionId}
            onChange={(e) => setConnectionId(e.target.value)}
          >
            <option value="">全部连接</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            className="btn-icon h-6 w-6 shrink-0"
            title="清空历史"
            onClick={() => setConfirmClear(true)}
          >
            <Eraser size={13} />
          </button>
        </div>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1.5">
        {entries.length === 0 && (
          <EmptyState
            icon={<Play size={24} />}
            title="暂无历史记录"
            hint="在终端中执行（或通过常用命令发送）的命令会出现在这里，可收藏为常用命令"
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
            <div className="mt-1 flex items-center gap-1.5 text-[10px] text-ink-3">
              <span>{formatRelativeTime(e.executedAt)}</span>
              <span className="text-ink-3/50">·</span>
              <span className="truncate">{e.connectionName}</span>
              {e.source === 'snippet' && (
                <span className="rounded-sm border border-accent/30 px-1 text-accent/80">
                  命令库
                </span>
              )}
              <span className="flex-1" />
              <button
                className="btn-icon h-5 w-5 opacity-0 group-hover:opacity-100"
                title="重新执行"
                onClick={() => rerun(e)}
              >
                <Play size={11} />
              </button>
              <button
                className="btn-icon h-5 w-5 opacity-0 group-hover:opacity-100"
                title="收藏为常用命令"
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
        title="清空命令历史"
        danger
        confirmText="清空"
        message={
          <>
            确定要清空{connectionId ? '当前筛选连接' : '全部'}的命令历史吗？该操作不可撤销。
          </>
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
