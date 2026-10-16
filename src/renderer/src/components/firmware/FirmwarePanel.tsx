import { useEffect, useState, type ReactNode } from 'react'
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
import { ConfirmDialog } from '@/components/ui'
import { useFirmwareStore } from '@/stores/firmwareStore'
import { useSftpStore } from '@/stores/sftpStore'
import { useSessionStore } from '@/stores/sessionStore'

/**
 * 固件升级助手（覆盖主区域）：选择 → 上传 → 校验 → 升级 → 重启等待 → 启动日志。
 * 每一步都有明确的状态与产物，升级命令完全可编辑（兼容各家厂商脚本）。
 */
export function FirmwarePanel(): JSX.Element | null {
  const panelOpen = useFirmwareStore((s) => s.panelOpen)
  if (!panelOpen) return null

  const close = (): void => useFirmwareStore.setState({ panelOpen: false })

  return (
    <div className="fixed inset-x-0 bottom-[26px] top-[38px] z-30 flex flex-col bg-app">
      {/* 标题栏 */}
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3">
        <Rocket size={14} className="text-accent" />
        <span className="text-xs font-semibold">固件升级助手</span>
        <span className="text-2xs text-ink-3">
          上传 → 校验（SHA256 双端比对）→ 升级（流式回显）→ 重启监控
        </span>
        <span className="flex-1" />
        <button className="btn-icon" title="关闭 (Esc)" onClick={close}>
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
}): JSX.Element {
  return (
    <div className="rounded-lg border border-edge-soft bg-panel">
      <div className="flex items-center gap-2 border-b border-edge-soft px-3 py-2">
        <span
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px]',
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

function TargetBar(): JSX.Element {
  const sessions = useSessionStore((s) => s.sessions)
  const sessionId = useFirmwareStore((s) => s.sessionId)
  const connected = sessions.filter((s) => s.status === 'connected')

  return (
    <div className="flex items-center gap-2 rounded-lg border border-edge-soft bg-panel px-3 py-2">
      <span className="text-2xs text-ink-3">目标设备</span>
      <select
        className="input h-7 w-[280px]"
        value={sessionId ?? ''}
        onChange={(e) => useFirmwareStore.getState().setSessionId(e.target.value)}
      >
        <option value="">选择一台在线设备…</option>
        {connected.map((s) => (
          <option key={s.id} value={s.id}>
            {s.title}（{s.username}@{s.host}）
          </option>
        ))}
      </select>
      {connected.length === 0 && (
        <span className="text-2xs text-warning">没有在线会话，请先在左侧连接设备</span>
      )}
      <span className="flex-1" />
      <span className="text-[10px] leading-relaxed text-ink-3">
        提示：升级前建议先用「一键诊断」留一份体检报告
      </span>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  ① 选择固件
 * ------------------------------------------------------------------ */

function StepSelectFile(): JSX.Element {
  const file = useFirmwareStore((s) => s.file)
  return (
    <StepCard index={1} title="选择固件文件" status={file ? 'done' : 'todo'}>
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn h-7 px-3 text-xs" onClick={() => void useFirmwareStore.getState().pickFile()}>
          <FileUp size={12} />
          {file ? '重新选择' : '浏览本地文件…'}
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

function StepUpload(): JSX.Element {
  const file = useFirmwareStore((s) => s.file)
  const remoteDir = useFirmwareStore((s) => s.remoteDir)
  const uploadTaskId = useFirmwareStore((s) => s.uploadTaskId)
  const uploadedPath = useFirmwareStore((s) => s.uploadedPath)
  const uploading = useFirmwareStore((s) => s.uploading)

  const transfers = useSftpStore((s) => s.transfers)
  const task = transfers.find((t) => t.id === uploadTaskId)

  // 上传完成 → 记录远端路径，供后续校验/升级使用
  useEffect(() => {
    if (task?.status === 'done' && task.remotePath && !uploadedPath) {
      useFirmwareStore.getState().markUploaded(task.remotePath)
    }
  }, [task?.status, task?.remotePath, uploadedPath])

  const pct = task && task.total > 0 ? Math.round((task.transferred / task.total) * 100) : 0

  return (
    <StepCard
      index={2}
      title="上传到设备"
      hint="大文件会走 SFTP 队列，可看到实时进度"
      status={uploadedPath ? 'done' : uploading || (task && task.status === 'running') ? 'doing' : 'todo'}
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 text-2xs text-ink-3">上传目录</span>
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
          开始上传
        </button>
        {uploadedPath && (
          <span className="min-w-0 flex-1 truncate font-mono text-2xs text-success">
            已上传：{uploadedPath}
          </span>
        )}
      </div>

      {task && (task.status === 'running' || task.status === 'pending') && (
        <div className="mt-2 flex items-center gap-2">
          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-raised">
            <div className="h-full bg-accent transition-all duration-200" style={{ width: `${pct}%` }} />
          </div>
          <span className="shrink-0 font-mono text-2xs text-ink-3">
            {pct}%{task.speedBps ? ` · ${formatBytes(task.speedBps)}/s` : ''}
          </span>
        </div>
      )}
      {task?.status === 'error' && (
        <div className="mt-2 text-2xs text-danger">上传失败：{task.error}</div>
      )}
    </StepCard>
  )
}

/* ------------------------------------------------------------------ *
 *  ③ 校验
 * ------------------------------------------------------------------ */

function StepVerify(): JSX.Element {
  const uploadedPath = useFirmwareStore((s) => s.uploadedPath)
  const verifying = useFirmwareStore((s) => s.verifying)
  const verify = useFirmwareStore((s) => s.verify)

  return (
    <StepCard
      index={3}
      title="校验固件完整性"
      hint="本机 SHA256 与设备端 sha256sum/md5sum 双端比对"
      status={verify ? (verify.match ? 'done' : 'warn') : verifying ? 'doing' : 'todo'}
    >
      <div className="flex items-center gap-2">
        <button
          className="btn h-7 px-3 text-xs"
          disabled={!uploadedPath || verifying}
          onClick={() => void useFirmwareStore.getState().startVerify()}
        >
          <ShieldCheck size={12} />
          开始校验
        </button>
        {!uploadedPath && <span className="text-2xs text-ink-3">请先完成上传</span>}
      </div>

      {verify && (
        <div className="mt-2 space-y-1 font-mono text-[10px] leading-relaxed">
          <div className="text-ink-3">
            本机（{verify.algo}）：<span className="text-ink-2">{verify.localHash}</span>
          </div>
          <div className="text-ink-3">
            设备（{verify.algo}）：<span className="text-ink-2">{verify.remoteHash}</span>
          </div>
          <div className={verify.match ? 'text-success' : 'text-danger'}>
            {verify.match ? '✓ 一致，固件完整无损坏' : '✗ 不一致！请勿升级，建议重新上传后再次校验'}
          </div>
        </div>
      )}
    </StepCard>
  )
}

/* ------------------------------------------------------------------ *
 *  ④ 执行升级
 * ------------------------------------------------------------------ */

function StepUpgrade(): JSX.Element {
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
      title="执行升级命令"
      hint="命令完全可编辑，兼容各家升级脚本"
      status={result ? (result.status === 'done' && result.exitCode === 0 ? 'done' : 'warn') : upgrading ? 'doing' : 'todo'}
    >
      <textarea
        className="textarea selectable min-h-[56px] font-mono text-[11px] leading-relaxed"
        placeholder="例如：sysupgrade -n {{file}} / fwupdate {{file}} / swupdate -i {{file}}"
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
              .setUpgradeCommand(base ? `${base} ${uploadedPath}` : uploadedPath)
          }}
        >
          插入文件路径
        </button>
        <button
          className="btn h-6 px-2 text-2xs"
          disabled={!uploadedPath}
          onClick={() =>
            uploadedPath && useFirmwareStore.getState().setUpgradeCommand(`sysupgrade -n ${uploadedPath}`)
          }
        >
          模板：sysupgrade -n
        </button>
        <button
          className="btn h-6 px-2 text-2xs"
          disabled={!uploadedPath}
          onClick={() =>
            uploadedPath && useFirmwareStore.getState().setUpgradeCommand(`fwupdate ${uploadedPath}`)
          }
        >
          模板：fwupdate
        </button>

        <span className="flex-1" />
        <label className="flex items-center gap-1 text-2xs text-ink-3">
          <Timer size={11} />
          超时
          <input
            className="input h-6 w-[70px] font-mono"
            value={String(Math.round(timeoutMs / 1000))}
            onChange={(e) =>
              useFirmwareStore
                .getState()
                .setUpgradeTimeoutMs(Number(e.target.value.replace(/[^\d]/g, '')) * 1000 || 0)
            }
          />
          秒
        </label>
        {upgrading ? (
          <button className="btn h-7 px-3 text-xs" onClick={() => void useFirmwareStore.getState().cancelUpgrade()}>
            <X size={12} />
            取消
          </button>
        ) : (
          <button
            className="btn btn-primary h-7 px-3.5 text-xs"
            disabled={!uploadedPath || !command.trim()}
            onClick={() => setConfirming(true)}
          >
            <Play size={12} />
            执行升级
          </button>
        )}
      </div>

      {(log || upgrading) && (
        <pre className="scroll-thin mt-2 max-h-[280px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-edge bg-app px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-ink-2">
          {log || '等待输出…'}
        </pre>
      )}

      {result && (
        <div
          className={cn(
            'mt-2 text-2xs',
            result.status === 'done' && result.exitCode === 0 ? 'text-success' : 'text-warning'
          )}
        >
          {result.status === 'done' && result.exitCode === 0 && '升级命令执行成功（退出码 0）'}
          {result.status === 'done' && result.exitCode !== 0 && result.exitCode !== null &&
            `命令结束，退出码 ${result.exitCode}，请核对上方输出`}
          {result.exitCode === null && result.status === 'done' &&
            '连接已中断 —— 升级脚本可能已触发重启，属正常现象'}
          {result.status === 'timeout' && `执行超时（${Math.round(result.durationMs / 1000)}s）`}
          {result.status === 'cancelled' && '已取消'}
          {result.status === 'error' && `执行失败：${result.error ?? '未知原因'}`}
          {result.error && result.status === 'done' && result.exitCode !== 0 && (
            <div className="mt-0.5 font-mono text-[10px] text-ink-3">{result.error}</div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirming}
        title="执行固件升级"
        danger
        confirmText="执行升级"
        message={
          <>
            将在设备上执行：
            <div className="mt-2 selectable break-all rounded border border-edge bg-app px-2 py-1.5 font-mono text-2xs text-ink-2">
              {command}
            </div>
            <div className="mt-2 text-2xs text-danger">
              升级过程中请勿断电断网，否则设备可能无法启动。
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

function StepReboot(): JSX.Element {
  const rebootCommand = useFirmwareStore((s) => s.rebootCommand)
  const rebooting = useFirmwareStore((s) => s.rebooting)
  const waitPort = useFirmwareStore((s) => s.waitPort)
  const wait = useFirmwareStore((s) => s.wait)
  const bootLoading = useFirmwareStore((s) => s.bootLoading)
  const bootLog = useFirmwareStore((s) => s.bootLog)
  const [confirming, setConfirming] = useState(false)

  const sessions = useSessionStore((s) => s.sessions)
  const hasOnline = sessions.some((s) => s.status === 'connected')

  return (
    <StepCard
      index={5}
      title="重启并监控启动"
      hint="TCP 探针等待设备回来，再抓取启动日志"
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
          重启设备
        </button>

        <span className="mx-1 h-4 w-px bg-edge-soft" />

        <span className="text-2xs text-ink-3">等待上线端口</span>
        <input
          className="input h-7 w-[64px] font-mono"
          value={String(waitPort)}
          onChange={(e) =>
            useFirmwareStore.getState().setWaitPort(Number(e.target.value.replace(/[^\d]/g, '')) || 22)
          }
        />
        {wait.waiting ? (
          <button className="btn h-7 px-3 text-xs" onClick={() => useFirmwareStore.getState().stopWaitOnline()}>
            停止等待（已尝试 {wait.attempts} 次）
          </button>
        ) : (
          <button className="btn h-7 px-3 text-xs" onClick={() => void useFirmwareStore.getState().startWaitOnline()}>
            <Timer size={12} />
            开始等待上线
          </button>
        )}
        {wait.online && (
          <span className="text-2xs text-success">
            设备已上线{wait.lastLatency !== undefined ? `（${wait.lastLatency}ms）` : ''}
          </span>
        )}

        <span className="flex-1" />
        <button
          className="btn h-7 px-3 text-xs"
          disabled={bootLoading}
          title={hasOnline ? '在当前活动会话上抓取 dmesg' : '需要先重新连接设备'}
          onClick={() => void useFirmwareStore.getState().fetchBootLog()}
        >
          {bootLoading ? <Loader2 size={12} className="animate-spin" /> : <ShieldCheck size={12} />}
          抓取启动日志
        </button>
      </div>

      {!hasOnline && (
        <div className="mt-2 text-2xs leading-relaxed text-ink-3">
          设备重启后原连接会断开：请双击左侧连接重新建立会话，再点「抓取启动日志」确认这次升级是否干净启动。
        </div>
      )}

      {bootLog && (
        <pre className="scroll-thin mt-2 max-h-[300px] overflow-auto whitespace-pre-wrap break-words rounded-md border border-edge bg-app px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-ink-2">
          {bootLog}
        </pre>
      )}

      <ConfirmDialog
        open={confirming}
        title="重启设备"
        danger
        confirmText="执行重启"
        message={
          <>
            将在设备上执行：
            <span className="ml-1 font-mono text-2xs text-ink-2">{rebootCommand || 'reboot'}</span>
            <div className="mt-2 text-2xs text-ink-3">当前连接会立即断开，属正常现象。</div>
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
