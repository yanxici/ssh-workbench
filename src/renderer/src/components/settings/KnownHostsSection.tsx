import { useEffect, useState } from 'react'
import { Fingerprint, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui'
import { call } from '@/lib/ipc'
import { useToastStore } from '@/stores/toastStore'

/**
 * 设置 → 已知主机指纹。
 *
 * 这块自带完整的状态机（探测 → 展示旧/新对比 → 确认后写回），
 * 从 SettingsPanel 里拆出来是因为它是那个 959 行文件里最独立、
 * 也最容易出问题的一段（涉及网络探测、破坏性写库、用户确认）。
 */

interface KnownHost {
  host: string
  port: number
  fingerprint: string
  addedAt: number
}

/** 「旧指纹 → 新指纹」的待确认更新；批量刷新时会有多条 */
interface FingerprintUpdate {
  host: string
  port: number
  from: string
  to: string
}

/**
 * 探测设备当前指纹。
 *
 * 刻意不用 call()：silent 模式下失败只会返回 null，把「端口不通 / 超时」
 * 这种必须让用户看见的原因一起吞掉；这里保留 IpcResult 里的 error 原文。
 */
async function probeHost(
  host: string,
  port: number
): Promise<{ ok: true; fingerprint: string } | { ok: false; error: string }> {
  try {
    const res = await window.api.knownHosts.probe(host, port)
    if (res.ok) return { ok: true, fingerprint: res.data.fingerprint }
    return { ok: false, error: res.error }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function KnownHostsSection(): JSX.Element {
  const [knownHosts, setKnownHosts] = useState<KnownHost[]>([])
  /** 正在探测/更新指纹的 host:port（按钮转圈）；'*' 表示批量 */
  const [probeBusy, setProbeBusy] = useState<string | null>(null)
  const [fpUpdates, setFpUpdates] = useState<FingerprintUpdate[]>([])
  const [fpError, setFpError] = useState<string | null>(null)

  useEffect(() => {
    void call(window.api.knownHosts.list(), { silent: true }).then((l) => setKnownHosts(l ?? []))
  }, [])

  /**
   * 更新某台设备的指纹。
   *
   * 设备重装 / 固件升级 / 换 sshd host key 之后，旧记录会让所有连接被拒。
   * 直接改库太危险（等于静默信任未知主机），所以先探测现状、把「旧 → 新」
   * 摆到用户面前确认，确认后才写回。
   */
  const updateFingerprint = async (h: KnownHost): Promise<void> => {
    const key = `${h.host}:${h.port}`
    setProbeBusy(key)
    setFpError(null)
    try {
      const probe = await probeHost(h.host, h.port)
      if (!probe.ok) {
        // 失败原因必须落到界面上：silent 的 call() 会把原因吞掉，用户只会看到按钮转一圈
        setFpError(`${key} 探测失败：${probe.error}`)
        return
      }
      if (probe.fingerprint === h.fingerprint) {
        useToastStore.getState().push({
          kind: 'success',
          title: '指纹无需更新',
          detail: `${key} 与设备当前一致`
        })
        return
      }
      setFpUpdates([{ host: h.host, port: h.port, from: h.fingerprint, to: probe.fingerprint }])
    } finally {
      setProbeBusy(null)
    }
  }

  const applyFingerprintUpdates = async (): Promise<void> => {
    const targets = fpUpdates
    setFpUpdates([])
    if (targets.length === 0) return
    let done = 0
    let failed = 0
    for (const t of targets) {
      const res = await call(window.api.knownHosts.refresh(t.host, t.port, t.to), { silent: true })
      if (res) {
        done += 1
        setKnownHosts((prev) =>
          prev.map((x) =>
            x.host === t.host && x.port === t.port
              ? { ...x, fingerprint: t.to, addedAt: Date.now() }
              : x
          )
        )
      } else {
        failed += 1
      }
    }
    useToastStore.getState().push({
      kind: failed > 0 ? 'warning' : 'success',
      title: failed > 0 ? `已更新 ${done} 条，${failed} 条失败` : `已更新 ${done} 条指纹`,
      detail: '下次连接会按新指纹校验'
    })
  }

  /** 一次性刷新全部记录：每台都探测一次，只列出真的变了的 */
  const refreshAllFingerprints = async (): Promise<void> => {
    if (knownHosts.length === 0) return
    setProbeBusy('*')
    setFpError(null)
    let changed = 0
    let failed = 0
    const updates: FingerprintUpdate[] = []
    for (const h of knownHosts) {
      const probe = await probeHost(h.host, h.port)
      if (!probe.ok) {
        failed += 1
        continue
      }
      if (probe.fingerprint !== h.fingerprint) {
        changed += 1
        updates.push({ host: h.host, port: h.port, from: h.fingerprint, to: probe.fingerprint })
      }
    }
    setProbeBusy(null)
    if (updates.length === 0) {
      useToastStore.getState().push({
        kind: failed > 0 ? 'warning' : 'success',
        title: failed > 0 ? `刷新完成，${failed} 台探测失败` : '全部指纹均与设备一致',
        detail: failed > 0 ? '离线设备/端口不通会探测失败，可单独重试' : undefined
      })
      return
    }
    // 统一弹一次确认框（列出每台的旧→新），不静默信任任何一台
    setFpUpdates(updates)
    useToastStore.getState().push({
      kind: 'warning',
      title: `有 ${changed} 台设备的指纹已变化`,
      detail: '请逐条确认后再更新'
    })
  }

  if (knownHosts.length === 0) {
    return (
      <div className="text-2xs text-ink-3">暂无记录。连接过的设备会在严格校验开启时自动记录。</div>
    )
  }

  return (
    <>
      <div className="mb-2 flex items-center gap-1.5">
        <button
          className="btn h-6 px-2 text-2xs"
          disabled={probeBusy !== null}
          title="逐台探测设备当前的主机指纹，只列出真的发生变化的"
          onClick={() => void refreshAllFingerprints()}
        >
          {probeBusy === '*' ? (
            <Loader2 size={11} className="animate-spin" />
          ) : (
            <RefreshCw size={11} />
          )}
          检查全部更新
        </button>
        <span className="text-3xs leading-relaxed text-ink-3">
          设备重装或固件升级后指纹会变，连接被拒时在这里更新即可
        </span>
      </div>
      {fpError && (
        <div className="mb-2 selectable rounded border border-danger/30 bg-danger/5 px-2 py-1 text-2xs text-danger">
          {fpError}
        </div>
      )}
      <div className="space-y-1.5">
        {knownHosts.map((h) => {
          const key = `${h.host}:${h.port}`
          return (
            <div
              key={key}
              className="flex items-center gap-2 rounded-md border border-edge-soft bg-panel px-2 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <div className="font-mono text-2xs text-ink-2">
                  {h.host}:{h.port}
                </div>
                <div className="selectable truncate font-mono text-3xs text-ink-3">
                  {h.fingerprint}
                </div>
              </div>
              <button
                className="btn-icon h-6 w-6 shrink-0 hover:text-accent"
                title="探测设备当前指纹并更新（会先展示旧值与新值对比）"
                disabled={probeBusy !== null}
                onClick={() => void updateFingerprint(h)}
              >
                {probeBusy === key ? (
                  <Loader2 size={12} className="animate-spin" />
                ) : (
                  <Fingerprint size={12} />
                )}
              </button>
              <button
                className="btn-icon h-6 w-6 shrink-0 hover:text-danger"
                title="删除该记录（设备重装后需要）"
                onClick={() => {
                  void call(window.api.knownHosts.remove(key), { silent: true }).then(() => {
                    setKnownHosts((prev) =>
                      prev.filter((x) => !(x.host === h.host && x.port === h.port))
                    )
                    useToastStore
                      .getState()
                      .push({ kind: 'success', title: '已删除主机指纹记录' })
                  })
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          )
        })}
      </div>

      {/* 指纹更新确认：必须让用户看到「旧 → 新」，不能静默信任 */}
      <ConfirmDialog
        open={fpUpdates.length > 0}
        title="更新主机指纹"
        confirmText="确认更新"
        message={
          <div className="space-y-2">
            <div className="text-2xs leading-relaxed text-ink-3">
              以下设备的指纹与本地记录不一致。如果设备确实重装过系统或升级过固件，可以确认更新；
              否则说明连接可能被中间人劫持，请先核实。
            </div>
            <div className="scroll-thin max-h-52 space-y-1.5 overflow-y-auto">
              {fpUpdates.map((u) => (
                <div
                  key={`${u.host}:${u.port}`}
                  className="rounded border border-edge-soft bg-app/60 px-2 py-1.5"
                >
                  <div className="font-mono text-2xs text-ink-2">
                    {u.host}:{u.port}
                  </div>
                  <div className="selectable break-all font-mono text-3xs text-danger/90">
                    - {u.from}
                  </div>
                  <div className="selectable break-all font-mono text-3xs text-success">
                    + {u.to}
                  </div>
                </div>
              ))}
            </div>
          </div>
        }
        onCancel={() => setFpUpdates([])}
        onConfirm={() => void applyFingerprintUpdates()}
      />
    </>
  )
}
