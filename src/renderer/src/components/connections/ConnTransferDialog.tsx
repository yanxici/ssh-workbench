import type * as React from 'react'
import { useMemo, useState } from 'react'
import { AlertTriangle, FileDown, FileUp, Loader2 } from 'lucide-react'
import type { ConnImportMode, ConnImportPreview } from '@shared/types'
import { groupConnections, useConnectionStore } from '@/stores/connectionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useToastStore } from '@/stores/toastStore'
import { call } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { Field, Modal, Toggle } from '@/components/ui'
import { isImeComposing } from '@/lib/ime'
import type { ExternalImportPreview, ExternalImportSource } from '@shared/types'
import { useI18n, type I18nKey } from '@/i18n'

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
}): React.JSX.Element | null {
  if (mode === 'export') return <ExportDialog onClose={onClose} />
  if (mode === 'import') return <ImportDialog onClose={onClose} />
  return null
}

/* ------------------------------------------------------------------ *
 *  导出
 * ------------------------------------------------------------------ */

function ExportDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
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

function ImportDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const { t } = useI18n()
  const load = useConnectionStore((s) => s.load)
  const [file, setFile] = useState<{ path: string; encrypted: boolean } | null>(null)
  const [pass, setPass] = useState('')
  const [preview, setPreview] = useState<ConnImportPreview | null>(null)
  const [mode, setMode] = useState<ConnImportMode>('skip')
  const [busy, setBusy] = useState(false)
  const [passError, setPassError] = useState<string | null>(null)
  /** 顶部两页：本工具备份 / 其他客户端与 ~/.ssh/config */
  const [page, setPage] = useState<'backup' | 'external'>('backup')
  /** 外部客户端：source 决定用哪个解析器；extPaths 是主进程对话框选过并登记过的路径 */
  const [source, setSource] = useState<ExternalImportSource | null>(null)
  const [extPaths, setExtPaths] = useState<string[]>([])
  const [extPreview, setExtPreview] = useState<ExternalImportPreview | null>(null)
  const [extBusy, setExtBusy] = useState(false)

  /*
   * 打开弹窗不再自动弹文件选择框。
   * 顶部分成两页之后，自动弹框会先把只想导 MobaXterm 的人挡在门外：
   * 取消选择等于关掉整个弹窗，根本走不到外部导入那一页。
   */
  const pickBackupFile = async (): Promise<void> => {
    const res = await call(window.api.conn.importPick(), { errorTitle: '无法读取文件' })
    if (!res || res.canceled || !res.path) return
    setFile({ path: res.path, encrypted: Boolean(res.encrypted) })
    if (!res.encrypted) void loadPreview(res.path)
  }

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
    const details: string[] = []
    if (res.keysWritten > 0) details.push(`已保存 ${res.keysWritten} 个私钥文件`)
    /*
     * 端口待确认要在导入完成的提示里说清楚：用户以为导入完就能连，
     * 结果点开发现连不上（本机没有那个 COM 号），会以为是导入坏了。
     */
    if (res.pendingPorts > 0) {
      details.push(`${res.pendingPorts} 条串口连接的端口需要重新选择（对方机器上的 COM 号在本机不适用）`)
    }
    useToastStore.getState().push({
      kind: res.pendingPorts > 0 ? 'warning' : 'success',
      title: `导入完成：${parts.join('，')}`,
      detail: details.length > 0 ? details.join('；') : undefined
    })
    onClose()
  }

  /* ---------- 外部客户端：只读纯文本配置，永不解析各家加密过的密码 ---------- */

  const pickSource = async (next: ExternalImportSource): Promise<void> => {
    setSource(next)
    setExtPaths([])
    setExtPreview(null)
    setExtBusy(true)
    const picked = await call(window.api.conn.extImportPick(next), {
      errorTitle: t('conn.extImport.pickFailed')
    })
    if (!picked || picked.canceled || !picked.paths || picked.paths.length === 0) {
      setExtBusy(false)
      return
    }
    const res = await call(window.api.conn.extImportPreview(next, picked.paths), {
      errorTitle: t('conn.extImport.previewFailed')
    })
    setExtBusy(false)
    if (!res) return
    setExtPaths(picked.paths)
    setExtPreview(res)
  }

  const applyExternal = async (): Promise<void> => {
    if (!source || extPaths.length === 0) return
    setExtBusy(true)
    const res = await call(window.api.conn.extImportApply(source, extPaths, mode), {
      errorTitle: t('conn.extImport.importFailed')
    })
    setExtBusy(false)
    if (!res) return
    await load()
    useToastStore.getState().push({
      kind: res.added > 0 ? 'success' : 'warning',
      title: t('conn.extImport.done', { added: res.added }),
      detail: t('conn.extImport.doneDetail', {
        updated: res.updated,
        skipped: res.skipped,
        invalid: res.invalid
      })
    })
    onClose()
  }

  const needPass = Boolean(file?.encrypted) && !preview

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
          {page === 'backup' ? (
            needPass ? (
              <button
                className="btn btn-primary"
                disabled={busy || !pass || !file}
                onClick={() => void loadPreview(file?.path ?? '', pass)}
              >
                {busy && <Loader2 size={13} className="animate-spin" />}
                解锁
              </button>
            ) : (
              <button
                className="btn btn-primary"
                disabled={busy || !preview}
                onClick={() => void apply()}
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />}
                导入
              </button>
            )
          ) : (
            <button
              className="btn btn-primary"
              disabled={extBusy || !extPreview || extPreview.count === 0}
              onClick={() => void applyExternal()}
            >
              {extBusy ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />}
              {t('conn.extImport.import')}
            </button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={() => setPage('backup')}
            className={cn(
              'h-7 flex-1 rounded-md border text-xs transition-colors',
              page === 'backup'
                ? 'border-accent/60 bg-accent/15 text-accent'
                : 'border-edge bg-raised text-ink-3 hover:text-ink-2'
            )}
          >
            {t('conn.extImport.tab.backup')}
          </button>
          <button
            type="button"
            onClick={() => setPage('external')}
            className={cn(
              'h-7 flex-1 rounded-md border text-xs transition-colors',
              page === 'external'
                ? 'border-accent/60 bg-accent/15 text-accent'
                : 'border-edge bg-raised text-ink-3 hover:text-ink-2'
            )}
          >
            {t('conn.extImport.tab.external')}
          </button>
        </div>

        {page === 'backup' && (
          <>
            {!file && (
              <button className="btn w-full" disabled={busy} onClick={() => void pickBackupFile()}>
                <FileUp size={13} />
                {t('conn.transfer.pick')}
              </button>
            )}

            {file && (
              <div className="selectable break-all font-mono text-2xs text-ink-3">{file.path}</div>
            )}

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
                if (e.key === 'Enter' && pass) void loadPreview(file?.path ?? '', pass)
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

            {preview.serialCount > 0 && (
              <div className="text-2xs leading-relaxed text-ink-3">
                其中 {preview.serialCount} 条是串口连接。
                {preview.pendingPorts > 0
                  ? ` 有 ${preview.pendingPorts} 条的端口在本机找不到，导入后需要重新选择端口才能连接。`
                  : ' 端口已按 USB 身份对上，导入后可直接使用。'}
              </div>
            )}

            <GroupList label="包含分组" groups={preview.groups} />

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
          </>
        )}

        {page === 'external' && (
          <>
            <div className="flex flex-wrap gap-1.5">
              {EXT_SOURCES.map((s) => (
                <button
                  key={s.value}
                  type="button"
                  disabled={extBusy}
                  onClick={() => void pickSource(s.value)}
                  className={cn(
                    'h-7 rounded-md border px-2.5 text-xs transition-colors',
                    source === s.value
                      ? 'border-accent/60 bg-accent/15 text-accent'
                      : 'border-edge bg-raised text-ink-3 hover:text-ink-2',
                    extBusy && 'opacity-60'
                  )}
                >
                  {t(s.labelKey)}
                </button>
              ))}
            </div>

            <div className="flex gap-2 rounded-md border border-edge-soft bg-app/60 px-3 py-2 text-2xs leading-relaxed text-ink-3">
              <AlertTriangle size={13} className="mt-px shrink-0" />
              <span>{t('conn.extImport.hint')}</span>
            </div>

            {extBusy && (
              <div className="flex items-center gap-2 text-xs text-ink-3">
                <Loader2 size={13} className="animate-spin" />
                {t('conn.extImport.loading')}
              </div>
            )}

            {!extBusy && extPreview && extPreview.count === 0 && (
              <div className="text-2xs text-warning">{t('conn.extImport.empty')}</div>
            )}

            {!extBusy && extPreview && extPreview.count > 0 && (
              <>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <Stat label={t('conn.extImport.statCount')} value={extPreview.count} />
                  <Stat label={t('conn.extImport.statGroups')} value={extPreview.groups.length} />
                  <Stat label={t('conn.extImport.statFiles')} value={extPreview.files} />
                </div>

                {extPreview.withoutPasswordCount > 0 && (
                  <div className="text-2xs leading-relaxed text-ink-3">
                    {t('conn.extImport.needPassword', { count: extPreview.withoutPasswordCount })}
                  </div>
                )}

                <GroupList
                  label={t('conn.extImport.statGroups')}
                  groups={extPreview.groups}
                />

                {extPreview.duplicates > 0 && (
                  <DupMode
                    labels={{
                      label: t('conn.extImport.duplicatesLabel'),
                      hint: t('conn.extImport.duplicates', { count: extPreview.duplicates }),
                      skip: t('conn.extImport.duplicatesSkip'),
                      overwrite: t('conn.extImport.duplicatesOverwrite')
                    }}
                    mode={mode}
                    onChange={setMode}
                  />
                )}

                {(extPreview.skippedNonSsh > 0 || extPreview.invalid > 0) && (
                  <div className="text-2xs text-warning">
                    {t('conn.extImport.skipped', {
                      nonSsh: extPreview.skippedNonSsh,
                      invalid: extPreview.invalid
                    })}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}

function Stat({ label, value }: { label: string; value: number }): React.JSX.Element {
  return (
    <div className="rounded-md border border-edge-soft bg-app py-2">
      <div className="text-base font-semibold text-ink">{value}</div>
      <div className="text-2xs text-ink-3">{label}</div>
    </div>
  )
}

/** 分组分布：导入前先看清这批连接会落在哪些分组里 */
function GroupList({
  label,
  groups
}: {
  label: string
  groups: Array<{ name: string; count: number }>
}): React.JSX.Element {
  return (
    <Field label={label} hint={String(groups.length)}>
      <div className="scroll-thin max-h-32 overflow-y-auto rounded-md border border-edge-soft bg-app px-2.5 py-1.5 text-xs text-ink-2">
        {groups.map((g) => (
          <div key={g.name} className="flex justify-between py-0.5">
            <span className="truncate">{g.name}</span>
            <span className="text-2xs text-ink-3">{g.count}</span>
          </div>
        ))}
      </div>
    </Field>
  )
}

/** 重复连接的处理方式：备份导入与外部导入共用同一套选中态 */
function DupMode({
  labels,
  mode,
  onChange
}: {
  labels: { label: string; hint: string; skip: string; overwrite: string }
  mode: ConnImportMode
  onChange: (mode: ConnImportMode) => void
}): React.JSX.Element {
  return (
    <Field label={labels.label} hint={labels.hint}>
      <div className="flex gap-2">
        {(
          [
            ['skip', labels.skip],
            ['overwrite', labels.overwrite]
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            type="button"
            onClick={() => onChange(v)}
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
  )
}

/** 五个外部来源；ssh_config 最通用放最前，MobaXterm 次之 */
const EXT_SOURCES: Array<{ value: ExternalImportSource; labelKey: I18nKey }> = [
  { value: 'ssh-config', labelKey: 'conn.extImport.source.sshConfig' },
  { value: 'mobaxterm', labelKey: 'conn.extImport.source.mobaxterm' },
  { value: 'xshell', labelKey: 'conn.extImport.source.xshell' },
  { value: 'securecrt', labelKey: 'conn.extImport.source.securecrt' },
  { value: 'finalshell', labelKey: 'conn.extImport.source.finalshell' }
]
