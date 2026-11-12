import type { Command, ConnKind } from './types'

/**
 * 命令「适用环境」的判定与归一化。
 *
 * 为什么是数组而不是三态字符串（'ssh' | 'serial' | 'both'）：
 * 数组让「只在串口」和「两者都行」用同一套包含关系表达，判定只有一句 includes，
 * 不必为第三种值再写一条分支；而且以后真出现第三种环境（比如 telnet）时，
 * 类型不用改，只是多一个可选值。
 */

/** 全部环境，顺序即 UI 上的展示顺序 */
export const ALL_ENVS: ConnKind[] = ['ssh', 'serial']

const ENV_LABEL: Record<ConnKind, string> = {
  ssh: 'SSH',
  serial: '串口'
}

/**
 * 归一化：空数组、非法值一律折算成 undefined（= 两者都适用）。
 * 落库前必须过这一道 —— commands.json 是纯文本、用户可手改，
 * `envs: []` 这种值会让「适用环境」变成「哪儿都不适用」，命令凭空消失。
 */
export function normalizeEnvs(envs: unknown): ConnKind[] | undefined {
  if (!Array.isArray(envs)) return undefined
  const picked = ALL_ENVS.filter((k) => envs.includes(k))
  // 只标了一种就是那种；标了两种等于没标（两者都适用），存 undefined 更省事
  if (picked.length === 0 || picked.length === ALL_ENVS.length) return undefined
  return picked
}

/** 命令是否适用于某种连接。缺省标记视为两者都适用。 */
export function appliesTo(
  command: Pick<Command, 'envs'>,
  kind: ConnKind | undefined
): boolean {
  // 没有活动会话（kind 未知）时不过滤：面板在没开会话时也要能浏览全部命令
  if (!kind) return true
  const envs = normalizeEnvs(command.envs)
  if (!envs) return true
  return envs.includes(kind)
}

/** 按环境过滤一批命令 */
export function filterByEnv<T extends Pick<Command, 'envs'>>(
  commands: T[],
  kind: ConnKind | undefined
): T[] {
  if (!kind) return commands
  return commands.filter((c) => appliesTo(c, kind))
}

/** 「适用环境」的短标签，用于卡片提示与编辑器 */
export function envLabel(envs: ConnKind[] | undefined): string {
  const norm = normalizeEnvs(envs)
  if (!norm) return '全部环境'
  return norm.map((k) => ENV_LABEL[k]).join(' / ')
}
