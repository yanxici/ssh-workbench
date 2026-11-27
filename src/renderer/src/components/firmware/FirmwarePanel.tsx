import type * as React from 'react'
import { useState, type ReactNode } from 'react'
import {
  CheckCircle2,
  Circle,
  FileUp,
  Loader2,
  Play,
  RotateCcw,
  Rocket,
  ShieldCheck,
  Timer,
  X
} from 'lucide-react'
import { cn, formatBytes } from '@/lib/utils'
import { useI18n } from '@/i18n'
import { useOverlayEscape } from '@/lib/overlayKeys'
import { ConfirmDialog } from '@/components/ui'
import { expandFilePlaceholder, shellQuotePath, useFirmwareStore } from '@/stores/firmwareStore'
import { useSftpStore } from '@/stores/sftpStore'
import { useSshSessions } from '@/stores/sessionStore'

/**
 * 固件升级助手（覆盖主区域）：选择 → 上传 → 校验 → 升级 → 重启等待 → 启动日志。
 * 每一步都有明确的状态与产物，升级命令完全可编辑（兼容各家厂商脚本）。
 */
export function FirmwarePanel(): React.JSX.Element | null {
  const { t } = useI18n()
  const panelOpen = useFirmwareStore((s) => s.panelOpen)

  const close = (): void => useFirmwareStore.setState({ panelOpen: false })
  // 面板按钮上写着「关闭 (Esc)」，这里必须真的响应 Esc
  useOverlayEscape(panelOpen, close)
  if (!panelOpen) return null

  return (
    <div className="panel-shell fixed inset-x-0 z-30 flex flex-col bg-app">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3">
        <Rocket size={14} className="text-accent" />
        <span className="text-xs font-semibold">{t('panel.firmware.title')}</span>
        <span className="text-2xs text-ink-3">{t('panel.firmware.subtitle')}</span>
        <span className="flex-1" />
        <button className="btn-icon" title={t('panel.firmware.closeEsc')} onClick={close}>
          <X size={14} />
        </button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex max-w-[860px] flex-col gap-3">
          <TargetBar />
          <StepSelectFile />
          <StepUpload />
          <StepVerify />
          <StepUpgrade />
          <StepReboot />
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  通用步骤卡片
 * ------------------------------------------------------------------ */

function StepCard({
  index,
  title,
  hint,
  status,
  children
}: {
  index: number
  title: string
  hint?: string
  status: 'todo' | 'doing' | 'done' | 'warn'
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-edge-soft bg-panel">
      <div className="flex items-center gap-2 border-b border-edge-soft px-3 py-2">
        <span
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-3xs',
            status === 'done'
              ? 'border-success/50 bg-success/10 text-success'
              : status === 'doing'
                ? 'border-accent/60 bg-accent/15 text-accent'
                : status === 'warn'
                  ? 'border-warning/60 bg-warning/10 text-warning'
                  : 'border-edge text-ink-3'
          )}
        >
          {status === 'done' ? <CheckCircle2 size={12} /> : index}
        </span>
        <span className="text-xs font-semibold text-ink">{title}</span>
        {hint && <span className="truncate text-2xs text-ink-3">{hint}</span>}
        <span className="flex-1" />
        {status === 'doing' && <Loader2 size={12} className="animate-spin text-accent" />}
        {status === 'todo' && <Circle size={10} className="text-ink-3/50" />}
      </div>
      <div className="p-3">{children}</div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  目标设备
 * ------------------------------------------------------------------ */

function TargetBar(): React.JSX.Element {
  const { t } = useI18n()
  // 固件升级靠 SFTP 传包 + 远端命令，串口会话在这里选了也只会报「仅支持 SSH」
  const sessions = useSshSessions()
  const sessionId = useFirmwareStore((s) => s.sessionId)
  const connected = sessions.filter((s) => s.status === 'connected')

  return (
    <div className="flex items-center gap-2 rounded-lg border border-edge-soft bg-panel px-3 py-2">
      <span className="text-2xs text-ink-3">{t('panel.firmware.targetDevice')}</span>
      <select
        className="input h-7 w-[280px]"
        value={sessionId ?? ''}
        onChange={(e) => useFirmwareStore.getState().setSessionId(e.target.value)}
      >
        <option value="">{t('panel.firmware.selectDevice')}</option>
        {connected.map((s) => (
          <option key={s.id} value={s.id}>
            {t('panel.firmware.sessionOption', { title: s.title, target: s.target })}
          </option>
        ))}
      </select>
      {connected.length === 0 && (
        <span className="text-2xs text-warning">{t('panel.firmware.noOnlineSession')}</span>
      )}
      <span className="flex-1" />
      <span className="text-3xs leading-relaxed text-ink-3">
        {t('panel.firmware.diagTip')}
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  ① 选择固件
 * ------------------------------------------------------------------ */

function StepSelectFile(): React.JSX.Element {
  const { t } = useI18n()
  const file = useFirmwareStore((s) => s.file)
  return (
    <StepCard index={1} title={t('panel.firmware.step1Title')} status={file ? 'done' : 'todo'}>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn h-7 px-3 text-xs" onClick={() => void useFirmwareStore.getState().pickFile()}>
          <FileUp size={12} />
          {file ? t('panel.firmware.reselect') : t('panel.firmware.browseFile')}
        </button>
        {file && (
          <span className="min-w-0 text-xs text-ink-2">
            <span className="font-medium">{file.name}</span>
            <span className="ml-2 font-mono text-2xs text-ink-3">
              {formatBytes(file.size)} · {file.path}
            </span>
          </span>
        )}
      </div>
    </StepCard>
  )
}

/* ------------------------------------------------------------------ *
 *  ② 上传
 * ------------------------------------------------------------------ */

function StepUpload(): React.JSX.Element {
  const { t } = useI18n()
  const file = useFirmwareStore((s) => s.file)
  const remoteDir = useFirmwareStore((s) => s.remoteDir)
  const uploadTaskId = useFirmwareStore((s) => s.uploadTaskId)
  const uploadedPath = useFirmwareStore((s) => s.uploadedPath)
  const uploading = useFirmwareStore((s) => s.uploading)

  const transfers = useSftpStore((s) => s.transfers)
  const task = transfers.find((t) => t.id === uploadTaskId)

  /*
   * 上传完成 → 记录远端路径这条链路已移到 sftpStore.applyProgress：
   * 面板关掉（含按 Esc）后组件内 useEffect 不再运行，上传完成态会永久丢失；
   * 而且组件里无法只在「本轮」触发，重传时会把旧固件路径复活。
   */

  const pct = task && task.total > 0 ? Math.round((task.transferred / task.total) * 100) : 0

  return (
    <StepCard
      index={2}
      title={t('panel.firmware.step2Title')}
      hint={t('panel.firmware.step2Hint')}
      status={uploadedPath ? 'done' : uploading || (task && task.status === 'running') ? 'doing' : 'todo'}
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-2xs text-ink-3">{t('panel.firmware.uploadDir')}</span>
        <input
          className="input h-7 w-[220px] font-mono"
          value={remoteDir}
          onChange={(e) => useFirmwareStore.getState().setRemoteDir(e.target.value)}
          placeholder="/tmp"
        />
        <button
          className="btn h-7 px-3 text-xs"
          disabled={!file || uploading || task?.status === 'running'}
          onClick={() => void useFirmwareStore.getState().startUpload()}
        >
          <FileUp size={12} />
          {t('panel.firmware.startUpload')}
        </button>
        {uploadedPath && (
          <span className="min-w-0 flex-1 truncate font-mono text-2xs text-success">
            {t('panel.firmware.uploadedAt', { path: uploadedPath })}
          </span>
        )}
      </div>

      {task && (task.status === 'running' || task.status === 'pending') && (
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-raised">
            <div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${pct}%` }} />
          </div>
          <span className="shrink-0 font-mono text-2xs text-ink-3">
            {pct}%{task.speedBps ? ` · ${formatBytes(task.speedBps)}/s` : ''}
          </span>
        </div>
      )}
      {task?.status === 'error' && (
        <div className="mt-2 text-2xs text-danger">
          {t('panel.firmware.uploadFailed', { error: task.error ?? '' })}
        </div>
      )}
    </StepCard>
  )
}

/* ------------------------------------------------------------------ *
 *  ③ 校验
 * ------------------------------------------------------------------ */

function StepVerify(): React.JSX.Element {
  const { t } = useI18n()
  const uploadedPath = useFirmwareStore((s) => s.uploadedPath)
  const verifying = useFirmwareStore((s) => s.verifying)
  const verify = useFirmwareStore((s) => s.verify)

  return (
    <StepCard
      index={3}
      title={t('panel.firmware.step3Title')}
      hint={t('panel.firmware.step3Hint')}
      status={verify ? (verify.match ? 'done' : 'warn') : verifying ? 'doing' : 'todo'}
    >
      <div className="flex items-center gap-2">
        <button
          className="btn h-7 px-3 text-xs"
          disabled={!uploadedPath || verifying}
          onClick={() => void useFirmwareStore.getState().startVerify()}
        >
          <ShieldCheck size={12} />
          {t('panel.firmware.startVerify')}
        </button>
        {!uploadedPath && (
          <span className="text-2xs text-ink-3">{t('panel.firmware.uploadFirst')}</span>
        )}
      </div>

      {verify && (
        <div className="mt-2 space-y-1 font-mono text-3xs leading-relaxed">
          <div className="text-ink-3">
            {t('panel.firmware.localHash', { algo: verify.algo })}
            <span className="text-ink-2">{verify.localHash}</span>
          </div>
          <div className="text-ink-3">
            {t('panel.firmware.remoteHash', { algo: verify.algo })}
            <span className="text-ink-2">{verify.remoteHash}</span>
          </div>
          <div className={verify.match ? 'text-success' : 'text-danger'}>
            {verify.match ? t('panel.firmware.verifyMatch') : t('panel.firmware.verifyMismatch')}
          </div>
        </div>
      )}
    </StepCard>
  )
}

/* ------------------------------------------------------------------ *
 *  ④ 执行升级
 * ------------------------------------------------------------------ */

function StepUpgrade(): React.JSX.Element {
  const { t } = useI18n()
  const uploadedPath = useFirmwareStore((s) => s.uploadedPath)
  const command = useFirmwareStore((s) => s.upgradeCommand)
  const timeoutMs = useFirmwareStore((s) => s.upgradeTimeoutMs)
  const upgrading = useFirmwareStore((s) => s.upgrading)
  const log = useFirmwareStore((s) => s.upgradeLog)
  const result = useFirmwareStore((s) => s.upgradeResult)
  const [confirming, setConfirming] = useState(false)

  return (
    <StepCard
      index={4}
      title={t('panel.firmware.step4Title')}
      hint={t('panel.firmware.step4Hint')}
      status={result ? (result.status === 'done' && result.exitCode === 0 ? 'done' : 'warn') : upgrading ? 'doing' : 'todo'}
    >
      <textarea
        className="textarea selectable min-h-[56px] font-mono text-2xs leading-relaxed"
        placeholder={t('panel.firmware.cmdPlaceholder')}
        value={command}
        onChange={(e) => useFirmwareStore.getState().setUpgradeCommand(e.target.value)}
      />
      <div className="mt-1.5 flex flex-wrap items-center gap-2">
        <button
          className="btn h-6 px-2 text-2xs"
          disabled={!uploadedPath}
          onClick={() => {
            if (!uploadedPath) return
            const base = command.trim()
            useFirmwareStore
              .getState()
              .setUpgradeCommand(base ? `${base} ${shellQuotePath(uploadedPath)}` : shellQuotePath(uploadedPath))
          }}
        >
          {t('panel.firmware.insertFilePath')}
        </button>
        <button
          className="btn h-6 px-2 text-2xs"
          disabled={!uploadedPath}
          onClick={() =>
            uploadedPath &&
            useFirmwareStore.getState().setUpgradeCommand(`sysupgrade -n ${shellQuotePath(uploadedPath)}`)
          }
        >
          {t('panel.firmware.tplSysupgrade')}
        </button>
        <button
          className="btn h-6 px-2 text-2xs"
          disabled={!uploadedPath}
          onClick={() =>
            uploadedPath && useFirmwareStore.getState().setUpgradeCommand(`fwupdate ${shellQuotePath(uploadedPath)}`)
          }
        >
          {t('panel.firmware.tplFwupdate')}
        </button>

        <span className="flex-1" />
        <label className="flex items-center gap-1 text-2xs text-ink-3">
          <Timer size={11} />
          {t('panel.firmware.timeout')}
          <input
            className="input h-6 w-[70px] font-mono"
            value={String(Math.round(timeoutMs / 1000))}
            onChange={(e) =>
              useFirmwareStore
                .getState()
                .setUpgradeTimeoutMs(Number(e.target.value.replace(/[^\d]/g, '')) * 1000 || 0)
            }
          />
          {t('panel.firmware.seconds')}
        </label>
        {upgrading ? (
          <button className="btn h-7 px-3 text-xs" onClick={() => void useFirmwareStore.getState().cancelUpgrade()}>
            <X size={12} />
            {t('panel.firmware.cancel')}
          </button>
        ) : (
          <button
            className="btn btn-primary h-7 px-3.5 text-xs"
            disabled={!uploadedPath || !command.trim()}
            onClick={() => setConfirming(true)}
          >
            <Play size={12} />
            {t('panel.firmware.runUpgrade')}
          </button>
        )}
      </div>

      {(log || upgrading) && (
        <pre className="scroll-thin mt-2 max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-edge bg-app px-2.5 py-2 font-mono text-3xs leading-relaxed text-ink-2">
          {log || t('panel.firmware.waitingOutput')}
        </pre>
      )}

      {result && (
        <div
          className={cn(
            'mt-2 text-2xs',
            result.status === 'done' && result.exitCode === 0 ? 'text-success' : 'text-warning'
          )}
        >
          {result.status === 'done' && result.exitCode === 0 && t('panel.firmware.upgradeOk')}
          {result.status === 'done' &&
            result.exitCode !== 0 &&
            result.exitCode !== null &&
            t('panel.firmware.upgradeExit', { code: result.exitCode })}
          {result.exitCode === null &&
            result.status === 'done' &&
            t('panel.firmware.upgradeDisconnected')}
          {result.status === 'timeout' &&
            t('panel.firmware.upgradeTimeout', { seconds: Math.round(result.durationMs / 1000) })}
          {result.status === 'cancelled' && t('panel.firmware.upgradeCancelled')}
          {result.status === 'error' &&
            t('panel.firmware.upgradeError', {
              error: result.error ?? t('panel.firmware.unknownReason')
            })}
          {result.error && result.status === 'done' && result.exitCode !== 0 && (
            <div className="mt-0.5 font-mono text-3xs text-ink-3">{result.error}</div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        title={t('panel.firmware.confirmUpgradeTitle')}
        danger
        confirmText={t('panel.firmware.confirmUpgradeBtn')}
        message={
          <>
            {t('panel.firmware.confirmWillRun')}
            <div className="mt-2 selectable break-all rounded-sm border border-edge bg-app px-2 py-1.5 font-mono text-2xs text-ink-2">
              {/*
               * 必须展示真正要执行的命令：占位符没展开时，用户确认的是一句带
               * {{file}} 的假命令
               */}
              {expandFilePlaceholder(command, uploadedPath)}
            </div>
            <div className="mt-2 text-2xs text-danger">
              {t('panel.firmware.confirmDangerHint')}
            </div>
          </>
        }
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          void useFirmwareStore.getState().startUpgrade()
        }}
      />
    </StepCard>
  )
}

/* ------------------------------------------------------------------ *
 *  ⑤ 重启与等待上线
 * ------------------------------------------------------------------ */

function StepReboot(): React.JSX.Element {
  const { t } = useI18n()
  const rebootCommand = useFirmwareStore((s) => s.rebootCommand)
  const rebooting = useFirmwareStore((s) => s.rebooting)
  const waitPort = useFirmwareStore((s) => s.waitPort)
  const wait = useFirmwareStore((s) => s.wait)
  const bootLoading = useFirmwareStore((s) => s.bootLoading)
  const bootLog = useFirmwareStore((s) => s.bootLog)
  const [confirming, setConfirming] = useState(false)

  const sessions = useSshSessions()
  const hasOnline = sessions.some((s) => s.status === 'connected')

  return (
    <StepCard
      index={5}
      title={t('panel.firmware.step5Title')}
      hint={t('panel.firmware.step5Hint')}
      status={bootLog ? 'done' : wait.online ? 'doing' : 'todo'}
    >
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input h-7 w-[140px] font-mono"
          value={rebootCommand}
          onChange={(e) => useFirmwareStore.getState().setRebootCommand(e.target.value)}
        />
        <button
          className="btn h-7 px-3 text-xs"
          disabled={rebooting}
          onClick={() => setConfirming(true)}
        >
          <RotateCcw size={12} />
          {t('panel.firmware.rebootBtn')}
        </button>

        <span className="mx-1 h-4 w-px bg-edge-soft" />

        <span className="text-2xs text-ink-3">{t('panel.firmware.waitPort')}</span>
        <input
          className="input h-7 w-[64px] font-mono"
          value={String(waitPort)}
          onChange={(e) =>
            useFirmwareStore.getState().setWaitPort(Number(e.target.value.replace(/[^\d]/g, '')) || 22)
          }
        />
        {wait.waiting ? (
          <button className="btn h-7 px-3 text-xs" onClick={() => useFirmwareStore.getState().stopWaitOnline()}>
            {t('panel.firmware.stopWait', { attempts: wait.attempts })}
          </button>
        ) : (
          <button className="btn h-7 px-3 text-xs" onClick={() => void useFirmwareStore.getState().startWaitOnline()}>
            <Timer size={12} />
            {t('panel.firmware.startWait')}
          </button>
        )}
        {wait.online && (
          <span className="text-2xs text-success">
            {t('panel.firmware.online')}
            {wait.lastLatency !== undefined
              ? t('panel.firmware.onlineLatency', { ms: wait.lastLatency })
              : ''}
          </span>
        )}

        <span className="flex-1" />
        <button
          className="btn h-7 px-3 text-xs"
          disabled={bootLoading}
          title={
            hasOnline ? t('panel.firmware.fetchBootOnline') : t('panel.firmware.fetchBootOffline')
          }
          onClick={() => void useFirmwareStore.getState().fetchBootLog()}
        >
          {bootLoading ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
          {t('panel.firmware.fetchBootBtn')}
        </button>
      </div>

      {!hasOnline && (
        <div className="mt-2 text-2xs leading-relaxed text-ink-3">
          {t('panel.firmware.reconnectHint')}
        </div>
      )}

      {bootLog && (
        <pre className="scroll-thin mt-2 max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-edge bg-app px-2.5 py-2 font-mono text-3xs leading-relaxed text-ink-2">
          {bootLog}
        </pre>
      )}

      <ConfirmDialog
        open={confirming}
        title={t('panel.firmware.confirmRebootTitle')}
        danger
        confirmText={t('panel.firmware.confirmRebootBtn')}
        message={
          <>
            {t('panel.firmware.confirmWillRun')}
            <span className="ml-1 font-mono text-2xs text-ink-2">{rebootCommand || 'reboot'}</span>
            <div className="mt-2 text-2xs text-ink-3">{t('panel.firmware.confirmRebootHint')}</div>
          </>
        }
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          void useFirmwareStore.getState().reboot()
        }}
      />
    </StepCard>
  )
}
