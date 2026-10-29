import { utils } from 'ssh2'

/** 私钥文件上限：正常私钥只有几 KB，超过说明选错了文件 */
export const MAX_KEY_BYTES = 64 * 1024

export interface KeyInspectResult {
  /** 密钥算法，如 ssh-rsa / ssh-ed25519 */
  type: string
  /** 是否加密（需要私钥口令） */
  encrypted: boolean
}

/**
 * 校验私钥文件内容：支持 PEM（-----BEGIN RSA PRIVATE KEY-----）、OpenSSH 新格式、PuTTY .ppk。
 * 无效时抛出可直接展示给用户的错误。
 */
export function inspectPrivateKey(data: Buffer): KeyInspectResult {
  if (data.length === 0) throw new Error('文件为空，不是私钥文件')
  if (data.length > MAX_KEY_BYTES) throw new Error('文件过大，不是私钥文件')

  const text = data.toString('utf8')
  if (/^ssh-(rsa|ed25519|dss)\s|^ecdsa-sha2-/.test(text.trim())) {
    throw new Error('这是公钥（.pub），请选择不带 .pub 后缀的私钥文件')
  }

  const parsed = utils.parseKey(data)
  if (parsed instanceof Error) {
    // 加密私钥未给口令时 ssh2 会报 passphrase 相关错误：文件本身是有效私钥
    if (/passphrase|encrypted/i.test(parsed.message)) {
      return { type: guessType(text), encrypted: true }
    }
    throw new Error(`无法识别的私钥格式：${parsed.message}`)
  }
  // ssh2 的 parseKey 返回类型是 any（新版 key 对象与旧版 ParsedKey 混用），
  // 这里只用到两个成员，就地收窄成最小接口，避免后续全是 unsafe member access
  const key = (Array.isArray(parsed) ? parsed[0] : parsed) as
    | { isPrivateKey?: () => boolean; type?: string }
    | undefined
  if (!key || typeof key.isPrivateKey !== 'function' || !key.isPrivateKey()) {
    throw new Error('这不是私钥文件')
  }
  return { type: key.type ?? guessType(text), encrypted: false }
}

function guessType(text: string): string {
  if (text.includes('RSA')) return 'ssh-rsa'
  if (text.includes('EC PRIVATE')) return 'ecdsa'
  return '未知'
}
