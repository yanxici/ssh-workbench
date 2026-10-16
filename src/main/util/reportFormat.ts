import type { DiagReport, DiagSectionResult } from '@shared/types'

/**
 * 诊断报告的 Markdown / HTML 生成（纯函数，便于独立测试）。
 *
 * - Markdown：适合贴进工单、IM、研发群；命令与输出用围栏代码块，输出内含 ``` 时自动升级围栏；
 * - HTML：单文件自包含（内联样式，无外部依赖），可直接发给客户或归档；
 *   所有动态内容一律 HTML 转义，防止设备输出里的尖括号破坏结构。
 */

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

export function formatDateTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function statusLabel(r: DiagSectionResult): string {
  switch (r.status) {
    case 'done':
      return '正常'
    case 'error':
      return '异常'
    case 'timeout':
      return '超时'
    case 'skipped':
      return '跳过'
    default:
      return r.status
  }
}

/** 输出围栏：内容含 ``` 时用更长的围栏避免截断 */
function fenceFor(text: string): string {
  return text.includes('```') ? '````' : '```'
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/* ------------------------------------------------------------------ *
 *  Markdown
 * ------------------------------------------------------------------ */

export function generateMarkdown(report: DiagReport): string {
  const lines: string[] = []
  lines.push(`# 诊断报告 · ${report.title}`)
  lines.push('')
  lines.push('| 项目 | 值 |')
  lines.push('| --- | --- |')
  lines.push(`| 设备 | \`${report.host}\`（${report.connectionName}） |`)
  lines.push(`| 用户 | \`${report.username}\` |`)
  lines.push(
    `| 时间 | ${formatDateTime(report.startedAt)} ~ ${formatDateTime(report.finishedAt)} |`
  )
  lines.push(`| 结果 | 共 ${report.sectionCount} 项：正常 ${report.okCount} / 异常 ${report.problemCount} |`)
  lines.push('')
  lines.push('---')
  lines.push('')

  let lastGroup = ''
  for (const r of report.sections) {
    if (r.group !== lastGroup) {
      lastGroup = r.group
      lines.push(`## ${r.group}`)
      lines.push('')
    }
    const flag = r.status === 'done' ? '✅' : r.status === 'skipped' ? '⏭️' : '⚠️'
    lines.push(`### ${flag} ${r.name}`)
    lines.push('')
    lines.push(`- 状态：**${statusLabel(r)}**　耗时：${r.durationMs}ms　退出码：${r.exitCode ?? '-'}`)
    lines.push('')
    lines.push('命令：')
    lines.push('')
    const cmdFence = fenceFor(r.command)
    lines.push(cmdFence + 'sh')
    lines.push(r.command)
    lines.push(cmdFence)
    lines.push('')
    const output = r.output.trim() === '' ? '（无输出）' : r.output.replace(/\s+$/, '')
    const outFence = fenceFor(output)
    lines.push(outFence)
    lines.push(output)
    lines.push(outFence)
    if (r.error && r.error.trim()) {
      lines.push('')
      lines.push('> 错误输出：')
      lines.push('>')
      for (const l of r.error.trim().split('\n')) lines.push(`> ${l}`)
    }
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push(`*由 SSH Workbench 生成于 ${formatDateTime(report.finishedAt)}*`)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 *  HTML（单文件自包含）
 * ------------------------------------------------------------------ */

export function generateHtml(report: DiagReport): string {
  const rows = report.sections
    .map((r) => {
      const ok = r.status === 'done'
      const cls = ok ? 'ok' : r.status === 'skipped' ? 'skip' : 'bad'
      const out = r.output.trim() === '' ? '（无输出）' : r.output.replace(/\s+$/, '')
      const err = r.error && r.error.trim()
        ? `<div class="errlabel">stderr</div><pre class="err">${escapeHtml(r.error.replace(/\s+$/, ''))}</pre>`
        : ''
      return `
  <section class="card ${cls}">
    <header>
      <span class="dot"></span>
      <h3>${escapeHtml(r.name)}</h3>
      <span class="meta">${escapeHtml(r.group)} · ${statusLabel(r)} · ${r.durationMs}ms · exit ${r.exitCode ?? '-'}</span>
    </header>
    <div class="cmd">$ ${escapeHtml(r.command)}</div>
    <pre class="out">${escapeHtml(out)}</pre>
    ${err}
  </section>`
    })
    .join('\n')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>诊断报告 · ${escapeHtml(report.title)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 32px 20px 64px; background: #0D1117; color: #E6EDF3;
         font: 13px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .wrap { max-width: 960px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 16px; }
  .summary { border: 1px solid #30363D; border-radius: 10px; background: #161B22; padding: 14px 18px; margin-bottom: 22px; }
  .summary table { border-collapse: collapse; width: 100%; }
  .summary td { padding: 3px 8px 3px 0; vertical-align: top; }
  .summary td:first-child { color: #8B949E; width: 72px; white-space: nowrap; }
  .pill { display: inline-block; border-radius: 999px; padding: 1px 10px; font-size: 12px; margin-right: 6px; }
  .pill.ok { background: rgba(63,185,80,.15); color: #3FB950; border: 1px solid rgba(63,185,80,.4); }
  .pill.bad { background: rgba(248,81,73,.12); color: #F85149; border: 1px solid rgba(248,81,73,.4); }
  .card { border: 1px solid #30363D; border-radius: 10px; background: #161B22; margin-bottom: 14px; overflow: hidden; }
  .card header { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid #21262D; }
  .card h3 { font-size: 13px; margin: 0; }
  .card .meta { margin-left: auto; color: #8B949E; font-size: 12px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #3FB950; }
  .card.bad .dot { background: #F85149; }
  .card.skip .dot { background: #8B949E; }
  .cmd { padding: 8px 14px; color: #58A6FF; font: 12px/1.5 "JetBrains Mono", Consolas, monospace;
         background: #0D1117; border-bottom: 1px solid #21262D; word-break: break-all; }
  pre { margin: 0; padding: 12px 14px; overflow: auto; font: 12px/1.55 "JetBrains Mono", Consolas, monospace;
        white-space: pre-wrap; word-break: break-word; }
  pre.out { color: #C9D1D9; }
  pre.err { color: #F85149; background: rgba(248,81,73,.06); }
  .errlabel { padding: 6px 14px 0; color: #8B949E; font-size: 11px; }
  footer { margin-top: 26px; color: #8B949E; font-size: 12px; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <h1>诊断报告 · ${escapeHtml(report.title)}</h1>
  <div class="summary">
    <table>
      <tr><td>设备</td><td><code>${escapeHtml(report.host)}</code>（${escapeHtml(report.connectionName)}）</td></tr>
      <tr><td>用户</td><td><code>${escapeHtml(report.username)}</code></td></tr>
      <tr><td>时间</td><td>${formatDateTime(report.startedAt)} ~ ${formatDateTime(report.finishedAt)}</td></tr>
      <tr><td>结果</td><td><span class="pill ok">正常 ${report.okCount}</span><span class="pill bad">异常 ${report.problemCount}</span>共 ${report.sectionCount} 项</td></tr>
    </table>
  </div>
${rows}
  <footer>由 SSH Workbench 生成于 ${formatDateTime(report.finishedAt)}</footer>
</div>
</body>
</html>`
}
