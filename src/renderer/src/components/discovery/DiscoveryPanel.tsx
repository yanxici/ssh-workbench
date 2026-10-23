import { Copy, Plug, Radar, RefreshCw, Search, Wifi, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { guessVendor } from '@shared/arpVendor'
import { EmptyState } from '@/components/ui'
import { useDiscoveryStore } from '@/stores/discoveryStore'
import { useToastStore } from '@/stores/toastStore'

/**
 * 设备发现（覆盖主区域）：
 * - 网段扫描：从本机对目标网段做 TCP 探针（无需管理员权限），补 ARP 厂商与反向 DNS；
 * - mDNS：查询网络中的 DNS-SD 服务（_ssh / _http 等），适合快速找到开了广播的设备。
 */
export function DiscoveryPanel(): JSX.Element | null {
  const panelOpen = useDiscoveryStore((s) => s.panelOpen)
  const tab = useDiscoveryStore((s) => s.tab)

  if (!panelOpen) return null

  const close = (): void => useDiscoveryStore.setState({ panelOpen: false })

  return (
    <div className="fixed inset-x-0 bottom-[26px] top-[38px] z-30 flex flex-col bg-app">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-edge bg-panel px-3">
        <Radar size={14} className="text-accent" />
        <span className="text-xs font-semibold">设备发现</span>
        <div className="ml-3 flex items-center gap-0.5 rounded-md border border-edge bg-app p-0.5">
          {(
            [
              { key: 'scan', label: '网段扫描' },
              { key: 'mdns', label: 'mDNS 服务' }
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              className={cn(
                'rounded px-2.5 py-1 text-2xs transition-colors',
                tab === t.key ? 'bg-accent/15 text-accent' : 'text-ink-3 hover:text-ink-2'
              )}
              onClick={() => useDiscoveryStore.getState().setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <button className="btn-icon" title="关闭 (Esc)" onClick={close}>
          <X size={14} />
        </button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
        <div className="mx-auto flex max-w-[880px] flex-col gap-3">
          {tab === 'scan' ? <ScanView /> : <MdnsView />}
        </div>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ *
 *  网段扫描
 * ------------------------------------------------------------------ */

function ScanView(): JSX.Element {
  const ifaces = useDiscoveryStore((s) => s.ifaces)
  const cidr = useDiscoveryStore((s) => s.cidr)
  const portsText = useDiscoveryStore((s) => s.portsText)
  const timeoutMs = useDiscoveryStore((s) => s.scanTimeoutMs)
  const scanning = useDiscoveryStore((s) => s.scanning)
  const scanned = useDiscoveryStore((s) => s.scanned)
  const total = useDiscoveryStore((s) => s.total)
  const hosts = useDiscoveryStore((s) => s.hosts)

  const pct = total > 0 ? Math.round((scanned / total) * 100) : 0

  return (
    <>
      <div className="rounded-lg border border-edge-soft bg-panel p-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-2xs text-ink-3">本机网段</span>
          <select
            className="input h-7 w-[240px]"
            value={cidr}
            onChange={(e) => useDiscoveryStore.getState().setCidr(e.target.value)}
          >
            {ifaces.length === 0 && <option value="">未检测到网卡</option>}
            {ifaces.map((i) => (
              <option key={`${i.name}-${i.address}`} value={i.cidr}>
                {i.name} · {i.address} → {i.cidr}（{i.hostCount} 台）
              </option>
            ))}
            {cidr && !ifaces.some((i) => i.cidr === cidr) && <option value={cidr}>{cidr}（手动）</option>}
          </select>
          <input
            className="input h-7 w-[180px]"
            value={cidr}
            onChange={(e) => useDiscoveryStore.getState().setCidr(e.target.value)}
            placeholder="也可手动输入 192.168.1.0/24"
          />
          <button
            className="btn-icon"
            title="重新读取网卡"
            onClick={() => void useDiscoveryStore.getState().loadIfaces()}
          >
            <RefreshCw size={13} />
          </button>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-2xs text-ink-3">探测端口</span>
          <input
            className="input h-7 w-[180px] font-mono"
            value={portsText}
            onChange={(e) => useDiscoveryStore.getState().setPortsText(e.target.value)}
            placeholder="22, 80, 443"
          />
          <label className="flex items-center gap-1 text-2xs text-ink-3">
            单端口超时
            <input
              className="input h-7 w-[64px] font-mono"
              value={String(timeoutMs)}
              onChange={(e) =>
                useDiscoveryStore
                  .getState()
                  .setScanTimeoutMs(Number(e.target.value.replace(/[^\d]/g, '')) || 0)
              }
            />
            ms
          </label>

          <span className="flex-1" />
          {scanning ? (
            <button className="btn h-7 px-3 text-xs" onClick={() => void useDiscoveryStore.getState().cancelScan()}>
              <X size={12} />
              停止（{scanned}/{total || '…'}）
            </button>
          ) : (
            <button
              className="btn btn-primary h-7 px-3.5 text-xs"
              onClick={() => void useDiscoveryStore.getState().startScan()}
            >
              <Search size={12} />
              开始扫描
            </button>
          )}
        </div>

        {scanning && total > 0 && (
          <div className="mt-2 flex items-center gap-2">
            <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-raised">
              <div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${pct}%` }} />
            </div>
            <span className="shrink-0 font-mono text-2xs text-ink-3">{pct}%</span>
          </div>
        )}
      </div>

      {hosts.length === 0 ? (
        <EmptyState
          icon={<Radar size={28} />}
          title={scanning ? '正在扫描…' : '还没有发现结果'}
          hint="扫描会对网段内每个 IP 的指定端口做一次 TCP 连接探测（含 ARP 厂商与主机名反查）；请确认你与设备在同一局域网"
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-edge-soft bg-panel">
          <div className="flex items-center gap-2 border-b border-edge-soft px-3 py-1.5">
            <span className="text-2xs font-semibold text-ink-2">发现 {hosts.length} 台设备</span>
            <span className="flex-1" />
            <span className="text-3xs text-ink-3">点击「新建连接」可直接把 IP 填进连接编辑器</span>
          </div>
          {hosts.map((h) => (
            <div
              key={h.ip}
              className="flex items-center gap-2.5 border-b border-edge-soft/60 px-3 py-1.5 last:border-b-0 hover:bg-hover/40"
            >
              <Wifi size={12} className="shrink-0 text-success" />
              <span className="w-[120px] shrink-0 font-mono text-xs text-ink">{h.ip}</span>
              <span className="w-[110px] shrink-0 font-mono text-3xs text-ink-3">
                {h.mac ? `${h.mac}${guessVendor(h.mac) ? `（${guessVendor(h.mac)}）` : ''}` : '—'}
              </span>
              <span className="w-[150px] shrink-0 truncate text-2xs text-ink-3" title={h.hostname}>
                {h.hostname ?? '—'}
              </span>
              <span className="shrink-0 space-x-1">
                {h.openPorts.map((p) => (
                  <span
                    key={p}
                    className={cn(
                      'rounded px-1 py-px font-mono text-3xs',
                      p === 22 ? 'bg-accent/15 text-accent' : 'bg-raised text-ink-3'
                    )}
                  >
                    {p}
                  </span>
                ))}
              </span>
              {h.latencyMs !== undefined && (
                <span className="shrink-0 font-mono text-3xs text-ink-3">{h.latencyMs}ms</span>
              )}
              <span className="flex-1" />
              <button
                className="btn-icon h-6 w-6"
                title="复制 IP"
                onClick={() => {
                  void window.api.clip.write(h.ip)
                  useToastStore.getState().push({ kind: 'success', title: `已复制 ${h.ip}` })
                }}
              >
                <Copy size={11} />
              </button>
              <button
                className="btn h-6 px-2 text-2xs"
                title={`为 ${h.ip} 新建连接`}
                onClick={() => useDiscoveryStore.getState().makeConnection(h.ip, h.openPorts[0] ?? 22)}
              >
                <Plug size={11} />
                新建连接
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/* ------------------------------------------------------------------ *
 *  mDNS
 * ------------------------------------------------------------------ */

function MdnsView(): JSX.Element {
  const running = useDiscoveryStore((s) => s.mdnsRunning)
  const done = useDiscoveryStore((s) => s.mdnsDone)
  const services = useDiscoveryStore((s) => s.mdnsServices)

  return (
    <>
      <div className="flex items-center gap-2 rounded-lg border border-edge-soft bg-panel px-3 py-2.5">
        <span className="text-2xs leading-relaxed text-ink-3">
          查询局域网内的 DNS-SD 服务广播（_ssh / _http / _https 等），约需 6 秒。
          部分企业网络会拦截组播，若结果为空属正常现象 —— 可改用「网段扫描」。
        </span>
        <span className="flex-1" />
        <button
          className={cn('btn h-7 px-3.5 text-xs', !running && 'btn-primary')}
          disabled={running}
          onClick={() => void useDiscoveryStore.getState().runMdns()}
        >
          {running ? '发现中…（约 6 秒）' : '开始发现'}
        </button>
      </div>

      {services.length === 0 ? (
        <EmptyState
          icon={<Radar size={28} />}
          title={running ? '正在监听 mDNS 广播…' : done ? '没有发现 mDNS 服务' : '尚未执行发现'}
          hint={
            done
              ? '可能原因：网络策略拦截组播 / 设备未开启 mDNS（avahi、Bonjour 等）。可考虑用网段扫描兜底'
              : 'mDNS 能发现主动广播服务的设备（如运行 avahi 的嵌入式 Linux）'
          }
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-edge-soft bg-panel">
          <div className="border-b border-edge-soft px-3 py-1.5 text-2xs font-semibold text-ink-2">
            发现 {services.length} 个服务实例
          </div>
          {services.map((s, idx) => (
            <div
              key={`${s.type}-${s.name}-${idx}`}
              className="flex items-center gap-2.5 border-b border-edge-soft/60 px-3 py-1.5 last:border-b-0 hover:bg-hover/40"
            >
              <span className="shrink-0 rounded bg-accent/10 px-1.5 py-px font-mono text-3xs text-accent">
                {s.type.replace(/^_|\._?/g, ' ').trim() || s.type}
              </span>
              <span className="min-w-0 flex-1 truncate text-xs text-ink-2">{s.name}</span>
              <span className="shrink-0 font-mono text-3xs text-ink-3">
                {s.address ?? s.host ?? '—'}
                {s.port ? `:${s.port}` : ''}
              </span>
              {s.address && (
                <button
                  className="btn h-6 px-2 text-2xs"
                  onClick={() => useDiscoveryStore.getState().makeConnection(s.address as string, 22)}
                >
                  <Plug size={11} />
                  新建连接
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  )
}
