import { BrowserWindow, dialog, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { generateHtml, generateMarkdown } from '../util/reportFormat'
import { createZip, type ZipEntry } from '../util/zip'
import { listConnections, listHistory, listProfiles } from './repository'
import { backupStore } from './backups'
import { readReport } from './reports'
import { recorder } from './recorder'

/**
 * 诊断报告一键打包 —— 把「报告 + 会话日志 + 命令历史 + 配置备份 + 设备档案」
 * 汇总成一个 zip，发给研发或客户即可复现现场。
 */

import type { BundleOptions, BundlePreview } from '@shared/types'

export type { BundleOptions, BundlePreview }

const MAX_BACKUP_FILES_PER_BACKUP = 200

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

  // 会话日志：录制文件名形如 {时间戳}-{会话名}.cast，按连接名匹配
  const logs = await recorder.list()
  const matchedLogs = logs.filter((l) => l.name.includes(report.connectionName))

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
    const logs = (await recorder.list())
      .filter((l) => l.name.includes(report.connectionName))
      .slice(0, 20)
    for (const log of logs) {
      try {
        const content = await fs.readFile(log.path)
        entries.push({ name: `会话日志/${log.name}`, data: content })
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
          const safePath = file.path.replace(/^\/+/, '').replace(/\.\./g, '_')
          entries.push({
            name: `配置备份/${detail.name}/${safePath}`,
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

  const win = BrowserWindow.getFocusedWindow()
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const res = await dialog.showSaveDialog(win as BrowserWindow, {
    title: '导出诊断打包（zip）',
    defaultPath: `${report.connectionName}-诊断打包-${stamp}.zip`,
    filters: [{ name: 'ZIP 压缩包', extensions: ['zip'] }]
  })
  if (res.canceled || !res.filePath) return { canceled: true }

  await fs.writeFile(res.filePath, zip)
  return { canceled: false, path: res.filePath, size: zip.length, entries: entries.length }
}

/** 在文件管理器中定位导出的 zip */
export function revealBundle(filePath: string): void {
  shell.showItemInFolder(filePath)
}
