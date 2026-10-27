# SSH Workbench 完整性标签守卫（Windows）
#
# 背景（本机反复踩的坑）：
#   目录或 exe 被打上 `Mandatory Label\Low Mandatory Level` 后，Electron 的沙箱
#   子进程启动即被杀，表现为：
#     - 双击 exe 毫无反应（窗口一闪都不闪）
#     - 退出码恒为 -2147483645 / 0xC0000005
#     - 同一份 exe 拷到别的目录（Medium IL）就能正常跑，字节一致也不影响结论
#
#   打标签的不是代码，是外部沙箱工具（本机装了 Codex 的 Windows 沙箱服务
#   CodexSandboxService，它会给「受信任工作目录」打 Low IL）。所以会复发。
#
# 用法：
#   pwsh scripts/check-integrity.ps1            # 只检查，发现问题退出码 1
#   pwsh scripts/check-integrity.ps1 -Fix       # 检查并修复（需管理员）
#   pwsh scripts/check-integrity.ps1 -Fix -Quiet
#
# 注意：修改完整性标签要动 SACL，需要 SeSecurityPrivilege，即管理员令牌。
#       普通权限跑 -Fix 会报「拒绝访问」，这是预期行为，不是脚本 bug。

param(
  [switch]$Fix,
  [switch]$Quiet,
  [string[]]$Roots = @()
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
if ($Roots.Count -eq 0) {
  $Roots = @($repoRoot)
  # dist-* 产物目录单独列，方便在打包机上只查产物
  $distDirs = Get-ChildItem $repoRoot -Directory -Filter "dist*" -ErrorAction SilentlyContinue
  foreach ($d in $distDirs) { $Roots += $d.FullName }
  $Roots = $Roots | Select-Object -Unique
}

function Get-MandatoryLabel([string]$Path) {
  try {
    $line = (icacls $Path 2>$null | Select-String "Mandatory Label").Line
  } catch {
    return $null
  }
  if (-not $line) { return $null }
  $line = ($line -replace '\s+', ' ').Trim()
  if ($line -match 'Low Mandatory') { return "Low" }
  if ($line -match 'Medium Mandatory') { return "Medium" }
  if ($line -match 'High Mandatory') { return "High" }
  return "Other"
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)

$bad = New-Object System.Collections.ArrayList
$scanned = 0

foreach ($root in $Roots) {
  if (-not (Test-Path $root)) { continue }

  # 1) 目录本身（含所有祖先到仓根）—— 目录 Low 会让里面的 exe 继承 Low
  foreach ($p in @($root, $repoRoot) | Select-Object -Unique) {
    $lbl = Get-MandatoryLabel $p
    $scanned++
    if ($lbl -eq "Low") { [void]$bad.Add([pscustomobject]@{ Kind = "DIR"; Path = $p; Label = $lbl }) }
  }

  # 2) 可执行产物文件 —— 文件自己被打了 Low 也一样起不来
  $exes = Get-ChildItem $root -Recurse -File -Include "*.exe", "*.dll" -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notmatch '\\node_modules\\' }
  foreach ($f in $exes) {
    $lbl = Get-MandatoryLabel $f.FullName
    $scanned++
    if ($lbl -eq "Low") { [void]$bad.Add([pscustomobject]@{ Kind = "FILE"; Path = $f.FullName; Label = $lbl }) }
  }
}

if (-not $Quiet) {
  Write-Host "扫描 $scanned 个对象，根目录：" -ForegroundColor DarkGray
  $Roots | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
}

if ($bad.Count -eq 0) {
  if (-not $Quiet) { Write-Host "OK：没有 Low 完整性标签" -ForegroundColor Green }
  exit 0
}

Write-Host ""
Write-Host "发现 $($bad.Count) 个 Low 完整性标签（会导致 exe 双击无反应）：" -ForegroundColor Yellow
$bad | ForEach-Object { Write-Host ("  [{0}] {1}" -f $_.Kind, $_.Path) -ForegroundColor Yellow }

if (-not $Fix) {
  Write-Host ""
  Write-Host "加 -Fix 修复（需管理员）：pwsh scripts/check-integrity.ps1 -Fix" -ForegroundColor Cyan
  exit 1
}

if (-not $isAdmin) {
  Write-Host ""
  Write-Host "当前不是管理员令牌，无法改完整性标签。请用管理员 PowerShell 重跑。" -ForegroundColor Red
  exit 2
}

Write-Host ""
Write-Host "开始修复..." -ForegroundColor Cyan
$fixed = 0
$failed = New-Object System.Collections.ArrayList

# 目录：递归重置整棵子树，一次性把里面的文件和子目录都拉回 Medium
foreach ($dir in ($bad | Where-Object { $_.Kind -eq "DIR" } | Select-Object -ExpandProperty Path -Unique)) {
  try {
    icacls $dir /setintegritylevel "(OI)(CI)Medium" /T /C /Q 2>&1 | Out-Null
    if ((Get-MandatoryLabel $dir) -eq "Low") {
      [void]$failed.Add($dir)
    } else {
      $fixed++
      if (-not $Quiet) { Write-Host "  已修复目录: $dir" -ForegroundColor Green }
    }
  } catch {
    [void]$failed.Add($dir)
  }
}

# 文件：单独打 Medium（目录递归通常已覆盖，这里兜底非 dist 下的散落 exe）
foreach ($file in ($bad | Where-Object { $_.Kind -eq "FILE" } | Select-Object -ExpandProperty Path -Unique)) {
  if (-not (Test-Path $file)) { continue }
  try {
    icacls $file /setintegritylevel Medium /C /Q 2>&1 | Out-Null
    if ((Get-MandatoryLabel $file) -eq "Low") {
      [void]$failed.Add($file)
    } else {
      $fixed++
      if (-not $Quiet) { Write-Host "  已修复文件: $file" -ForegroundColor Green }
    }
  } catch {
    [void]$failed.Add($file)
  }
}

Write-Host ""
Write-Host "修复完成：$fixed 个成功，$($failed.Count) 个失败" -ForegroundColor Cyan
if ($failed.Count -gt 0) {
  Write-Host "仍为 Low 的项：" -ForegroundColor Red
  $failed | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
  exit 3
}

Write-Host "不需要重启机器，直接双击 exe 验证。" -ForegroundColor Green
exit 0
