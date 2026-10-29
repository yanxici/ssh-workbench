import { IPC } from '@shared/ipc'
import type { DeviceProfileInput } from '@shared/types'
import { handle } from './handle'
import { deleteProfile, listProfiles, saveProfile } from '../store/repository'
import { metricsSampler } from '../ssh/metrics'
import { execCollect } from '../ssh/exec'
import { sessionManager } from '../ssh/sessionManager'
import { firmwareOps } from '../ssh/firmware'
import { tcpProbe } from '../util/tcpProbe'
import { netScanner } from '../ssh/netScan'
import { discoverMdns } from '../util/mdns'

/** 客户/设备档案、资源仪表盘、固件升级、设备发现（局域网扫描 + mDNS）、通用 ssh 执行 */
export function registerDeviceIpc(): void {
  /* ---------------- 客户 / 设备档案 ---------------- */
  handle(IPC.PROFILE_LIST, () => listProfiles())
  handle(IPC.PROFILE_SAVE, (input: DeviceProfileInput) => saveProfile(input))
  handle(IPC.PROFILE_DELETE, (id: string) => deleteProfile(id))

  /* ---------------- 资源仪表盘（实时监控） ---------------- */
  handle(IPC.METRICS_START, (sessionId: string, intervalMs?: number) =>
    metricsSampler.start(sessionId, intervalMs)
  )
  handle(IPC.METRICS_STOP, (sessionId: string) => metricsSampler.stop(sessionId))
  handle(IPC.METRICS_STATES, () => metricsSampler.states())

  /* ---------------- 固件升级助手 ---------------- */
  handle(IPC.FW_PICK_FILE, () => firmwareOps.pickFile())
  handle(IPC.FW_UPLOAD, (sessionId: string, localPath: string, remoteDir: string) =>
    firmwareOps.upload(sessionId, localPath, remoteDir)
  )
  handle(IPC.FW_VERIFY, (sessionId: string, localPath: string, remotePath: string) =>
    firmwareOps.verify(sessionId, localPath, remotePath)
  )
  handle(IPC.FW_UPGRADE, (runId: string, sessionId: string, command: string, timeoutMs: number) =>
    firmwareOps.upgrade(runId, sessionId, command, timeoutMs)
  )
  handle(IPC.FW_CANCEL, (runId: string) => firmwareOps.cancel(runId))
  handle(IPC.FW_REBOOT, (sessionId: string, command: string) =>
    firmwareOps.reboot(sessionId, command)
  )

  handle(IPC.NET_PROBE, (host: string, port: number, timeoutMs?: number) =>
    tcpProbe(host, port, timeoutMs)
  )

  handle(IPC.SSH_EXEC, async (sessionId: string, command: string, timeoutMs?: number) => {
    await sessionManager.waitUntilReady(sessionId)
    const client = sessionManager.getClient(sessionId)
    if (!client) throw new Error('会话不可用，请检查连接状态')
    const out = await execCollect(client, command, timeoutMs ?? 20000)
    return {
      status: out.status,
      exitCode: out.exitCode,
      stdout: out.stdout,
      stderr: out.stderr,
      error: out.error
    }
  })

  /* ---------------- 设备发现（局域网扫描 / mDNS） ---------------- */
  handle(IPC.NET_IFACES, () => netScanner.interfaces())
  handle(IPC.NET_SCAN, (runId: string, cidr: string, ports: number[], timeoutMs?: number) =>
    netScanner.scan(runId, cidr, ports, timeoutMs)
  )
  handle(IPC.NET_SCAN_CANCEL, (runId: string) => netScanner.cancel(runId))
  handle(IPC.NET_MDNS, (timeoutMs?: number) => discoverMdns(timeoutMs))
}
