import type { TestConnectionInput, TestConnectionResult } from '@shared/types'
import { getSettings } from '../store/repository'
import { getSecret } from '../store/vault'
import {
  buildConnectConfig,
  connectClient,
  connectWithOptionalProxy,
  humanizeConnectError,
  takeHostKeyMismatch
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
    const cfg = await buildConnectConfig(
      {
        host: input.host,
        port: input.port,
        username: input.username,
        authType: input.authType,
        privateKeyPath: input.privateKeyPath,
        legacyAlgorithms: input.legacyAlgorithms
      },
      secret,
      settings,
      (fp) => {
        fingerprint = fp
      }
    )
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
    const friendly = /host key|verif|Host denied/i.test(raw)
      ? `主机指纹校验未通过：${fingerprint ?? ''}。若设备已重装或固件升级，可直接点「更新主机指纹」`
      : humanizeConnectError(raw)
    // 指纹冲突：把「记录中 / 设备当前」都带回去，让编辑器能直接给「更新指纹」按钮
    const mismatch = /host key|verif|Host denied/i.test(raw)
      ? takeHostKeyMismatch(input.host, input.port)
      : null
    const result: TestConnectionResult = {
      ok: false,
      error: friendly,
      durationMs: Date.now() - started,
      banner,
      fingerprint
    }
    if (mismatch) {
      result.hostKeyMismatch = {
        known: mismatch.known,
        actual: mismatch.actual
      }
    }
    return result
  } finally {
    try {
      /*
       * 关闭期也要有 'error' 监听：connectClient 已在成功路径常驻兜底，
       * 但没连上（client 为 undefined）或走了别的分支时仍可能对端先发 RST，
       * 而 end() 之后 ssh2 的迟到 error 没有监听 = 主进程 uncaughtException。
       */
      if (client && client.listenerCount('error') === 0) client.on('error', () => {})
      client?.end()
    } catch {
      /* ignore */
    }
  }
}
