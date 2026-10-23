$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class WIcon2 {
  [DllImport("user32.dll", CharSet=CharSet.Auto)]
  public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr GetClassLongPtr(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetClassNameW(IntPtr hWnd, StringBuilder s, int n);
  public delegate bool EnumProc(IntPtr hWnd, IntPtr l);
}
'@
Add-Type -TypeDefinition $sig

$procs = Get-CimInstance Win32_Process -Filter "Name='SSH Workbench.exe'"
$byPid = @{}
foreach ($p in $procs) {
  if (-not $byPid.ContainsKey([uint32]$p.ProcessId)) { $byPid[[uint32]$p.ProcessId] = $p.ExecutablePath }
}

$script:rows = @()
$cb = [WIcon2+EnumProc]{
  param($hWnd, $l)
  $pid2 = [uint32]0
  [void][WIcon2]::GetWindowThreadProcessId($hWnd, [ref]$pid2)
  if (-not $script:byPid.ContainsKey($pid2)) { return $true }
  if (-not [WIcon2]::IsWindowVisible($hWnd)) { return $true }
  $sb = New-Object System.Text.StringBuilder 512
  [void][WIcon2]::GetWindowTextW($hWnd, $sb, 512)
  $title = $sb.ToString()
  if ([string]::IsNullOrWhiteSpace($title)) { return $true }
  $cls = New-Object System.Text.StringBuilder 256
  [void][WIcon2]::GetClassNameW($hWnd, $cls, 256)
  $small = [WIcon2]::SendMessage($hWnd, 0x007F, [IntPtr]0, [IntPtr]::Zero)
  $big = [WIcon2]::SendMessage($hWnd, 0x007F, [IntPtr]1, [IntPtr]::Zero)
  $script:rows += [pscustomobject]@{
    Pid = $pid2
    Class = $cls.ToString()
    Title = $title
    SmallIcon = $small.ToInt64()
    BigIcon = $big.ToInt64()
    Exe = (Split-Path -Leaf (Split-Path -Parent (Split-Path -Parent $script:byPid[$pid2])))
  }
  return $true
}
[void][WIcon2]::EnumWindows($cb, [IntPtr]::Zero)

foreach ($r in $script:rows) {
  Write-Output ("PID {0} [{1}] title='{2}' small={3} big={4}" -f $r.Pid, $r.Class, $r.Title, $r.SmallIcon, $r.BigIcon)
  if ($r.SmallIcon -ne 0) {
    $ico = [System.Drawing.Icon]::FromHandle([IntPtr]$r.SmallIcon)
    $bmp = $ico.ToBitmap()
    $g = 0; $w = 0; $t = 0
    for ($y = 0; $y -lt $bmp.Height; $y++) {
      for ($x = 0; $x -lt $bmp.Width; $x++) {
        $c = $bmp.GetPixel($x, $y); $t++
        if ($c.G -gt 90 -and $c.G -gt ($c.R + 25) -and $c.G -gt ($c.B + 25)) { $g++ }
        elseif ($c.R -gt 230 -and $c.G -gt 230 -and $c.B -gt 230) { $w++ }
      }
    }
    Write-Output ("   small {0}x{1} green={2}% white={3}%" -f $bmp.Width, $bmp.Height, [math]::Round(100.0*$g/$t,1), [math]::Round(100.0*$w/$t,1))
    $bmp.Dispose()
  } else {
    Write-Output '   small icon = 0 (未设置)'
  }
}
