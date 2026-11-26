import { useSftpStore } from '@/stores/sftpStore'
import { useDiagStore } from '@/stores/diagStore'
import { useBatchStore } from '@/stores/batchStore'
import { useProfileStore } from '@/stores/profileStore'
import { useMetricsStore } from '@/stores/metricsStore'
import { useFirmwareStore } from '@/stores/firmwareStore'
import { useDiscoveryStore } from '@/stores/discoveryStore'
import { useBackupStore } from '@/stores/backupStore'
import { useTransferStore } from '@/stores/transferStore'
import type { PanelId } from './panelPrefetch'

/**
 * 面板互斥开关。
 *
 * 9 个功能面板都在 App.tsx 里以 `{open && <Panel />}` 平铺挂载、同一个 z-30 层，
 * 谁盖住谁由挂载顺序决定，跟"哪个后打开"无关。于是"从 A 面板跳到 B 面板"
 * （传输记录里点定位、档案里点诊断……）会出现两种坏结果：新面板在底下默默打开，
 * 用户完全看不见；或者两个面板叠着，Esc 只关掉其中一个。
 *
 * 所有"跨面板跳转"都走这里：先关掉其余全部，再打开目标。
 */
const CLOSERS: Record<PanelId, () => void> = {
  sftp: () => useSftpStore.getState().close(),
  diag: () => useDiagStore.setState({ panelOpen: false }),
  batch: () => useBatchStore.setState({ panelOpen: false }),
  profile: () => useProfileStore.setState({ panelOpen: false }),
  metrics: () => useMetricsStore.setState({ panelOpen: false }),
  firmware: () => useFirmwareStore.setState({ panelOpen: false }),
  discovery: () => useDiscoveryStore.setState({ panelOpen: false }),
  backup: () => useBackupStore.setState({ panelOpen: false }),
  transfer: () => useTransferStore.setState({ panelOpen: false })
}

/** 关掉除 keep 以外的所有功能面板 */
export function closePanelsExcept(keep: PanelId): void {
  for (const id of Object.keys(CLOSERS) as PanelId[]) {
    if (id !== keep) CLOSERS[id]()
  }
}
