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
  # 空 = 自动探测（读系统代理注册表 + 常见 Clash 端口），探不到就直连。
  # 之前默认写死 7897，换了机器/换了 Clash 配置端口就整条链路挂掉，见 scripts/check-net.ps1。
  [string]$Proxy = "",
  [string]$NotesFile = "RELEASE_NOTES.md",
  [switch]$IncludePortable
)

$ErrorActionPreference = "Stop"
# 控制台默认 GBK，脚本里全是中文；从 bash / CI 日志读回来就是乱码，先钉成 UTF-8。
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

if (-not $env:GH_TOKEN) {
  Write-Host "缺少 GH_TOKEN 环境变量（git credential fill 可取到系统凭证管理器里的 token）" -ForegroundColor Red
  exit 1
}

$root = Split-Path -Parent $PSScriptRoot

# ---- 硬性校验：文档必须跟版本号同步，否则不发 ----
# v1.9.0 的教训：包传上去了、tag 打了、Release 日志也有，但 GitHub 上的 README
# 还写着 v1.8.1、CHANGELOG 里没有 1.9.0 —— 代码全对，唯独人打开仓库第一眼
# 看到的两处停在上一版。
#
# 根因是流程不对称：release-notes 有 CI 硬门禁所以从没漏过，README / CHANGELOG
# 只是 RELEASE_CHECKLIST 里的 checkbox，没有任何脚本判它。这里把它挪到发布
# 脚本的必经路径上 —— 打包完才发现文档没写，比发出去才发现便宜得多。
$docsScript = Join-Path $PSScriptRoot "verify-docs-sync.cjs"
if (Test-Path $docsScript) {
  Write-Host "校验文档同步..." -ForegroundColor DarkGray
  $docsOut = & node $docsScript 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "文档没跟版本号同步，已中止发布：" -ForegroundColor Red
    $docsOut | Where-Object { $_ -match 'FAIL' } | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    Write-Host "补 README 当前版本 / 最近更新首条 + CHANGELOG 本版条目后重试" -ForegroundColor Yellow
    exit 1
  }
  Write-Host "  文档已同步" -ForegroundColor Green
}

# ---- 输出目录从 electron-builder.yml 解析，不再硬编码 ----
# 硬编码 dist-v13 而配置早已切到 dist-v15，每次发版都要手动改脚本，
# 忘改就报「没有产物」，本身就是事故源。以配置里的 directories.output 为准。
$builderYml = Join-Path $root "electron-builder.yml"
$distName = $null
if (Test-Path $builderYml) {
  $m = Select-String -Path $builderYml -Pattern '^\s*output:\s*(\S+)\s*$' -AllMatches
  if ($m -and $m.Matches.Count -gt 0) { $distName = $m.Matches[0].Groups[1].Value.Trim('"', "'") }
}
if (-not $distName) {
  Write-Host "electron-builder.yml 里没解析到 directories.output，无法确定产物目录" -ForegroundColor Red
  exit 1
}
$dist = Join-Path $root $distName
Write-Host "产物目录：$distName（来自 electron-builder.yml）" -ForegroundColor DarkGray
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
  Write-Host "$distName 里没有 $Version 的产物，先执行打包" -ForegroundColor Red
  exit 1
}

# ---- 硬性校验：产物所在目录不能带 Low 完整性标签 ----
# Low IL 的 Setup.exe 在用户机器上双击会毫无反应（Electron 沙箱子进程被拦），
# 传上去等于发个装完打不开的版本。这里上传前拦一道，别让坏包出门。
$integrityScript = Join-Path $PSScriptRoot "check-integrity.ps1"
if (Test-Path $integrityScript) {
  Write-Host "校验完整性标签..." -ForegroundColor DarkGray
  $checkOut = & pwsh -NoProfile -File $integrityScript 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Host "产物带 Low 完整性标签，已中止发布（安装后会打不开）：" -ForegroundColor Red
    $checkOut | Select-Object -Last 20 | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    Write-Host "修复后重试：npm run fix:integrity（需管理员）" -ForegroundColor Yellow
    exit 1
  }
  Write-Host "  完整性标签正常" -ForegroundColor Green
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
# 不再写死端口。顺序：-Proxy 显式传入 > 系统代理注册表（Clash 自己写的那个）> 常见端口 > 直连。
# 为什么这么改：本机从 7897 换到了 7900，写死的那次发版白等了四十多分钟，
# 报错还是「无法连接到远程服务器」，看不出只是代理没开。
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

function Find-Proxy([string]$explicit) {
  if ($explicit) {
    if (Test-ProxyPort $explicit) { return $explicit }
    Write-Host "指定的代理 $explicit 不可达，改为自动探测" -ForegroundColor Yellow
  }
  $net = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
  $candidates = @()
  if ($net.ProxyEnable -eq 1 -and $net.ProxyServer -match '^(?:https?://)?([^:/]+):(\d+)$') {
    $candidates += "http://$($Matches[1]):$($Matches[2])"
  }
  foreach ($port in @(7897, 7890, 7900, 7891, 10808, 1080)) {
    $candidates += "http://127.0.0.1:$port"
  }
  foreach ($c in $candidates) {
    if (Test-ProxyPort $c) { return $c }
  }
  return ""
}

# 显式传入的也走同一套校验：端口不通就退回自动探测，不让一个手误的端口把整条链路拖死。
$resolved = Find-Proxy $Proxy
if ($resolved) {
  $Proxy = $resolved
} elseif ($Proxy) {
  Write-Host "指定的代理 $Proxy 不可达，也没探测到别的代理，按直连继续。" -ForegroundColor Yellow
  $Proxy = ""
} else {
  Write-Host "没探测到可用代理端口。若要走代理，先打开 Clash Verge —— 现在按直连继续。" -ForegroundColor Yellow
}
if ($Proxy) {
  Write-Host "使用代理 $Proxy" -ForegroundColor DarkGray
  $proxyArgs = @{ Proxy = $Proxy }
} else {
  Write-Host "直连 api.github.com" -ForegroundColor DarkGray
  $proxyArgs = @{}
}

# ---- 上线前真打一次 github.com，别等到上传 80MB 才失败 ----
# 之前代理端口不对时，整条脚本要跑到上传阶段才报错，而且每次 git 操作都等满 300 秒超时。
# 这里花最多 20 秒先确认链路，失败直接退出并把「去开 Clash」写在最显眼的位置。
Write-Host "探测 GitHub 连通性..." -ForegroundColor DarkGray
$reachable = $false
try {
  $probe = Invoke-WebRequest -Uri "https://github.com" -TimeoutSec 20 -UseBasicParsing -MaximumRedirection 0 -ErrorAction Stop @proxyArgs
  $reachable = $true
} catch {
  $code = $null
  if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
  if ($code -and $code -lt 500) { $reachable = $true }
}
if (-not $reachable) {
  Write-Host ""
  Write-Host "GitHub 不可达，发布已中止（还没上传任何东西）。" -ForegroundColor Red
  Write-Host "  最大概率：Clash Verge 没开，或者节点没选。" -ForegroundColor Yellow
  Write-Host "  下一步：托盘里打开 Clash → 跑 pwsh -NoProfile -File scripts/check-net.ps1 确认 → 再发版。" -ForegroundColor Yellow
  exit 1
}
Write-Host "  链路正常" -ForegroundColor Green

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
