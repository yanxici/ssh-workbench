import type { TestConnectionInput, TestConnectionResult } from '@shared/types'
import { getSettings } from '../store/repository'
import { getSecret } from '../store/vault'
import {
  buildConnectConfig,
  connectClient,
  connectWithOptionalProxy,
  humanizeConnectError
} from './connectConfig'

/**
 * 测试连接：在独立客户端上完成一次完整握手 + 认证，随后立即断开。
 * 编辑器中的「测试连接」按钮使用；语义是「凭据与网络是否可用」，不打开 shell。
 */
export async function testConnection(input: TestConnectionInput): Promise<TestConnectionResult> {
  const started = Date.now()
  const settings = await getSettings()

  // 编辑已有连接且未重新输入密码时，复用保险箱中的凭据（含代理密码）
  const secret = {
    password: input.password,
    passphrase: input.passphrase,
    proxyPassword: input.proxy?.password
  }
  if (input.connectionId) {
    const stored = await getSecret(input.connectionId)
    if (!secret.password) secret.password = stored.password
    if (!secret.passphrase) secret.passphrase = stored.passphrase
    if (!secret.proxyPassword) secret.proxyPassword = stored.proxyPassword
  }

  let banner: string | undefined
  let fingerprint: string | undefined
  let client: Awaited<ReturnType<typeof connectClient>> | null = null

  try {
    const cfg = await buildConnectConfig(input, secret, settings, (fp) => {
      fingerprint = fp
    })
    client = await connectWithOptionalProxy(cfg, {
      host: input.host,
      port: input.port,
      proxy: input.proxy,
      proxyPassword: secret.proxyPassword,
      onBanner: (b) => {
        banner = b
      }
    })
    return { ok: true, durationMs: Date.now() - started, banner, fingerprint }
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    const friendly = /host key|verif/i.test(raw)
      ? `主机指纹校验未通过：${fingerprint ?? ''}。若设备已重装或固件升级，请在 设置 → 已知主机 中删除记录后重试`
      : humanizeConnectError(raw)
    return { ok: false, error: friendly, durationMs: Date.now() - started, banner, fingerprint }
  } finally {
    try {
      client?.end()
    } catch {
      /* ignore */
    }
  }
}
