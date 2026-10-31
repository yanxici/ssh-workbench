import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, FileDown, FileUp, Loader2 } from 'lucide-react'
import type { ConnImportMode, ConnImportPreview } from '@shared/types'
import { groupConnections, useConnectionStore } from '@/stores/connectionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useToastStore } from '@/stores/toastStore'
import { call } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { Field, Modal, Toggle } from '@/components/ui'
import { isImeComposing } from '@/lib/ime'

/**
 * 连接导出 / 导入：导出文件发给同事，对方导入后直接可用
 * （密码在对方机器上重新加密保存，私钥写入对方数据目录并改写路径）。
 */
export function ConnTransferDialog({
  mode,
  onClose
}: {
  mode: 'export' | 'import' | null
  onClose: () => void
}): JSX.Element | null {
  if (mode === 'export') return <ExportDialog onClose={onClose} />
  if (mode === 'import') return <ImportDialog onClose={onClose} />
  return null
}

/* ------------------------------------------------------------------ *
 *  导出
 * ------------------------------------------------------------------ */

function ExportDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const connections = useConnectionStore((s) => s.connections)
  // 空分组也要能选：用户可能刚建好分组就想把别的组导进去
  const savedGroups = useSettingsStore((s) => s.settings.connectionGroups)
  const savedOrder = useSettingsStore((s) => s.settings.connectionGroupOrder)
  const groups = useMemo(
    () => groupConnections(connections, '', savedGroups ?? [], savedOrder ?? []),
    [connections, savedGroups, savedOrder]
  )

  const [selected, setSelected] = useState<Set<string>>(() => new Set(groups.map((g) => g.group)))
  const [includeSecrets, setIncludeSecrets] = useState(true)
  const [usePass, setUsePass] = useState(false)
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [busy, setBusy] = useState(false)

  const count = groups.filter((g) => selected.has(g.group)).reduce((n, g) => n + g.items.length, 0)
  const allSelected = selected.size === groups.length

  const toggle = (g: string): void =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(g)) next.delete(g)
      else next.add(g)
      return next
    })

  const error = ((): string | null => {
    if (count === 0) return '请至少选择一个分组'
    if (usePass && pass.length < 4) return '口令至少 4 位'
    if (usePass && pass !== pass2) return '两次输入的口令不一致'
    return null
  })()

  const submit = async (): Promise<void> => {
    if (error) return
    setBusy(true)
    const res = await call(
      window.api.conn.exportToFile({
        groups: allSelected ? undefined : [...selected],
        includeSecrets,
        passphrase: usePass ? pass : undefined
      }),
      { errorTitle: '导出失败' }
    )
    setBusy(false)
    if (!res || res.canceled) return

    const warns: string[] = []
    if (res.noPassword > 0) warns.push(`${res.noPassword} 条密码连接本机没有可用密码`)
    if (res.missingKeys > 0) warns.push(`${res.missingKeys} 条私钥连接找不到私钥文件`)
    if (res.droppedJumps > 0) warns.push(`${res.droppedJumps} 个跳板机不在导出范围内，已去掉`)
    useToastStore.getState().push({
      kind: warns.length > 0 ? 'warning' : 'success',
      title: `已导出 ${res.count} 条连接${includeSecrets ? `，私钥 ${res.keyCount} 个` : ''}`,
      detail: [res.path, ...warns].join('；')
    })
    onClose()
  }

  return (
    <Modal
      open
      title="导出连接"
      onClose={onClose}
      width="max-w-lg"
      footer={
        <>
          {error && <span className="mr-auto text-2xs text-warning">{error}</span>}
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" disabled={busy || Boolean(error)} onClick={() => void submit()}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} />}
            导出 {count} 条
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="导出范围" hint={`共 ${groups.length} 个分组`}>
          <div className="mb-1.5 flex gap-3 text-2xs">
            <button
              className="text-accent hover:underline"
              onClick={() => setSelected(new Set(groups.map((g) => g.group)))}
            >
              全选
            </button>
            <button className="text-accent hover:underline" onClick={() => setSelected(new Set())}>
              全不选
            </button>
          </div>
          <div className="scroll-thin max-h-48 overflow-y-auto rounded-md border border-edge-soft bg-app p-1.5">
            {groups.map((g) => (
              <label
                key={g.group}
                className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-xs text-ink-2 hover:bg-hover/60"
              >
                <input
                  type="checkbox"
                  className="h-3 w-3 accent-[rgb(var(--c-accent))]"
                  checked={selected.has(g.group)}
                  onChange={() => toggle(g.group)}
                />
                <span className="min-w-0 flex-1 truncate">{g.group}</span>
                <span className="text-2xs text-ink-3">{g.items.length}</span>
              </label>
            ))}
          </div>
        </Field>

        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-ink">带上密码和私钥</div>
            <div className="mt-0.5 text-2xs leading-relaxed text-ink-3">
              对方导入后直接能登录。关闭则只导出连接信息，对方需自己补密码。
            </div>
          </div>
          <Toggle checked={includeSecrets} onChange={setIncludeSecrets} />
        </div>

        <div>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs text-ink">设置口令加密文件</div>
              <div className="mt-0.5 text-2xs leading-relaxed text-ink-3">
                导入时需要输入这个口令。口令忘了文件就打不开。
              </div>
            </div>
            <Toggle checked={usePass} onChange={setUsePass} />
          </div>
          {usePass && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <input
                className="input selectable"
                type="password"
                placeholder="口令（至少 4 位）"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                autoFocus
              />
              <input
                className="input selectable"
                type="password"
                placeholder="再输入一次"
                value={pass2}
                onChange={(e) => setPass2(e.target.value)}
              />
            </div>
          )}
        </div>

        {includeSecrets && !usePass && (
          <div className="flex gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-2xs leading-relaxed text-warning">
            <AlertTriangle size={13} className="mt-px shrink-0" />
            文件里是明文密码和私钥，拿到文件的人可以登录这些设备。建议设置口令，或只通过可信渠道发送。
          </div>
        )}
      </div>
    </Modal>
  )
}

/* ------------------------------------------------------------------ *
 *  导入
 * ------------------------------------------------------------------ */

function ImportDialog({ onClose }: { onClose: () => void }): JSX.Element | null {
  const load = useConnectionStore((s) => s.load)
  const [file, setFile] = useState<{ path: string; encrypted: boolean } | null>(null)
  const [pass, setPass] = useState('')
  const [preview, setPreview] = useState<ConnImportPreview | null>(null)
  const [mode, setMode] = useState<ConnImportMode>('skip')
  const [busy, setBusy] = useState(false)
  const [passError, setPassError] = useState<string | null>(null)

  // 打开即弹出选择文件；取消选择则关闭
  useEffect(() => {
    let alive = true
    void call(window.api.conn.importPick(), { errorTitle: '无法读取文件' }).then((res) => {
      if (!alive) return
      if (!res || res.canceled || !res.path) {
        onClose()
        return
      }
      setFile({ path: res.path, encrypted: Boolean(res.encrypted) })
      if (!res.encrypted) void loadPreview(res.path)
    })
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadPreview = async (path: string, passphrase?: string): Promise<void> => {
    setBusy(true)
    setPassError(null)
    const res = await window.api.conn.importPreview(path, passphrase)
    setBusy(false)
    if (res.ok) setPreview(res.data)
    else if (passphrase !== undefined) setPassError(res.error)
    else {
      useToastStore.getState().push({ kind: 'error', title: '无法读取文件', detail: res.error })
      onClose()
    }
  }

  const apply = async (): Promise<void> => {
    if (!file) return
    setBusy(true)
    const res = await call(
      window.api.conn.importApply(file.path, file.encrypted ? pass : undefined, mode),
      { errorTitle: '导入失败' }
    )
    setBusy(false)
    if (!res) return
    await load()
    const parts = [`新增 ${res.added}`]
    if (res.updated > 0) parts.push(`覆盖 ${res.updated}`)
    if (res.skipped > 0) parts.push(`跳过重复 ${res.skipped}`)
    if (res.invalid > 0) parts.push(`格式不对忽略 ${res.invalid}`)
    useToastStore.getState().push({
      kind: 'success',
      title: `导入完成：${parts.join('，')}`,
      detail: res.keysWritten > 0 ? `已保存 ${res.keysWritten} 个私钥文件` : undefined
    })
    onClose()
  }

  if (!file) return null

  const needPass = file.encrypted && !preview

  return (
    <Modal
      open
      title="导入连接"
      onClose={onClose}
      width="max-w-lg"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          {needPass ? (
            <button
              className="btn btn-primary"
              disabled={busy || !pass}
              onClick={() => void loadPreview(file.path, pass)}
            >
              {busy && <Loader2 size={13} className="animate-spin" />}
              解锁
            </button>
          ) : (
            <button className="btn btn-primary" disabled={busy || !preview} onClick={() => void apply()}>
              {busy ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />}
              导入
            </button>
          )}
        </>
      }
    >
      <div className="space-y-4">
        <div className="selectable break-all font-mono text-2xs text-ink-3">{file.path}</div>

        {needPass && (
          <Field label="文件口令" hint="导出时设置的口令">
            <input
              className="input selectable"
              type="password"
              value={pass}
              autoFocus
              onChange={(e) => setPass(e.target.value)}
              onKeyDown={(e) => {
                if (isImeComposing(e)) return
                if (e.key === 'Enter' && pass) void loadPreview(file.path, pass)
              }}
            />
            {passError && <div className="mt-1.5 text-2xs text-danger">{passError}</div>}
          </Field>
        )}

        {!needPass && !preview && (
          <div className="flex items-center gap-2 text-xs text-ink-3">
            <Loader2 size={13} className="animate-spin" />
            正在读取…
          </div>
        )}

        {preview && (
          <>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Stat label="连接" value={preview.count} />
              <Stat label="带凭据" value={preview.withSecrets} />
              <Stat label="私钥文件" value={preview.keyCount} />
            </div>

            <Field label="包含分组" hint={`${preview.groups.length} 个`}>
              <div className="scroll-thin max-h-32 overflow-y-auto rounded-md border border-edge-soft bg-app px-2.5 py-1.5 text-xs text-ink-2">
                {preview.groups.map((g) => (
                  <div key={g.name} className="flex justify-between py-0.5">
                    <span className="truncate">{g.name}</span>
                    <span className="text-2xs text-ink-3">{g.count}</span>
                  </div>
                ))}
              </div>
            </Field>

            {preview.duplicates > 0 && (
              <Field label="重复连接" hint={`${preview.duplicates} 条与本机已有连接相同（名称、地址、端口、用户名都一样）`}>
                <div className="flex gap-2">
                  {(
                    [
                      ['skip', '跳过，保留本机的'],
                      ['overwrite', '用文件里的覆盖']
                    ] as const
                  ).map(([v, label]) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setMode(v)}
                      className={cn(
                        'h-7 flex-1 rounded-md border text-xs transition-colors',
                        mode === v
                          ? 'border-accent/60 bg-accent/15 text-accent'
                          : 'border-edge bg-raised text-ink-3 hover:text-ink-2'
                      )}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </Field>
            )}

            {preview.invalid > 0 && (
              <div className="text-2xs text-warning">{preview.invalid} 条格式不对，会被忽略。</div>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

function Stat({ label, value }: { label: string; value: number }): JSX.Element {
  return (
    <div className="rounded-md border border-edge-soft bg-app py-2">
      <div className="text-base font-semibold text-ink">{value}</div>
      <div className="text-2xs text-ink-3">{label}</div>
    </div>
  )
}
