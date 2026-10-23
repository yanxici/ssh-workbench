import { useState } from 'react'
import {
  Archive,
  ArchiveRestore,
  FileText,
  FolderOpen,
  GitCompare,
  Plus,
  RefreshCw,
  Trash2,
  X
} from 'lucide-react'
import type { BackupDiffResult, BackupMeta } from '@shared/types'
import { cn, formatBytes, formatTime } from '@/lib/utils'
import { ConfirmDialog, EmptyState, Field, Modal } from '@/components/ui'
import { useBackupStore } from '@/stores/backupStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useToastStore } from '@/stores/toastStore'

/**
 * 配置备份对比（覆盖主区域）：
 * 备份设备配置文件到本地 → 与设备当前内容逐文件对比（行级 diff）→ 一键还原（自动留 .bak）。
 */
export function BackupPanel(): JSX.Element | null {
  const panelOpen = useBackupStore((s) => s.panelOpen)
  const backups = useBackupStore((s) => s.backups)
  const selectedId = useBackupStore((s) => s.selectedId)

  if (!panelOpen) return null

  const close = (): void => useBackupStore.setState({ panelOpen: false })

  return (
    <div className="fixed inset-x-0 bottom-[26px] top-[38px] z-30 flex flex-col bg-app">
      {/* 标题栏 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3">
        <Archive size={14} className="text-accent" />
        <span className="text-xs font-semibold">配置备份对比</span>
        <span className="text-2xs text-ink-3">{backups.length} 份备份</span>
        <span className="flex-1" />
        <button className="btn h-7 px-3 text-xs" onClick={() => useBackupStore.getState().setCreateOpen(true)}>
          <Plus size={12} />
          新建备份
        </button>
        <button
          className="btn-icon"
          title="打开备份目录"
          onClick={() => void window.api.backups.openDir()}
        >
          <FolderOpen size={14} />
        </button>
        <button className="btn-icon" title="刷新" onClick={() => void useBackupStore.getState().load()}>
          <RefreshCw size={14} />
        </button>
        <button className="btn-icon" title="关闭 (Esc)" onClick={close}>
          <X size={14} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左：备份列表 */}
        <div className="scroll-thin w-[280px] shrink-0 overflow-y-auto border-r border-edge bg-panel p-1.5">
          {backups.length === 0 && (
            <div className="px-2 py-4 text-2xs leading-relaxed text-ink-3">
              还没有备份。点右上角「新建备份」，把设备上的配置文件（如 /etc/config、/etc/network/interfaces）
              采回本地存档。
            </div>
          )}
          {backups.map((b) => (
            <BackupRow key={b.id} backup={b} selected={b.id === selectedId} />
          ))}
        </div>

        {/* 右：详情 */}
        <div className="min-w-0 flex-1">
          {selectedId ? <BackupDetailView /> : <EmptyState icon={<Archive size={30} />} title="选择或新建一份备份" hint="备份后可与设备当前配置逐行对比，出问题时一键还原（原文件自动留 .bak）" />}
        </div>
      </div>

      <CreateBackupModal />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  左侧行
 * ------------------------------------------------------------------ */

function BackupRow({ backup, selected }: { backup: BackupMeta; selected: boolean }): JSX.Element {
  const [confirming, setConfirming] = useState(false)
  return (
    <div
      className={cn(
        'group mb-0.5 flex cursor-default items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors',
        selected ? 'bg-accent/15' : 'hover:bg-hover/60'
      )}
      onClick={() => void useBackupStore.getState().select(backup.id)}
    >
      <Archive size={12} className={cn('shrink-0', selected ? 'text-accent' : 'text-ink-3')} />
      <div className="min-w-0 flex-1">
        <div className={cn('truncate text-xs', selected ? 'text-ink' : 'text-ink-2')}>
          {backup.name}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-3xs text-ink-3">
          <span className="truncate">{backup.host}</span>
          <span>·</span>
          <span>{formatTime(backup.createdAt)}</span>
          <span>·</span>
          <span className="font-mono">{backup.fileCount} 文件</span>
        </div>
      </div>
      <button
        className="btn-icon h-5 w-5 shrink-0 opacity-0 hover:text-danger group-hover:opacity-100"
        title="删除备份"
        onClick={(e) => {
          e.stopPropagation()
          setConfirming(true)
        }}
      >
        <Trash2 size={11} />
      </button>

      <ConfirmDialog
        open={confirming}
        title="删除备份"
        danger
        confirmText="删除"
        message={
          <>
            确定删除备份
            <span className="font-medium text-ink">「{backup.name}」</span>吗？该操作不可撤销。
          </>
        }
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          void useBackupStore.getState().remove(backup.id)
        }}
      />
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  右侧详情
 * ------------------------------------------------------------------ */

function BackupDetailView(): JSX.Element {
  const detail = useBackupStore((s) => s.detail)
  const diffs = useBackupStore((s) => s.diffs)
  const diffPath = useBackupStore((s) => s.diffPath)
  const diff = useBackupStore((s) => s.diff)
  const diffing = useBackupStore((s) => s.diffing)
  const diffAllRunning = useBackupStore((s) => s.diffAllRunning)

  const sessions = useSessionStore((s) => s.sessions)
  const connected = sessions.filter((s) => s.status === 'connected')
  const compareSessionId = useBackupStore((s) => s.compareSessionId)

  const [confirmRestoreAll, setConfirmRestoreAll] = useState(false)
  const [pendingRestore, setPendingRestore] = useState<string | null>(null)

  if (!detail) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-2xs text-ink-3">
        <RefreshCw size={12} className="animate-spin" />
        读取备份中…
      </div>
    )
  }

  const restorable = detail.files.filter((f) => f.content !== undefined)

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 概览 + 工具栏 */}
      <div className="shrink-0 border-b border-edge-soft px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-ink">{detail.name}</span>
          <span className="font-mono text-2xs text-ink-3">
            {detail.connectionName}（{detail.host}） · {formatTime(detail.createdAt)} ·{' '}
            {formatBytes(detail.totalSize)}
          </span>
          <span className="flex-1" />
        </div>

        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <span className="text-2xs text-ink-3">对比会话</span>
          <select
            className="input h-7 w-[240px]"
            value={compareSessionId ?? ''}
            onChange={(e) => useBackupStore.getState().setCompareSessionId(e.target.value)}
          >
            <option value="">选择一台在线设备…</option>
            {connected.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}（{s.username}@{s.host}）
              </option>
            ))}
          </select>
          <button
            className="btn h-7 px-3 text-xs"
            disabled={!compareSessionId || diffAllRunning}
            onClick={() => void useBackupStore.getState().diffAll()}
          >
            <GitCompare size={12} />
            {diffAllRunning ? '对比中…' : '与设备对比全部'}
          </button>
          <span className="flex-1" />
          <button
            className="btn h-7 px-3 text-xs"
            disabled={!compareSessionId || restorable.length === 0}
            onClick={() => setConfirmRestoreAll(true)}
          >
            <ArchiveRestore size={12} />
            还原全部（{restorable.length}）
          </button>
        </div>

        <div className="mt-1.5 flex flex-wrap gap-1">
          {detail.paths.map((p) => (
            <span key={p} className="rounded bg-raised px-1.5 py-px font-mono text-3xs text-ink-3">
              {p}
            </span>
          ))}
        </div>
      </div>

      {/* 文件列表 */}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {detail.files.length === 0 && (
          <div className="px-3 py-4 text-2xs text-ink-3">这份备份里还没有文件。</div>
        )}
        {detail.files.map((f) => {
          const d = diffs[f.path]
          return (
            <div
              key={f.path}
              className={cn(
                'flex cursor-default items-center gap-2 border-b border-edge-soft/60 px-3 py-1.5 hover:bg-hover/40',
                diffPath === f.path && 'bg-accent/10'
              )}
              onClick={() => {
                if (!d && !f.error && compareSessionId) void useBackupStore.getState().runDiff(f.path)
                else if (d) useBackupStore.setState({ diffPath: f.path, diff: d })
              }}
            >
              <FileText size={12} className="shrink-0 text-ink-3" />
              <span className="min-w-0 flex-1 truncate font-mono text-2xs text-ink-2">
                {f.path}
              </span>
              <span className="shrink-0 font-mono text-3xs text-ink-3">
                {f.size > 0 ? formatBytes(f.size) : ''}
              </span>
              <DiffStatusChip entry={f.error} diff={d} />
              <button
                className="btn h-6 shrink-0 px-2 text-2xs"
                disabled={f.content === undefined || !compareSessionId}
                title="把备份内容写回设备（原文件自动改名 .bak）"
                onClick={(e) => {
                  e.stopPropagation()
                  setPendingRestore(f.path)
                }}
              >
                还原
              </button>
            </div>
          )
        })}
      </div>

      {/* 差异视图 */}
      {diffPath && (
        <div className="flex h-[42%] min-h-[200px] shrink-0 flex-col border-t border-edge">
          <div className="flex shrink-0 items-center gap-2 border-b border-edge-soft bg-panel px-3 py-1">
            <span className="font-mono text-2xs text-ink-2">{diffPath}</span>
            {diff && (
              <span className="text-3xs text-ink-3">
                {diff.status === 'same' && '无差异'}
                {diff.status === 'changed' && (
                  <>
                    <span className="text-success">+{diff.added}</span> /{' '}
                    <span className="text-danger">-{diff.removed}</span>
                  </>
                )}
                {diff.status === 'remote-missing' && '设备上已不存在'}
                {diff.status === 'error' && '无法读取'}
              </span>
            )}
            {diffing && <RefreshCw size={11} className="animate-spin text-accent" />}
            <span className="flex-1" />
            <span className="text-3xs text-ink-3">绿=设备新增 · 红=设备删除（相对备份）</span>
            <button
              className="btn h-6 px-2 text-2xs"
              disabled={!compareSessionId}
              onClick={() => void useBackupStore.getState().runDiff(diffPath)}
            >
              <RefreshCw size={11} />
              重新对比
            </button>
            <button className="btn-icon h-6 w-6" onClick={() => useBackupStore.setState({ diffPath: null })}>
              <X size={11} />
            </button>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-auto bg-app px-2 py-1.5 font-mono text-2xs leading-[1.5]">
            {!diff && <div className="text-ink-3">对比中…</div>}
            {diff?.status === 'same' && (
              <div className="py-3 text-center text-ink-3">设备当前内容与备份完全一致 ✓</div>
            )}
            {diff?.error && <div className="py-2 text-danger">{diff.error}</div>}
            {diff?.lines.map((line, i) => (
              <div
                key={i}
                className={cn(
                  'whitespace-pre-wrap break-words px-1',
                  line.type === 'add' && 'bg-success/10 text-success',
                  line.type === 'del' && 'bg-danger/10 text-danger',
                  line.type === 'same' && 'text-ink-3'
                )}
              >
                {line.type === 'add' ? '+ ' : line.type === 'del' ? '- ' : '  '}
                {line.text}
              </div>
            ))}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingRestore !== null}
        title="还原此文件"
        danger
        confirmText="还原"
        message={
          <>
            将把备份内容写回设备：
            <div className="mt-1 selectable break-all font-mono text-2xs text-ink-3">{pendingRestore}</div>
            <div className="mt-2 text-2xs text-ink-3">
              设备上的原文件会先自动改名为 <span className="font-mono">.bak</span>，可用于回退。
            </div>
          </>
        }
        onCancel={() => setPendingRestore(null)}
        onConfirm={() => {
          const path = pendingRestore
          setPendingRestore(null)
          if (path) void useBackupStore.getState().restore([path])
        }}
      />

      <ConfirmDialog
        open={confirmRestoreAll}
        title="还原全部文件"
        danger
        confirmText={`还原 ${restorable.length} 个文件`}
        message={
          <>
            将把这份备份里的 {restorable.length} 个文件全部写回设备
            <span className="font-medium text-ink">{detail.host}</span>。
            <div className="mt-2 text-2xs text-danger">
              批量还原可能影响设备网络/服务，请确认设备当前状态后再执行（原文件会自动留 .bak）。
            </div>
          </>
        }
        onCancel={() => setConfirmRestoreAll(false)}
        onConfirm={() => {
          setConfirmRestoreAll(false)
          void useBackupStore.getState().restore(restorable.map((f) => f.path))
        }}
      />
    </div>
  )
}

function DiffStatusChip({
  entry,
  diff
}: {
  entry?: string
  diff?: BackupDiffResult
}): JSX.Element {
  if (entry) {
    return <span className="shrink-0 rounded bg-warning/10 px-1 py-px text-3xs text-warning" title={entry}>读取失败</span>
  }
  if (!diff) {
    return <span className="shrink-0 rounded bg-raised px-1 py-px text-3xs text-ink-3">未对比</span>
  }
  const map = {
    same: ['bg-success/10 text-success', '一致'],
    changed: ['bg-warning/10 text-warning', `有差异 +${diff.added}/-${diff.removed}`],
    'remote-missing': ['bg-danger/10 text-danger', '设备上不存在'],
    error: ['bg-danger/10 text-danger', '读取失败']
  } as const
  const [cls, label] = map[diff.status]
  return <span className={cn('shrink-0 rounded px-1 py-px text-3xs', cls)}>{label}</span>
}

/* ------------------------------------------------------------------ *
 *  新建备份
 * ------------------------------------------------------------------ */

const DEFAULT_PATHS = '/etc/config\n/etc/network/interfaces\n/etc/hosts'

function CreateBackupModal(): JSX.Element {
  const open = useBackupStore((s) => s.createOpen)
  const sessions = useSessionStore((s) => s.sessions)
  const connected = sessions.filter((s) => s.status === 'connected')

  const [sessionId, setSessionId] = useState('')
  const [name, setName] = useState('')
  const [paths, setPaths] = useState(DEFAULT_PATHS)
  const [saving, setSaving] = useState(false)

  const chosen = connected.find((s) => s.id === sessionId)

  const submit = async (): Promise<void> => {
    if (!sessionId) {
      useToastStore.getState().push({ kind: 'warning', title: '请选择要备份的设备会话' })
      return
    }
    setSaving(true)
    const ok = await useBackupStore
      .getState()
      .create(
        sessionId,
        name.trim() || `${chosen?.title ?? '设备'} 配置备份`,
        paths.split('\n')
      )
    setSaving(false)
    if (ok) {
      setName('')
      setPaths(DEFAULT_PATHS)
    }
  }

  return (
    <Modal
      open={open}
      title="新建配置备份"
      onClose={() => useBackupStore.getState().setCreateOpen(false)}
      footer={
        <>
          <button className="btn h-7 px-3 text-xs" onClick={() => useBackupStore.getState().setCreateOpen(false)}>
            取消
          </button>
          <button className="btn btn-primary h-7 px-3.5 text-xs" disabled={saving} onClick={() => void submit()}>
            {saving ? '采集中…' : '开始备份'}
          </button>
        </>
      }
    >
      <div className="space-y-3.5">
        <Field label="设备会话（需在线）">
          <select className="input selectable" value={sessionId} onChange={(e) => setSessionId(e.target.value)}>
            <option value="">选择一台在线设备…</option>
            {connected.map((s) => (
              <option key={s.id} value={s.id}>
                {s.title}（{s.username}@{s.host}）
              </option>
            ))}
          </select>
        </Field>
        <Field label="备份名称">
          <input
            className="input selectable"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={chosen ? `${chosen.title} 配置备份` : '例如：A区 现场配置'}
          />
        </Field>
        <Field
          label="要备份的路径（每行一个，可以是文件或目录）"
          hint="目录会递归采集（深度 ≤ 4 层、单文件 ≤ 512 KB、总量 ≤ 8 MB）"
        >
          <textarea
            className="textarea selectable min-h-[88px] font-mono text-2xs leading-relaxed"
            value={paths}
            onChange={(e) => setPaths(e.target.value)}
            placeholder={'/etc/config\n/etc/network/interfaces'}
          />
        </Field>
      </div>
    </Modal>
  )
}
