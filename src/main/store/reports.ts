import { app, dialog, shell, BrowserWindow } from 'electron'
import { promises as fs } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import type { DiagReport, DiagReportMeta } from '@shared/types'
import { generateHtml, generateMarkdown } from '../util/reportFormat'

/**
 * 诊断报告的持久化与导出。
 *
 * 存储：userData/reports/{时间戳}-{连接名}.json（结构化，便于再次渲染成 Markdown/HTML）
 * 导出：Markdown（贴工单/IM）与单文件 HTML（发客户/归档）均走系统保存对话框。
 */

function formatStamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function sanitize(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]/g, '_').trim() || 'report'
}

function reportsDir(): string {
  return join(app.getPath('userData'), 'reports')
}

/** 校验 report id 合法且文件位于报告目录内（防路径逃逸） */
function reportPath(id: string): string {
  // 报告名来自连接名（可能含中文/emoji），只拦截路径分隔符与上跳
  if (!id || /[\\/:*?"<>|]/.test(id) || id.includes('..') || id.startsWith('.')) {
    throw new Error('非法报告标识')
  }
  const dir = resolve(reportsDir())
  const target = resolve(join(dir, `${id}.json`))
  if (!target.startsWith(dir + sep)) throw new Error('非法报告路径')
  if (basename(target).startsWith('.')) throw new Error('非法报告路径')
  return target
}

export async function saveReport(
  report: Omit<DiagReport, 'id' | 'size'>
): Promise<DiagReport> {
  await fs.mkdir(reportsDir(), { recursive: true })
  const id = `${formatStamp(new Date(report.startedAt))}-${sanitize(report.connectionName)}`
  const full: DiagReport = { ...report, id, size: 0 }
  const json = JSON.stringify(full, null, 2)
  await fs.writeFile(reportPath(id), json, 'utf-8')
  return { ...full, size: Buffer.byteLength(json, 'utf-8') }
}

function toMeta(r: DiagReport, size: number): DiagReportMeta {
  return {
    id: r.id,
    title: r.title,
    connectionName: r.connectionName,
    host: r.host,
    username: r.username,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    sectionCount: r.sectionCount,
    okCount: r.okCount,
    problemCount: r.problemCount,
    size
  }
}

export async function listReports(): Promise<DiagReportMeta[]> {
  await fs.mkdir(reportsDir(), { recursive: true })
  const names = await fs.readdir(reportsDir())
  const out: DiagReportMeta[] = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const full = join(reportsDir(), name)
    try {
      const [raw, st] = await Promise.all([fs.readFile(full, 'utf-8'), fs.stat(full)])
      const parsed = JSON.parse(raw) as DiagReport
      out.push(toMeta(parsed, st.size))
    } catch {
      /* 跳过损坏文件 */
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt)
}

export async function readReport(id: string): Promise<DiagReport> {
  const raw = await fs.readFile(reportPath(id), 'utf-8')
  return JSON.parse(raw) as DiagReport
}

export async function removeReport(id: string): Promise<void> {
  await fs.rm(reportPath(id), { force: true })
}

/** 生成报告文本（Markdown/HTML），供导出对话框与「复制」使用 */
export async function reportText(id: string, format: 'md' | 'html'): Promise<string> {
  const report = await readReport(id)
  return format === 'html' ? generateHtml(report) : generateMarkdown(report)
}

export async function exportReport(
  id: string,
  format: 'md' | 'html'
): Promise<{ canceled: boolean; path?: string }> {
  const report = await readReport(id)
  const text = format === 'html' ? generateHtml(report) : generateMarkdown(report)
  const ext = format === 'html' ? 'html' : 'md'
  const win = BrowserWindow.getFocusedWindow()

  const res = await dialog.showSaveDialog(win as BrowserWindow, {
    title: format === 'html' ? '导出诊断报告（HTML）' : '导出诊断报告（Markdown）',
    defaultPath: `${sanitize(report.connectionName)}-诊断报告-${report.id.slice(0, 15)}.${ext}`,
    filters: [
      format === 'html'
        ? { name: 'HTML 文件', extensions: ['html'] }
        : { name: 'Markdown 文件', extensions: ['md'] }
    ]
  })
  if (res.canceled || !res.filePath) return { canceled: true }
  await fs.writeFile(res.filePath, text, 'utf-8')
  return { canceled: false, path: res.filePath }
}

export async function openReportsDir(): Promise<void> {
  await fs.mkdir(reportsDir(), { recursive: true })
  await shell.openPath(reportsDir())
}

export { reportsDir }
