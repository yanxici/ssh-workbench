# Dump every taskbar button with its green/white pixel ratios.
# Used to identify a freshly launched probe window by its icon colour, without
# relying on button names (which are localized and mojibake through the console).
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

$i = 0
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
  $gp = [math]::Round(100.0 * $green / $total, 1)
  $wp = [math]::Round(100.0 * $white / $total, 1)
  $i++
  Write-Output ("[{0}] x={1} w={2} green={3}% white={4}%" -f $i, $x, $w, $gp, $wp)
  if ($gp -eq 0 -and $wp -gt 3) {
    $safe = Join-Path (Get-Location) ("tb-white-" + $i + ".png")
    $bmp.Save($safe, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output ("     saved " + $safe)
  }
  $bmp.Dispose()
}
