$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

$sig = @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public class Cap3 {
  [DllImport("shell32.dll")] public static extern IntPtr SHAppBarMessage(int msg, ref APPBARDATA d);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct APPBARDATA {
    public int cbSize; public IntPtr hWnd; public int uCallbackMessage; public int uEdge;
    public RECT rc; public IntPtr lParam;
  }
  public static RECT TaskbarRect() {
    APPBARDATA d = new APPBARDATA();
    d.cbSize = Marshal.SizeOf(typeof(APPBARDATA));
    SHAppBarMessage(5, ref d);
    return d.rc;
  }
  public static Bitmap Grab(int x, int y, int w, int h) {
    Bitmap bmp = new Bitmap(w, h, System.Drawing.Imaging.PixelFormat.Format32bppArgb);
    using (Graphics g = Graphics.FromImage(bmp)) {
      g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
    }
    return bmp;
  }
}
'@
Add-Type -TypeDefinition $sig -ReferencedAssemblies System.Drawing

$tb = [Cap3]::TaskbarRect()
Write-Output ("taskbar L={0} T={1} R={2} B={3}" -f $tb.L, $tb.T, $tb.R, $tb.B)

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ClassNameProperty), 'Shell_TrayWnd'
$tray = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if ($null -eq $tray) { Write-Output 'Shell_TrayWnd not found'; exit 1 }

$btnCond = New-Object System.Windows.Automation.PropertyCondition -ArgumentList ([System.Windows.Automation.AutomationElement]::ControlTypeProperty), ([System.Windows.Automation.ControlType]::Button)
$buttons = $tray.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
Write-Output ("taskbar buttons: {0}" -f $buttons.Count)

$i = 0
foreach ($b in $buttons) {
  $r = $b.Current.BoundingRectangle
  if ($r.Width -lt 10) { continue }
  $i++
  Write-Output ("  [{0}] name='{1}' rect={2},{3} {4}x{5}" -f $i, $b.Current.Name, [int]$r.X, [int]$r.Y, [int]$r.Width, [int]$r.Height)
}

foreach ($b in $buttons) {
  if ($b.Current.Name -notmatch 'SSH') { continue }
  $r = $b.Current.BoundingRectangle
  $pad = 14
  $x = [int]$r.X - $pad
  $y = [int]$r.Y - $pad
  $w = [int]$r.Width + $pad * 2
  $h = [int]$r.Height + $pad * 2
  $crop = [Cap3]::Grab($x, $y, $w, $h)
  $outFile = 'D:\ssh-workbench\probe-taskbar-ssh.png'
  $crop.Save($outFile, [System.Drawing.Imaging.ImageFormat]::Png)
  Write-Output ("cropped '{0}' -> {1} ({2}x{3}) at {4},{5}" -f $b.Current.Name, $outFile, $w, $h, $x, $y)

  $green = 0; $white = 0; $other = 0; $total = 0
  for ($yy = 0; $yy -lt $crop.Height; $yy++) {
    for ($xx = 0; $xx -lt $crop.Width; $xx++) {
      $c = $crop.GetPixel($xx, $yy)
      $total++
      if ($c.G -gt 100 -and $c.G -gt ($c.R + 30) -and $c.G -gt ($c.B + 30)) { $green++ }
      elseif ($c.R -gt 225 -and $c.G -gt 225 -and $c.B -gt 225) { $white++ }
      else { $other++ }
    }
  }
  $gp = [math]::Round(100.0 * $green / $total, 1)
  $wp = [math]::Round(100.0 * $white / $total, 1)
  $op = [math]::Round(100.0 * $other / $total, 1)
  Write-Output ("  green={0}% white={1}% other={2}%" -f $gp, $wp, $op)

  for ($yy = 0; $yy -lt $crop.Height; $yy += 2) {
    $line = ''
    for ($xx = 0; $xx -lt $crop.Width; $xx += 2) {
      $c = $crop.GetPixel($xx, $yy)
      if ($c.G -gt 100 -and $c.G -gt ($c.R + 30) -and $c.G -gt ($c.B + 30)) { $line += 'G' }
      elseif ($c.R -gt 225 -and $c.G -gt 225 -and $c.B -gt 225) { $line += 'W' }
      elseif ($c.R -lt 80 -and $c.G -lt 80 -and $c.B -lt 80) { $line += '#' }
      else { $line += '.' }
    }
    Write-Output ('  ' + $line)
  }
  $crop.Dispose()
}
