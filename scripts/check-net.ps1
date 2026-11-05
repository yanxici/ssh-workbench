# 发布/推送前的网络自检。
#
# 为什么需要这个：本机走 GitHub 是否可达完全取决于后台有没有开 Clash（verge-mihomo）。
# 没开的时候 git 会卡满 300 秒才报 "Connection timed out"，release.ps1 会报一堆
# 「无法连接到远程服务器」—— 症状看起来像 GitHub 挂了或 token 失效，实际只是代理没起。
# 历史代价：v1.8.1 发版时为这个白等了四十多分钟。
#
# 判据三件事，全部打字输出，不做任何自动修复：
#   1. 系统代理开关 + 端口（读注册表，这是 Clash 自己写的）
#   2. 该端口是不是真的在监听
#   3. 挂这个代理能不能真的取到 api.github.com
#
# 用法：pwsh -NoProfile -File scripts/check-net.ps1
#       pwsh -NoProfile -File scripts/check-net.ps1 -Fix   # 顺手把 git 的 http.proxy 改成探测到的端口

param(
  [switch]$Fix,
  # 常见的 Clash / mihomo 混合端口，按经验顺序。7897 是老配置，7900 是当前机器在用的。
  [string[]]$Candidates = @("7897", "7890", "7900", "7891", "10808", "1080")
)

$ErrorActionPreference = "Stop"
# 控制台默认按 GBK 输出，脚本里写的是中文，从别的终端（bash / CI 日志）读回来就是乱码。
# 显式钉成 UTF-8，这样无论谁调用都能读懂。
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()

function Test-Port([string]$hostName, [int]$port, [int]$timeoutMs = 600) {
  try {
    $c = New-Object System.Net.Sockets.TcpClient
    $ok = $c.ConnectAsync($hostName, $port).Wait($timeoutMs)
    $c.Close()
    return $ok
  } catch { return $false }
}

# ---- 1. 系统代理 ----
$reg = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
$sysEnabled = ($reg.ProxyEnable -eq 1)
$sysServer = $reg.ProxyServer
Write-Host ""
Write-Host "== 系统代理 ==" -ForegroundColor Cyan
if ($sysEnabled -and $sysServer) {
  Write-Host "  开启，指向 $sysServer"
} else {
  Write-Host "  未开启（ProxyEnable=$($reg.ProxyEnable) ProxyServer=$($reg.ProxyServer)）" -ForegroundColor Yellow
  Write-Host "  → Clash 没跑起来的时候这里就是关的，先去托盘把 Clash Verge 打开" -ForegroundColor Yellow
}

# ---- 2. 端口探测 ----
Write-Host ""
Write-Host "== 端口探测 ==" -ForegroundColor Cyan
$live = @()
foreach ($p in $Candidates) {
  if (Test-Port "127.0.0.1" ([int]$p)) {
    Write-Host "  $p  LISTEN" -ForegroundColor Green
    $live += $p
  } else {
    Write-Host "  $p  closed" -ForegroundColor DarkGray
  }
}

# 系统代理里写的那一个优先，其次是候选顺序里的第一个活的
$chosen = $null
if ($sysEnabled -and $sysServer -match ':(\d+)$') {
  $sysPort = $Matches[1]
  if ($live -contains $sysPort) { $chosen = $sysPort }
}
if (-not $chosen -and $live.Count -gt 0) { $chosen = $live[0] }

if (-not $chosen) {
  Write-Host ""
  Write-Host "结论：本机没有可用代理端口。" -ForegroundColor Red
  Write-Host "      先去打开 Clash Verge，再回来跑发布。不要在这种情况下重试 git push —— " -ForegroundColor Red
  Write-Host "      每次都要等满 300 秒连接超时，而且日志报的是 GitHub 不可达，看不出是代理没开。" -ForegroundColor Red
  exit 1
}

$proxyUrl = "http://127.0.0.1:$chosen"
Write-Host ""
Write-Host "选定代理：$proxyUrl" -ForegroundColor Green

# ---- 3. 真打一次 ----
Write-Host ""
Write-Host "== 连通性 ==" -ForegroundColor Cyan
$probeOk = $false
# 为什么用 github.com 而不是 api.github.com/zen：
# 后者匿名有 60 次/小时限流，一不小心就是 403 rate limit exceeded —— 那说明
# TLS 握手、HTTP 往返全都通了，只是额度用光，把它当「不通」会误判成节点挂了。
# github.com 主页不参与 API 限流，200/301 就能证明链路是活的。
try {
  $r = Invoke-WebRequest -Uri "https://github.com" -Proxy $proxyUrl -TimeoutSec 20 -UseBasicParsing -MaximumRedirection 0 -ErrorAction Stop
  Write-Host "  github.com  $($r.StatusCode)" -ForegroundColor Green
  $probeOk = $true
} catch {
  # 301/302 在 -MaximumRedirection 0 下会抛，状态码还在响应里，同样算通
  $code = $null
  if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
  if ($code -and $code -lt 500) {
    Write-Host "  github.com  $code（重定向，链路正常）" -ForegroundColor Green
    $probeOk = $true
  } else {
    Write-Host "  github.com  失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  端口在监听但取不到内容，通常是节点没选、或者规则把它 reject 了 —— 去 Clash 里换个节点" -ForegroundColor Yellow
  }
}
if ($probeOk) {
  # 再确认一次 API 主机：发布走的是 api.github.com，和 github.com 可能命中不同规则
  try {
    $a = Invoke-WebRequest -Uri "https://api.github.com/zen" -Proxy $proxyUrl -TimeoutSec 15 -UseBasicParsing -ErrorAction Stop
    Write-Host "  api.github.com  $($a.StatusCode)" -ForegroundColor Green
  } catch {
    $code = $null
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 403 -or $code -eq 401) {
      Write-Host "  api.github.com  $code（限流或需要 token，链路本身是通的）" -ForegroundColor Yellow
    } else {
      Write-Host "  api.github.com  失败：$($_.Exception.Message)" -ForegroundColor Red
      Write-Host "  github.com 通但 API 不通，发布会在创建 Release 那一步失败 —— 检查 Clash 规则" -ForegroundColor Red
      $probeOk = $false
    }
  }
}

if (-not $probeOk) { exit 1 }

# ---- 4. 可选：把 git 的代理改过来 ----
$cur = (git config --local --get http.proxy) 2>$null
Write-Host ""
Write-Host "== git http.proxy ==" -ForegroundColor Cyan
Write-Host "  当前：$(if ($cur) { $cur } else { '(未设置)' })"
if ($Fix) {
  git config --local http.proxy $proxyUrl
  Write-Host "  已改为：$proxyUrl" -ForegroundColor Green
} elseif ($cur -ne $proxyUrl) {
  Write-Host "  和探测结果不一致。加 -Fix 自动改：pwsh -NoProfile -File scripts/check-net.ps1 -Fix" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "网络就绪，可以 push / 发版了。" -ForegroundColor Green
