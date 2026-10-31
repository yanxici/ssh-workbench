# SSH Workbench 回滚脚本
#
# 用途：把某个已发布的版本重新「设为最新」，让客户端的自动更新指回它。
#
# 为什么需要它：
#   electron-updater 读 Release 上的 latest.yml 判断有没有新版本。一旦发了个
#   坏版本，latest.yml 就被覆盖成坏版本 —— 所有客户端都会指向它，包括还没升级的。
#   唯一的止血办法是把旧版本的 latest.yml（内容含旧 version + 旧 Setup 的 sha512）
#   重新传上去覆盖。这一步没沉淀的话，半夜发版时没人记得住顺序和 sha512 从哪来。
#
# 用法：
#   $env:GH_TOKEN = "<token>"
#   pwsh scripts/rollback.ps1 -Version 1.6.13                    # 回滚到 1.6.13
#   pwsh scripts/rollback.ps1 -Version 1.6.13 -WhatIf            # 只看要做什么
#
# 注意：本脚本**不删 tag、不改 git 历史**。回滚是发布层面的操作，
# 让客户端更新指回旧版本；代码层面的修复该走正常的发版流程。

param(
  [Parameter(Mandatory = $true)][string]$Version,
  [string]$Owner = "yanxici",
  [string]$Repo = "ssh-workbench",
  # 只演练不执行：打印将要上传的文件与来源
  [switch]$WhatIf,
  # 本地找不到对应版本产物时，允许从 GitHub Release 下载回来重传
  [switch]$FromRelease
)

$ErrorActionPreference = "Stop"

$ver = $Version -replace '^v', ''
$tag = "v$ver"

if (-not $env:GH_TOKEN) {
  Write-Host "缺少 GH_TOKEN 环境变量" -ForegroundColor Red
  exit 1
}

$root = Split-Path -Parent $PSScriptRoot

# ---- 产物目录：与 release.ps1 同源，从 electron-builder.yml 解析 ----
$builderYml = Join-Path $root "electron-builder.yml"
$m = Select-String -Path $builderYml -Pattern '^\s*output:\s*(\S+)\s*$' -AllMatches
if (-not $m -or $m.Matches.Count -eq 0) {
  Write-Host "electron-builder.yml 里没解析到 directories.output" -ForegroundColor Red
  exit 1
}
$distName = $m.Matches[0].Groups[1].Value.Trim('"', "'")
$dist = Join-Path $root $distName

Write-Host "回滚目标：$tag（产物目录 $distName）" -ForegroundColor Cyan
Write-Host ""

# ---- 1. 确认目标版本在 GitHub 上确实存在且有 assets ----
Write-Host "[1/4] 确认 $tag 在远端存在..." -ForegroundColor DarkGray
$releaseJson = gh release view $tag --repo "$Owner/$Repo" --json tagName,assets,isDraft 2>$null
if ($LASTEXITCODE -ne 0 -or -not $releaseJson) {
  Write-Host "远端找不到 $tag，无法回滚到不存在的版本" -ForegroundColor Red
  exit 1
}
$rel = $releaseJson | ConvertFrom-Json
$remoteAssets = @($rel.assets | ForEach-Object { $_.name })
Write-Host "      远端 assets：$($remoteAssets -join ', ')"

$setupName = "ssh-workbench-Setup-$ver.exe"
$blockName = "$setupName.blockmap"
foreach ($need in @($setupName, $blockName, 'latest.yml')) {
  if ($remoteAssets -notcontains $need) {
    Write-Host "      远端缺少 $need —— 这个版本的 Release 不完整，不能作为回滚目标" -ForegroundColor Red
    exit 1
  }
}
Write-Host "      三件套齐全" -ForegroundColor Green

# ---- 2. 准备要上传的 latest.yml + Setup + blockmap ----
Write-Host ""
Write-Host "[2/4] 准备本地文件..." -ForegroundColor DarkGray
$localSetup = Join-Path $dist $setupName
$localBlock = Join-Path $dist $blockName
$localYml = Join-Path $dist "latest.yml"

$missing = @($localSetup, $localBlock, $localYml) | Where-Object { -not (Test-Path $_) }
if ($missing.Count -gt 0) {
  if ($FromRelease) {
    Write-Host "      本地缺文件，按 -FromRelease 从远端下载..." -ForegroundColor Yellow
    $tmp = Join-Path ([System.IO.Path]::GetTempPath()) "sw-rollback-$ver"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    foreach ($name in @($setupName, $blockName, 'latest.yml')) {
      $target = Join-Path $tmp $name
      $url = "https://github.com/$Owner/$Repo/releases/download/$tag/$name"
      Write-Host "        ↓ $name"
      curl.exe -sSL --retry 3 -o $target $url
      if (-not (Test-Path $target) -or (Get-Item $target).Length -eq 0) {
        Write-Host "        下载失败：$url" -ForegroundColor Red
        exit 1
      }
    }
    $localSetup = Join-Path $tmp $setupName
    $localBlock = Join-Path $tmp $blockName
    $localYml = Join-Path $tmp 'latest.yml'
  } else {
    Write-Host "      本地 $distName 缺少：$($missing -join ', ')" -ForegroundColor Red
    Write-Host "      用 -FromRelease 从远端取回，或先把该版本的产物放回 $distName" -ForegroundColor Yellow
    exit 1
  }
}

# ---- 3. 校验 latest.yml 确实指向目标版本，且 sha512 与本地 Setup 对得上 ----
Write-Host ""
Write-Host "[3/4] 校验 latest.yml 与 Setup..." -ForegroundColor DarkGray
$ymlText = Get-Content $localYml -Raw
# 注意：Select-String 默认按「行」匹配，对整段文本要显式用 -AllMatches + 多行锚点会失效，
# 这里直接用 -match 取捕获组，行为可预期。
#
# (?m)^version: 只锚「行首」，没锚「顶层块」。当前 electron-builder 产出的
# latest.yml 里 files 条目下只有 url/sha512/size，没有 version 子键，
# 所以第一个 version: 就是顶层版本号，没问题。
# 但若将来 latest-mac.yml / latest-linux.yml 也走这个脚本，或 electron-builder
# 调整格式把 version 塞进 files 条目，这里可能匹配到非预期位置 ——
# 那时改成显式切片（只取 files: 之前的文本）再匹配。
# 现在不提前改，因为「多加一层切片」本身也会成为新的出错点。
if ($ymlText -notmatch '(?m)^version:\s*(\S+)') {
  Write-Host "      latest.yml 里没有 version 字段" -ForegroundColor Red
  exit 1
}
$ymlVersion = $Matches[1].Trim()
if ($ymlVersion -ne $ver) {
  Write-Host "      latest.yml 里的 version 是 $ymlVersion，与回滚目标 $ver 不符" -ForegroundColor Red
  Write-Host "      这是最关键的一道校验：传错的话客户端会被指向别的版本" -ForegroundColor Yellow
  exit 1
}
if ($ymlText -notmatch '(?m)^sha512:\s*(\S+)') {
  Write-Host "      latest.yml 里没有 sha512 字段" -ForegroundColor Red
  exit 1
}
$ymlSha = $Matches[1].Trim()
$actualHash = [Convert]::ToBase64String(
  [System.Security.Cryptography.SHA512]::Create().ComputeHash(
    [System.IO.File]::ReadAllBytes($localSetup)
  )
)
if ($ymlSha -ne $actualHash) {
  Write-Host "      sha512 不匹配！" -ForegroundColor Red
  Write-Host "        latest.yml: $ymlSha" -ForegroundColor Red
  Write-Host "        实际文件:   $actualHash" -ForegroundColor Red
  Write-Host "      说明 latest.yml 与这个 Setup 不是同一次构建产出的，传上去会让客户端校验失败" -ForegroundColor Yellow
  exit 1
}
Write-Host "      version=$ver，sha512 与 Setup 一致" -ForegroundColor Green

# ---- 4. 上传（覆盖远端同名文件） ----
Write-Host ""
if ($WhatIf) {
  Write-Host "[4/4] -WhatIf：将执行以下命令（未实际执行）" -ForegroundColor Yellow
  Write-Host "      gh release upload $tag `"$localSetup`" `"$localBlock`" `"$localYml`" --clobber"
  Write-Host ""
  Write-Host "演练完成。" -ForegroundColor Cyan
  exit 0
}

Write-Host "[4/4] 上传并覆盖远端 latest.yml..." -ForegroundColor DarkGray
gh release upload $tag $localSetup $localBlock $localYml --repo "$Owner/$Repo" --clobber
if ($LASTEXITCODE -ne 0) {
  Write-Host "上传失败" -ForegroundColor Red
  exit 1
}

# ---- 收尾：把远端 latest.yml 拉回来核对 ----
Write-Host ""
Write-Host "核对远端 latest.yml..." -ForegroundColor DarkGray
$verifyTmp = Join-Path ([System.IO.Path]::GetTempPath()) "sw-rollback-verify-$ver.yml"
curl.exe -sSL --retry 3 -o $verifyTmp "https://github.com/$Owner/$Repo/releases/latest/download/latest.yml"
$verifyText = Get-Content $verifyTmp -Raw
$remoteVer = if ($verifyText -match '(?m)^version:\s*(\S+)') { $Matches[1].Trim() } else { '(无法解析)' }
Remove-Item $verifyTmp -Force -EA SilentlyContinue

if ($remoteVer -eq $ver) {
  Write-Host ""
  Write-Host "回滚完成：客户端自动更新现在指向 $ver" -ForegroundColor Green
  Write-Host "  已安装更高版本的用户不会自动降级（electron-updater 默认不降级），" -ForegroundColor DarkGray
  Write-Host "  他们需要手动安装 $setupName 覆盖。" -ForegroundColor DarkGray
} else {
  Write-Host "远端 latest.yml 的 version 是 $remoteVer，与预期 $ver 不符 —— 请手动检查" -ForegroundColor Red
  exit 1
}
