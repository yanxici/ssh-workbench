import type { ParsedSshCommand } from '@shared/types'

/**
 * 解析 ssh 命令行文本，用于「从剪贴板识别并自动填充连接信息」。
 *
 * 支持的形态（含各 flag 的不同顺序/合并写法）：
 *   ssh user@host
 *   ssh user@host -p 2222
 *   ssh -p 2222 -i ~/.ssh/id_rsa user@host
 *   ssh -l root 192.168.1.10
 *   ssh -o StrictHostKeyChecking=no root@10.0.0.1
 *
 * 说明：只解析「连接信息」这层；ssh 之后的远程命令参数一律忽略。
 */

/** 需要吞掉下一个参数的 flag（-o Key=Value 之类） */
const FLAGS_WITH_VALUE = new Set([
  '-o',
  '-F',
  '-J',
  '-c',
  '-m',
  '-b',
  '-E',
  '-e',
  '-D',
  '-L',
  '-R',
  '-w',
  '-W',
  '-Q',
  '-S',
  '-B',
  '-I'
])

/** 按 shell 习惯拆分 token，支持单/双引号包裹 */
function tokenize(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null

  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
    } else {
      cur += ch
    }
  }
  if (cur) out.push(cur)
  return out
}

export function parseSshCommand(raw: string): ParsedSshCommand {
  const text = raw.trim()
  if (!/^ssh(\s|$)/.test(text)) return { ok: false }

  const tokens = tokenize(text)
  let username: string | undefined
  let port: number | undefined
  let privateKeyPath: string | undefined
  const positional: string[] = []

  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i]

    if (t === '-p' && tokens[i + 1]) {
      port = Number(tokens[i + 1])
      i += 1
    } else if (t === '-i' && tokens[i + 1]) {
      privateKeyPath = tokens[i + 1]
      i += 1
    } else if (t === '-l' && tokens[i + 1]) {
      username = tokens[i + 1]
      i += 1
    } else if (t.startsWith('-p') && t.length > 2) {
      port = Number(t.slice(2))
    } else if (t.startsWith('-i') && t.length > 2) {
      privateKeyPath = t.slice(2)
    } else if (t.startsWith('-l') && t.length > 2) {
      username = t.slice(2)
    } else if (FLAGS_WITH_VALUE.has(t)) {
      i += 1 // 吞掉 flag 的参数
    } else if (t.startsWith('-')) {
      // 其余无参 flag（-v -N -q -T ...）忽略
    } else {
      positional.push(t)
    }
  }

  const target = positional[0]
  if (!target) return { ok: false }

  let host = target
  if (target.includes('@')) {
    const at = target.lastIndexOf('@')
    if (!username) username = target.slice(0, at)
    host = target.slice(at + 1)
  }

  if (!host) return { ok: false }
  if (port !== undefined && (!Number.isInteger(port) || port <= 0 || port > 65535)) port = undefined

  return {
    ok: true,
    username,
    host,
    port: port ?? 22,
    privateKeyPath
  }
}
