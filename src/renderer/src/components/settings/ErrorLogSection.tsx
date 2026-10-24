import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Copy, FileDown, RefreshCw, Search, Trash2, X } from 'lucide-react'
import type { ErrorEntry } from '@shared/types'
import { call } from '@/lib/ipc'
import { useToastStore } from '@/stores/toastStore'
import { cn } from '@/lib/utils'

/**
 * 错误日志面板（设置 → 错误日志）。
 *
 * 目标是「用户自己能定位问题」而不是「开发者看堆栈」：
 * - 默认只显示标题和来源，点开才看详情 —— 一屏能放下更多条目；
 * - 相同错误已由主进程聚合（×N），这里直接展示次数；
 * - 一键复制单条 / 导出全部，方便贴给同事或提 issue。
 */
export function ErrorLogSection(): JSX.Element {
  const [entries, setEntries] = useState<ErrorEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())

  const reload = (): void => {
    setLoading(true)
    void call(window.api.errors.list(), { silent: true })
      .then((list) => setEntries(list ?? []))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    reload()
  }, [])

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return entries
    return entries.filter(
      (e) =>
        e.title.toLowerCase().includes(kw) ||
        e.source.toLowerCase().includes(kw) ||
        (e.detail ?? '').toLowerCase().includes(kw)
    )
  }, [entries, keyword])

  const totalCount = useMemo(() => entries.reduce((n, e) => n + e.count, 0), [entries])

  const fmt = (ts: number): string => {
    const d = new Date(ts)
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  }

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const copyOne = (e: ErrorEntry): void => {
    const text = [
      `[${e.level}] ${fmt(e.at)} ×${e.count}`,
      `来源：${e.source}`,
      `标题：${e.title}`,
      e.detail ? `详情：${e.detail}` : ''
    ]
      .filter(Boolean)
      .join('\n')
    void navigator.clipboard.writeText(text)
    useToastStore.getState().push({ kind: 'success', title: '已复制到剪贴板' })
  }

  return (
    <div className="space-y-2">
      {/* 工具条 */}
      <div className="flex items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search
            size={11}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3"
          />
          <input
            className="input h-7 py-0 pl-6 pr-6 text-xs"
            placeholder="搜索标题 / 来源 / 详情…"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          {keyword && (
            <button
              className="absolute right-1 top-1/2 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-ink-3 hover:text-ink"
              onClick={() => setKeyword('')}
              title="清空"
            >
              <X size={11} />
            </button>
          )}
        </div>
        <button className="btn-icon h-7 w-7" title="刷新" onClick={reload}>
          <RefreshCw size={12} className={cn(loading && 'animate-spin')} />
        </button>
        <button
          className="btn-icon h-7 w-7"
          title="导出为文本文件"
          disabled={entries.length === 0}
          onClick={() => {
            void call(window.api.errors.export(), { errorTitle: '导出失败' }).then((res) => {
              if (res && res.canceled === false) {
                useToastStore.getState().push({
                  kind: 'success',
                  title: '已导出错误日志',
                  detail: res.path
                })
              }
            })
          }}
        >
          <FileDown size={12} />
        </button>
        <button
          className="btn-icon h-7 w-7 hover:text-danger"
          title="清空全部错误日志"
          disabled={entries.length === 0}
          onClick={() => {
            void call(window.api.errors.clear(), { errorTitle: '清空失败' }).then(() => {
              setEntries([])
              useToastStore.getState().push({ kind: 'success', title: '已清空错误日志' })
            })
          }}
        >
          <Trash2 size={12} />
        </button>
      </div>

      <div className="text-3xs text-ink-3">
        {entries.length === 0
          ? '暂无错误记录。出现异常时这里会自动收集，可直接导出反馈。'
          : `${filtered.length} 类 / 累计 ${totalCount} 次` +
            (keyword ? `（已按「${keyword}」筛选）` : '')}
      </div>

      {/* 列表 */}
      <div className="space-y-1">
        {filtered.map((e) => {
          const open = expanded.has(e.id)
          return (
            <div
              key={e.id}
              className="rounded-md border border-edge-soft bg-panel px-2 py-1.5"
            >
              <div className="flex items-start gap-1.5">
                <AlertTriangle
                  size={11}
                  className={cn(
                    'mt-0.5 shrink-0',
                    e.level === 'warn' ? 'text-warning' : 'text-danger'
                  )}
                />
                <button
                  className="min-w-0 flex-1 text-left"
                  onClick={() => toggle(e.id)}
                  title="点击展开/收起详情"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-xs text-ink">{e.title}</span>
                    {e.count > 1 && (
                      <span className="shrink-0 rounded bg-raised px-1 font-mono text-3xs text-ink-3">
                        ×{e.count}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-3xs text-ink-3">
                    <span className="font-mono">{fmt(e.at)}</span>
                    <span className="truncate font-mono">{e.source}</span>
                    {e.version && <span className="shrink-0">v{e.version}</span>}
                  </div>
                  {open && e.detail && (
                    <pre className="selectable mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-app p-1.5 font-mono text-3xs text-ink-2">
                      {e.detail}
                    </pre>
                  )}
                </button>
                <button
                  className="btn-icon h-5 w-5 shrink-0"
                  title="复制这条"
                  onClick={() => copyOne(e)}
                >
                  <Copy size={10} />
                </button>
                <button
                  className="btn-icon h-5 w-5 shrink-0 hover:text-danger"
                  title="删除这条"
                  onClick={() => {
                    void call(window.api.errors.remove(e.id), { silent: true }).then(() => {
                      setEntries((prev) => prev.filter((x) => x.id !== e.id))
                    })
                  }}
                >
                  <Trash2 size={10} />
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
