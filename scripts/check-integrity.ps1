# SSH Workbench 完整性标签守卫（Windows）
#
# 背景（本机反复踩的坑）：
#   目录或 exe 被打上 `Mandatory Label\Low Mandatory Level` 后，Electron 的沙箱
#   子进程启动即被杀，表现为：
#     - 双击 exe 毫无反应（窗口一闪都不闪）
#     - 退出码恒为 -2147483645 / 0xC0000005
#     - 同一份 exe 拷到别的目录（Medium IL）就能正常跑，字节一致也不影响结论
#
#   打标签的是「受限令牌沙箱」这类外部工具（本机既有 Codex 的
#   CodexSandboxService，也有 DSH 自带的 @deepseek-ai/dsh-sandbox-windows-acl，
#   后者在授权工作区时会 setintegritylevel Low）。所以会复发。
#
# 性能设计（v2）：
#   旧版对每个对象单独 spawn 一次 icacls，实测 45 个对象要 25.9 秒。
#   新版两级：先对每棵树只跑一次 `icacls <dir> /T /C`，输出里 grep
#   "Low Mandatory"；命中才下钻定位。无问题时整仓约 1~4 秒。
#
# 用法：
#   pwsh scripts/check-integrity.ps1                  # 只检查，发现问题退出码 1
#   pwsh scripts/check-integrity.ps1 -Fix             # 检查并修复（需管理员）
#   pwsh scripts/check-integrity.ps1 -Fix -Quiet
#   pwsh scripts/check-integrity.ps1 -Guard           # 装硬锁：拒绝 WRITE_OWNER，从源头打不上 Low
#   pwsh scripts/check-integrity.ps1 -Unguard         # 摘掉硬锁
#
# -Guard 的代价（务必知悉）：
#   硬锁 = 给根目录加 Everyone 拒绝 WRITE_OWNER（含 (OI)(CI) 继承）。
#   它会连带切断「以该目录为 workspace 的 workspace-write 型 ACL 沙箱」——
#   实测 DSH 的 acl runner 会 fail-closed：SetNamedSecurityInfoW (Win32 5)。
#   read-only 型沙箱不受影响（它不做 grantWrite）。所以：只用 danger-full-access
#   或 read-only 的话可以放心开硬锁；要在这棵树上跑 workspace-write 沙箱就别开。
#
# 注意：修改完整性标签要动 SACL，需要 SeSecurityPrivilege，即管理员令牌。
#       普通权限跑 -Fix 会报「拒绝访问」，这是预期行为，不是脚本 bug。

param(
  [switch]$Fix,
  [switch]$Quiet,
  [switch]$Guard,
  [switch]$Unguard,
  [string[]]$Roots = @(),
  # 这些目录名在递归时整体跳过（大且无关）
  [string[]]$Skip = @('node_modules', '.git', '_piai_probe', '.claude-flow', '.swc'),
  # 加锁/解锁的目标；默认与 Roots 相同
  [string[]]$GuardRoots = @()
)

$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
if ($Roots.Count -eq 0) {
  $Roots = @($repoRoot)
  $distDirs = Get-ChildItem $repoRoot -Directory -Filter "dist*" -ErrorAction SilentlyContinue
  foreach ($d in $distDirs) { $Roots += $d.FullName }
  $Roots = $Roots | Select-Object -Unique
}
if ($GuardRoots.Count -eq 0) { $GuardRoots = $Roots }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)

function Write-Step([string]$Text, [string]$Color = "Gray") {
  if (-not $Quiet) { Write-Host $Text -ForegroundColor $Color }
}

# ---------------------------------------------------------------------------
# 硬锁：拒绝 WRITE_OWNER
#   为什么是 WRITE_OWNER：SetNamedSecurityInfoW 写 SACL（完整性标签就存在 SACL 里）
#   需要 SeSecurityPrivilege + 对象上的 WRITE_OWNER（不是 WRITE_DAC）。
#   实测：加完这条 deny，icacls /setintegritylevel Low 直接 Access is denied；
#   常规读写、复制、删除、重命名、改 DACL（/remove:d）全部不受影响。
# ---------------------------------------------------------------------------
$guardSid = "*S-1-1-0"   # Everyone：对所有令牌生效，含沙箱的受限令牌

# 区分「显式装在这层」与「从父目录继承下来」：
#   icacls 输出里继承项带独立标记 (I)，显式项是 (OI)(CI) 这类继承位。
#   子目录继承了父级的锁时，对它 /remove:d 不会生效 —— 这是正确行为，
#   不能当成失败，否则每次对 dist* 子目录跑 -Unguard 都会误报。
function Get-GuardState([string]$Dir) {
  $lines = @(icacls $Dir 2>$null | Select-String "\(DENY\)\(WO\)")
  if ($lines.Count -eq 0) { return [pscustomobject]@{ Any = $false; Explicit = $false } }
  $explicit = $false
  foreach ($l in $lines) {
    # 只含 (I) 不带 (OI)/(CI) 的是纯继承项
    if ($l.Line -notmatch '\(I\)') { $explicit = $true; break }
  }
  return [pscustomobject]@{ Any = $true; Explicit = $explicit }
}

function Test-GuardInstalled([string]$Dir) {
  return (Get-GuardState $Dir).Any
}

if ($Guard) {
  if (-not $isAdmin) { Write-Host "装硬锁需要管理员令牌。" -ForegroundColor Red; exit 2 }
  foreach ($dir in $GuardRoots) {
    if (-not (Test-Path $dir)) { continue }
    if (Test-GuardInstalled $dir) {
      Write-Step "  已有锁: $dir" "DarkGray"
      continue
    }
    # 只给 OI/CI 继承位，让新老子孙都吃到；不需要 /T 逐个刷
    icacls $dir /deny "$guardSid`:(OI)(CI)(WO)" /C /Q 2>&1 | Out-Null
    if (Test-GuardInstalled $dir) {
      Write-Step "  已装锁: $dir" "Green"
    } else {
      Write-Host "  装锁失败: $dir" -ForegroundColor Red
    }
  }
}

if ($Unguard) {
  if (-not $isAdmin) { Write-Host "摘锁需要管理员令牌。" -ForegroundColor Red; exit 2 }
  foreach ($dir in $GuardRoots) {
    if (-not (Test-Path $dir)) { continue }
    $st = Get-GuardState $dir
    if (-not $st.Any) { Write-Step "  无锁: $dir" "DarkGray"; continue }
    if (-not $st.Explicit) {
      # 只有继承来的锁：去父目录摘，这里只报告，不报错
      Write-Step "  锁继承自父目录，跳过: $dir" "DarkGray"
      continue
    }
    # 只删 deny 条目；/remove:d 走 WRITE_DAC，被 WO 拒绝不影响
    icacls $dir /remove:d $guardSid /C /Q 2>&1 | Out-Null
    $after = Get-GuardState $dir
    if ($after.Explicit) {
      Write-Host "  摘锁失败: $dir" -ForegroundColor Red
    } elseif ($after.Any) {
      Write-Step "  已摘显式锁（仍有父级继承）: $dir" "Green"
    } else {
      Write-Step "  已摘锁: $dir" "Green"
    }
  }
}

if ($Guard -or $Unguard) {
  if (-not $Quiet) { Write-Host "" }
}

# ---------------------------------------------------------------------------
# 第一级：每棵树一次 icacls /T，只问「这棵树里有没有 Low」
# ---------------------------------------------------------------------------
function Test-TreeHasLow([string]$Dir) {
  $out = & icacls $Dir /T /C 2>$null
  return [bool]($out | Select-String "Low Mandatory")
}

# 并行版：一次把多棵树丢进 ForEach-Object -Parallel，把单次 icacls 约 190ms 的
# 进程启动成本摊到 8 路并发上（实测串行 7018ms → 并行 3086ms）。
function Get-TreeLowMap([string[]]$Dirs) {
  if ($Dirs.Count -eq 0) { return @{} }
  $rows = $Dirs | ForEach-Object -Parallel {
    $out = & icacls $_ /T /C 2>$null
    [pscustomobject]@{
      Path = $_
      HasLow = [bool]($out | Select-String "Low Mandatory")
    }
  } -ThrottleLimit 8
  $map = @{}
  foreach ($r in $rows) { $map[$r.Path] = $r.HasLow }
  return $map
}

# 扫描目标：每棵树一次 icacls /T。
# 关键：绝不对仓根直接跑 /T —— 那会递归进 node_modules（本机 1.7 万文件，>120s）。
# dist* 目录本身小，可以整棵 /T；仓根则拆成「根单点 + 每个顶层子目录一棵」。
function Get-ScanTargets([string]$Root) {
  $targets = @()
  if (-not (Test-Path $Root)) { return $targets }
  $name = Split-Path $Root -Leaf
  if ($name -match '^dist') {
    # 产物目录：整棵扫（通常几十~几百个对象）
    return @($Root)
  }
  $targets += $Root   # 根目录本身只做单点标签检查
  $children = Get-ChildItem $Root -Directory -ErrorAction SilentlyContinue |
    Where-Object { $Skip -notcontains $_.Name -and $_.Name -notmatch '^_piai' }
  foreach ($c in $children) { $targets += $c.FullName }
  return $targets
}

# 递归枚举但跳过 $Skip 目录（避免 Get-ChildItem -Recurse 一头钻进 node_modules）
function Get-ChildPathsSkipping([string]$Dir, [switch]$DirectoryOnly, [switch]$FileOnly) {
  $results = New-Object System.Collections.ArrayList
  $stack = New-Object System.Collections.Stack
  $stack.Push($Dir)
  while ($stack.Count -gt 0) {
    $cur = $stack.Pop()
    $items = Get-ChildItem $cur -ErrorAction SilentlyContinue
    foreach ($i in $items) {
      if ($i.PSIsContainer) {
        if ($Skip -contains $i.Name) { continue }
        if (-not $FileOnly) { [void]$results.Add($i) }
        $stack.Push($i.FullName)
      } elseif (-not $DirectoryOnly) {
        if ($i.Extension -in @('.exe', '.dll')) { [void]$results.Add($i) }
      }
    }
  }
  return $results
}

# ---------------------------------------------------------------------------
# 第二级：只在命中 Low 的子树里精确定位（目录 + exe/dll）
# ---------------------------------------------------------------------------
function Get-MandatoryLabelFromIcacls([string]$Path) {
  $line = (icacls $Path 2>$null | Select-String "Mandatory Label" | Select-Object -First 1).Line
  if (-not $line) { return $null }
  if ($line -match 'Low Mandatory') { return "Low" }
  if ($line -match 'Medium Mandatory') { return "Medium" }
  if ($line -match 'High Mandatory') { return "High" }
  return "Other"
}

$bad = New-Object System.Collections.ArrayList
$treesScanned = 0
$watch = [Diagnostics.Stopwatch]::StartNew()

foreach ($root in $Roots) {
  if (-not (Test-Path $root)) { continue }
  $targets = Get-ScanTargets $root
  $name = Split-Path $root -Leaf
  $isDist = $name -match '^dist'

  # 阶段 1：根目录单点检查（不递归）
  $treeTargets = @()
  foreach ($t in $targets) {
    $treesScanned++
    if (($t -eq $root) -and (-not $isDist)) {
      if ((Get-MandatoryLabelFromIcacls $t) -eq "Low") {
        [void]$bad.Add([pscustomobject]@{ Kind = "DIR"; Path = $t; Label = "Low" })
      }
      continue
    }
    $treeTargets += $t
  }

  # 阶段 2：并行判定哪棵树里有 Low（一次 icacls /T per tree，8 路并发）
  $lowMap = Get-TreeLowMap $treeTargets

  # 阶段 3：只在命中的树里下钻定位
  foreach ($t in $treeTargets) {
    if (-not $lowMap[$t]) { continue }

    Write-Step "  命中 Low，下钻定位: $t" "DarkGray"

    $lbl = Get-MandatoryLabelFromIcacls $t
    if ($lbl -eq "Low") { [void]$bad.Add([pscustomobject]@{ Kind = "DIR"; Path = $t; Label = $lbl }) }

    # 子孙目录 + 可执行产物（跳过 node_modules 等）
    foreach ($d in (Get-ChildPathsSkipping $t -DirectoryOnly)) {
      if ((Get-MandatoryLabelFromIcacls $d.FullName) -eq "Low") {
        [void]$bad.Add([pscustomobject]@{ Kind = "DIR"; Path = $d.FullName; Label = "Low" })
      }
    }
    foreach ($f in (Get-ChildPathsSkipping $t -FileOnly)) {
      if ((Get-MandatoryLabelFromIcacls $f.FullName) -eq "Low") {
        [void]$bad.Add([pscustomobject]@{ Kind = "FILE"; Path = $f.FullName; Label = "Low" })
      }
    }
  }
}

$watch.Stop()
$elapsedMs = [int]$watch.Elapsed.TotalMilliseconds

# 去重（同一路径可能被父/子两轮都报到）
$bad = $bad | Sort-Object Path -Unique

if (-not $Quiet) {
  Write-Host "扫描 $treesScanned 棵子树（$elapsedMs ms），根目录：" -ForegroundColor DarkGray
  $Roots | ForEach-Object { Write-Host "  $_" -ForegroundColor DarkGray }
  foreach ($g in $GuardRoots) {
    if (-not (Test-Path $g)) { continue }
    $gs = if (Test-GuardInstalled $g) { "硬锁已装" } else { "无硬锁" }
    Write-Host ("  [guard] {0} — {1}" -f $g, $gs) -ForegroundColor DarkGray
  }
}

if (-not $bad -or $bad.Count -eq 0) {
  Write-Step "OK：没有 Low 完整性标签（$elapsedMs ms）" "Green"
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
    if ((Get-MandatoryLabelFromIcacls $dir) -eq "Low") {
      [void]$failed.Add($dir)
    } else {
      $fixed++
      Write-Step "  已修复目录: $dir" "Green"
    }
  } catch {
    [void]$failed.Add($dir)
  }
}

# 文件：单独打 Medium（目录递归通常已覆盖，这里兜底散落的 exe）
foreach ($file in ($bad | Where-Object { $_.Kind -eq "FILE" } | Select-Object -ExpandProperty Path -Unique)) {
  if (-not (Test-Path $file)) { continue }
  try {
    icacls $file /setintegritylevel Medium /C /Q 2>&1 | Out-Null
    if ((Get-MandatoryLabelFromIcacls $file) -eq "Low") {
      [void]$failed.Add($file)
    } else {
      $fixed++
      Write-Step "  已修复文件: $file" "Green"
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
