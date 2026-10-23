$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sig = @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
public class Cap4 {
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

# SSH Workbench 按钮 rect=1258,1008 66x72
$bmp = [Cap4]::Grab(1258, 1008, 66, 72)
$bmp.Save('D:\ssh-workbench\probe-tb-btn.png', [System.Drawing.Imaging.ImageFormat]::Png)

Write-Output ("captured {0}x{1}" -f $bmp.Width, $bmp.Height)
for ($y = 0; $y -lt $bmp.Height; $y++) {
  $line = ''
  for ($x = 0; $x -lt $bmp.Width; $x++) {
    $c = $bmp.GetPixel($x, $y)
    if ($c.G -gt 90 -and $c.G -gt ($c.R + 25) -and $c.G -gt ($c.B + 25)) { $line += 'G' }
    elseif ($c.R -gt 230 -and $c.G -gt 230 -and $c.B -gt 230) { $line += 'W' }
    elseif ($c.R -lt 90 -and $c.G -lt 90 -and $c.B -lt 90) { $line += '#' }
    elseif ($c.R -gt 200 -and $c.B -gt 200 -and $c.G -lt 200) { $line += 'p' }
    else { $line += '.' }
  }
  Write-Output ('{0,2} {1}' -f $y, $line)
}

# 统计
$hist = @{}
for ($y = 0; $y -lt $bmp.Height; $y++) {
  for ($x = 0; $x -lt $bmp.Width; $x++) {
    $c = $bmp.GetPixel($x, $y)
    $k = '#{0:X2}{1:X2}{2:X2}' -f $c.R, $c.G, $c.B
    if ($hist.ContainsKey($k)) { $hist[$k]++ } else { $hist[$k] = 1 }
  }
}
$top = $hist.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 10
Write-Output '--- top colors ---'
foreach ($t in $top) { Write-Output ("  {0} x{1}" -f $t.Key, $t.Value) }
$bmp.Dispose()
