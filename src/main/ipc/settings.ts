import { app, clipboard } from 'electron'
import { IPC } from '@shared/ipc'
import { handle } from './handle'
import { dataDir } from '../store/jsonStore'
import { deleteKnownHost, listKnownHosts, refreshKnownHost } from '../store/repository'
import { getSettings, updateSettings } from '../app/settingsService'
import { probeHostFingerprint } from '../ssh/connectConfig'

/** 应用设置 / 数据目录 / 已知主机指纹 / 剪贴板 */
export function registerSettingsIpc(): void {
  handle(IPC.SETTINGS_GET, () => getSettings())
  /*
   * 只做转发：落盘 + 「更新偏好立刻生效」的副作用统一收在
   * app/settingsService.ts，传输层不再承载域逻辑。
   */
  handle(IPC.SETTINGS_SET, (patch: Parameters<typeof updateSettings>[0]) =>
    updateSettings(patch)
  )
  handle(IPC.STORE_PATHS, () => ({
    dataDir: dataDir(),
    userData: app.getPath('userData')
  }))

  /* ---------------- 已知主机指纹 ---------------- */
  handle(IPC.KNOWN_HOSTS_LIST, () => listKnownHosts())
  handle(IPC.KNOWN_HOSTS_DELETE, (key: string) => deleteKnownHost(key))

  // 探测设备「现在」的主机指纹：只握手、不认证、不写库。
  // 用户看到的对比是「记录里的旧值 vs 现场的新值」，所以不能走会拒绝握手的校验流程。
  handle(IPC.KNOWN_HOSTS_PROBE, async (host: string, port: number) => {
    const fingerprint = await probeHostFingerprint(host, port)
    return { host, port, fingerprint }
  })

  // 更新指纹：缺省重新探测一次再写入，也允许直接带上用户确认过的值。
  handle(
    IPC.KNOWN_HOSTS_REFRESH,
    async (host: string, port: number, fingerprint?: string) => {
      const next = fingerprint?.trim() || (await probeHostFingerprint(host, port))
      if (!next.startsWith('SHA256:')) throw new Error('指纹格式不正确（应形如 SHA256:xxxx）')
      return refreshKnownHost(host, port, next)
    }
  )

  /* ---------------- 剪贴板 ---------------- */
  handle(IPC.CLIP_READ, () => clipboard.readText())
  handle(IPC.CLIP_WRITE, (text: string) => clipboard.writeText(text))
}
