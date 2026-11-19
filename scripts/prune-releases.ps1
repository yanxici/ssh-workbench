#Requires -Version 7.0
<#
.SYNOPSIS
    裁剪 ssh-workbench 的 GitHub Release：只保留最近几个版本，其余连资产一并删除。

.DESCRIPTION
    默认是演练（DRY-RUN），只打印将删除什么；加 -Apply 才真正调 GitHub API。
    删 Release 会连带删掉它的全部资产（Setup.exe / .blockmap / latest.yml），不可恢复。

    安全设计（四条，任何一条不过都不会开始删）：
      1. 先校验 -Keep 里的每个 tag 在远端确实存在。Keep 拼错一个字符就等于「全删」，所以先拦。
      2. 永不删除 isLatest 的 Release（当前 v2.0.0）。自动更新链 latest.yml 挂在这个 Release 上，
         误删会让所有客户端的「检查更新」404。
      3. 默认只删 Release、保留 git tag；-DeleteTags 才连带删 tag。
      4. 单条失败不中断，末尾汇总失败列表并以非 0 退出，方便重跑。

.PARAMETER Repo
    owner/repo，默认 yanxici/ssh-workbench。

.PARAMETER Keep
    要保留的 tag 列表，默认 v2.0.0 / v1.9.0 / v1.8.1。

.PARAMETER DeleteTags
    连带删除对应的 git tag。Release 删了 tag 还在的话，仓库 Tags 页仍会留 30 多个条目。

.PARAMETER Apply
    真删。不带就是演练。

.EXAMPLE
    pwsh scripts/prune-releases.ps1
    演练：列出将要删除的 Release（不动任何东西）。

.EXAMPLE
    pwsh scripts/prune-releases.ps1 -Apply
    真删 Release，保留 tag。

.EXAMPLE
    pwsh scripts/prune-releases.ps1 -Apply -DeleteTags
    真删 Release 并连带删 tag（推荐，一次清干净）。
#>
[CmdletBinding()]
param(
    [string]   $Repo = 'yanxici/ssh-workbench',
    [string[]] $Keep = @('v2.0.0', 'v1.9.0', 'v1.8.1'),
    [switch]   $DeleteTags,
    [switch]   $Apply,
    [int]      $Limit = 200
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw 'gh CLI 不在 PATH。安装：winget install --id GitHub.cli'
}

gh auth status --hostname github.com *> $null
if ($LASTEXITCODE -ne 0) {
    throw 'gh 未登录或 token 已失效。先执行：gh auth login'
}

# ---------- 拉远端 Release 列表 ----------

$raw = gh release list --repo $Repo --limit $Limit --json tagName,isLatest,isDraft,isPrerelease,publishedAt
if ($LASTEXITCODE -ne 0) {
    throw "gh release list 失败（退出码 $LASTEXITCODE）"
}

$releases = @($raw | ConvertFrom-Json)
if ($releases.Count -eq 0) {
    throw "仓库 $Repo 没有 Release"
}

$existing = @($releases | ForEach-Object { $_.tagName })

# ---------- 守门 1：Keep 必须真实存在 ----------

$missing = @($Keep | Where-Object { $existing -notcontains $_ })
if ($missing.Count -gt 0) {
    throw "保留清单中的 $($missing -join ', ') 在远端不存在。已中止 —— 继续下去会把不该删的删掉。"
}

# ---------- 守门 2：永不删 latest ----------

$latest = @($releases | Where-Object { $_.isLatest } | ForEach-Object { $_.tagName })

$doomed = @($releases | Where-Object {
    $Keep -notcontains $_.tagName -and $latest -notcontains $_.tagName
})

$mode = if ($Apply) { 'APPLY（真删）' } else { 'DRY-RUN（演练，不改动）' }

Write-Host ''
Write-Host "仓库     : $Repo"
Write-Host "模式     : $mode"
Write-Host "保留     : $($Keep -join ', ')"
Write-Host "latest   : $($latest -join ', ')  （受保护，永不删除）"
Write-Host "远端总数 : $($releases.Count)"
Write-Host "将删除   : $($doomed.Count)"
if ($DeleteTags) { Write-Host "tag 处理 : 连带删除" } else { Write-Host "tag 处理 : 保留（要删加 -DeleteTags）" }
Write-Host ''

if ($doomed.Count -eq 0) {
    Write-Host '没有需要删除的 Release，已经是目标状态。'
    exit 0
}

Write-Host '--- 将删除的 Release ---'
$doomed |
    Sort-Object publishedAt |
    Select-Object @{ n = 'tag'; e = { $_.tagName } }, @{ n = 'published'; e = { $_.publishedAt } } |
    Format-Table -AutoSize |
    Out-String -Width 120 |
    Write-Host

if (-not $Apply) {
    Write-Host '--- 演练结束，未做任何改动 ---'
    Write-Host '确认清单无误后执行：'
    $rerun = 'pwsh scripts/prune-releases.ps1 -Apply'
    if ($DeleteTags) { $rerun += ' -DeleteTags' }
    Write-Host "  $rerun"
    Write-Host ''
    Write-Host '提示：真删前先确认 v2.0.0 的 latest.yml 资产还在（自动更新靠它）：'
    Write-Host "  gh release view v2.0.0 --repo $Repo --json assets --jq '.assets[].name'"
    exit 0
}

# ---------- 执行删除 ----------

$failed = [System.Collections.Generic.List[string]]::new()
$done = 0

foreach ($r in ($doomed | Sort-Object publishedAt)) {
    $tag = $r.tagName
    $ghArgs = @('release', 'delete', $tag, '--repo', $Repo, '--yes')
    if ($DeleteTags) { $ghArgs += '--cleanup-tag' }

    $out = gh @ghArgs 2>&1
    $code = $LASTEXITCODE

    if ($code -ne 0) {
        # 二级限流（403 / rate limit）重试一次
        Start-Sleep -Seconds 3
        $out = gh @ghArgs 2>&1
        $code = $LASTEXITCODE
    }

    if ($code -eq 0) {
        $done++
        Write-Host ("  [ok]   {0}" -f $tag)
    }
    else {
        $failed.Add($tag)
        Write-Host ("  [fail] {0}  <- {1}" -f $tag, (($out | Out-String).Trim()))
    }

    Start-Sleep -Milliseconds 250
}

# ---------- 收尾核对 ----------

$after = @(gh release list --repo $Repo --limit $Limit --json tagName | ConvertFrom-Json | ForEach-Object { $_.tagName })

Write-Host ''
Write-Host "已删除 $done 个，失败 $($failed.Count) 个"
Write-Host "远端剩余 $($after.Count) 个 Release：$($after -join ', ')"

if ($failed.Count -gt 0) {
    Write-Host ''
    Write-Host "失败清单（可重跑本脚本补删）：$($failed -join ', ')"
    exit 1
}

$extra = @($after | Where-Object { $Keep -notcontains $_ })
if ($extra.Count -gt 0) {
    Write-Host ''
    Write-Host "注意：仍有非保留版本残留 $($extra -join ', ')（可能是分页未取全或权限不足）"
    exit 2
}

Write-Host ''
Write-Host '完成：远端只剩保留的版本。'
exit 0
