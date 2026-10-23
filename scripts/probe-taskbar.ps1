$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$sig = @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public class Cap {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr FindWindow(string c, string n);
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

$tb = [Cap]::TaskbarRect()
$w = $tb.R - $tb.L
$h = $tb.B - $tb.T
Write-Output ("任务栏矩形: L={0} T={1} R={2} B={3}  ({4}x{5})" -f $tb.L, $tb.T, $tb.R, $tb.B, $w, $h)

if ($w -le 0 -or $h -le 0) { Write-Output '拿不到任务栏矩形（可能是非交互会话）'; exit 1 }

$bmp = [Cap]::Grab($tb.L, $tb.T, $w, $h)
$out = Join-Path (Get-Location) 'probe-taskbar.png'
$bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ("截图: $out")

function Hex($c) { '#{0:X2}{1:X2}{2:X2}' -f $c.R, $c.G, $c.B }

# 底色：取左端 8px 处（任务栏最左通常是空白/开始按钮之外）
$bgCandidates = @()
foreach ($y in 2, [int]($h/2), ($h - 3)) {
  foreach ($x in 2, 12, ($w - 3)) {
    $bgCandidates += (Hex $bmp.GetPixel($x, $y))
  }
}
Write-Output ("边缘采样: " + ($bgCandidates -join ' '))

# 逐列统计「偏离底色」的像素数，找出内容区块
$bg = $bmp.GetPixel(2, [int]($h/2))
$colDiff = New-Object 'int[]' $w
for ($x = 0; $x -lt $w; $x++) {
  $n = 0
  for ($y = 2; $y -lt $h - 2; $y++) {
    $c = $bmp.GetPixel($x, $y)
    $d = [math]::Abs($c.R - $bg.R) + [math]::Abs($c.G - $bg.G) + [math]::Abs($c.B - $bg.B)
    if ($d -gt 30) { $n++ }
  }
  $colDiff[$x] = $n
}

$runs = New-Object System.Collections.ArrayList
$start = -1
for ($x = 0; $x -lt $w; $x++) {
  if ($colDiff[$x] -gt 4) { if ($start -lt 0) { $start = $x } }
  else { if ($start -ge 0) { [void]$runs.Add(@($start, ($x - 1))); $start = -1 } }
}
if ($start -ge 0) { [void]$runs.Add(@($start, ($w - 1))) }

Write-Output ("检测到 {0} 个区块:" -f $runs.Count)
foreach ($r in $runs) {
  $rw = $r[1] - $r[0] + 1
  if ($rw -lt 8) { continue }
  # 该区块内绿色像素占比
  $green = 0; $white = 0; $total = 0
  for ($x = $r[0]; $x -le $r[1]; $x++) {
    for ($y = 2; $y -lt $h - 2; $y++) {
      $c = $bmp.GetPixel($x, $y)
      $total++
      if ($c.G -gt 110 -and $c.G -gt ($c.R + 40) -and $c.G -gt ($c.B + 40)) { $green++ }
      elseif ($c.R -gt 225 -and $c.G -gt 225 -and $c.B -gt 225) { $white++ }
    }
  }
  $gp = [math]::Round(100.0 * $green / $total, 1)
  $wp = [math]::Round(100.0 * $white / $total, 1)
  Write-Output ("  x {0}..{1} width={2} green={3}% white={4}%" -f $r[0], $r[1], $rw, $gp, $wp)
}
$bmp.Dispose()
