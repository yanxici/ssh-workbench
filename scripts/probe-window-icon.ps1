Add-Type -AssemblyName System.Drawing

$sig = @'
using System;
using System.Runtime.InteropServices;
public class WinIcon {
  [DllImport("user32.dll", CharSet=CharSet.Auto)]
  public static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError=true)]
  public static extern IntPtr GetClassLongPtr(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)]
  public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr hWnd);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
}
'@
Add-Type -TypeDefinition $sig

$WM_GETICON = 0x007F
$procs = Get-CimInstance Win32_Process -Filter "Name='SSH Workbench.exe'"
$pids = $procs | ForEach-Object { [uint32]$_.ProcessId }
Write-Output ("PIDs: " + ($pids -join ', '))

$found = @()
$cb = [WinIcon+EnumWindowsProc]{
  param($hWnd, $lParam)
  $pid2 = [uint32]0
  [void][WinIcon]::GetWindowThreadProcessId($hWnd, [ref]$pid2)
  if ($script:pids -contains $pid2 -and [WinIcon]::IsWindowVisible($hWnd)) {
    $sb = New-Object System.Text.StringBuilder 512
    [void][WinIcon]::GetWindowTextW($hWnd, $sb, 512)
    $script:found += [pscustomobject]@{ Hwnd = $hWnd; Pid = $pid2; Title = $sb.ToString() }
  }
  return $true
}
[void][WinIcon]::EnumWindows($cb, [IntPtr]::Zero)

foreach ($w in $found) {
  Write-Output ("`n=== HWND 0x{0:X}  PID {1}  Title='{2}' ===" -f $w.Hwnd.ToInt64(), $w.Pid, $w.Title)
  foreach ($kind in @(0, 1, 2)) {
    $label = @{ 0 = 'ICON_SMALL(16)'; 1 = 'ICON_BIG(32)'; 2 = 'ICON_SMALL2' }[$kind]
    $h = [WinIcon]::SendMessage($w.Hwnd, $WM_GETICON, [IntPtr]$kind, [IntPtr]::Zero)
    if ($h -eq [IntPtr]::Zero) {
      Write-Output ("  WM_GETICON {0,-14} -> 0  (窗口没有设图标，Windows 回退到 exe 资源 / 类图标)" -f $label)
      continue
    }
    $ico = [System.Drawing.Icon]::FromHandle($h)
    $bmp = $ico.ToBitmap()
    # 取中心像素与四个象限采样，判断是不是整片白
    $samples = @()
    foreach ($pt in @(@(0.5, 0.5), @(0.25, 0.25), @(0.75, 0.25), @(0.25, 0.75), @(0.75, 0.75))) {
      $x = [int]($bmp.Width * $pt[0]); $y = [int]($bmp.Height * $pt[1])
      if ($x -ge $bmp.Width) { $x = $bmp.Width - 1 }
      if ($y -ge $bmp.Height) { $y = $bmp.Height - 1 }
      $c = $bmp.GetPixel($x, $y)
      $samples += ("({0},{1})#{2:X2}{3:X2}{4:X2}a{5}" -f $x, $y, $c.R, $c.G, $c.B, $c.A)
    }
    Write-Output ("  WM_GETICON {0,-14} -> hIcon {1}  bitmap {2}x{3}  {4}" -f $label, $h, $bmp.Width, $bmp.Height, ($samples -join ' '))
    $bmp.Dispose()
  }
  $cls = [WinIcon]::GetClassLongPtr($w.Hwnd, -34)  # GCLP_HICON
  $clsSm = [WinIcon]::GetClassLongPtr($w.Hwnd, -14) # GCLP_HICONSM
  Write-Output ("  class icon: big={0} small={1}" -f $cls, $clsSm)
}
