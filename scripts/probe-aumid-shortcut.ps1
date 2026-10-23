# Find every .lnk that claims a given AppUserModelID, and report what the shell
# resolves as that shortcut's icon (name + the icon pixels the shell would draw).
param([string]$Aumid = 'com.sshworkbench.app')

Add-Type -AssemblyName System.Drawing

$shellApp = New-Object -ComObject Shell.Application
$roots = @(
  "$env:APPDATA\Microsoft\Windows\Start Menu\Programs",
  "$env:ProgramData\Microsoft\Windows\Start Menu\Programs",
  "$env:USERPROFILE\Desktop",
  "$env:PUBLIC\Desktop"
)

$hits = @()
foreach ($root in $roots) {
  if (-not (Test-Path -LiteralPath $root)) { continue }
  $lnks = Get-ChildItem -LiteralPath $root -Filter *.lnk -Recurse -ErrorAction SilentlyContinue
  foreach ($f in $lnks) {
    $dir = $f.DirectoryName
    $ns = $shellApp.Namespace($dir)
    $it = $ns.ParseName($f.Name)
    if (-not $it) { continue }
    $id = $it.ExtendedProperty('System.AppUserModel.ID')
    if ($id -ne $Aumid) { continue }
    $sh = New-Object -ComObject WScript.Shell
    $sc = $sh.CreateShortcut($f.FullName)
    $hits += [ordered]@{
      path     = $f.FullName
      target   = $sc.TargetPath
      iconLoc  = $sc.IconLocation
      aumid    = $id
      targetOk = (Test-Path -LiteralPath $sc.TargetPath)
    }
  }
}

if ($hits.Count -eq 0) {
  Write-Output "NO shortcut carries AUMID '$Aumid'"
} else {
  Write-Output ("{0} shortcut(s) carry AUMID '{1}':" -f $hits.Count, $Aumid)
  $hits | ForEach-Object {
    Write-Output ("  lnk={0}`n    target={1} (exists={4})`n    icon={2}" -f $_.path, $_.target, $_.iconLoc, '', $_.targetOk)
  }
}

# What the shell itself would draw for each shortcut, via SHGetFileInfo.
$sig = @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;

public static class ShellIcon {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct SHFILEINFO {
    public IntPtr hIcon; public int iIcon; public uint dwAttributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
  }

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr SHGetFileInfo(string pszPath, uint dwFileAttributes, ref SHFILEINFO psfi, uint cbFileInfo, uint uFlags);

  [DllImport("user32.dll")]
  static extern bool DestroyIcon(IntPtr hIcon);

  public static int[] Stats(string path, int size) {
    var fi = new SHFILEINFO();
    uint flags = 0x000000100 | 0x0; // SHGFI_ICON
    SHGetFileInfo(path, 0, ref fi, (uint)Marshal.SizeOf(fi), flags);
    if (fi.hIcon == IntPtr.Zero) return new int[] { -1, -1, -1 };
    try {
      using (var src = Icon.FromHandle(fi.hIcon).ToBitmap())
      using (var bmp = new Bitmap(src, new Size(size, size))) {
        int green = 0, white = 0, total = 0;
        for (int y = 0; y < bmp.Height; y++)
          for (int x = 0; x < bmp.Width; x++) {
            var c = bmp.GetPixel(x, y);
            total++;
            if (c.G > 120 && c.G > c.R + 40 && c.G > c.B + 40) green++;
            else if (c.R > 230 && c.G > 230 && c.B > 230) white++;
          }
        return new int[] { green * 100 / total, white * 100 / total, total };
      }
    } finally { DestroyIcon(fi.hIcon); }
  }
}
'@
Add-Type -TypeDefinition $sig -ReferencedAssemblies System.Drawing -Language CSharp

Write-Output ''
Write-Output 'shell-resolved icon (SHGetFileInfo, 32px):'
foreach ($h in $hits) {
  $s = [ShellIcon]::Stats($h.path, 32)
  Write-Output ("  lnk     green={0}% white={1}%  {2}" -f $s[0], $s[1], $h.path)
  $s2 = [ShellIcon]::Stats($h.target, 32)
  Write-Output ("  target  green={0}% white={1}%  {2}" -f $s2[0], $s2[1], $h.target)
}
