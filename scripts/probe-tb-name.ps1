param([string]$NameLike = 'Probe')

# Crop every taskbar button whose accessible name contains $NameLike,
# then report green/white pixel ratios plus a coarse ASCII preview.
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Shell_TrayWnd')
$tray = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $tray) { Write-Output 'taskbar not found'; exit 1 }

$btnCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Button)
$buttons = $tray.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
Write-Output ("taskbar buttons: " + $buttons.Count)

$found = 0
foreach ($b in $buttons) {
  $name = $b.Current.Name
  if (-not $name) { continue }
  if ($name -notlike "*$NameLike*") { continue }
  $r = $b.Current.BoundingRectangle
  if ($r.Width -lt 8 -or $r.Height -lt 8) { continue }
  $found++
  $x = [int]$r.X; $y = [int]$r.Y; $w = [int]$r.Width; $h = [int]$r.Height
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g.Dispose()

  $green = 0; $white = 0; $total = 0
  for ($py = 0; $py -lt $h; $py += 1) {
    for ($px = 0; $px -lt $w; $px += 1) {
      $c = $bmp.GetPixel($px, $py)
      $total++
      if ($c.G -gt 120 -and $c.G -gt ($c.R + 40) -and $c.G -gt ($c.B + 40)) { $green++ }
      elseif ($c.R -gt 230 -and $c.G -gt 230 -and $c.B -gt 230) { $white++ }
    }
  }
  $gp = [math]::Round(100.0 * $green / $total, 1)
  $wp = [math]::Round(100.0 * $white / $total, 1)
  Write-Output ("name='{0}' rect={1},{2} {3}x{4} green={5}% white={6}%" -f $name, $x, $y, $w, $h, $gp, $wp)

  foreach ($py in 0..($h - 1)) {
    if ($py % 3 -ne 0) { continue }
    $line = ''
    foreach ($px in 0..($w - 1)) {
      if ($px % 2 -ne 0) { continue }
      $c = $bmp.GetPixel($px, $py)
      if ($c.G -gt 120 -and $c.G -gt ($c.R + 40) -and $c.G -gt ($c.B + 40)) { $line += 'G' }
      elseif ($c.R -gt 230 -and $c.G -gt 230 -and $c.B -gt 230) { $line += 'W' }
      else { $line += '.' }
    }
    Write-Output ("  |" + $line + "|")
  }
  $bmp.Save((Join-Path (Get-Location) ("probe-tb-" + ($found) + ".png")), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
if ($found -eq 0) { Write-Output "no taskbar button matched '$NameLike'" }
