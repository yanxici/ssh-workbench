$ErrorActionPreference = 'Stop'

# 给指定 .lnk 写入 System.AppUserModel.ID，让任务栏按 AUMID 分组时能找到它并取它的图标。
# 走 IPropertyStore（shell32!SHGetPropertyStoreFromParsingName），WScript.Shell 改不了这个属性。
$sig = @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
  uint GetCount(out uint cProps);
  uint GetAt(uint iProp, out PROPERTYKEY pkey);
  uint GetValue(ref PROPERTYKEY key, out PROPVARIANT pv);
  uint SetValue(ref PROPERTYKEY key, ref PROPVARIANT pv);
  uint Commit();
}

[StructLayout(LayoutKind.Sequential)]
public struct PROPERTYKEY { public Guid fmtid; public uint pid; }

[StructLayout(LayoutKind.Sequential)]
public struct PROPVARIANT {
  public ushort vt;
  public ushort r1, r2, r3;
  public IntPtr p;
  public IntPtr p2;
}

public static class AumidWriter {
  static Guid FMTID_AppUserModel = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3");
  const uint PID_AppUserModel_ID = 5;

  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHGetPropertyStoreFromParsingName(
    string pszPath, IntPtr zero, int flags, ref Guid riid, out IPropertyStore ppv);

  public static string Write(string lnkPath, string aumid) {
    Guid iid = typeof(IPropertyStore).GUID;
    IPropertyStore store;
    int hr = SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 2, ref iid, out store);
    if (hr != 0) return "SHGetPropertyStoreFromParsingName hr=0x" + hr.ToString("X8");

    PROPERTYKEY key = new PROPERTYKEY();
    key.fmtid = FMTID_AppUserModel;
    key.pid = PID_AppUserModel_ID;

    PROPVARIANT pv = new PROPVARIANT();
    pv.vt = 31; // VT_LPWSTR
    pv.p = Marshal.StringToCoTaskMemUni(aumid);
    try {
      hr = store.SetValue(ref key, ref pv);
      if (hr != 0) return "SetValue hr=0x" + hr.ToString("X8");
      hr = store.Commit();
      if (hr != 0) return "Commit hr=0x" + hr.ToString("X8");
      return "ok";
    } finally {
      Marshal.FreeCoTaskMem(pv.p);
    }
  }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp

$targets = @(
  @{ Lnk = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\SSH Workbench.lnk"; Exe = 'D:\ssh-workbench\dist-v10\SSH Workbench-1.0.0-portable.exe' },
  @{ Lnk = "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\SSH Workbench (unpacked).lnk"; Exe = 'D:\ssh-workbench\dist-v10\win-unpacked\SSH Workbench.exe' }
)

$sh = New-Object -ComObject WScript.Shell
$shellApp = New-Object -ComObject Shell.Application

foreach ($t in $targets) {
  if (-not (Test-Path -LiteralPath $t.Exe)) { Write-Output "skip (missing exe): $($t.Exe)"; continue }
  $lnk = $sh.CreateShortcut($t.Lnk)
  $lnk.TargetPath = $t.Exe
  $lnk.WorkingDirectory = Split-Path -Parent $t.Exe
  $lnk.IconLocation = "$($t.Exe),0"
  $lnk.Description = 'SSH Workbench'
  $lnk.Save()

  $res = [AumidWriter]::Write($t.Lnk, 'com.sshworkbench.app')
  Start-Sleep -Milliseconds 250
  $ns = $shellApp.Namespace((Split-Path -Parent $t.Lnk))
  $it = $ns.ParseName((Split-Path -Leaf $t.Lnk))
  $readBack = if ($it) { $it.ExtendedProperty('System.AppUserModel.ID') } else { '<parse failed>' }
  Write-Output ("{0}`n   target={1}`n   aumid write={2} readback='{3}'" -f $t.Lnk, $t.Exe, $res, $readBack)
}
