# SSH Workbench 国内更新通道同步脚本（同步发行版到 Gitee Release）
#
# 用途：把当前版本的 Setup 安装包、.blockmap、latest.yml 与更新日志同步到
# Gitee 公开仓库（w3554334905/ssh-workbench），供国内免代理自动更新使用。
#
# 顺序硬要求：先传 .exe 与 .blockmap，最后传 latest.yml —— 客户端发现 Gitee
# 发行版时以附件里是否存在 latest.yml 作为「已发布完成」判据，最后上传它可避免
# 半成品窗口期被客户端拉到 404。
#
# 用法（本机执行，默认优先复用本地产物，本地没有或指定 -FromGitHub 时自动从 GitHub Release 拉取同字节产物）：
#   $env:GITEE_TOKEN = "<Gitee 私人令牌（需勾选 projects 权限）>"
#   pwsh -NoProfile -File scripts/sync-gitee-release.ps1 -Version 2.4.1
#   pwsh -NoProfile -File scripts/sync-gitee-release.ps1 -Version 2.4.1 -FromGitHub

param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Owner = "w3554334905",
  [string]$Repo = "ssh-workbench",
  [string]$GitHubRepo = "yanxici/ssh-workbench",
  [string]$DistDir = "",
  [string]$NotesFile = "",
  [string]$TargetCommitish = "main",
  [switch]$FromGitHub,
  [switch]$IncludePortable
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

$token = $env:GITEE_TOKEN
if (-not $token) {
  Write-Host "缺少 GITEE_TOKEN 环境变量（Gitee 个人设置 → 私人令牌，勾选 projects 权限）" -ForegroundColor Red
  exit 1
}

$root = Split-Path -Parent $PSScriptRoot
$ver = $Version -replace '^v', ''
$tag = "v$ver"
$explicitDist = [bool]$DistDir
$tempDownloadDir = $null

try {
  # ---- 解析产物目录（未显式传入时从 electron-builder.yml 读取）----
  if (-not $DistDir) {
    $builderYml = Join-Path $root "electron-builder.yml"
    if (Test-Path $builderYml) {
      $m = Select-String -Path $builderYml -Pattern '^\s*output:\s*(\S+)\s*$' -AllMatches
      if ($m -and $m.Matches.Count -gt 0) {
        $DistDir = $m.Matches[0].Groups[1].Value.Trim('"', "'")
      }
    }
  }

  $dist = if ($DistDir) {
    if ([System.IO.Path]::IsPathRooted($DistDir)) { $DistDir } else { Join-Path $root $DistDir }
  } else {
    ""
  }

  $hasLocalRequired = $dist -and
    (Test-Path (Join-Path $dist "ssh-workbench-Setup-$ver.exe")) -and
    (Test-Path (Join-Path $dist "latest.yml"))

  # 指定 -FromGitHub，或未显式指定 -DistDir 且本地没有该版本产物时，从 GitHub Release 拉取同字节产物
  if ($FromGitHub -or (-not $explicitDist -and -not $hasLocalRequired)) {
    $tempDownloadDir = Join-Path $env:TEMP ("swb-gitee-sync-$ver-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
    New-Item -ItemType Directory -Path $tempDownloadDir -Force | Out-Null
    Write-Host "从 GitHub Release ($GitHubRepo $tag) 拉取同字节产物到临时目录..." -ForegroundColor Cyan
    & gh release download $tag -R $GitHubRepo -D $tempDownloadDir
    if ($LASTEXITCODE -ne 0) {
      Write-Host "从 GitHub Release 拉取 $tag 产物失败（请确认 gh 已登录且 $tag 已发布）" -ForegroundColor Red
      exit 1
    }
    $dist = $tempDownloadDir
  }

  if (-not $dist) {
    Write-Host "未能确定产物目录，请传入 -DistDir、使用 -FromGitHub 或检查 electron-builder.yml" -ForegroundColor Red
    exit 1
  }

  # ---- 构造上传清单：大文件在前，latest.yml 压轴 ----
  $setupExe = Join-Path $dist "ssh-workbench-Setup-$ver.exe"
  $blockmap = Join-Path $dist "ssh-workbench-Setup-$ver.exe.blockmap"
  $latestYml = Join-Path $dist "latest.yml"

  $ordered = @($setupExe, $blockmap)
  if ($IncludePortable) {
    $portable = Join-Path $dist "ssh-workbench-$ver-portable.exe"
    if (Test-Path $portable) { $ordered += $portable }
  }
  $ordered += $latestYml

  foreach ($req in @($setupExe, $latestYml)) {
    if (-not (Test-Path $req)) {
      Write-Host "缺少必需产物：$req" -ForegroundColor Red
      exit 1
    }
  }
  $files = @($ordered | Where-Object { Test-Path $_ })

  # ---- 抽取发行说明 ----
  $notes = ""
  if ($NotesFile) {
    $notesPath = if ([System.IO.Path]::IsPathRooted($NotesFile)) { $NotesFile } else { Join-Path $root $NotesFile }
    if (Test-Path $notesPath) {
      $notes = Get-Content $notesPath -Raw -Encoding UTF8
    }
  }
  if (-not $notes) {
    $gen = Join-Path $PSScriptRoot "release-notes.cjs"
    $tmpNotes = Join-Path $env:TEMP "swb-gitee-notes-$tag.md"
    & node $gen --version $ver --out $tmpNotes
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $tmpNotes)) {
      Write-Host "无法从 CHANGELOG 生成 $ver 的更新说明" -ForegroundColor Red
      exit 1
    }
    $notes = Get-Content $tmpNotes -Raw -Encoding UTF8
    Remove-Item $tmpNotes -ErrorAction SilentlyContinue
  }

  $apiBase = "https://gitee.com/api/v5/repos/$Owner/$Repo"
  $authHeaders = @{ Authorization = "token $token" }

  Write-Host "同步 $tag 到 Gitee $Owner/$Repo（共 $($files.Count) 个附件）" -ForegroundColor Cyan

  # ---- 查找或创建 Release ----
  # 注意：Gitee API v5 查询不存在的 tag 时返回 HTTP 200 + JSON `null`（不会抛 404），
  # 不能只靠 catch 判定不存在，必须显式检查 `$found.id`。
  $release = $null
  try {
    $found = Invoke-RestMethod -Method Get -Uri "$apiBase/releases/tags/$tag" -Headers $authHeaders -TimeoutSec 30
    if ($found -and $found.id) {
      $release = $found
      Write-Host "复用已有 Gitee Release: id=$($release.id) tag=$($release.tag_name)" -ForegroundColor Green
    }
  } catch {
    # 404 时走下方创建逻辑
  }

  if (-not $release) {
    $createPayload = @{
      access_token     = $token
      tag_name         = $tag
      name             = "Portix $tag"
      body             = $notes
      prerelease       = $false
      target_commitish = $TargetCommitish
    } | ConvertTo-Json -Depth 5
    $release = Invoke-RestMethod -Method Post -Uri "$apiBase/releases" -Body ([System.Text.Encoding]::UTF8.GetBytes($createPayload)) -ContentType "application/json; charset=utf-8" -TimeoutSec 30
    Write-Host "已创建 Gitee Release: id=$($release.id) tag=$($release.tag_name)" -ForegroundColor Green
  }

  $releaseId = $release.id
  if (-not $releaseId) {
    Write-Host "Gitee API 未返回有效的 release.id" -ForegroundColor Red
    exit 1
  }

  # ---- 读取现有附件，上传前清理同名旧附件避免重复 ----
  $existing = @()
  try {
    $rawExisting = Invoke-RestMethod -Method Get -Uri "$apiBase/releases/$releaseId/attach_files" -Headers $authHeaders -TimeoutSec 30
    if ($rawExisting) { $existing = @($rawExisting) }
  } catch {
    Write-Host "读取现有附件列表失败，继续尝试上传：$($_.Exception.Message)" -ForegroundColor Yellow
  }

  foreach ($f in $files) {
    $name = Split-Path -Leaf $f
    $sizeMb = [math]::Round((Get-Item $f).Length / 1MB, 2)

    foreach ($old in ($existing | Where-Object { $_.name -eq $name })) {
      Write-Host "  删除同名旧附件: $name (id=$($old.id))" -ForegroundColor DarkYellow
      Invoke-RestMethod -Method Delete -Uri "$apiBase/releases/$releaseId/attach_files/$($old.id)" -Headers $authHeaders -TimeoutSec 30 | Out-Null
    }

    Write-Host "  上传 $name ($sizeMb MB)..."
    $uploadUrl = "$apiBase/releases/$releaseId/attach_files"
    $resp = & curl.exe --fail-with-body -sS --max-time 600 -X POST $uploadUrl -F "access_token=$token" -F "file=@$f"
    if ($LASTEXITCODE -ne 0) {
      Write-Host "  上传 $name 失败：$resp" -ForegroundColor Red
      exit 1
    }
    Write-Host "  OK $name" -ForegroundColor Green
  }

  Write-Host ""
  Write-Host "Gitee 国内更新通道同步完成：https://gitee.com/$Owner/$Repo/releases/tag/$tag" -ForegroundColor Cyan
} finally {
  if ($tempDownloadDir -and (Test-Path $tempDownloadDir)) {
    Remove-Item -Recurse -Force $tempDownloadDir -ErrorAction SilentlyContinue
  }
}
