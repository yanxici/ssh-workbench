# OS 级鼠标点击助手（供 verify-tabmenu-os.cjs 调用）
# 用法: pwsh -NoProfile -File _osclick.ps1 -Action click -X 100 -Y 200 -Button left
#       pwsh -NoProfile -File _osclick.ps1 -Action dclick -X 100 -Y 200   # 原生双击（同进程内两次 down/up）
#       pwsh -NoProfile -File _osclick.ps1 -Action key -X <hwnd> -Y 27     # 真按 ESC（-Y 是虚拟键码）
#       pwsh -NoProfile -File _osclick.ps1 -Action pin -X <hwnd>           # 钉 TOPMOST，防被别的窗口吃掉点击
#       pwsh -NoProfile -File _osclick.ps1 -Action unpin -X <hwnd>
#       pwsh -NoProfile -File _osclick.ps1 -Action save            # 保存当前鼠标位置
#       pwsh -NoProfile -File _osclick.ps1 -Action restore -X 1 -Y 2
#       pwsh -NoProfile -File _osclick.ps1 -Action findhwnd -X <pid> # 找指定进程真正的主窗口句柄（避开 50x50 UAC/IME 覆盖窗）
param(
  [string]$Action = 'click',
  [int]$X = 0,
  [int]$Y = 0,
  [string]$Button = 'left',
  # 传主窗口句柄后，每次点击前都会重新确认「该窗口在最前 + 前台」，
  # 否则桌面上任何后来的窗口（另一个实例、通知、甚至资源管理器）都会把真实点击吃掉。
  [int]$Hwnd = 0
)
Add-Type @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class OsMouse {
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc p, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder sb, int n);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  public struct POINT { public int X, Y; }
  public struct RECT { public int Left, Top, Right, Bottom; }
  public static long FindMainHwnd(uint targetPid) {
    long bestChrome = 0; long bestChromeArea = -1;
    long bestAny = 0; long bestAnyArea = -1;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != targetPid || !IsWindowVisible(h)) return true;
      RECT cr; GetClientRect(h, out cr);
      long area = (long)cr.Right * (long)cr.Bottom;
      if (area <= 0) return true;
      var cb = new StringBuilder(128);
      GetClassName(h, cb, 128);
      string cls = cb.ToString();
      if (cls == "Chrome_WidgetWin_1" && cr.Right >= 200 && cr.Bottom >= 200) {
        if (area > bestChromeArea) { bestChromeArea = area; bestChrome = h.ToInt64(); }
      }
      if (area > bestAnyArea) { bestAnyArea = area; bestAny = h.ToInt64(); }
      return true;
    }, IntPtr.Zero);
    return bestChrome != 0 ? bestChrome : bestAny;
  }
}
"@
$LEFTDOWN = 0x0002; $LEFTUP = 0x0004; $RIGHTDOWN = 0x0008; $RIGHTUP = 0x0010

function Focus-Window([IntPtr]$h) {
  [OsMouse]::ShowWindow($h, 9) | Out-Null
  [OsMouse]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [OsMouse]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 120
  [OsMouse]::BringWindowToTop($h) | Out-Null
  [OsMouse]::SetForegroundWindow($h) | Out-Null
  [OsMouse]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040) | Out-Null
  Start-Sleep -Milliseconds 150
  [OsMouse]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040) | Out-Null
  Start-Sleep -Milliseconds 250
}

function Assert-Top([int]$hnum) {
  # 只在需要时才做（前台已经是目标窗口就不动，省 500ms）
  $h = [IntPtr]$hnum
  [OsMouse]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040) | Out-Null
  if ([OsMouse]::GetForegroundWindow() -ne $h) { Focus-Window $h }
}

switch ($Action) {
  'findhwnd' {
    # 避开 Process.MainWindowHandle 误取 50x50 UAC_InputIndicatorOverlayWnd / 输入法浮窗：
    # 枚举该 PID 全部可见顶层窗口，优先取客户区面积最大的 Chrome_WidgetWin_1。
    [OsMouse]::FindMainHwnd([uint32]$X)
  }
  'save' {
    $p = New-Object OsMouse+POINT
    [OsMouse]::GetCursorPos([ref]$p) | Out-Null
    "cursor=$($p.X),$($p.Y)"
  }
  'restore' {
    [OsMouse]::SetCursorPos($X, $Y) | Out-Null
    "restored=$X,$Y"
  }
  'geometry' {
    # 取窗口客户区在屏幕坐标系的原点（CSS px == 屏幕 px，DPR=1 时可直接相加）
    $h = [IntPtr]$X
    $cr = New-Object OsMouse+RECT
    [OsMouse]::GetClientRect($h, [ref]$cr) | Out-Null
    $p = New-Object OsMouse+POINT
    $p.X = 0; $p.Y = 0
    [OsMouse]::ClientToScreen($h, [ref]$p) | Out-Null
    "clientOrigin=$($p.X),$($p.Y) clientSize=$($cr.Right)x$($cr.Bottom)"
  }
  'pin' {
    # 把目标窗口钉在 TOPMOST 并保持（其他窗口脚本留下的 TOPMOST 会盖住被测窗口，
    # 曾让整轮 OS 回归 16 条假红：点击全被上面的窗口吃掉）。
    $h = [IntPtr]$X
    [OsMouse]::ShowWindow($h, 9) | Out-Null
    [OsMouse]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [OsMouse]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [OsMouse]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040) | Out-Null
    [OsMouse]::SetForegroundWindow($h) | Out-Null
    Start-Sleep -Milliseconds 300
    "pinned=$($h.ToInt64())"
  }
  'unpin' {
    $h = [IntPtr]$X
    [OsMouse]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0040) | Out-Null
    "unpinned=$($h.ToInt64())"
  }
  'focus' {
    Focus-Window ([IntPtr]$X)
    $fg = [OsMouse]::GetForegroundWindow()
    "fg=$($fg.ToInt64())"
  }
  'key' {
    # 真实键盘：-Y 传虚拟键码（27 = ESC）。走 keybd_event，和用户按键同一条路径。
    $vk = [byte]$Y
    [OsMouse]::SetForegroundWindow([IntPtr]$X) | Out-Null
    Start-Sleep -Milliseconds 100
    [OsMouse]::keybd_event($vk, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 40
    [OsMouse]::keybd_event($vk, 0, 2, [UIntPtr]::Zero)
    "key=$vk"
  }
  'dclick' {
    if ($Hwnd -ne 0) { Assert-Top $Hwnd }
    [OsMouse]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 120
    # 原生双击：两次 down/up 在同一个进程里，间隔 40ms —— 用两个独立 pwsh 进程
    # 各点一次是拼不出双击的（进程启动就要几百毫秒），B6 曾因此假红。
    for ($i = 0; $i -lt 2; $i++) {
      [OsMouse]::mouse_event($LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 20
      [OsMouse]::mouse_event($LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
      if ($i -eq 0) { Start-Sleep -Milliseconds 40 }
    }
    "dclicked=$X,$Y"
  }
  'click' {
    if ($Hwnd -ne 0) { Assert-Top $Hwnd }
    [OsMouse]::SetCursorPos($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 90
    if ($Button -eq 'right') {
      [OsMouse]::mouse_event($RIGHTDOWN, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 60
      [OsMouse]::mouse_event($RIGHTUP, 0, 0, 0, [UIntPtr]::Zero)
    } else {
      [OsMouse]::mouse_event($LEFTDOWN, 0, 0, 0, [UIntPtr]::Zero)
      Start-Sleep -Milliseconds 60
      [OsMouse]::mouse_event($LEFTUP, 0, 0, 0, [UIntPtr]::Zero)
    }
    "clicked=$X,$Y,$Button"
  }
}
