# What a person does with Walnut for Windows, on a GitHub Windows runner's desktop, recorded:
# download Walnut-Setup-x64.exe (with the mark of the web a browser puts on a download, so
# Windows treats it as one), double-click it in Explorer, get past "Windows protected your PC"
# (More info, Run anyway) when SmartScreen shows it, wait for the Walnut window, click
# "Set up Walnut", and wait until the window shows this PC's own Walnut. Then close it and open
# it again from the Start menu. Windows PowerShell 5.1 runs this (UI Automation is .NET Framework).
param(
  [Parameter(Mandatory)] [string]$Installer,
  [Parameter(Mandatory)] [string]$Out,
  [int]$SetupMinutes = 35
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force -Path $Out | Out-Null
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing, System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class Mouse {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, IntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static void Click(int x, int y, int times) {
    SetCursorPos(x, y);
    for (int i = 0; i < times; i++) { mouse_event(2, 0, 0, 0, IntPtr.Zero); mouse_event(4, 0, 0, 0, IntPtr.Zero); System.Threading.Thread.Sleep(90); }
  }
}
'@
$A = [Windows.Automation.AutomationElement]
$Tree = [Windows.Automation.TreeScope]
$log = Join-Path $Out 'steps.txt'
function Say([string]$text) { $line = (Get-Date).ToUniversalTime().ToString('HH:mm:ss') + ' ' + $text; Write-Host $line; Add-Content -Path $log -Value $line }
$result = [ordered]@{}
function Done([string]$key, $value) { $result[$key] = $value; $result | ConvertTo-Json | Set-Content (Join-Path $Out 'result.json') }

function Find-Window([scriptblock]$match, [int]$seconds) {
  $until = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $until) {
    foreach ($w in $A::RootElement.FindAll($Tree::Children, [Windows.Automation.Condition]::TrueCondition)) {
      try { if (& $match $w) { return $w } } catch { }
    }
    Start-Sleep -Milliseconds 500
  }
  return $null
}
function Find-In($root, [scriptblock]$match, [int]$seconds) {
  $until = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $until) {
    try {
      foreach ($e in $root.FindAll($Tree::Descendants, [Windows.Automation.Condition]::TrueCondition)) {
        try { if (& $match $e) { return $e } } catch { }
      }
    } catch { }
    Start-Sleep -Milliseconds 700
  }
  return $null
}
# A click where a person clicks: the middle of the element, with the real mouse.
function Click-Element($e, [int]$times = 1) {
  $r = $e.Current.BoundingRectangle
  [Mouse]::Click([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2), $times)
}
function Shot([string]$name) {
  $b = [Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object Drawing.Bitmap $b.Width, $b.Height
  $g = [Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [Drawing.Point]::Empty, $b.Size)
  $bmp.Save((Join-Path $Out $name), [Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
function Walnut-Window([int]$seconds) {
  Find-Window { param($w) $w.Current.Name -eq 'Walnut' -and $w.Current.ClassName -like 'Chrome_WidgetWin*' } $seconds
}
# The page the window shows: Chromium's document answers UI Automation's Value with its URL.
function Window-Url($w) {
  $doc = Find-In $w { param($e) $e.Current.ControlType -eq [Windows.Automation.ControlType]::Document } 20
  if (-not $doc) { return '' }
  try { return [string]$doc.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { return '' }
}

# The screen, from here to the end.
$psi = New-Object Diagnostics.ProcessStartInfo 'ffmpeg.exe', ('-loglevel error -y -f gdigrab -framerate 8 -i desktop -vf scale=1280:-2 -c:v libx264 -preset veryfast -pix_fmt yuv420p -movflags +frag_keyframe+empty_moov "' + (Join-Path $Out 'screen.mp4') + '"')
# Its output drained here, never the step's: a child holding the step's output keeps the step open.
$psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true; $psi.CreateNoWindow = $true
$ff = [Diagnostics.Process]::Start($psi)
$ff.BeginOutputReadLine(); $ff.BeginErrorReadLine()
try {
  Start-Sleep 2
  # 1. The download, as a browser leaves it: in Downloads, marked as from the internet.
  $downloads = Join-Path $env:USERPROFILE 'Downloads'
  New-Item -ItemType Directory -Force -Path $downloads | Out-Null
  $dl = Join-Path $downloads 'Walnut-Setup-x64.exe'
  Copy-Item -LiteralPath $Installer -Destination $dl -Force
  Set-Content -LiteralPath $dl -Stream Zone.Identifier -Value "[ZoneTransfer]`r`nZoneId=3`r`nReferrerUrl=https://github.com/EvanZhang008/open-walnut/releases/latest`r`nHostUrl=https://github.com/EvanZhang008/open-walnut/releases/latest/download/Walnut-Setup-x64.exe"
  Say ('downloaded ' + [math]::Round((Get-Item $dl).Length / 1MB) + ' MB to Downloads, marked as from the internet')
  Done 'installerBytes' (Get-Item $dl).Length

  # 2. Double-click it in Explorer.
  Start-Process explorer.exe -ArgumentList ('/select,"' + $dl + '"')
  $explorer = Find-Window { param($w) $w.Current.ClassName -eq 'CabinetWClass' } 30
  if (-not $explorer) { throw 'Explorer did not open Downloads' }
  $item = Find-In $explorer { param($e) $e.Current.ControlType -eq [Windows.Automation.ControlType]::ListItem -and $e.Current.Name -like 'Walnut-Setup-x64*' } 30
  if ($item) {
    Start-Sleep 2
    Click-Element $item 2
    Say 'double-clicked Walnut-Setup-x64 in Explorer'
    Done 'doubleClicked' 'explorer'
  } else {
    # What a double-click does, when UI Automation cannot see the file's row.
    Invoke-Item -LiteralPath $dl
    Say 'Explorer row not found; opened the file as a double-click does'
    Done 'doubleClicked' 'shell'
  }

  # 3. What Windows asks before it runs a downloaded app that is not signed.
  # SmartScreen's "Windows protected your PC" sits in a frame window with no name (on the runner,
  # class ApplicationFrameWindow), so neither its name nor its process tells it apart
  # (2026-11-02, twice): what does is the text inside it.
  $named = { param($n) New-Object Windows.Automation.PropertyCondition($A::NameProperty, $n) }
  $smartText = New-Object Windows.Automation.OrCondition((& $named 'Windows protected your PC'), (& $named 'More info'))
  $isSmart = { param($w)
    $w.Current.Name -like '*protected your PC*' -or $w.Current.Name -like '*SmartScreen*' -or
      ($w.Current.ClassName -in 'ApplicationFrameWindow', 'Windows.UI.Core.CoreWindow', '#32770' -and $w.FindFirst($Tree::Descendants, $smartText))
  }
  $warned = Find-Window { param($w) $w.Current.Name -eq 'Open File - Security Warning' -or (& $isSmart $w) } 60
  if (-not $warned) {
    # Anywhere on the desktop, once: the top-level window that holds the text.
    $hit = $A::RootElement.FindFirst($Tree::Descendants, $smartText)
    if ($hit) {
      $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
      $warned = $hit
      for ($p = $walker.GetParent($warned); $p -and -not [Windows.Automation.Automation]::Compare($p, $A::RootElement); $p = $walker.GetParent($warned)) { $warned = $p }
    }
  }
  if ($warned) {
    $asked = $warned.Current.Name
    if ($asked -ne 'Open File - Security Warning') { $asked = 'Windows protected your PC' }
    Say ('Windows asked first: ' + $asked + ' (window class ' + $warned.Current.ClassName + ')')
    Shot 'windows-asks.png'
    Done 'windowsAsked' $asked
    if ($asked -eq 'Windows protected your PC') {
      $more = Find-In $warned { param($e) $e.Current.Name -eq 'More info' } 15
      if (-not $more) { throw 'SmartScreen shows no More info' }
      Start-Sleep 2; Click-Element $more; Say 'clicked More info'
      $run = Find-In $warned { param($e) $e.Current.Name -eq 'Run anyway' -and $e.Current.ControlType -eq [Windows.Automation.ControlType]::Button } 15
      if (-not $run) { throw 'SmartScreen shows no Run anyway' }
      Start-Sleep 2; Shot 'windows-asks-more-info.png'; Click-Element $run; Say 'clicked Run anyway'
    } else {
      $run = Find-In $warned { param($e) $e.Current.Name -eq 'Run' -and $e.Current.ControlType -eq [Windows.Automation.ControlType]::Button } 15
      if (-not $run) { throw 'The security warning shows no Run' }
      Start-Sleep 2; Click-Element $run; Say 'clicked Run'
    }
  } else {
    # Every top-level window and what an unnamed one holds, so a prompt this does not know is
    # named in the log.
    foreach ($w in $A::RootElement.FindAll($Tree::Children, [Windows.Automation.Condition]::TrueCondition)) {
      try {
        Say ('  window: "' + $w.Current.Name + '" class ' + $w.Current.ClassName + ' process ' + (Get-Process -Id $w.Current.ProcessId).ProcessName)
        if (-not $w.Current.Name) {
          foreach ($e in $w.FindAll($Tree::Descendants, [Windows.Automation.Condition]::TrueCondition)) { Say ('    in it: "' + $e.Current.Name + '" ' + $e.Current.ControlType.ProgrammaticName + ' class ' + $e.Current.ClassName) }
        }
      } catch { }
    }
    Say 'Windows asked nothing before running it'
    Done 'windowsAsked' ''
  }

  # 4. The installer installs and opens Walnut.
  $win = Walnut-Window 240
  if (-not $win) { throw 'no Walnut window within 4 minutes of the double-click' }
  $installed = Join-Path $env:LOCALAPPDATA 'Programs\Walnut\Walnut.exe'
  $lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'Walnut.lnk'
  Say ('the Walnut window opened; installed: ' + (Test-Path $installed) + ', Start menu: ' + (Test-Path $lnk))
  Done 'windowOpened' $true
  Done 'startMenu' (Test-Path $lnk)
  if (-not (Test-Path $installed)) { throw "Walnut.exe is not in $installed" }
  if (-not (Test-Path $lnk)) { throw 'Walnut is not in the Start menu' }
  Start-Sleep 3
  Shot 'setup-page.png'

  # 5. Use Walnut on this PC: Set up Walnut.
  $button = Find-In $win { param($e) $e.Current.Name -eq 'Set up Walnut' -and $e.Current.ControlType -eq [Windows.Automation.ControlType]::Button } 60
  if ($button) {
    Start-Sleep 2; Click-Element $button; Say 'clicked Set up Walnut'
  } else {
    # The button has the focus when the page opens: Enter presses it.
    [Mouse]::SetForegroundWindow([IntPtr]$win.Current.NativeWindowHandle) | Out-Null
    Start-Sleep 1
    [Windows.Forms.SendKeys]::SendWait('{ENTER}')
    Say 'Set up Walnut not visible to UI Automation; pressed Enter on it'
  }

  # 6. Setup: WSL, the OpenWalnut Linux, Walnut as a service there, then its console in the window.
  $state = Join-Path $env:LOCALAPPDATA 'OpenWalnut\app.json'
  $appLog = Join-Path $env:LOCALAPPDATA 'OpenWalnut\app.log'
  $until = (Get-Date).AddMinutes($SetupMinutes)
  $shown = 0
  $url = ''
  while ((Get-Date) -lt $until) {
    Start-Sleep 10
    if (Test-Path $appLog) {
      $lines = @(Get-Content $appLog)
      for ($i = $shown; $i -lt $lines.Count; $i++) { Write-Host ('app.log ' + $lines[$i]) }
      $shown = $lines.Count
      if ($lines -match 'setup own ended: (failed|restart)') { Shot 'setup-stopped.png'; throw 'setup stopped (app.log above)' }
      if ($lines -match 'console did not answer') { Shot 'console-silent.png'; throw 'the console did not answer after setup (app.log above)' }
    }
    if ((Test-Path $state) -and ((Get-Content $state -Raw) -match '"mode": "own"')) {
      $url = Window-Url $win
      if ($url -like 'http://localhost:3456*') { break }
    }
  }
  Done 'consoleUrl' $url
  if ($url -notlike 'http://localhost:3456*') { Shot 'setup-timeout.png'; throw "the window did not show this PC's Walnut within $SetupMinutes minutes (it shows '$url')" }
  Say ('the window shows ' + $url)
  try { $cfg = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3456/api/config' -TimeoutSec 10; Done 'consoleAnswers' $cfg.StatusCode } catch { Done 'consoleAnswers' $_.Exception.Message }
  Start-Sleep 20
  Shot 'console.png'

  # 7. Closed, then opened again from the Start menu: straight to the console. Without what the
  # app remembers, so the open reads it from the Linux (the console service runs).
  Remove-Item -LiteralPath $state -Force
  $proc = Get-Process Walnut -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($proc) { $proc.CloseMainWindow() | Out-Null }
  for ($i = 0; $i -lt 30 -and (Get-Process Walnut -ErrorAction SilentlyContinue); $i++) { Start-Sleep 1 }
  Say ('closed the window; Walnut still running: ' + [bool](Get-Process Walnut -ErrorAction SilentlyContinue))
  Start-Sleep 3
  Start-Process -FilePath $lnk
  $win = Walnut-Window 60
  if (-not $win) { throw 'Walnut did not open from the Start menu' }
  $again = ''
  for ($i = 0; $i -lt 30 -and $again -notlike 'http://localhost:3456*'; $i++) { Start-Sleep 2; $again = Window-Url $win }
  Done 'reopenedUrl' $again
  Done 'reopenedState' ((Test-Path $state) -and ((Get-Content $state -Raw) -match '"mode": "own"'))
  if ($again -notlike 'http://localhost:3456*') { throw "reopened from the Start menu, the window shows '$again'" }
  Say ('opened again from the Start menu: ' + $again)
  Start-Sleep 12
  Shot 'reopened.png'
  Done 'ok' $true
} finally {
  try { Shot 'last.png' } catch { Write-Host ('last screenshot: ' + $_.Exception.Message) }
  try { $ff.StandardInput.Write('q'); $ff.StandardInput.Close() } catch { }
  if (-not $ff.WaitForExit(60000)) { try { $ff.Kill() } catch { } }
  $appLog = Join-Path $env:LOCALAPPDATA 'OpenWalnut\app.log'
  if (Test-Path $appLog) { Copy-Item $appLog (Join-Path $Out 'app.log') }
}
