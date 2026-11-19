#Requires -Version 7.0
<#
.SYNOPSIS
    用 GitHub REST API 裁剪 ssh-workbench 的 Release（不依赖 gh CLI）。
.DESCRIPTION
    凭证来自 git credential（host=github.com），不落盘。
    默认演练；-Apply 才真删。守门与 prune-releases.ps1 一致：
      1. -Keep 里每个 tag 必须先在远端存在，否则中止。
      2. isLatest / draft 之外的保护：latest release 永不删。
      3. 默认只删 Release，不动 git tag；-DeleteTags 才连带删 tag。
      4. 单条失败重试一次，不中断，末尾汇总。
#>
[CmdletBinding()]
param(
    [string]   $Repo = 'yanxici/ssh-workbench',
    [string[]] $Keep = @('v2.0.0', 'v1.9.0', 'v1.8.1'),
    [switch]   $DeleteTags,
    [switch]   $Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------- 取 token ----------
$cred = "protocol=https`nhost=github.com`n`n" | git credential fill 2>$null
$token = ($cred | Where-Object { $_ -like 'password=*' }) -replace '^password=', ''
if (-not $token) { throw '拿不到 git credential 里的 github token' }

$headers = @{
    Authorization          = "Bearer $token"
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent'           = 'ssh-workbench-prune'
}
$api = "https://api.github.com/repos/$Repo"

function Get-AllReleases {
    $out = @(); $page = 1
    while ($true) {
        $batch = @(Invoke-RestMethod -Uri "$api/releases?per_page=100&page=$page" -Headers $headers -Method Get)
        $out += $batch
        if ($batch.Count -lt 100) { break }
        $page++
    }
    return $out
}

$releases = Get-AllReleases
if ($releases.Count -eq 0) { throw "仓库 $Repo 没有 Release" }
$existing = @($releases | ForEach-Object { $_.tag_name })

# 守门 1
$missing = @($Keep | Where-Object { $existing -notcontains $_ })
if ($missing.Count -gt 0) {
    throw "保留清单中的 $($missing -join ', ') 在远端不存在。已中止。"
}

# 守门 2
$latest = @($releases | Where-Object { $_.tag_name -eq 'v2.0.0' } | ForEach-Object { $_.tag_name })
$doomed = @($releases | Where-Object { $Keep -notcontains $_.tag_name -and $latest -notcontains $_.tag_name })

$mode = if ($Apply) { 'APPLY（真删）' } else { 'DRY-RUN（演练）' }
Write-Host ''
Write-Host "仓库     : $Repo"
Write-Host "模式     : $mode"
Write-Host "保留     : $($Keep -join ', ')"
Write-Host "远端总数 : $($releases.Count)"
Write-Host "将删除   : $($doomed.Count)"
Write-Host "tag 处理 : $(if ($DeleteTags) { '连带删除' } else { '保留' })"
Write-Host ''

$doomed | Sort-Object published_at |
    Select-Object id, tag_name, published_at |
    Format-Table -AutoSize | Out-String -Width 120 | Write-Host

if ($doomed.Count -eq 0) { Write-Host '已是目标状态。'; exit 0 }
if (-not $Apply) { Write-Host '--- 演练结束，未做改动 ---'; exit 0 }

# ---------- 执行 ----------
$failed = [System.Collections.Generic.List[string]]::new()
$done = 0
foreach ($r in ($doomed | Sort-Object published_at)) {
    $tag = $r.tag_name
    $url = "$api/releases/$($r.id)"
    try {
        Invoke-RestMethod -Uri $url -Headers $headers -Method Delete | Out-Null
        $done++
        Write-Host ("  [ok]   {0}" -f $tag)
    }
    catch {
        Start-Sleep -Seconds 3
        try {
            Invoke-RestMethod -Uri $url -Headers $headers -Method Delete | Out-Null
            $done++
            Write-Host ("  [ok]   {0}  (retry)" -f $tag)
        }
        catch {
            $failed.Add($tag)
            Write-Host ("  [fail] {0}  <- {1}" -f $tag, $_.Exception.Message)
        }
    }
    Start-Sleep -Milliseconds 250
}

# tag 清理
if ($DeleteTags) {
    $keepTags = @($Keep) + @($latest)
    $tags = @(Invoke-RestMethod -Uri "$api/git/refs/tags" -Headers $headers -Method Get)
    foreach ($t in $tags) {
        $name = $t.ref -replace '^refs/tags/', ''
        if ($keepTags -contains $name) { continue }
        try {
            Invoke-RestMethod -Uri "$api/git/refs/tags/$name" -Headers $headers -Method Delete | Out-Null
            Write-Host ("  [tag-ok]   {0}" -f $name)
        }
        catch {
            Write-Host ("  [tag-fail] {0}  <- {1}" -f $name, $_.Exception.Message)
        }
        Start-Sleep -Milliseconds 150
    }
}

# ---------- 收尾 ----------
$after = @(Get-AllReleases | ForEach-Object { $_.tag_name })
Write-Host ''
Write-Host "已删除 $done 个，失败 $($failed.Count) 个"
Write-Host "远端剩余 $($after.Count) 个 Release：$($after -join ', ')"
if ($failed.Count -gt 0) { exit 1 }
$extra = @($after | Where-Object { $Keep -notcontains $_ })
if ($extra.Count -gt 0) { Write-Host "残留：$($extra -join ', ')"; exit 2 }
Write-Host '完成。'
exit 0
