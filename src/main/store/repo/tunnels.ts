import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { TunnelConfig, TunnelInput } from '@shared/types'
import { isLoopbackHost } from '@shared/bindHost'
import { JsonStore, dataDir } from '../jsonStore'

/** 端口转发 / 隧道定义（运行时状态在 ssh/portForward.ts） */

const tunnelStore = new JsonStore<TunnelConfig[]>(join(dataDir(), 'tunnels.json'), () => [])

export async function listTunnels(): Promise<TunnelConfig[]> {
  const list = await tunnelStore.read()
  return [...list].sort((a, b) => a.createdAt - b.createdAt)
}

export async function getTunnel(id: string): Promise<TunnelConfig | undefined> {
  const list = await tunnelStore.read()
  return list.find((t) => t.id === id)
}

/**
 * 校验监听地址。
 *
 * 原来只给默认值不校验范围：用户填 0.0.0.0 就把整台机器的内网出口变成
 * 同网段任一台机器可用的免认证代理（socks5.ts 明确实现的是无认证 CONNECT）。
 * -L 同理，会让本机端口暴露到局域网。
 * 默认只允许回环；确实需要对外暴露的，必须显式勾 allowLan（UI 上有明确提示）。
 *
 * @param alreadyGranted 该配置此前已授权过 LAN 监听（存量配置兼容）。
 *   没有这个豁免，v1.6.5 及之前存下来的 0.0.0.0 隧道在本版之后
 *   一编辑就抛错 —— 改个名字都存不了，等于把用户锁死。
 */
function normalizeBindHost(
  raw: string | undefined,
  allowLan: boolean | undefined,
  alreadyGranted = false
): { bindHost: string; allowLan: boolean } {
  const host = (raw ?? '').trim() || '127.0.0.1'
  const loopback = isLoopbackHost(host)
  if (loopback) return { bindHost: host, allowLan: false }
  const granted = Boolean(allowLan) || alreadyGranted
  if (!granted) {
    // 显式取消勾选时把两个字段一起说清楚：只提示「请勾选允许局域网」会让人以为按钮坏了
    if (allowLan === false) {
      throw new Error(
        `已取消「允许局域网访问」，但监听地址仍是 ${host}。请把监听地址改回 127.0.0.1，或重新勾选允许局域网访问`
      )
    }
    throw new Error(
      `监听地址 ${host} 会暴露到局域网，代理无认证等于给同网段开放出口。若要对外监听，请显式允许局域网访问`
    )
  }
  return { bindHost: host, allowLan: true }
}

export async function saveTunnel(input: TunnelInput): Promise<TunnelConfig> {
  const now = Date.now()
  let saved!: TunnelConfig

  await tunnelStore.update((list) => {
    // 存量配置此前已授权过 LAN 监听 → 本次编辑不再要求重新勾选
    const prev = input.id ? list.find((t) => t.id === input.id) : undefined
    /*
     * 存量豁免只在用户**没有主动取消**时生效。
     * 原来无条件豁免，导致编辑框里把「允许局域网访问」取消勾选也照样存成 allowLan: true ——
     * 那个开关等于永久只读，用户没法把已经开放的端口收回来。
     */
    const alreadyGranted =
      (prev?.allowLan === true || (prev ? !isLoopbackHost(prev.bindHost) : false)) &&
      input.allowLan !== false
    const host = normalizeBindHost(input.bindHost, input.allowLan, alreadyGranted)

    const base = {
      name: input.name.trim() || '未命名隧道',
      type: input.type,
      bindHost: host.bindHost,
      /*
       * allowLan 必须持久化：只在校验时用一次就丢掉，下次打开编辑框
       * 读不到该字段，保存时又会因为 bindHost 非回环再次抛错。
       */
      allowLan: host.allowLan,
      bindPort: input.bindPort,
      targetHost: input.targetHost?.trim() || undefined,
      targetPort: input.targetPort,
      connectionId: input.connectionId || undefined,
      remark: input.remark?.trim() || undefined,
      /*
       * autoStart 只在绑定了连接时才有意义：没绑连接的隧道是「用户临时手动开一个」，
       * 让它跟着任意会话自启会给用户凭空多出监听端口。
       *
       * 必须写在 base 里而不是事后补：saveTunnel 用 { ...list[idx], ...base }
       * 合并已有配置，base 里没有这个字段就等于把它覆盖成 undefined，
       * 用户改个名字就会把自启标记弄丢。
       */
      autoStart: input.connectionId && input.autoStart === true ? true : undefined
    }

    if (input.id) {
      const idx = list.findIndex((t) => t.id === input.id)
      if (idx >= 0) {
        const next = [...list]
        saved = { ...list[idx], ...base, updatedAt: now }
        next[idx] = saved
        return next
      }
    }

    saved = { id: randomUUID(), ...base, createdAt: now, updatedAt: now }
    return [...list, saved]
  })

  return saved
}

export async function deleteTunnel(id: string): Promise<void> {
  await tunnelStore.update((list) => list.filter((t) => t.id !== id))
}
