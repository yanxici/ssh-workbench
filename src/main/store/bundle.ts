import { shell } from 'electron'
import { promises as fs } from 'node:fs'
import { generateHtml, generateMarkdown } from '../util/reportFormat'
import { createZip, zipEntryName, type ZipEntry } from '../util/zip'
import { listConnections, listHistory, listProfiles } from './repository'
import { backupStore } from './backups'
import { readReport } from './reports'
import { listSessionLogs } from './sessionLogs'
import { dialogDefaultPath, rememberDialogPick } from '../util/dialogDirs'
import { showSaveDialog } from '../windowRef'

/**
 * 诊断报告一键打包 —— 把「报告 + 会话日志 + 命令历史 + 配置备份 + 设备档案」
 * 汇总成一个 zip，发给研发或客户即可复现现场。
 */

import type { BundleOptions, BundlePreview } from '@shared/types'

export type { BundleOptions, BundlePreview }

const MAX_BACKUP_FILES_PER_BACKUP = 200

/** 录制文件名的时间戳前缀：YYYYMMDD-HHMMSS- */
const STAMP_RE = /^\d{8}-\d{6}-/

/**
 * 这个日志文件是否属于给定连接。
 *
 * 原来是 `name.includes(connectionName)` —— 连接名是 prod / 1 / 2026 这种短词时，
 * 会把别的客户同名字段的录屏一并打进支持包（私密终端内容泄漏给第三方），
 * 而带 `:` 的连接名在文件名里被 sanitize 成 `_`，反而一个都匹配不上。
 * 所以两侧都按录制器同一套规则清洗，再要求「时间戳之后的部分完全相等」。
 */
function logBelongsTo(name: string, connectionName: string): boolean {
  const stem = name.replace(/\.[^.]+$/, '')
  /*
   * 同一秒开两个同名会话时，录制器会把后一个退到「名-2」「名-3」
   * （见 ssh/recorder.ts 的 reserveBase）。只比完全相等的话，第二条录屏
   * 就被判成「别的连接的」而漏进支持包 —— 用户恰恰最需要那一份。
   * 判据改成「名」或「名-N」，N 限纯数字，避免把 prod-legacy 误认成 prod。
   */
  const rawBody = stem.replace(STAMP_RE, '')
  const expected = sanitizeLogName(connectionName)
  /*
   * 同秒重名后缀现在是 '#{2}'（见 ssh/recorder.ts 的 reserveBase），只剥 #N。
   * 旧实现剥 /-\d+$/：'web-1' 被剥成 'web' —— 既丢掉 web-1 自己的录屏，
   * 又把它的终端内容错打进 web 的外发诊断包。
   */
  return rawBody === expected || rawBody.replace(/#\d+$/, '') === expected
}

/** 与 ssh/recorder.ts 的 sanitize 保持一致（那边是模块私有，这里只能复制规则） */
function sanitizeLogName(name: string): string {
  return name.replace(/[\\/:*?"<>|#]/g, '_').trim() || 'session'
}

async function resolveContext(reportId: string): Promise<{
  report: Awaited<ReturnType<typeof readReport>>
  connectionId?: string
  proxyTitle: string
}> {
  const report = await readReport(reportId)
  const connections = await listConnections()
  const connection = connections.find((c) => c.name === report.connectionName)
  return { report, connectionId: connection?.id, proxyTitle: report.connectionName }
}

/** 打包前预览：告诉用户各分项有多少内容可入包 */
export async function bundlePreview(reportId: string): Promise<BundlePreview> {
  const { report, connectionId } = await resolveContext(reportId)

  // 会话日志：录制文件名形如 {时间戳}-{会话名}.cast，按连接名精确匹配
  const logs = await listSessionLogs()
  const matchedLogs = logs.filter((l) => logBelongsTo(l.name, report.connectionName))

  const history = connectionId ? await listHistory({ connectionId, limit: 5000 }) : []

  const backups = (await backupStore.list()).filter(
    (b) => b.connectionName === report.connectionName
  )

  const profiles = await listProfiles()
  const profile = connectionId
    ? profiles.find((p) => p.connectionIds.includes(connectionId))
    : undefined

  return {
    reportTitle: report.title,
    connectionName: report.connectionName,
    host: report.host,
    logFiles: matchedLogs.length,
    logBytes: matchedLogs.reduce((n, l) => n + l.size, 0),
    historyCount: history.length,
    backups: backups.length,
    profileName: profile?.customerName
  }
}

/** 生成并保存 zip（走系统保存对话框） */
export async function exportBundle(
  reportId: string,
  options: BundleOptions
): Promise<{ canceled: boolean; path?: string; size?: number; entries?: number }> {
  const { report, connectionId } = await resolveContext(reportId)
  const entries: ZipEntry[] = []

  /* ---------- 报告本体（Markdown + HTML） ---------- */
  entries.push({ name: '诊断报告.md', data: Buffer.from(generateMarkdown(report), 'utf-8') })
  entries.push({ name: '诊断报告.html', data: Buffer.from(generateHtml(report), 'utf-8') })

  /* ---------- 设备信息 ---------- */
  const connections = await listConnections()
  const profiles = await listProfiles()
  const profile = connectionId
    ? profiles.find((p) => p.connectionIds.includes(connectionId))
    : undefined
  const connection = connectionId ? connections.find((c) => c.id === connectionId) : undefined
  entries.push({
    name: '设备信息.json',
    data: Buffer.from(
      JSON.stringify(
        {
          导出时间: new Date().toISOString(),
          诊断报告: {
            title: report.title,
            connectionName: report.connectionName,
            host: report.host,
            username: report.username,
            startedAt: new Date(report.startedAt).toISOString(),
            finishedAt: new Date(report.finishedAt).toISOString(),
            sectionCount: report.sectionCount,
            okCount: report.okCount,
            problemCount: report.problemCount
          },
          连接: connection
            ? { name: connection.name, host: connection.host, port: connection.port, username: connection.username, group: connection.group, tags: connection.tags }
            : undefined,
          设备档案: profile
            ? {
                customerName: profile.customerName,
                project: profile.project,
                deviceModel: profile.deviceModel,
                sn: profile.sn,
                firmwareVersion: profile.firmwareVersion,
                contact: profile.contact,
                ticketNo: profile.ticketNo
              }
            : undefined
        },
        null,
        2
      ),
      'utf-8'
    )
  })

  /* ---------- 会话日志 ---------- */
  if (options.includeLogs) {
    const logs = (await listSessionLogs())
      .filter((l) => logBelongsTo(l.name, report.connectionName))
      .slice(0, 20)
    for (const log of logs) {
      try {
        const content = await fs.readFile(log.path)
        entries.push({ name: zipEntryName(`会话日志/${log.name}`), data: content })
      } catch {
        /* 跳过读取失败 */
      }
    }
  }

  /* ---------- 命令历史 ---------- */
  if (options.includeHistory && connectionId) {
    const history = await listHistory({ connectionId, limit: 5000 })
    if (history.length > 0) {
      const lines = history
        .slice()
        .reverse()
        .map((h) => `[${new Date(h.executedAt).toLocaleString()}] ${h.command}`)
      entries.push({
        name: '命令历史.txt',
        data: Buffer.from(`# ${report.connectionName} 命令历史（${history.length} 条）\n\n${lines.join('\n')}\n`, 'utf-8')
      })
    }
  }

  /* ---------- 配置备份 ---------- */
  if (options.includeBackups) {
    const backups = (await backupStore.list()).filter(
      (b) => b.connectionName === report.connectionName
    )
    for (const meta of backups) {
      try {
        const detail = await backupStore.detail(meta.id)
        let count = 0
        for (const file of detail.files) {
          if (count >= MAX_BACKUP_FILES_PER_BACKUP) break
          if (file.content === undefined) continue
          // 备份名与备份内路径都来自远端设备（可含 ../），必须走同一套清洗，
          // 否则解压时条目会写到用户选定目录之外
          entries.push({
            name: zipEntryName(`配置备份/${detail.name}/${file.path}`),
            data: Buffer.from(file.content, 'utf-8')
          })
          count += 1
        }
      } catch {
        /* 跳过损坏备份 */
      }
    }
  }

  if (entries.length === 0) throw new Error('没有可打包的内容')

  const zip = createZip(entries)

  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const res = await showSaveDialog({
    title: '导出诊断打包（zip）',
    // 连接名可由用户任意编辑（含 / \ : * ? " < > |），不净化会让默认文件名非法
    defaultPath: dialogDefaultPath('backup', `${sanitizeLogName(report.connectionName)}-诊断打包-${stamp}.zip`),
    filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
  })
  if (res.canceled || !res.filePath) return { canceled: true }
  rememberDialogPick('backup', res.filePath, false)

  await fs.writeFile(res.filePath, zip)
  return { canceled: false, path: res.filePath, size: zip.length, entries: entries.length }
}

/** 在文件管理器中定位导出的 zip */
export function revealBundle(filePath: string): void {
  shell.showItemInFolder(filePath)
}
