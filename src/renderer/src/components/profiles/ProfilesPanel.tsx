import { useEffect, useMemo, useState } from 'react'
import {
  BookUser,
  ExternalLink,
  FileText,
  ListFilter,
  Plus,
  Save,
  Search,
  Terminal,
  Trash2,
  Undo2,
  X
} from 'lucide-react'
import type { Connection, DeviceProfile, DeviceProfileInput } from '@shared/types'
import { cn, formatTime } from '@/lib/utils'
import { ConfirmDialog, EmptyState, Field } from '@/components/ui'
import { useProfileStore } from '@/stores/profileStore'
import { useConnectionStore } from '@/stores/connectionStore'
import { useSessionStore } from '@/stores/sessionStore'
import { useLayoutStore } from '@/stores/layoutStore'
import { useCommandStore } from '@/stores/commandStore'
import { useDiagStore } from '@/stores/diagStore'
import { useToastStore } from '@/stores/toastStore'

/**
 * 客户 / 设备档案面板（覆盖主区域）。
 * 左侧档案列表；右侧详情：基本信息编辑 + 关联连接 + 该客户诊断报告 + 常用命令分组。
 */
export function ProfilesPanel(): JSX.Element | null {
  const panelOpen = useProfileStore((s) => s.panelOpen)
  const profiles = useProfileStore((s) => s.profiles)
  const keyword = useProfileStore((s) => s.keyword)
  const selectedId = useProfileStore((s) => s.selectedId)

  // 打开时确保报告列表可用（用于「该客户的诊断报告」）
  useEffect(() => {
    if (panelOpen) void useDiagStore.getState().loadReports()
  }, [panelOpen])

  if (!panelOpen) return null

  const close = (): void => useProfileStore.setState({ panelOpen: false })

  const kw = keyword.trim().toLowerCase()
  const filtered = kw
    ? profiles.filter(
        (p) =>
          p.customerName.toLowerCase().includes(kw) ||
          (p.deviceModel ?? '').toLowerCase().includes(kw) ||
          (p.sn ?? '').toLowerCase().includes(kw) ||
          (p.project ?? '').toLowerCase().includes(kw)
      )
    : profiles

  const selected = profiles.find((p) => p.id === selectedId) ?? null

  const createNew = (): void => {
    useProfileStore.getState().select('__new__')
  }

  return (
    <div className="fixed inset-x-0 bottom-[26px] top-[38px] z-30 flex flex-col bg-app">
      {/* 标题栏 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3">
        <BookUser size={14} className="text-accent" />
        <span className="text-xs font-semibold">客户 / 设备档案</span>
        <span className="text-2xs text-ink-3">{profiles.length} 份</span>
        <span className="flex-1" />
        <button className="btn h-7 px-3 text-xs" onClick={createNew}>
          <Plus size={12} />
          新建档案
        </button>
        <button className="btn-icon" title="关闭 (Esc)" onClick={close}>
          <X size={14} />
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左：档案列表 */}
        <div className="flex w-[280px] shrink-0 flex-col border-r border-edge bg-panel">
          <div className="shrink-0 p-2 pb-1.5">
            <div className="relative">
              <Search
                size={12}
                className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-ink-3"
              />
              <input
                className="input pl-7"
                placeholder="搜索客户 / 型号 / SN…"
                value={keyword}
                onChange={(e) => useProfileStore.getState().setKeyword(e.target.value)}
              />
            </div>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-1.5">
            {filtered.length === 0 && (
              <div className="px-2 py-4 text-2xs leading-relaxed text-ink-3">
                {profiles.length === 0
                  ? '还没有档案。点右上角「新建档案」，把客户、设备型号、SN、固件版本、工单等信息记在这里，并与连接、命令分组关联。'
                  : '没有匹配的档案'}
              </div>
            )}
            {filtered.map((p) => (
              <button
                key={p.id}
                className={cn(
                  'mb-0.5 flex w-full flex-col rounded-md px-2 py-1.5 text-left transition-colors',
                  p.id === selectedId ? 'bg-accent/15' : 'hover:bg-hover/60'
                )}
                onClick={() => useProfileStore.getState().select(p.id)}
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-xs',
                      p.id === selectedId ? 'text-ink' : 'text-ink-2'
                    )}
                  >
                    {p.customerName}
                  </span>
                  {p.connectionIds.length > 0 && (
                    <span className="shrink-0 font-mono text-3xs text-ink-3">
                      {p.connectionIds.length} 连接
                    </span>
                  )}
                </span>
                <span className="mt-0.5 truncate text-3xs text-ink-3">
                  {[p.deviceModel, p.project].filter(Boolean).join(' · ') || p.sn || '—'}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* 右：详情 */}
        <div className="min-w-0 flex-1">
          {selectedId === '__new__' || selected ? (
            <ProfileDetail
              key={selected?.id ?? '__new__'}
              profile={selected}
              // 保存成功后 store 已把选中态切到该档案，父组件 key 变化会以新数据重建详情
              onDone={() => undefined}
            />
          ) : (
            <EmptyState
              icon={<BookUser size={30} />}
              title="选择或新建一份档案"
              hint="档案把客户信息、现场设备（连接）、常用命令分组和历史诊断报告串在一起，出问题时一眼看清全貌"
            />
          )}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  详情 / 编辑
 * ------------------------------------------------------------------ */

interface FormState {
  customerName: string
  project: string
  deviceModel: string
  sn: string
  firmwareVersion: string
  contact: string
  ticketNo: string
  commandGroup: string
  remark: string
  connectionIds: string[]
}

const EMPTY: FormState = {
  customerName: '',
  project: '',
  deviceModel: '',
  sn: '',
  firmwareVersion: '',
  contact: '',
  ticketNo: '',
  commandGroup: '',
  remark: '',
  connectionIds: []
}

function toForm(p: DeviceProfile | null): FormState {
  if (!p) return EMPTY
  return {
    customerName: p.customerName,
    project: p.project ?? '',
    deviceModel: p.deviceModel ?? '',
    sn: p.sn ?? '',
    firmwareVersion: p.firmwareVersion ?? '',
    contact: p.contact ?? '',
    ticketNo: p.ticketNo ?? '',
    commandGroup: p.commandGroup ?? '',
    remark: p.remark ?? '',
    connectionIds: p.connectionIds
  }
}

function ProfileDetail({
  profile,
  onDone
}: {
  profile: DeviceProfile | null
  onDone: () => void
}): JSX.Element {
  const isNew = profile === null
  const connections = useConnectionStore((s) => s.connections)
  const reports = useDiagStore((s) => s.reports)
  const commands = useCommandStore((s) => s.commands)

  const [form, setForm] = useState<FormState>(() => toForm(profile))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState(false)

  useEffect(() => setForm(toForm(profile)), [profile])

  const dirty = useMemo(
    () => JSON.stringify(form) !== JSON.stringify(toForm(profile)),
    [form, profile]
  )

  const set = <K extends keyof FormState>(key: K, value: FormState[K]): void => {
    setForm((f) => ({ ...f, [key]: value }))
  }

  const toggleConnection = (id: string): void => {
    setForm((f) => ({
      ...f,
      connectionIds: f.connectionIds.includes(id)
        ? f.connectionIds.filter((x) => x !== id)
        : [...f.connectionIds, id]
    }))
  }

  const submit = async (): Promise<void> => {
    if (!form.customerName.trim()) return setError('请填写客户名称')
    setSaving(true)
    setError(null)
    const input: DeviceProfileInput = {
      id: profile?.id,
      customerName: form.customerName,
      project: form.project,
      deviceModel: form.deviceModel,
      sn: form.sn,
      firmwareVersion: form.firmwareVersion,
      contact: form.contact,
      ticketNo: form.ticketNo,
      commandGroup: form.commandGroup,
      remark: form.remark,
      connectionIds: form.connectionIds
    }
    const saved = await useProfileStore.getState().save(input)
    setSaving(false)
    if (saved) onDone()
  }

  /* ---------- 关联信息 ---------- */

  const linkedConnections: Connection[] = connections.filter((c) =>
    form.connectionIds.includes(c.id)
  )
  const linkedNames = new Set(linkedConnections.map((c) => c.name))
  const linkedReports = reports.filter((r) => linkedNames.has(r.connectionName))
  const groupCommands = form.commandGroup.trim()
    ? commands.filter((c) => c.group === form.commandGroup.trim())
    : []

  const openSession = (c: Connection): void => {
    useSessionStore.getState().open({ id: c.id, name: c.name, host: c.host, username: c.username })
    useProfileStore.setState({ panelOpen: false })
  }

  const openReport = async (id: string): Promise<void> => {
    useProfileStore.setState({ panelOpen: false })
    useDiagStore.setState({ panelOpen: true })
    await useDiagStore.getState().viewReport(id)
  }

  const filterCommands = (): void => {
    if (!form.commandGroup.trim()) return
    useCommandStore.getState().setKeyword(form.commandGroup.trim())
    // 命令栏常驻在窗口右侧，不再是活动栏里的一个视图：这里只要确保它展开，
    // 关键字已经写进 commandStore，CommandPanel 会自己筛。
    useLayoutStore.getState().setCommandRailVisible(true)
    useProfileStore.setState({ panelOpen: false })
    useToastStore.getState().push({
      kind: 'info',
      title: `已在常用命令面板筛选「${form.commandGroup.trim()}」`
    })
  }

  return (
    <div className="scroll-thin h-full overflow-y-auto p-4">
      {/* 操作条 */}
      <div className="mb-3 flex items-center gap-2">
        <span className="text-sm font-semibold text-ink">
          {isNew ? '新建档案' : form.customerName || '未命名客户'}
        </span>
        {!isNew && (
          <span className="text-2xs text-ink-3">更新于 {formatTime(profile.updatedAt)}</span>
        )}
        <span className="flex-1" />
        {dirty && (
          <>
            <button
              className="btn h-7 px-2.5 text-xs"
              onClick={() => {
                setForm(toForm(profile))
                setError(null)
              }}
            >
              <Undo2 size={12} />
              取消
            </button>
            <button
              className="btn btn-primary h-7 px-3 text-xs"
              disabled={saving}
              onClick={() => void submit()}
            >
              <Save size={12} />
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        )}
        {!isNew && !dirty && (
          <button
            className="btn h-7 px-2.5 text-xs hover:text-danger"
            onClick={() => setPendingDelete(true)}
          >
            <Trash2 size={12} />
            删除档案
          </button>
        )}
      </div>

      {error && <div className="mb-2 text-2xs text-danger">{error}</div>}

      <div className="flex max-w-[760px] flex-col gap-5">
        {/* 基本信息 */}
        <div className="rounded-lg border border-edge-soft bg-panel p-3.5">
          <div className="mb-2.5 text-2xs font-semibold tracking-wide text-ink-3">基本信息</div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-3">
            <Field label="客户名称 *">
              <input
                className="input selectable"
                value={form.customerName}
                onChange={(e) => set('customerName', e.target.value)}
                placeholder="例如：某某客户"
              />
            </Field>
            <Field label="项目">
              <input
                className="input selectable"
                value={form.project}
                onChange={(e) => set('project', e.target.value)}
                placeholder="例如：网关项目二期"
              />
            </Field>
            <Field label="设备型号">
              <input
                className="input selectable"
                value={form.deviceModel}
                onChange={(e) => set('deviceModel', e.target.value)}
                placeholder="例如：XR-2000"
              />
            </Field>
            <Field label="序列号 SN">
              <input
                className="input selectable font-mono"
                value={form.sn}
                onChange={(e) => set('sn', e.target.value)}
                placeholder="例如：XR2000-2024-0137"
              />
            </Field>
            <Field label="固件版本">
              <input
                className="input selectable font-mono"
                value={form.firmwareVersion}
                onChange={(e) => set('firmwareVersion', e.target.value)}
                placeholder="例如：v2.3.1"
              />
            </Field>
            <Field label="现场联系人">
              <input
                className="input selectable"
                value={form.contact}
                onChange={(e) => set('contact', e.target.value)}
                placeholder="姓名 / 电话"
              />
            </Field>
            <Field label="工单号">
              <input
                className="input selectable font-mono"
                value={form.ticketNo}
                onChange={(e) => set('ticketNo', e.target.value)}
                placeholder="例如：FW-2026-1014"
              />
            </Field>
            <Field label="常用命令分组" hint="与右侧命令面板的分组名一致，可一键筛选该客户在用的命令">
              <input
                className="input selectable"
                value={form.commandGroup}
                onChange={(e) => set('commandGroup', e.target.value)}
                placeholder="例如：某某客户"
              />
            </Field>
            <Field label="备注" className="col-span-2">
              <input
                className="input selectable"
                value={form.remark}
                onChange={(e) => set('remark', e.target.value)}
                placeholder="现场环境、特殊约定等"
              />
            </Field>
          </div>
        </div>

        {/* 关联连接 */}
        <div className="rounded-lg border border-edge-soft bg-panel p-3.5">
          <div className="mb-2.5 flex items-center gap-2">
            <span className="text-2xs font-semibold tracking-wide text-ink-3">
              关联连接（{form.connectionIds.length}）
            </span>
            <span className="text-2xs text-ink-3/70">勾选属于该客户的设备连接</span>
          </div>
          {connections.length === 0 ? (
            <div className="text-2xs text-ink-3">还没有任何连接，先在左侧「连接」页添加设备。</div>
          ) : (
            <div className="scroll-thin grid max-h-[168px] grid-cols-2 gap-1 overflow-y-auto pr-1">
              {connections.map((c) => {
                const on = form.connectionIds.includes(c.id)
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={cn(
                      'flex items-center gap-1.5 rounded-md border px-2 py-1 text-left text-xs transition-colors',
                      on
                        ? 'border-accent/50 bg-accent/10 text-ink'
                        : 'border-edge bg-raised/60 text-ink-3 hover:text-ink-2'
                    )}
                    onClick={() => toggleConnection(c.id)}
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      /*
                       * 这里原来写的是 `var(--c-accent, <GitHub 暗色板的亮蓝>)` —— 两个错：
                       * 1) `--c-accent` 存的是三通道数值（如「37 99 235」），不用 rgb()
                       *    包起来作为 background 是无效值，圆点会直接透明；
                       * 2) 回退色是暗色板专用，在浅色主题上过于刺眼。
                       * 正确写法是 rgb(var(--c-accent))，回退交给 index.css 的 :root。
                       */
                      style={{ background: c.color || 'rgb(var(--c-accent))' }}
                    />
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    <span className="shrink-0 font-mono text-3xs text-ink-3">{c.host}</span>
                  </button>
                )
              })}
            </div>
          )}
          {!isNew && linkedConnections.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {linkedConnections.map((c) => (
                <button
                  key={c.id}
                  className="btn h-6 px-2 text-2xs"
                  title={`打开 ${c.username}@${c.host} 的会话`}
                  onClick={() => openSession(c)}
                >
                  <Terminal size={11} />
                  连接 {c.name}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* 关联信息（只读） */}
        {!isNew && (
          <div className="rounded-lg border border-edge-soft bg-panel p-3.5">
            <div className="mb-2.5 text-2xs font-semibold tracking-wide text-ink-3">
              关联信息（自动汇总）
            </div>
            <div className="space-y-2.5">
              {/* 诊断报告 */}
              <div>
                <div className="mb-1 flex items-center gap-1.5">
                  <FileText size={11} className="text-ink-3" />
                  <span className="text-2xs text-ink-2">
                    诊断报告 <span className="text-ink-3">（{linkedReports.length} 份）</span>
                  </span>
                  {linkedReports.length === 0 && (
                    <span className="text-2xs text-ink-3/70">
                      关联的连接还没有生成过诊断报告
                    </span>
                  )}
                </div>
                {linkedReports.length > 0 && (
                  <div className="scroll-thin max-h-[132px] space-y-1 overflow-y-auto pr-1">
                    {linkedReports.slice(0, 12).map((r) => (
                      <button
                        key={r.id}
                        className="flex w-full items-center gap-2 rounded-md border border-edge-soft px-2 py-1 text-left transition-colors hover:bg-hover/50"
                        onClick={() => void openReport(r.id)}
                      >
                        <span className="min-w-0 flex-1 truncate text-2xs text-ink-2">
                          {r.title}
                        </span>
                        <span
                          className={cn(
                            'shrink-0 rounded px-1 py-px text-3xs',
                            r.problemCount > 0
                              ? 'bg-danger/10 text-danger'
                              : 'bg-success/10 text-success'
                          )}
                        >
                          {r.okCount}/{r.sectionCount}
                        </span>
                        <span className="shrink-0 text-3xs text-ink-3">
                          {formatTime(r.startedAt)}
                        </span>
                        <ExternalLink size={10} className="shrink-0 text-ink-3" />
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* 常用命令 */}
              <div className="flex items-center gap-2">
                <ListFilter size={11} className="text-ink-3" />
                <span className="text-2xs text-ink-2">
                  常用命令分组{' '}
                  <span className="text-ink-3">
                    {form.commandGroup.trim() ? `「${form.commandGroup.trim()}」` : '（未设置）'}
                  </span>
                  {form.commandGroup.trim() && (
                    <span className="text-ink-3">：{groupCommands.length} 条</span>
                  )}
                </span>
                <span className="flex-1" />
                {form.commandGroup.trim() && groupCommands.length > 0 && (
                  <button className="btn h-6 px-2 text-2xs" onClick={filterCommands}>
                    在命令面板筛选
                  </button>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={pendingDelete}
        title="删除档案"
        danger
        confirmText="删除"
        message={
          <>
            确定删除档案
            <span className="font-medium text-ink">「{profile?.customerName}」</span>吗？
            <div className="mt-1 text-2xs text-ink-3">
              仅删除档案本身，不影响关联的连接、命令与报告。
            </div>
          </>
        }
        onCancel={() => setPendingDelete(false)}
        onConfirm={() => {
          setPendingDelete(false)
          if (profile) void useProfileStore.getState().remove(profile.id)
        }}
      />
    </div>
  )
}
