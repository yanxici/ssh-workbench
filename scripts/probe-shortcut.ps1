$ErrorActionPreference = 'Stop'
$sh = New-Object -ComObject WScript.Shell

$links = @(
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\SSH Workbench.lnk",
  "C:\Users\yuzhu22\Desktop\SSH Workbench.lnk",
  "C:\Users\yuzhu22\Desktop\SSH Workbench - 快捷方式.lnk"
)

foreach ($p in $links) {
  Write-Output ("=== {0}" -f $p)
  if (-not (Test-Path -LiteralPath $p)) { Write-Output '  (missing)'; continue }
  $lnk = $sh.CreateShortcut($p)
  Write-Output ("  TargetPath : {0}" -f $lnk.TargetPath)
  Write-Output ("  WorkingDir : {0}" -f $lnk.WorkingDirectory)
  Write-Output ("  IconLocation: {0}" -f $lnk.IconLocation)
  Write-Output ("  Arguments  : {0}" -f $lnk.Arguments)
  $targetExists = $false
  if ($lnk.TargetPath) { $targetExists = Test-Path -LiteralPath $lnk.TargetPath }
  Write-Output ("  target exists: {0}" -f $targetExists)

  # 读 lnk 里的 AppUserModelID（System.AppUserModel.ID 属性）
  try {
    $folder = Split-Path -Parent $p
    $file = Split-Path -Leaf $p
    $shellApp = New-Object -ComObject Shell.Application
    $ns = $shellApp.Namespace($folder)
    $item = $ns.ParseName($file)
    $aumid = $item.ExtendedProperty('System.AppUserModel.ID')
    Write-Output ("  AUMID      : '{0}'" -f $aumid)
    $iconProp = $item.ExtendedProperty('System.Link.TargetParsingPath')
    Write-Output ("  TargetParsingPath: {0}" -f $iconProp)
  } catch {
    Write-Output ("  (AUMID read failed: {0})" -f $_.Exception.Message)
  }
}
