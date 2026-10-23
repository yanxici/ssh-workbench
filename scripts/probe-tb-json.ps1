# Export taskbar buttons as UTF-8 JSON (avoids console mojibake for Chinese names),
# together with each button's cropped-icon colour statistics.
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$out = Join-Path (Get-Location) 'probe-tb.json'
$root = [System.Windows.Automation.AutomationElement]::RootElement
$cond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'Shell_TrayWnd')
$tray = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $cond)
if (-not $tray) { '{"error":"taskbar not found"}' | Set-Content -Path $out -Encoding UTF8; exit 1 }

$btnCond = New-Object System.Windows.Automation.PropertyCondition(
  [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
  [System.Windows.Automation.ControlType]::Button)
$buttons = $tray.FindAll([System.Windows.Automation.TreeScope]::Descendants, $btnCond)

$result = @()
foreach ($b in $buttons) {
  $r = $b.Current.BoundingRectangle
  if ($r.Width -lt 40 -or $r.Height -lt 40) { continue }
  $x = [int]$r.X; $y = [int]$r.Y; $w = [int]$r.Width; $h = [int]$r.Height
  $bmp = New-Object System.Drawing.Bitmap($w, $h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($w, $h)))
  $g.Dispose()

  $green = 0; $white = 0; $total = 0
  for ($py = 0; $py -lt $h; $py++) {
    for ($px = 0; $px -lt $w; $px++) {
      $c = $bmp.GetPixel($px, $py)
      $total++
      if ($c.G -gt 120 -and $c.G -gt ($c.R + 40) -and $c.G -gt ($c.B + 40)) { $green++ }
      elseif ($c.R -gt 230 -and $c.G -gt 230 -and $c.B -gt 230) { $white++ }
    }
  }
  $bmp.Dispose()
  $result += [ordered]@{
    name  = $b.Current.Name
    x     = $x
    w     = $w
    green = [math]::Round(100.0 * $green / $total, 1)
    white = [math]::Round(100.0 * $white / $total, 1)
  }
}

$result | ConvertTo-Json -Depth 4 | Set-Content -Path $out -Encoding UTF8
Write-Output ("wrote " + $out + " (" + $result.Count + " buttons)")
