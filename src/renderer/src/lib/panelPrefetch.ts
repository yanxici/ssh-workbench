/**
 * 功能面板 chunk 的空闲预加载。
 *
 * 问题：8 个功能面板都是 lazy()，`<Suspense fallback={null}>` 意味着**首次切换时白屏**，
 * 直到 chunk 下载完、组件求值完才出现内容。这就是「面板切换闪烁」的直接原因。
 * 注意它不是「缺过渡动画」——加动画只会把白屏变成「白屏 + 淡入」。
 *
 * 方案（Q4=d）：空闲预加载为主，骨架为兜底。
 *   1. 启动后（以及每次切换后）在 requestIdleCallback 空档里把尚未加载的 chunk 拉下来；
 *   2. 已经加载过的记在 resolved 集合里，不再重复 import（import() 本身有模块缓存，
 *      这里记一份只是为了让「要不要起骨架」这个判断是同步可得的）；
 *   3. 真遇到慢机器/首次冷启动，骨架兜底 —— 但它必须有正确的尺寸，
 *      否则切换瞬间的布局跳动比白屏更难受。
 *
 * 为什么不用「保活」（切走不卸载、display:none 隐藏）：
 * 8 个面板各自持有列表/图表状态，全部保活会让内存随打开过的面板数累加，
 * 与本项目「轻」的第一目标冲突。
 */

export type PanelId =
  | 'sftp'
  | 'diag'
  | 'batch'
  | 'profile'
  | 'metrics'
  | 'firmware'
  | 'discovery'
  | 'backup'

/** 每个面板的 loader。与 App.tsx 里的 lazy() 指向同一模块，避免两处漂移。 */
const LOADERS: Record<PanelId, () => Promise<unknown>> = {
  sftp: () => import('@/components/files/FileManagerPanel'),
  diag: () => import('@/components/diagnostics/DiagnosticsPanel'),
  batch: () => import('@/components/batch/BatchPanel'),
  profile: () => import('@/components/profiles/ProfilesPanel'),
  metrics: () => import('@/components/metrics/MetricsPanel'),
  firmware: () => import('@/components/firmware/FirmwarePanel'),
  discovery: () => import('@/components/discovery/DiscoveryPanel'),
  backup: () => import('@/components/backup/BackupPanel')
}

/** 已完成的 id：同步可读，供 Suspense 的 fallback 判断要不要起骨架 */
const resolved = new Set<PanelId>()
/** 进行中的 promise：避免同一面板被重复预加载 */
const inflight = new Map<PanelId, Promise<unknown>>()

export function isPanelLoaded(id: PanelId): boolean {
  return resolved.has(id)
}

/** 取一个面板的 chunk（幂等）。返回的 promise 只用于等待，不消费其结果。 */
export function loadPanel(id: PanelId): Promise<unknown> {
  if (resolved.has(id)) return Promise.resolve()
  const existing = inflight.get(id)
  if (existing) return existing
  const p = LOADERS[id]()
    .then((m) => {
      resolved.add(id)
      return m
    })
    .catch(() => {
      /*
       * 预加载失败不能抛：这是后台优化，失败就让 lazy() 在真正需要时再试一次。
       * 但要从 inflight 里删掉，否则下次 loadPanel 会拿到一个已 reject 的 promise，
       * 永远不再重试。
       */
      inflight.delete(id)
      return undefined
    })
  inflight.set(id, p)
  return p
}

type IdleHandle = { cancel: () => void }

/**
 * 在浏览器空闲时依次预加载剩余面板。
 *
 * 为什么串行而不是 Promise.all：并行拉 8 个 chunk 会和用户真正在等的那个请求
 * 抢带宽/解压 CPU。串行 + 空闲窗口让步，才叫「不打扰」。
 * 返回的 cancel 在组件卸载时调用，避免在已卸载的树上继续拉数据。
 */
export function prefetchPanelsIdle(exclude?: PanelId): IdleHandle {
  const queue: PanelId[] = (Object.keys(LOADERS) as PanelId[]).filter(
    (id) => id !== exclude && !resolved.has(id)
  )
  let cancelled = false
  let handle = 0

  const ric: (cb: () => void) => number =
    typeof requestIdleCallback === 'function'
      ? (cb) => requestIdleCallback(cb, { timeout: 2000 })
      : (cb) => setTimeout(cb, 200) as unknown as number
  const cic = (h: number): void => {
    if (typeof cancelIdleCallback === 'function') cancelIdleCallback(h)
    else clearTimeout(h)
  }

  const step = (): void => {
    if (cancelled) return
    const next = queue.shift()
    if (!next) return
    void loadPanel(next).then(() => {
      if (cancelled) return
      handle = ric(step)
    })
  }
  handle = ric(step)

  return {
    cancel: () => {
      cancelled = true
      cic(handle)
    }
  }
}

export function panelIdFor(open: Record<PanelId, boolean>, current?: PanelId): PanelId | undefined {
  if (current && open[current]) return current
  return (Object.keys(open) as PanelId[]).find((k) => open[k])
}
