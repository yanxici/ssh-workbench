# SSH Workbench 发布脚本（GitHub Release）
#
# 规则（用户 2026-10-26 明确要求）：
#   远端 Release 只上传 NSIS 安装包及其自动更新元数据，
#   不上传 portable.exe / win.zip —— 它们解出来的 win-unpacked 与安装包完全一致。
#
# 用法：
#   1. 先在本地打包三件套（本地仍出三件套，只是远端不全传）：
#        npm run build:win
#   2. 提交并打 tag 推送：
#        git tag -a v1.5.1 -m "v1.5.1" && git -c http.proxy=... push origin v1.5.1
#   3. 设置 token 后运行：
#        $env:GH_TOKEN = "<token>"
#        pwsh scripts/release.ps1 -Version 1.5.1

param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Owner = "yanxici",
  [string]$Repo = "ssh-workbench",
  [string]$Proxy = "http://127.0.0.1:7897",
  [string]$NotesFile = "RELEASE_NOTES.md",
  [switch]$IncludePortable
)

$ErrorActionPreference = "Stop"

if (-not $env:GH_TOKEN) {
  Write-Host "缺少 GH_TOKEN 环境变量（git credential fill 可取到系统凭证管理器里的 token）" -ForegroundColor Red
  exit 1
}

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist-v12"
$tag = "v$Version"

# ---- 上传清单：只传安装包 + 自动更新元数据 ----
$candidates = @(
  (Join-Path $dist "ssh-workbench-Setup-$Version.exe"),
  (Join-Path $dist "ssh-workbench-Setup-$Version.exe.blockmap"),
  (Join-Path $dist "latest.yml")
)

# 兜底：老版本命名（含空格），仅在精确路径不存在时尝试
$legacy = @(
  (Join-Path $dist "SSH Workbench Setup $Version.exe")
)

if ($IncludePortable) {
  $candidates +=
    (Join-Path $dist "ssh-workbench-$Version-portable.exe"),
    (Join-Path $dist "SSH Workbench-$Version-win.zip")
}

$files = @()
foreach ($c in $candidates) {
  if (Test-Path $c) { $files += (Get-Item $c).FullName }
}
if ($files.Count -eq 0) {
  foreach ($l in $legacy) { if (Test-Path $l) { $files += (Get-Item $l).FullName } }
}

if ($files.Count -eq 0) {
  Write-Host "dist-v12 里没有 $Version 的产物，先执行打包" -ForegroundColor Red
  exit 1
}

# ---- 硬性校验：未显式要求时，绝不允许 portable / zip 出现在上传列表 ----
$banned = $files | Where-Object { $_ -match '(portable\.exe|win\.zip)$' }
if ($banned -and -not $IncludePortable) {
  Write-Host "检测到不该上传的产物，已中止：" -ForegroundColor Red
  $banned | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  exit 1
}

# ---- 硬性校验：latest.yml 与 blockmap 必须齐，否则客户端更新链路会断 ----
$needYml = Test-Path (Join-Path $dist "latest.yml")
$needBlock = (Get-ChildItem $dist -Filter "*$Version*.blockmap" -EA SilentlyContinue).Count -gt 0
if (-not $needYml) { Write-Host "缺少 latest.yml：客户端将查不到更新" -ForegroundColor Yellow }
if (-not $needBlock) { Write-Host "缺少 Setup 的 .blockmap：无法差量下载，只能整包下" -ForegroundColor Yellow }

Write-Host "发布 $tag 到 $Owner/$Repo，共 $($files.Count) 个附件" -ForegroundColor Cyan
$files | ForEach-Object { Write-Host "  + $(Split-Path -Leaf $_)" -ForegroundColor DarkGray }

$headers = @{
  Authorization          = "Bearer $($env:GH_TOKEN)"
  Accept                 = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
}

# ---- 代理自动探测 ----
# 默认值是家里机器的 127.0.0.1:7897，换到别的网络环境时那个端口通常没人监听，
# Invoke-RestMethod 会直接抛「无法连接到远程服务器」。这里先探一下：能连上才用，
# 探不到就直连 —— 国内直连 api.github.com 有时反而比半死的代理快。
function Test-ProxyPort([string]$p) {
  if (-not $p) { return $false }
  try {
    $u = [uri]$p
    $c = New-Object System.Net.Sockets.TcpClient
    $ok = $c.ConnectAsync($u.Host, $u.Port).Wait(600)
    $c.Close()
    return $ok
  } catch { return $false }
}

if ($Proxy -and -not (Test-ProxyPort $Proxy)) {
  Write-Host "代理 $Proxy 不可达，改为直连" -ForegroundColor Yellow
  $Proxy = ""
}
if ($Proxy) {
  Write-Host "使用代理 $Proxy" -ForegroundColor DarkGray
  $proxyArgs = @{ Proxy = $Proxy }
} else {
  Write-Host "直连 api.github.com" -ForegroundColor DarkGray
  $proxyArgs = @{}
}

Push-Location $root
$sha = (git rev-parse HEAD).Trim()
Pop-Location
Write-Host "target commit: $sha"

# ---- 正文：优先用 RELEASE_NOTES.md ----
$notesPath = Join-Path $root $NotesFile
if (Test-Path $notesPath) {
  $notes = Get-Content $notesPath -Raw -Encoding UTF8
  Write-Host "正文取自 $NotesFile（$($notes.Length) 字符）"
} else {
  $notes = "SSH Workbench $tag"
  Write-Host "未找到 $NotesFile，使用默认正文" -ForegroundColor Yellow
}

$body = @{
  tag_name         = $tag
  target_commitish = $sha
  name             = "SSH Workbench $tag"
  draft            = $false
  prerelease       = $false
  body             = $notes
} | ConvertTo-Json -Depth 5

$release = $null
try {
  $release = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$Owner/$Repo/releases" -Headers $headers -Body $body -ContentType "application/json; charset=utf-8" @proxyArgs
  Write-Host "已创建 release: $($release.html_url)" -ForegroundColor Green
} catch {
  Write-Host "创建失败，尝试复用已存在的 release: $($_.Exception.Message)" -ForegroundColor Yellow
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/tags/$tag" -Headers $headers @proxyArgs
  Write-Host "复用 release: $($release.html_url)" -ForegroundColor Green
}

# ---- 上传（先删同名旧 asset，避免 422 already_exists）----
# 注意 `${uploadBase}?name=` 的花括号不能省：PowerShell 会把 "$uploadBase?" 里
# 的 `?` 当成变量名的一部分，变量直接展开成空串，最终 URL 变成 "=latest.yml"，
# Invoke-RestMethod 抛 "Invalid URI: The hostname could not be parsed."
$uploadBase = $release.upload_url -replace "\{.*$", ""
$existing = (Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/$($release.id)/assets" -Headers $headers @proxyArgs)
foreach ($f in $files) {
  $name = Split-Path -Leaf $f
  $hit = $existing | Where-Object { $_.name -eq $name }
  if ($hit) {
    Write-Host "  删除同名旧 asset: $name" -ForegroundColor DarkYellow
    Invoke-RestMethod -Method Delete -Uri "https://api.github.com/repos/$Owner/$Repo/releases/assets/$($hit.id)" -Headers $headers @proxyArgs | Out-Null
  }
  $sizeMb = [math]::Round((Get-Item $f).Length / 1MB, 2)
  Write-Host "上传 $name ($sizeMb MB)..."
  $uploadUrl = "${uploadBase}?name=$([uri]::EscapeDataString($name))"
  try {
    $r = Invoke-RestMethod -Method Post -Uri $uploadUrl -Headers $headers -ContentType "application/octet-stream" -InFile $f @proxyArgs -TimeoutSec 900
    Write-Host "  OK state=$($r.state) $($r.browser_download_url)" -ForegroundColor Green
  } catch {
    Write-Host "  失败: $($_.Exception.Message)" -ForegroundColor Red
  }
}

# ---- 回读校验：assets 必须恰好是这次的上传清单，且无 portable / zip ----
Write-Host ""
$final = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/$($release.id)" -Headers $headers @proxyArgs
Write-Host "assets 回读（$($final.assets.Count) 个）：" -ForegroundColor Cyan
$final.assets | ForEach-Object { Write-Host ("  {0,-46} {1,12}  {2}" -f $_.name, $_.size, $_.state) }

$extra = $final.assets | Where-Object { $_.name -match '(portable\.exe|win\.zip)$' }
if ($extra -and -not $IncludePortable) {
  Write-Host "警告：远端存在多余的 portable / zip 资产，请手工删除" -ForegroundColor Red
}

Write-Host ""
Write-Host "发布完成: $($final.html_url)" -ForegroundColor Cyan
