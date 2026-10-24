import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  AppSettings,
  Command,
  CommandHistoryEntry,
  CommandInput,
  Connection,
  ConnectionInput,
  DeviceProfile,
  DeviceProfileInput,
  DiagSection,
  DiagSectionInput,
  HistoryFilter,
  TerminalPrefs,
  TunnelConfig,
  TunnelInput
} from '@shared/types'
import { BUILTIN_DIAG_SECTIONS } from '../data/diagTemplates'
import { buildSeedCommands } from '../data/seedCommands'
import { JsonStore, dataDir } from './jsonStore'
import { deleteSecret, getSecret, setSecret } from './vault'

/**
 * 数据仓库 —— 全部持久化读写的唯一入口。
 *
 * 文件布局（%APPDATA%/ssh-workbench/data/）：
 *   connections.json   连接定义（不含任何密码）
 *   secrets.json       凭据密文（vault 管理，safeStorage 加密）
 *   commands.json      常用命令
 *   history.json       命令历史
 *   settings.json      应用设置
 *   known-hosts.json   已知主机指纹
 */

const connStore = new JsonStore<Connection[]>(join(dataDir(), 'connections.json'), () => [])
const cmdStore = new JsonStore<Command[]>(join(dataDir(), 'commands.json'), () => [])
const histStore = new JsonStore<CommandHistoryEntry[]>(join(dataDir(), 'history.json'), () => [])
const settingsStore = new JsonStore<Partial<AppSettings>>(
  join(dataDir(), 'settings.json'),
  () => ({})
)
const tunnelStore = new JsonStore<TunnelConfig[]>(join(dataDir(), 'tunnels.json'), () => [])
const diagSectionStore = new JsonStore<DiagSection[]>(
  join(dataDir(), 'diag-sections.json'),
  () => []
)
const profileStore = new JsonStore<DeviceProfile[]>(join(dataDir(), 'profiles.json'), () => [])

export interface KnownHost {
  host: string
  port: number
  /** SHA256:xxxx 格式 */
  fingerprint: string
  addedAt: number
}

const knownHostStore = new JsonStore<Record<string, KnownHost>>(
  join(dataDir(), 'known-hosts.json'),
  () => ({})
)

/**
 * 外观外壳版本号。
 *
 * 每次「外壳整体换一版设计」就 +1，用于把老用户的设置一次性迁移到新默认值：
 * 老版本（没有这个字段）存的是 dark + workbench 配色 + 旧字体链，
 * 而这些值恰好就是旧默认值 —— 分不清「用户主动选的」和「安装时写进去的」。
 * 用版本号一刀切做一次性迁移，比猜用户意图可靠；迁移只发生一次，
 * 之后用户再改成什么都由他自己说了算。
 */
const UI_SHELL_VERSION = 2

/** 旧版默认字体链，仅用于迁移时判断「用户没改过」 */
const LEGACY_FONT_FAMILY =
  "'JetBrains Mono', 'Cascadia Code', Consolas, 'Microsoft YaHei Mono', monospace"
const NEW_FONT_FAMILY = "'JetBrains Mono', 'Fira Code', Consolas, monospace"

/**
 * 一次性外观迁移。
 *
 * 只在这三种情况下改值：
 * - 完全没有 uiShellVersion（老配置）：外壳整体换代，主题/配色/字体直接对齐新规范；
 * - uiShellVersion 小于当前值：逐版补丁；
 * - 字体仍旧等于旧默认值：说明用户没自定义过，跟着换。
 * 用户自己改过的字体、以及迁移过一次之后的任何设置，一律不动。
 */
function migrateShell(stored: Partial<AppSettings>): Partial<AppSettings> {
  const from = stored.uiShellVersion ?? 0
  if (from >= UI_SHELL_VERSION) return stored

  const next: Partial<AppSettings> = { ...stored, uiShellVersion: UI_SHELL_VERSION }

  // v1 → v2：绿色标题栏外壳上线，默认切到浅色 + VS Code 配色
  if (from < 2) {
    next.theme = 'light'
    next.colorTheme = 'vscode'
    if (!stored.terminal?.fontFamily || stored.terminal.fontFamily === LEGACY_FONT_FAMILY) {
      next.terminal = { ...stored.terminal, fontFamily: NEW_FONT_FAMILY } as TerminalPrefs
    }
    /*
     * 侧栏默认宽度 250 → 280。250 是旧三栏外壳的默认值，那时侧栏里只放连接
     * 列表；新外壳的侧栏要放文件树、命令按钮墙、日志表格，250 会把
     * `root@192.168.100.120` 截断成 `root@192.168.100.…`。
     * 用户真正拖过的其它宽度保持不动 —— 只认「等于旧默认值」这一种情况。
     */
    if (stored.layout?.sidebar === undefined || stored.layout.sidebar === 250) {
      next.layout = { ...stored.layout, sidebar: 280 }
    }
  }

  return next
}

export const DEFAULT_SETTINGS: AppSettings = {
  // 新外观外壳（绿色标题栏 / 浅色工作区）是按浅色规范设计的，
  // 所以首装默认走 light + vscode 配色；老用户存了别的值就继续用他的。
  theme: 'light',
  colorTheme: 'vscode',
  terminal: {
    // 与设计规范一致：JetBrains Mono → Fira Code → Consolas 兜底。
    // 去掉了 'Cascadia Code' 与 'Microsoft YaHei Mono' —— 前者与 JetBrains Mono
    // 字形宽度接近但大写字高不同，混排时中英混排基线会跳；后者是中文等宽，
    // 只在没有前两者时才有意义，写上反而让 font-family 匹配链变长。
    fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
    fontSize: 13.5,
    lineHeight: 1.35,
    cursorStyle: 'block',
    cursorBlink: true,
    scrollback: 5000
  },
  uiShellVersion: UI_SHELL_VERSION,
  commandPanelPosition: 'right',
  latencyProbe: true,
  autoLog: true,
  dangerPatterns: [
    'rm -rf',
    'mkfs',
    'dd if=',
    'dd of=/dev/',
    'shutdown',
    'reboot',
    'poweroff',
    '> /dev/sd',
    'chmod -R 777 /',
    'kill -9 1'
  ],
  strictHostKey: true,
  // 现场设备网络抖动频繁，默认开启自动重连；仍可在设置里关掉
  autoReconnect: true,
  autoReconnectMax: 5
}

/* ------------------------------------------------------------------ *
 *  连接
 * ------------------------------------------------------------------ */

export async function listConnections(): Promise<Connection[]> {
  return connStore.read()
}

export async function getConnection(id: string): Promise<Connection | undefined> {
  const list = await connStore.read()
  return list.find((c) => c.id === id)
}

/**
 * 保存连接（新增或更新）。
 * 凭据语义：password / passphrase 为 undefined 表示保持原值，'' 表示清除，非空表示覆盖。
 */
export async function saveConnection(input: ConnectionInput): Promise<Connection> {
  const now = Date.now()
  let saved!: Connection

  await connStore.update((list) => {
    const base = {
      name: input.name.trim(),
      host: input.host.trim(),
      port: input.port,
      username: input.username.trim(),
      authType: input.authType,
      privateKeyPath: input.privateKeyPath?.trim() || undefined,
      group: input.group.trim() || '默认',
      tags: input.tags ?? [],
      color: input.color,
      remark: input.remark,
      proxyJump: input.proxyJump && input.proxyJump.length > 0 ? input.proxyJump : undefined,
      // 代理密码不落盘：剥离后存入凭据保险箱（见下方 setSecret）
      proxy: input.proxy ? { ...input.proxy, password: undefined } : undefined
    }

    if (input.id) {
      const idx = list.findIndex((c) => c.id === input.id)
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

  if (input.password !== undefined || input.passphrase !== undefined || input.proxy !== undefined) {
    const current = await getSecret(saved.id)
    await setSecret(saved.id, {
      password: input.password === undefined ? current.password : input.password,
      passphrase: input.passphrase === undefined ? current.passphrase : input.passphrase,
      // 代理密码语义：proxy 缺失 = 取消代理（清空）；password undefined = 保持；'' = 清除；其他 = 覆盖
      proxyPassword:
        input.proxy === undefined
          ? undefined
          : input.proxy.password === undefined
            ? current.proxyPassword
            : input.proxy.password === ''
              ? undefined
              : input.proxy.password
    })
  }

  return saved
}

/** 批量写入完整连接对象（按 id 覆盖或追加），一次读改写完成；供导入使用 */
export async function bulkUpsertConnections(items: Connection[]): Promise<void> {
  if (items.length === 0) return
  await connStore.update((list) => {
    const byId = new Map(items.map((c) => [c.id, c]))
    const next = list.map((c) => {
      const hit = byId.get(c.id)
      if (!hit) return c
      byId.delete(c.id)
      return hit
    })
    return [...next, ...byId.values()]
  })
}

export async function deleteConnection(id: string): Promise<void> {
  await connStore.update((list) => list.filter((c) => c.id !== id))
  await deleteSecret(id)
}

/**
 * 批量删除连接：一次读改写，返回实际删除条数。
 *
 * 逐个 deleteConnection 会走 N 次 update（每次一次落盘），
 * 删几百条时既慢又产生 N 次临时文件重命名；这里合并成一次。
 */
export async function deleteConnections(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const want = new Set(ids)
  let removed = 0
  await connStore.update((list) => {
    const next = list.filter((c) => {
      if (!want.has(c.id)) return true
      removed++
      return false
    })
    return next
  })
  // 凭据清理不阻塞主流程，逐条删（secrets 体量小）
  for (const id of ids) await deleteSecret(id)
  return removed
}

/**
 * 连接分组重命名：一次读改写完成。
 * 与命令分组同一套路 —— 逐条 saveConnection 会产生 N 次落盘，
 * 上千条连接时每次改名要等几秒，这里直接改字段。
 */
export async function renameConnectionGroup(from: string, to: string): Promise<number> {
  const target = to.trim()
  if (!target) throw new Error('分组名称不能为空')
  let count = 0
  await connStore.update((list) =>
    list.map((c) => {
      if ((c.group || '默认') !== from) return c
      count++
      return { ...c, group: target, updatedAt: Date.now() }
    })
  )
  return count
}

/** 删除连接分组及其下全部连接，返回删除的连接数（连带清理凭据保险箱） */
export async function deleteConnectionGroup(group: string): Promise<number> {
  let removedIds: string[] = []
  await connStore.update((list) => {
    removedIds = list.filter((c) => (c.group || '默认') === group).map((c) => c.id)
    return list.filter((c) => (c.group || '默认') !== group)
  })
  for (const id of removedIds) await deleteSecret(id)
  return removedIds.length
}

/** 记录最近使用时间 */
export async function touchConnection(id: string): Promise<void> {
  await connStore.update((list) =>
    list.map((c) => (c.id === id ? { ...c, lastUsedAt: Date.now() } : c))
  )
}

/* ------------------------------------------------------------------ *
 *  常用命令
 * ------------------------------------------------------------------ */

export async function listCommands(): Promise<Command[]> {
  return cmdStore.read()
}

export async function saveCommand(input: CommandInput): Promise<Command> {
  const now = Date.now()
  let saved!: Command

  await cmdStore.update((list) => {
    const base = {
      name: input.name.trim(),
      command: input.command,
      description: input.description?.trim() || undefined,
      group: input.group.trim() || '默认',
      icon: input.icon,
      color: input.color,
      confirmRequired: input.confirmRequired,
      variables: input.variables ?? []
    }

    if (input.id) {
      const idx = list.findIndex((c) => c.id === input.id)
      if (idx >= 0) {
        const next = [...list]
        saved = { ...list[idx], ...base, updatedAt: now }
        next[idx] = saved
        return next
      }
    }

    const maxOrder = list.reduce((max, c) => Math.max(max, c.sortOrder), 0)
    saved = {
      id: randomUUID(),
      ...base,
      sortOrder: maxOrder + 1,
      useCount: 0,
      createdAt: now,
      updatedAt: now
    }
    return [...list, saved]
  })

  return saved
}

export async function deleteCommand(id: string): Promise<void> {
  await cmdStore.update((list) => list.filter((c) => c.id !== id))
}

/** 分组重命名：一次读改写完成（逐条 save 会产生大量写入），返回移动的命令数 */
export async function renameCommandGroup(from: string, to: string): Promise<number> {
  const target = to.trim()
  if (!target) throw new Error('分组名称不能为空')
  const now = Date.now()
  let count = 0
  await cmdStore.update((list) =>
    list.map((c) => {
      if ((c.group || '默认') !== from) return c
      count++
      return { ...c, group: target, updatedAt: now }
    })
  )
  return count
}

/** 删除分组及其下全部命令，返回删除的命令数 */
export async function deleteCommandGroup(group: string): Promise<number> {
  let count = 0
  await cmdStore.update((list) => {
    const next = list.filter((c) => (c.group || '默认') !== group)
    count = list.length - next.length
    return next
  })
  return count
}

/** 按给定的 id 顺序重排 sortOrder */
export async function reorderCommands(orderedIds: string[]): Promise<void> {
  await cmdStore.update((list) => {
    const orderMap = new Map(orderedIds.map((id, i) => [id, i]))
    return list.map((c) => {
      const order = orderMap.get(c.id)
      return order === undefined ? c : { ...c, sortOrder: order }
    })
  })
}

/**
 * 记录一次执行：useCount + 1，lastUsedAt 置为当前时间。
 *
 * 这两个字段本来就在 Command 模型里（types.ts:139-141），但旧代码从未写入过，
 * 于是「最常用 / 最近使用」只能是摆设。命令中心的排序完全依赖它，
 * 所以执行成功后必须从这里打点。
 */
export async function touchCommand(id: string): Promise<Command | null> {
  const now = Date.now()
  let touched: Command | null = null
  await cmdStore.update((list) =>
    list.map((c) => {
      if (c.id !== id) return c
      touched = { ...c, useCount: c.useCount + 1, lastUsedAt: now }
      return touched
    })
  )
  return touched
}

/** 导入：merge = 追加去重（name+command 相同视为重复）；replace = 整体替换 */
export async function importCommands(
  rawList: unknown,
  mode: 'merge' | 'replace'
): Promise<{ imported: number; skipped: number }> {
  if (!Array.isArray(rawList)) throw new Error('导入内容不是命令数组')

  const now = Date.now()
  const normalized: Command[] = []
  let skipped = 0

  for (const item of rawList) {
    const it = item as Partial<Command>
    if (typeof it?.name !== 'string' || typeof it?.command !== 'string') {
      skipped += 1
      continue
    }
    normalized.push({
      id: randomUUID(),
      name: it.name,
      command: it.command,
      description: typeof it.description === 'string' ? it.description : undefined,
      group: typeof it.group === 'string' && it.group ? it.group : '导入',
      icon: typeof it.icon === 'string' ? it.icon : undefined,
      color: typeof it.color === 'string' ? it.color : undefined,
      confirmRequired: Boolean(it.confirmRequired),
      variables: Array.isArray(it.variables) ? it.variables : [],
      sortOrder: typeof it.sortOrder === 'number' ? it.sortOrder : normalized.length,
      useCount: 0,
      createdAt: now,
      updatedAt: now
    })
  }

  if (mode === 'replace') {
    await cmdStore.write(normalized)
    return { imported: normalized.length, skipped }
  }

  let imported = 0
  await cmdStore.update((list) => {
    const seen = new Set(list.map((c) => `${c.name}\u0000${c.command}`))
    const next = [...list]
    for (const c of normalized) {
      const key = `${c.name}\u0000${c.command}`
      if (seen.has(key)) {
        skipped += 1
        continue
      }
      seen.add(key)
      next.push(c)
      imported += 1
    }
    return next
  })
  return { imported, skipped }
}

export async function exportCommands(): Promise<Command[]> {
  const list = await cmdStore.read()
  return [...list].sort((a, b) => a.sortOrder - b.sortOrder)
}

/** 首次运行时注入内置命令 */
export async function seedCommandsIfNeeded(): Promise<void> {
  if (await cmdStore.exists()) return
  await cmdStore.write(buildSeedCommands())
}

/* ------------------------------------------------------------------ *
 *  命令历史
 * ------------------------------------------------------------------ */

const HISTORY_LIMIT = 2000

export async function listHistory(filter: HistoryFilter = {}): Promise<CommandHistoryEntry[]> {
  let list = await histStore.read()
  if (filter.connectionId) list = list.filter((e) => e.connectionId === filter.connectionId)
  if (filter.keyword) {
    const kw = filter.keyword.toLowerCase()
    list = list.filter((e) => e.command.toLowerCase().includes(kw))
  }
  const limit = filter.limit ?? 500
  return list.slice(-limit).reverse()
}

export async function addHistory(
  entry: Omit<CommandHistoryEntry, 'id'>
): Promise<CommandHistoryEntry> {
  const full: CommandHistoryEntry = { ...entry, id: randomUUID() }

  await histStore.update((list) => {
    const next = [...list, full]
    return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next
  })

  // 来自常用命令的执行：同步使用计数，供「最常用」排序
  if (full.snippetId) {
    await cmdStore.update((cmds) =>
      cmds.map((c) =>
        c.id === full.snippetId
          ? { ...c, useCount: c.useCount + 1, lastUsedAt: Date.now() }
          : c
      )
    )
  }

  return full
}

export async function clearHistory(connectionId?: string): Promise<void> {
  if (!connectionId) {
    await histStore.write([])
    return
  }
  await histStore.update((list) => list.filter((e) => e.connectionId !== connectionId))
}

/* ------------------------------------------------------------------ *
 *  设置
 * ------------------------------------------------------------------ */

function mergeSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return {
    ...base,
    ...patch,
    terminal: { ...base.terminal, ...(patch.terminal ?? {}) },
    dangerPatterns: patch.dangerPatterns ?? base.dangerPatterns
  }
}

export async function getSettings(): Promise<AppSettings> {
  const stored = await settingsStore.read()
  const migrated = migrateShell(stored)
  return mergeSettings(DEFAULT_SETTINGS, migrated)
}

export async function setSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  // 走 update 串行读改写：并发修改（如新建分组的同时切主题）不会互相覆盖
  const next = await settingsStore.update((stored) =>
    mergeSettings(mergeSettings(DEFAULT_SETTINGS, migrateShell(stored)), patch)
  )
  return next as AppSettings
}

/* ------------------------------------------------------------------ *
 *  诊断巡检项（自定义部分）
 * ------------------------------------------------------------------ */

/** 全部诊断项 = 内置 + 自定义 */
export async function listDiagSections(): Promise<DiagSection[]> {
  const custom = await diagSectionStore.read()
  return [...BUILTIN_DIAG_SECTIONS, ...custom]
}

export async function saveDiagSection(input: DiagSectionInput): Promise<DiagSection> {
  const now = Date.now()
  let saved!: DiagSection

  await diagSectionStore.update((list) => {
    const base = {
      name: input.name.trim() || '未命名检查',
      group: input.group.trim() || '自定义',
      command: input.command,
      timeoutMs: Math.min(Math.max(input.timeoutMs || 12000, 1000), 120000),
      description: input.description?.trim() || undefined,
      builtin: false
    }

    if (input.id) {
      const idx = list.findIndex((s) => s.id === input.id)
      if (idx >= 0) {
        const next = [...list]
        saved = { ...list[idx], ...base, updatedAt: now }
        next[idx] = saved
        return next
      }
    }

    saved = { id: `custom.${randomUUID()}`, ...base, createdAt: now, updatedAt: now }
    return [...list, saved]
  })

  return saved
}

export async function deleteDiagSection(id: string): Promise<void> {
  await diagSectionStore.update((list) => list.filter((s) => s.id !== id))
}

/* ------------------------------------------------------------------ *
 *  客户 / 设备档案
 * ------------------------------------------------------------------ */

export async function listProfiles(): Promise<DeviceProfile[]> {
  const list = await profileStore.read()
  return [...list].sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function saveProfile(input: DeviceProfileInput): Promise<DeviceProfile> {
  const now = Date.now()
  let saved!: DeviceProfile

  await profileStore.update((list) => {
    const base = {
      customerName: input.customerName.trim() || '未命名客户',
      project: input.project?.trim() || undefined,
      deviceModel: input.deviceModel?.trim() || undefined,
      sn: input.sn?.trim() || undefined,
      firmwareVersion: input.firmwareVersion?.trim() || undefined,
      contact: input.contact?.trim() || undefined,
      ticketNo: input.ticketNo?.trim() || undefined,
      connectionIds: input.connectionIds ?? [],
      commandGroup: input.commandGroup?.trim() || undefined,
      remark: input.remark?.trim() || undefined
    }

    if (input.id) {
      const idx = list.findIndex((p) => p.id === input.id)
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

export async function deleteProfile(id: string): Promise<void> {
  await profileStore.update((list) => list.filter((p) => p.id !== id))
}

/* ------------------------------------------------------------------ *
 *  端口转发 / 隧道
 * ------------------------------------------------------------------ */

export async function listTunnels(): Promise<TunnelConfig[]> {
  const list = await tunnelStore.read()
  return [...list].sort((a, b) => a.createdAt - b.createdAt)
}

export async function getTunnel(id: string): Promise<TunnelConfig | undefined> {
  const list = await tunnelStore.read()
  return list.find((t) => t.id === id)
}

export async function saveTunnel(input: TunnelInput): Promise<TunnelConfig> {
  const now = Date.now()
  let saved!: TunnelConfig

  await tunnelStore.update((list) => {
    const base = {
      name: input.name.trim() || '未命名隧道',
      type: input.type,
      bindHost: input.bindHost.trim() || '127.0.0.1',
      bindPort: input.bindPort,
      targetHost: input.targetHost?.trim() || undefined,
      targetPort: input.targetPort,
      connectionId: input.connectionId || undefined,
      remark: input.remark?.trim() || undefined
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

/* ------------------------------------------------------------------ *
 *  已知主机指纹
 * ------------------------------------------------------------------ */

export function hostKey(host: string, port: number): string {
  return `${host}:${port}`
}

export async function getKnownHost(host: string, port: number): Promise<KnownHost | undefined> {
  const all = await knownHostStore.read()
  return all[hostKey(host, port)]
}

export async function upsertKnownHost(entry: KnownHost): Promise<void> {
  await knownHostStore.update((all) => ({ ...all, [hostKey(entry.host, entry.port)]: entry }))
}

export async function listKnownHosts(): Promise<KnownHost[]> {
  const all = await knownHostStore.read()
  return Object.values(all).sort((a, b) => b.addedAt - a.addedAt)
}

export async function deleteKnownHost(key: string): Promise<void> {
  await knownHostStore.update((all) => {
    const next = { ...all }
    delete next[key]
    return next
  })
}
