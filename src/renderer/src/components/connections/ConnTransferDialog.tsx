import type * as React from 'react'
import { useMemo, useState } from 'react'
import { AlertTriangle, FileDown, FileUp, Loader2 } from 'lucide-react'
import type { ConnImportMode, ConnImportPreview } from '@shared/types'
import { groupConnections, useConnectionStore } from '@/stores/connectionStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { useToastStore } from '@/stores/toastStore'
import { call } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { Field, Modal, Segmented, Toggle } from '@/components/ui'
import { isImeComposing } from '@/lib/ime'
import type { ExternalImportPreview, ExternalImportSource } from '@shared/types'
import { useI18n, type I18nKey } from '@/i18n'

const DEFAULT_GROUP = '\u9ed8\u8ba4'

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
  const { t } = useI18n()
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
    if (count === 0) return t('conn.ui.export.errSelectGroup')
    if (usePass && pass.length < 4) return t('conn.ui.export.errPassLength')
    if (usePass && pass !== pass2) return t('conn.ui.export.errPassMismatch')
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
      { errorTitle: t('conn.ui.export.failed') }
    )
    setBusy(false)
    if (!res || res.canceled) return

    const warns: string[] = []
    if (res.noPassword > 0) warns.push(t('conn.ui.export.warnNoPassword', { count: res.noPassword }))
    if (res.missingKeys > 0) warns.push(t('conn.ui.export.warnMissingKeys', { count: res.missingKeys }))
    if (res.droppedJumps > 0) warns.push(t('conn.ui.export.warnDroppedJumps', { count: res.droppedJumps }))
    useToastStore.getState().push({
      kind: warns.length > 0 ? 'warning' : 'success',
      title: t('conn.ui.export.done', {
        count: res.count,
        keySuffix: includeSecrets ? t('conn.ui.export.doneKeySuffix', { count: res.keyCount }) : ''
      }),
      detail: [res.path, ...warns].join(t('conn.ui.listSep'))
    })
    onClose()
  }

  return (
    <Modal
      open
      title={t('conn.ui.export.title')}
      onClose={onClose}
      width="max-w-lg"
      footer={
        <>
          {error && <span className="mr-auto text-2xs text-warning">{error}</span>}
          <button className="btn" onClick={onClose}>
            {t('conn.ui.cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy || Boolean(error)} onClick={() => void submit()}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <FileDown size={13} />}
            {t('conn.ui.export.submit', { count })}
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label={t('conn.ui.export.scope')} hint={t('conn.ui.export.scopeHint', { count: groups.length })}>
          <div className="mb-1.5 flex gap-3 text-2xs">
            <button
              className="text-accent hover:underline"
              onClick={() => setSelected(new Set(groups.map((g) => g.group)))}
            >
              {t('conn.ui.selectAll')}
            </button>
            <button className="text-accent hover:underline" onClick={() => setSelected(new Set())}>
              {t('conn.ui.selectNone')}
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
                <span className="min-w-0 flex-1 truncate">
                  {g.group === DEFAULT_GROUP ? t('conn.ui.defaultGroup') : g.group}
                </span>
                <span className="text-2xs text-ink-3">{g.items.length}</span>
              </label>
            ))}
          </div>
        </Field>

        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-ink">{t('conn.ui.export.includeSecrets')}</div>
            <div className="mt-0.5 text-2xs leading-relaxed text-ink-3">
              {t('conn.ui.export.includeSecretsHint')}
            </div>
          </div>
          <Toggle checked={includeSecrets} onChange={setIncludeSecrets} />
        </div>

        <div>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs text-ink">{t('conn.ui.export.usePass')}</div>
              <div className="mt-0.5 text-2xs leading-relaxed text-ink-3">
                {t('conn.ui.export.usePassHint')}
              </div>
            </div>
            <Toggle checked={usePass} onChange={setUsePass} />
          </div>
          {usePass && (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <input
                className="input selectable"
                type="password"
                placeholder={t('conn.ui.export.passPlaceholder')}
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                autoFocus
              />
              <input
                className="input selectable"
                type="password"
                placeholder={t('conn.ui.export.passConfirmPlaceholder')}
                value={pass2}
                onChange={(e) => setPass2(e.target.value)}
              />
            </div>
          )}
        </div>

        {includeSecrets && !usePass && (
          <div className="flex gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-2xs leading-relaxed text-warning">
            <AlertTriangle size={13} className="mt-px shrink-0" />
            {t('conn.ui.export.plaintextWarning')}
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
    const res = await call(window.api.conn.importPick(), {
      errorTitle: t('conn.ui.import.readFailed')
    })
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
      useToastStore
        .getState()
        .push({ kind: 'error', title: t('conn.ui.import.readFailed'), detail: res.error })
      onClose()
    }
  }

  const apply = async (): Promise<void> => {
    if (!file) return
    setBusy(true)
    const res = await call(
      window.api.conn.importApply(file.path, file.encrypted ? pass : undefined, mode),
      { errorTitle: t('conn.ui.import.failed') }
    )
    setBusy(false)
    if (!res) return
    await load()
    const parts = [t('conn.ui.import.partAdded', { count: res.added })]
    if (res.updated > 0) parts.push(t('conn.ui.import.partUpdated', { count: res.updated }))
    if (res.skipped > 0) parts.push(t('conn.ui.import.partSkipped', { count: res.skipped }))
    if (res.invalid > 0) parts.push(t('conn.ui.import.partInvalid', { count: res.invalid }))
    const details: string[] = []
    if (res.keysWritten > 0) {
      details.push(t('conn.ui.import.detailKeysWritten', { count: res.keysWritten }))
    }
    if (res.invalidKeys > 0) {
      details.push(t('conn.ui.import.detailInvalidKeys', { count: res.invalidKeys }))
    }
    /*
     * 端口待确认要在导入完成的提示里说清楚：用户以为导入完就能连，
     * 结果点开发现连不上（本机没有那个 COM 号），会以为是导入坏了。
     */
    if (res.pendingPorts > 0) {
      details.push(t('conn.ui.import.detailPendingPorts', { count: res.pendingPorts }))
    }
    useToastStore.getState().push({
      kind: res.pendingPorts > 0 ? 'warning' : 'success',
      title: t('conn.ui.import.done', { summary: parts.join(t('conn.ui.commaSep')) }),
      detail: details.length > 0 ? details.join(t('conn.ui.listSep')) : undefined
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
      title={t('conn.ui.import.title')}
      onClose={onClose}
      width="max-w-lg"
      footer={
        <>
          <button className="btn" onClick={onClose}>
            {t('conn.ui.cancel')}
          </button>
          {page === 'backup' ? (
            needPass ? (
              <button
                className="btn btn-primary"
                disabled={busy || !pass || !file}
                onClick={() => void loadPreview(file?.path ?? '', pass)}
              >
                {busy && <Loader2 size={13} className="animate-spin" />}
                {t('conn.ui.import.unlock')}
              </button>
            ) : (
              <button
                className="btn btn-primary"
                disabled={busy || !preview}
                onClick={() => void apply()}
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <FileUp size={13} />}
                {t('conn.ui.import.submit')}
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
        <Segmented
          value={page}
          onChange={setPage}
          options={[
            { value: 'backup', label: t('conn.extImport.tab.backup') },
            { value: 'external', label: t('conn.extImport.tab.external') }
          ]}
        />

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
          <Field label={t('conn.ui.import.filePass')} hint={t('conn.ui.import.filePassHint')}>
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

        {/*
         * 只有真的在等文件解析时才转圈。
         * 旧条件是「没口令 && 没预览」，而刚打开对话框时这两个都成立 ——
         * 用户看到的是一个永远转下去的「正在读取…」，明明还没选文件。
         */}
        {file && !needPass && !preview && (
          <div className="flex items-center gap-2 text-xs text-ink-3">
            <Loader2 size={13} className="animate-spin" />
            {t('conn.ui.import.reading')}
          </div>
        )}

        {preview && (
          <>
            <div className="grid grid-cols-3 gap-2 text-center">
              <Stat label={t('conn.ui.import.statConnections')} value={preview.count} />
              <Stat label={t('conn.ui.import.statSecrets')} value={preview.withSecrets} />
              <Stat label={t('conn.ui.import.statKeys')} value={preview.keyCount} />
            </div>

            {preview.serialCount > 0 && (
              <div className="text-2xs leading-relaxed text-ink-3">
                {t('conn.ui.import.serialSummary', { count: preview.serialCount })}
                {preview.pendingPorts > 0
                  ? t('conn.ui.import.serialPending', { count: preview.pendingPorts })
                  : t('conn.ui.import.serialMatched')}
              </div>
            )}

            <GroupList label={t('conn.ui.import.groupsLabel')} groups={preview.groups} />

            {preview.duplicates > 0 && (
              <Field
                label={t('conn.extImport.duplicatesLabel')}
                hint={t('conn.extImport.duplicates', { count: preview.duplicates })}
              >
                <Segmented
                  value={mode}
                  onChange={setMode}
                  options={[
                    { value: 'skip', label: t('conn.extImport.duplicatesSkip') },
                    { value: 'overwrite', label: t('conn.ui.import.duplicatesOverwrite') }
                  ]}
                />
              </Field>
            )}

            {preview.invalid > 0 && (
              <div className="text-2xs text-warning">
                {t('conn.ui.import.invalidIgnored', { count: preview.invalid })}
              </div>
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
  const { t } = useI18n()
  return (
    <Field label={label} hint={String(groups.length)}>
      <div className="scroll-thin max-h-32 overflow-y-auto rounded-md border border-edge-soft bg-app px-2.5 py-1.5 text-xs text-ink-2">
        {groups.map((g) => (
          <div key={g.name} className="flex justify-between py-0.5">
            <span className="truncate">
              {g.name === DEFAULT_GROUP ? t('conn.ui.defaultGroup') : g.name}
            </span>
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
      <Segmented
        value={mode}
        onChange={onChange}
        options={[
          { value: 'skip', label: labels.skip },
          { value: 'overwrite', label: labels.overwrite }
        ]}
      />
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
