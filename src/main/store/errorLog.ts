/**
 * 错误日志（用户可见 + 可导出）。
 *
 * 和 boot.log 的分工：
 * - boot.log：启动期诊断，纯文本，给开发看，用户不知道它存在；
 * - 本模块：运行期错误，结构化，**用户在「错误日志」面板里能直接看到并复制**。
 *
 * 设计要点：
 * 1. 去重聚合 —— 同一个「来源+标题+详情」只记一条并累加 count。
 *    真实场景里一次断网会刷出几十条同样的 IPC 失败，不去重的话
 *    日志文件几秒就废了，用户也对着一堆重复条目无从下手。
 * 2. 上限裁剪 —— 最多保留 MAX_ENTRIES 条，超了丢最旧的。
 *    错误日志不该成为磁盘隐患。
 * 3. 绝不记录敏感内容 —— 密码、私钥、token 只在 detail 出现时必须先脱敏。
 *    这里做一层兜底过滤，避免调用方漏处理。
 */

import { app } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ErrorEntry, ErrorLogStats } from '@shared/types'
import { JsonStore, dataDir } from './jsonStore'

/** 最多保留条数 */
const MAX_ENTRIES = 500
/** detail 最大长度，防止超长堆栈占满文件 */
const MAX_DETAIL = 2000
/** 相同错误的聚合窗口：窗口内重复出现只累加 count */
const DEDUPE_WINDOW_MS = 5 * 60 * 1000

const store = new JsonStore<ErrorEntry[]>(join(dataDir(), 'error-log.json'), () => [])

/**
 * 脱敏：把可能混进 detail 的敏感值替换掉。
 *
 * 为什么要在这一层做：调用方可能把整个 ConnectConfig、命令行参数、
 * 甚至私钥内容塞进 error.message。日志是会被用户复制发给别人的东西，
 * 一旦带上明文密码就是安全事故。
 */
function redact(text: string): string {
  return (
    text
      // password=xxx / passwd: xxx / pwd=xxx
      .replace(/((?:password|passwd|pwd|secret|token|apikey|api_key)\s*[=:]\s*)([^\s,;'"`\]}]+)/gi, '$1***')
      // 形如 "password":"xxx" 的 JSON 片段
      .replace(/("(?:password|passwd|secret|token)"\s*:\s*")([^"]*)(")/gi, '$1***$3')
      // PRIVATE KEY 块整体抹掉
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[PRIVATE KEY REDACTED]')
      // OpenSSH 私钥单行形态
      .replace(/-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*$/g, '[PRIVATE KEY REDACTED]')
  )
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + `…（截断，共 ${text.length} 字符）`
}

export interface RecordErrorInput {
  level?: 'error' | 'warn'
  /** 来源标记：'ipc:conn:save' / 'renderer' / 'main' 之类 */
  source: string
  /** 人话标题 */
  title: string
  detail?: string
}

/**
 * 记录一条错误。返回记录本身（便于调用方回读）。
 *
 * 这个函数**永不抛异常**：错误日志自己出错时不能反过来搞崩主流程，
 * 所有异常在内部吞掉。
 */
export async function recordError(input: RecordErrorInput): Promise<ErrorEntry | null> {
  try {
    const now = Date.now()
    const detail = input.detail ? clip(redact(String(input.detail)), MAX_DETAIL) : undefined
    const level = input.level ?? 'error'
    let saved: ErrorEntry | null = null

    await store.update((list) => {
      // 聚合窗口内相同内容：累加 count，不新增条目
      const dupIdx = list.findIndex(
        (e) =>
          e.source === input.source &&
          e.title === input.title &&
          e.detail === detail &&
          now - e.lastAt < DEDUPE_WINDOW_MS
      )

      if (dupIdx >= 0) {
        const next = [...list]
        next[dupIdx] = {
          ...next[dupIdx],
          count: next[dupIdx].count + 1,
          lastAt: now
        }
        saved = next[dupIdx]
        return next
      }

      const entry: ErrorEntry = {
        id: randomUUID(),
        at: now,
        lastAt: now,
        level,
        source: input.source,
        title: input.title,
        detail,
        count: 1,
        version: app.getVersion()
      }
      saved = entry
      // 新的排前面，超限从尾部（最旧）裁掉
      return [entry, ...list].slice(0, MAX_ENTRIES)
    })

    return saved
  } catch {
    // 错误日志自身失败时静默：不能因为记日志把业务搞崩
    return null
  }
}

/** 读取全部（新的在前） */
export async function listErrors(): Promise<ErrorEntry[]> {
  return store.read()
}

/** 清空 */
export async function clearErrors(): Promise<void> {
  await store.update(() => [])
}

/** 删除单条 */
export async function deleteError(id: string): Promise<void> {
  await store.update((list) => list.filter((e) => e.id !== id))
}

/** 统计：总数 + 按来源聚合 */
export async function errorStats(): Promise<ErrorLogStats> {
  const list = await store.read()
  const map = new Map<string, number>()
  let total = 0
  for (const e of list) {
    map.set(e.source, (map.get(e.source) ?? 0) + e.count)
    total += e.count
  }
  return {
    total,
    bySource: [...map.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count)
  }
}

/** 导出为纯文本（用户能直接贴给同事/提 issue） */
export async function exportErrorsText(): Promise<string> {
  const list = await store.read()
  if (list.length === 0) return '（没有错误记录）'
  const lines: string[] = [
    `SSH Workbench 错误日志`,
    `应用版本：${app.getVersion()}`,
    `导出时间：${new Date().toLocaleString()}`,
    `共 ${list.length} 类错误`,
    ''.padEnd(60, '=')
  ]
  for (const e of list) {
    lines.push('')
    lines.push(`[${e.level.toUpperCase()}] ${new Date(e.at).toLocaleString()}  ×${e.count}`)
    if (e.lastAt !== e.at) lines.push(`最近一次：${new Date(e.lastAt).toLocaleString()}`)
    lines.push(`来源：${e.source}`)
    lines.push(`标题：${e.title}`)
    if (e.detail) lines.push(`详情：${e.detail}`)
  }
  return lines.join('\n')
}

/** 暴露给测试：脱敏函数单独可测 */
export const __redactForTest = redact
