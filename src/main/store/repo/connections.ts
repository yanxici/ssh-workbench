import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { Connection, ConnectionInput, ConnKind, SerialConfig } from '@shared/types'
import { JsonStore, dataDir } from '../jsonStore'
import { deleteSecret, getSecret, setSecret } from '../vault'

/**
 * 连接定义（不含任何密码）。
 *
 * 凭据落在 vault 里（safeStorage 加密），这个文件只管「连到哪、用什么认证方式」。
 */

/**
 * 串口参数的落盘归一化。
 *
 * 只保留显式白名单字段，且对数值做区间收敛：connections.json 是纯文本、
 * 用户可以手改，一个 baudRate: 0 或 dataBits: 9 会让 serialport 在 open
 * 时抛一串 C++ 侧的错误，不如在这里就纠回合法值。
 */
function normalizeSerial(serial: ConnectionInput['serial']): SerialConfig | undefined {
  if (!serial) return undefined
  const baud = Number(serial.baudRate)
  const dataBits = Number(serial.dataBits)
  const stopBits = Number(serial.stopBits)
  return {
    path: (serial.path ?? '').trim(),
    baudRate: Number.isFinite(baud) && baud > 0 ? Math.floor(baud) : 115200,
    dataBits: ([5, 6, 7, 8] as const).includes(dataBits as 5 | 6 | 7 | 8)
      ? (dataBits as SerialConfig['dataBits'])
      : 8,
    stopBits: ([1, 1.5, 2] as const).includes(stopBits as 1 | 1.5 | 2)
      ? (stopBits as SerialConfig['stopBits'])
      : 1,
    parity: serial.parity ?? 'none',
    flowControl: serial.flowControl ?? 'none',
    charset: serial.charset ?? 'utf-8',
    newline: serial.newline ?? 'cr',
    autoReset: serial.autoReset === true,
    usbSerialNumber: serial.usbSerialNumber || undefined,
    usbPnpId: serial.usbPnpId || undefined,
    pathPending: serial.pathPending === true
  }
}

const connStore = new JsonStore<Connection[]>(join(dataDir(), 'connections.json'), () => [])

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
    const kind: ConnKind = input.kind === 'serial' ? 'serial' : 'ssh'
    const base = {
      kind,
      /*
       * 串口连接的 host/port/username/authType 一律落成空值。
       *
       * 为什么不把这些字段改成可选：改成可选会让 connectConfig、主机指纹
       * 校验、跳板链、导入导出、搜索等几十处全部要做类型收窄，收益只是
       * 「类型上更诚实」。这里统一成空串/0，读取方按 kind 分支即可。
       */
      host: kind === 'serial' ? '' : input.host.trim(),
      port: kind === 'serial' ? 0 : input.port,
      username: kind === 'serial' ? '' : input.username.trim(),
      authType: kind === 'serial' ? 'password' : input.authType,
      serial: kind === 'serial' ? normalizeSerial(input.serial) : undefined,
      name: input.name.trim(),
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
 * 批量设置连接标签：一次读改写 + 一次落盘。
 *
 * 为什么需要它：渲染层多选后打标签原本逐条调 saveConnection，
 * 500 条 = 500 次 IPC + 500 次「读全表 → 改一条 → 写全表」，
 * 而且每写完一次都把整个连接数组换掉，侧栏跟着全量重渲染 500 次。
 * 删除有 deleteConnections、移动分组有 renameConnectionGroup，唯独打标签漏了。
 *
 * mode：
 *   'add'     追加（去重合并）
 *   'remove'  移除指定标签
 *   'replace' 整体替换
 */
export async function updateConnectionsTags(
  ids: string[],
  tags: string[],
  mode: 'add' | 'remove' | 'replace' = 'add'
): Promise<number> {
  if (ids.length === 0) return 0
  const want = new Set(ids)
  const incoming = tags.map((t) => t.trim()).filter(Boolean)
  if (mode !== 'remove' && incoming.length === 0) return 0

  let count = 0
  await connStore.update((list) =>
    list.map((c) => {
      if (!want.has(c.id)) return c
      count++
      const current = c.tags ?? []
      let next: string[]
      if (mode === 'replace') next = incoming
      else if (mode === 'remove') next = current.filter((t) => !incoming.includes(t))
      else next = Array.from(new Set([...current, ...incoming]))
      return { ...c, tags: next, updatedAt: Date.now() }
    })
  )
  return count
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
