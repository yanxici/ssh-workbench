<#
  发布到 GitHub Releases。
  用法：
    $env:GH_TOKEN = "ghp_xxx"
    pwsh -NoProfile -File scripts/release.ps1 -Version 1.1.0

  需要 token 具备 Contents 写权限。
  走本地代理 127.0.0.1:7897，避免国内直连超时。
#>
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Owner = "yanxici",
  [string]$Repo = "ssh-workbench",
  [string]$Proxy = "http://127.0.0.1:7897"
)

$ErrorActionPreference = "Stop"

if (-not $env:GH_TOKEN) {
  Write-Host "缺少 GH_TOKEN 环境变量" -ForegroundColor Red
  exit 1
}

$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $root "dist-v11"
$tag = "v$Version"

$candidates = @(
  (Join-Path $dist "SSH Workbench Setup $Version.exe"),
  (Join-Path $dist "SSH Workbench-$Version-portable.exe"),
  (Join-Path $dist "SSH Workbench-$Version-win.zip"),
  (Join-Path $dist "latest.yml")
)
$files = $candidates | Where-Object { Test-Path $_ }

if ($files.Count -eq 0) {
  Write-Host "dist-v11 里没有 $Version 的产物，先执行打包" -ForegroundColor Red
  exit 1
}

Write-Host "发布 $tag 到 $Owner/$Repo，共 $($files.Count) 个附件" -ForegroundColor Cyan

$headers = @{
  Authorization          = "Bearer $($env:GH_TOKEN)"
  Accept                 = "application/vnd.github+json"
  "X-GitHub-Api-Version" = "2022-11-28"
}

Push-Location $root
$sha = (git rev-parse HEAD).Trim()
Pop-Location
Write-Host "target commit: $sha"

$notes = @"
## SSH Workbench $tag

### 新增：连接分组管理

之前分组只能靠在连接编辑器里手填 group 字段，没有独立入口：无法新建空分组、无法整组改名、也无法整组清理。

- **新建分组**：工具栏文件夹按钮，或分组右键菜单。空分组立刻出现在侧栏。
- **重命名分组**：整组一次迁移，2790 条连接实测 11ms。
- **删除分组**：连带清理组内连接与凭据保险箱，删除前显示组内条数。
- **拖拽排序**：分组可拖动调整顺序，顺序持久化。
- **移到分组**：连接右键可在分组间移动。
- 同名冲突拒绝合并，避免误操作把两组揉成一组。

### 验证

- 分组逻辑自检 26 项全通过（含 2 万条聚合压测）
- 真实应用端到端 9 项通过（渲染层 → IPC → 主进程 → 落盘）
- 真实 2790 条连接压测 12 项通过（整组重命名 11ms，并发 rename 无丢更新）

### 下载

| 文件 | 说明 |
|---|---|
| SSH Workbench Setup $Version.exe | 安装版，可选安装目录、建桌面快捷方式 |
| SSH Workbench-$Version-portable.exe | 免安装单文件版，双击即用，不写注册表 |
| SSH Workbench-$Version-win.zip | 解压即用版，启动最快 |

> 未做代码签名，SmartScreen 提示时点「更多信息 → 仍要运行」。

**已知环境坑**：若双击后闪退，检查是否设置了环境变量 ELECTRON_RUN_AS_NODE=1 —— 它会让 Electron 退化成纯 Node 解释器。清空该变量即可。

数据位置：%APPDATA%\ssh-workbench\data\
"@

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
  $release = Invoke-RestMethod -Method Post -Uri "https://api.github.com/repos/$Owner/$Repo/releases" -Headers $headers -Body $body -ContentType "application/json" -Proxy $Proxy
  Write-Host "已创建 release: $($release.html_url)" -ForegroundColor Green
} catch {
  Write-Host "创建失败，尝试复用已存在的 release: $($_.Exception.Message)" -ForegroundColor Yellow
  $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/releases/tags/$tag" -Headers $headers -Proxy $Proxy
  Write-Host "复用 release: $($release.html_url)" -ForegroundColor Green
}

$uploadBase = $release.upload_url -replace "\{.*$", ""
foreach ($f in $files) {
  $name = Split-Path -Leaf $f
  $sizeMb = [math]::Round((Get-Item $f).Length / 1MB, 1)
  Write-Host "上传 $name ($sizeMb MB)..."
  $uploadUrl = "$uploadBase?name=$([uri]::EscapeDataString($name))"
  try {
    $r = Invoke-RestMethod -Method Post -Uri $uploadUrl -Headers $headers -ContentType "application/octet-stream" -InFile $f -Proxy $Proxy -TimeoutSec 900
    Write-Host "  OK $($r.browser_download_url)" -ForegroundColor Green
  } catch {
    Write-Host "  失败: $($_.Exception.Message)" -ForegroundColor Red
  }
}

Write-Host ""
Write-Host "发布完成: $($release.html_url)" -ForegroundColor Cyan
