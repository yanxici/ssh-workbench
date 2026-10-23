# Crop ONLY the icon glyph area of a taskbar button (32x32 centred horizontally,
# vertically centred) and report its colour composition. Cropping the full button
# rect is useless because the taskbar background dominates the white count --
# and it flips with light/dark taskbar themes, which is exactly what made an
# earlier measurement look contradictory.
param(
  [int]$X = 1192,
  [int]$Y = 1008,
  [int]$W = 66,
  [int]$H = 72
)

Add-Type -AssemblyName System.Drawing

$icon = 32
$ox = $X + [int](($W - $icon) / 2)
$oy = $Y + [int](($H - $icon) / 2)

$bmp = New-Object System.Drawing.Bitmap($icon, $icon)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($ox, $oy, 0, 0, (New-Object System.Drawing.Size($icon, $icon)))
$g.Dispose()

$green = 0; $white = 0; $other = 0
for ($py = 0; $py -lt $icon; $py++) {
  for ($px = 0; $px -lt $icon; $px++) {
    $c = $bmp.GetPixel($px, $py)
    if ($c.G -gt 120 -and $c.G -gt ($c.R + 40) -and $c.G -gt ($c.B + 40)) { $green++ }
    elseif ($c.R -gt 235 -and $c.G -gt 235 -and $c.B -gt 235) { $white++ }
    else { $other++ }
  }
}
$total = $icon * $icon
Write-Output ("crop=({0},{1}) {2}x{3}  green={4}%  white={5}%  other={6}%" -f $ox, $oy, $icon, $icon,
  [math]::Round(100.0 * $green / $total, 1),
  [math]::Round(100.0 * $white / $total, 1),
  [math]::Round(100.0 * $other / $total, 1))

for ($py = 0; $py -lt $icon; $py++) {
  $line = ''
  for ($px = 0; $px -lt $icon; $px++) {
    $c = $bmp.GetPixel($px, $py)
    if ($c.G -gt 120 -and $c.G -gt ($c.R + 40) -and $c.G -gt ($c.B + 40)) { $line += 'G' }
    elseif ($c.R -gt 235 -and $c.G -gt 235 -and $c.B -gt 235) { $line += 'W' }
    else { $line += '.' }
  }
  Write-Output ('  |' + $line + '|')
}

$safe = Join-Path (Get-Location) 'tb-icon-crop.png'
$bmp.Save($safe, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output ('saved ' + $safe)
$bmp.Dispose()
