$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$src = 'D:\ssh-workbench\probe-taskbar.png'
$bmp = [System.Drawing.Bitmap]::FromFile($src)
Write-Output ("source {0}x{1}" -f $bmp.Width, $bmp.Height)

function Dump($x0, $x1, $yTop, $yBot, $step) {
  Write-Output ("--- region x $x0..$x1  y $yTop..$yBot  step $step ---")
  for ($y = $yTop; $y -lt $yBot; $y += $step) {
    $line = ''
    for ($x = $x0; $x -lt $x1; $x += $step) {
      $c = $bmp.GetPixel($x, $y)
      $g = $c.G; $r = $c.R; $b = $c.B
      if ($g -gt 100 -and $g -gt ($r + 30) -and $g -gt ($b + 30)) { $line += 'G' }
      elseif ($r -gt 225 -and $g -gt 225 -and $b -gt 225) { $line += 'W' }
      elseif ($r -lt 70 -and $g -lt 70 -and $b -lt 70) { $line += '#' }
      else { $line += '.' }
    }
    Write-Output ('  ' + $line)
  }
}

# 两个疑似带绿色的按钮
Dump 995 1060 6 68 2
Dump 1062 1125 6 68 2

# 打印这几个区块的主色分布
foreach ($range in @(@(1009, 1044), @(1075, 1110))) {
  $hist = @{}
  for ($x = $range[0]; $x -le $range[1]; $x++) {
    for ($y = 4; $y -lt 70; $y++) {
      $c = $bmp.GetPixel($x, $y)
      $key = '#{0:X2}{1:X2}{2:X2}' -f $c.R, $c.G, $c.B
      if ($hist.ContainsKey($key)) { $hist[$key]++ } else { $hist[$key] = 1 }
    }
  }
  $top = $hist.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 6
  Write-Output ("block {0}..{1} top colors: {2}" -f $range[0], $range[1], (($top | ForEach-Object { "$($_.Key)x$($_.Value)" }) -join ' '))
}
$bmp.Dispose()
